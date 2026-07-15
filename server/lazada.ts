import { constantTimeEqual } from './server-data.js';

export type LazadaCountryUser = {
  country: string;
  userId: string;
  sellerId: string;
  shortCode: string;
};

export type LazadaToken = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  accountPlatform: string;
  country: string;
  shops: LazadaCountryUser[];
};

export type LazadaInboundMessage = {
  sellerId: string;
  buyerId: string;
  sessionId: string;
  messageId: string;
  body: string;
  preview: string;
  occurredAt: string;
  siteId: string;
  templateId: number;
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

export async function signLazadaRequest(path: string, parameters: Record<string, string | number>, secret: string) {
  if (!path.startsWith('/') || !secret) throw new Error('INVALID_LAZADA_SIGNING_INPUT');
  const canonical = Object.entries(parameters)
    .filter(([key]) => key !== 'sign')
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}${value}`)
    .join('');
  return bytesToHex(await hmacSha256(`${path}${canonical}`, secret)).toUpperCase();
}

export async function verifyLazadaWebhook(rawBody: Uint8Array, supplied: string, appKey: string, secret: string) {
  const normalized = supplied.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized) || !appKey || !secret) return false;
  const input = new Uint8Array(encoder.encode(appKey).byteLength + rawBody.byteLength);
  input.set(encoder.encode(appKey), 0);
  input.set(rawBody, encoder.encode(appKey).byteLength);
  return constantTimeEqual(bytesToHex(await hmacSha256(input, secret)), normalized);
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum)
    : '';
}

function positiveNumber(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function identifier(value: unknown) {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? String(value) : cleanText(value, 180);
  return /^[A-Za-z0-9._:-]{1,180}$/.test(normalized) ? normalized : '';
}

function normalizedCountry(value: unknown) {
  const country = cleanText(value, 8).toLowerCase();
  return ['sg', 'my', 'ph', 'th', 'id', 'vn'].includes(country) ? country : '';
}

export function parseLazadaToken(value: unknown): LazadaToken | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const accessToken = cleanText(candidate.access_token, 4_096);
  const refreshToken = cleanText(candidate.refresh_token, 4_096);
  const expiresIn = positiveNumber(candidate.expires_in);
  const refreshExpiresIn = positiveNumber(candidate.refresh_expires_in);
  const accountPlatform = cleanText(candidate.account_platform, 100);
  const country = normalizedCountry(candidate.country);
  if (accessToken.length < 20 || refreshToken.length < 20 || !expiresIn || !refreshExpiresIn) return null;
  const seen = new Set<string>();
  const shops = (Array.isArray(candidate.country_user_info) ? candidate.country_user_info : []).flatMap((entry): LazadaCountryUser[] => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const sellerId = identifier(item.seller_id);
    const userId = identifier(item.user_id);
    const shopCountry = normalizedCountry(item.country);
    const shortCode = cleanText(item.short_code, 80);
    if (!sellerId || !userId || !shopCountry || seen.has(`${shopCountry}:${sellerId}`)) return [];
    seen.add(`${shopCountry}:${sellerId}`);
    return [{ country: shopCountry, sellerId, userId, shortCode }];
  });
  if (!shops.length) return null;
  return { accessToken, refreshToken, expiresIn, refreshExpiresIn, accountPlatform, country, shops };
}

export function lazadaApiHost(country: string) {
  const hosts: Record<string, string> = {
    sg: 'https://api.lazada.sg/rest',
    my: 'https://api.lazada.com.my/rest',
    ph: 'https://api.lazada.com.ph/rest',
    th: 'https://api.lazada.co.th/rest',
    id: 'https://api.lazada.co.id/rest',
    vn: 'https://api.lazada.vn/rest',
  };
  const host = hosts[country.toLowerCase()];
  if (!host) throw new Error('UNSUPPORTED_LAZADA_COUNTRY');
  return host;
}

function parseObject(value: unknown) {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string' || value.length > 100_000) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function contentSummary(templateId: number, content: Record<string, unknown>) {
  const text = cleanText(content.txt, 4_000) || cleanText(content.translateTxt, 4_000);
  if (templateId === 1 && text) return text;
  if (templateId === 3) return 'Customer sent an image.';
  if (templateId === 4 && text) return text;
  if (templateId === 6) return 'Customer sent a video.';
  if (templateId === 10006) return 'Customer shared a product.';
  if (templateId === 10007) return 'Customer shared an order.';
  if (templateId === 10008) return 'Customer shared a voucher.';
  if (templateId === 10010) return 'Customer followed the shop.';
  return text || 'Customer sent an attachment.';
}

export function normalizeLazadaMessage(value: unknown): LazadaInboundMessage | null {
  if (!value || typeof value !== 'object') return null;
  const envelope = value as Record<string, unknown>;
  if (Number(envelope.message_type) !== 2) return null;
  const sellerId = identifier(envelope.seller_id);
  const data = parseObject(envelope.data);
  if (!sellerId || !data) return null;
  const toAccountType = Number(data.to_account_type);
  if (Number(data.from_account_type) !== 1 || ![1, 2].includes(toAccountType) || Number(data.type) !== 1 || Number(data.status) !== 0) return null;
  const buyerId = identifier(data.from_account_id);
  const sessionId = identifier(data.session_id);
  const messageId = identifier(data.message_id);
  const sendTime = positiveNumber(data.send_time);
  const templateId = Number(data.template_id);
  const content = parseObject(data.content) || {};
  if (!buyerId || !sessionId || !messageId || !sendTime || !Number.isInteger(templateId)) return null;
  const processMessage = cleanText(data.process_msg, 1_000);
  const body = processMessage ? `Lazada safety notice: ${processMessage}` : contentSummary(templateId, content);
  const occurredDate = new Date(sendTime < 10_000_000_000 ? sendTime * 1_000 : sendTime);
  if (Number.isNaN(occurredDate.getTime())) return null;
  const occurredAt = occurredDate.toISOString();
  return {
    sellerId,
    buyerId,
    sessionId,
    messageId,
    body,
    preview: body.slice(0, 180),
    occurredAt,
    siteId: normalizedCountry(data.site_id),
    templateId,
    replyable: !processMessage && data.auto_reply !== true,
  };
}
