import { constantTimeEqual } from './server-data.js';

export type ShopeeShopToken = {
  shopId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  shopName: string;
  region: string;
};

export type ShopeeCredential = {
  provider: 'shopee';
  partnerId: string;
  shops: ShopeeShopToken[];
};

export type ShopeeInboundMessage = {
  shopId: string;
  buyerId: string;
  shopUserId: string;
  conversationId: string;
  messageId: string;
  body: string;
  preview: string;
  occurredAt: string;
  region: string;
  messageType: string;
  replyable: boolean;
};

const encoder = new TextEncoder();

function bytesToHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(message: string | Uint8Array, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const input = typeof message === 'string' ? encoder.encode(message) : message;
  const data = new Uint8Array(input.byteLength);
  data.set(input);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data.buffer));
}

export async function signShopeePublic(path: string, timestamp: number, partnerId: string, partnerKey: string) {
  if (!path.startsWith('/') || !/^\d{1,20}$/.test(partnerId) || !Number.isInteger(timestamp) || !partnerKey) throw new Error('INVALID_SHOPEE_SIGNING_INPUT');
  return bytesToHex(await hmacSha256(`${partnerId}${path}${timestamp}`, partnerKey));
}

export async function signShopeeShop(path: string, timestamp: number, accessToken: string, shopId: string, partnerId: string, partnerKey: string) {
  if (!path.startsWith('/') || !/^\d{1,20}$/.test(shopId) || accessToken.length < 8) throw new Error('INVALID_SHOPEE_SIGNING_INPUT');
  return bytesToHex(await hmacSha256(`${partnerId}${path}${timestamp}${accessToken}${shopId}`, partnerKey));
}

export async function verifyShopeeWebhook(rawBody: Uint8Array, supplied: string, callbackUrl: string, partnerKey: string) {
  const normalized = supplied.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized) || !/^https:\/\//i.test(callbackUrl) || !partnerKey) return false;
  const prefix = encoder.encode(`${callbackUrl}|`);
  const input = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  input.set(prefix, 0);
  input.set(rawBody, prefix.byteLength);
  return constantTimeEqual(bytesToHex(await hmacSha256(input, partnerKey)), normalized);
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum)
    : '';
}

function identifier(value: unknown) {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : cleanText(value, 180);
  return /^[A-Za-z0-9._:-]{1,180}$/.test(normalized) ? normalized : '';
}

function positiveNumber(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentSummary(messageType: string, content: Record<string, unknown>, source: Record<string, unknown>) {
  const text = cleanText(content.text, 4_000) || cleanText(content.title, 4_000);
  if (messageType === 'text' && text) return text;
  if (['faq_liveagent', 'faq', 'bundle_message'].includes(messageType) && text) return text;
  if (messageType === 'image') return 'Customer sent an image.';
  if (messageType === 'video') return 'Customer sent a video.';
  if (messageType === 'sticker') return 'Customer sent a sticker.';
  if (messageType === 'item') return source.item_id || content.item_id ? 'Customer shared a product.' : 'Customer sent a product message.';
  if (messageType === 'order') return source.order_sn || content.order_sn ? 'Customer shared an order.' : 'Customer sent an order message.';
  if (messageType === 'voucher') return 'Customer shared a voucher.';
  if (messageType === 'location') return 'Customer shared a location.';
  return text || 'Customer sent an attachment.';
}

export function parseShopeeCredential(value: unknown): ShopeeCredential | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.provider !== 'shopee') return null;
  const partnerId = identifier(candidate.partnerId);
  const seen = new Set<string>();
  const shops = (Array.isArray(candidate.shops) ? candidate.shops : []).flatMap((entry): ShopeeShopToken[] => {
    const item = objectValue(entry);
    const shopId = identifier(item.shopId);
    const accessToken = cleanText(item.accessToken, 4_096);
    const refreshToken = cleanText(item.refreshToken, 4_096);
    const expiresAt = cleanText(item.expiresAt, 80);
    const date = new Date(expiresAt);
    if (!shopId || accessToken.length < 8 || refreshToken.length < 8 || Number.isNaN(date.getTime()) || seen.has(shopId)) return [];
    seen.add(shopId);
    return [{
      shopId,
      accessToken,
      refreshToken,
      expiresAt: date.toISOString(),
      shopName: cleanText(item.shopName, 160) || `Shopee shop ${shopId.slice(-4)}`,
      region: cleanText(item.region, 8).toUpperCase(),
    }];
  });
  return partnerId && shops.length ? { provider: 'shopee', partnerId, shops } : null;
}

export function normalizeShopeeMessage(value: unknown): ShopeeInboundMessage | null {
  if (!value || typeof value !== 'object') return null;
  const envelope = value as Record<string, unknown>;
  if (Number(envelope.code) !== 10) return null;
  const shopId = identifier(envelope.shop_id);
  const data = objectValue(envelope.data);
  if (!shopId || cleanText(data.type, 40).toLowerCase() !== 'message') return null;
  const content = objectValue(data.content);
  const messageId = identifier(content.message_id);
  const buyerId = identifier(content.from_id);
  const shopUserId = identifier(content.to_id);
  const conversationId = identifier(content.conversation_id);
  const messageType = cleanText(content.message_type, 80).toLowerCase();
  const createdTimestamp = positiveNumber(content.created_timestamp) || positiveNumber(envelope.timestamp);
  if (!messageId || !buyerId || !shopUserId || !conversationId || !messageType || !createdTimestamp) return null;

  const fromShopId = identifier(content.from_shop_id);
  const toShopId = identifier(content.to_shop_id);
  if (fromShopId === shopId && toShopId !== shopId) return null;
  if (toShopId && toShopId !== shopId) return null;
  const status = cleanText(content.status, 80).toLowerCase();
  if (status && !['normal', 'censored whitelist'].includes(status)) return null;

  const occurredDate = new Date(createdTimestamp < 10_000_000_000 ? createdTimestamp * 1_000 : createdTimestamp);
  if (Number.isNaN(occurredDate.getTime())) return null;
  const messageContent = objectValue(content.content);
  const sourceContent = objectValue(content.source_content);
  const body = contentSummary(messageType, messageContent, sourceContent);
  return {
    shopId,
    buyerId,
    shopUserId,
    conversationId,
    messageId,
    body,
    preview: body.slice(0, 180),
    occurredAt: occurredDate.toISOString(),
    region: cleanText(data.region, 8).toUpperCase() || cleanText(content.region, 8).toUpperCase(),
    messageType,
    replyable: content.is_in_chatbot_session !== true && content.shopee_chatbot_replied !== true,
  };
}
