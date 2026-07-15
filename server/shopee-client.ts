import {
  commitWrites,
  documentName,
  encryptJson,
  fieldString,
  getDocument,
  stringValue,
  timestampValue,
  type FirestoreDocument,
} from './server-data.js';
import { parseShopeeCredential, signShopeePublic, signShopeeShop, type ShopeeCredential, type ShopeeShopToken } from './shopee.js';

type ShopeeApiPayload = {
  error?: string;
  message?: string;
  access_token?: string;
  refresh_token?: string;
  expire_in?: number;
  response?: { message_id?: string | number; request_id?: string };
  request_id?: string;
};

const decoder = new TextDecoder();

function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum) : '';
}

async function decryptCredential(document: FirestoreDocument | null) {
  const keyBytes = base64ToBytes((process.env.CONNECTOR_ENCRYPTION_KEY || '').trim());
  const ciphertext = fieldString(document, 'ciphertext');
  const iv = fieldString(document, 'iv');
  if (!document || keyBytes.byteLength !== 32 || !ciphertext || !iv) return null;
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const ivBytes = base64ToBytes(iv);
    const ciphertextBytes = base64ToBytes(ciphertext);
    const ivCopy = new Uint8Array(ivBytes.byteLength);
    const ciphertextCopy = new Uint8Array(ciphertextBytes.byteLength);
    ivCopy.set(ivBytes);
    ciphertextCopy.set(ciphertextBytes);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivCopy.buffer }, key, ciphertextCopy.buffer);
    return parseShopeeCredential(JSON.parse(decoder.decode(plaintext)));
  } catch {
    return null;
  }
}

function shopeeHost() {
  return process.env.SHOPEE_API_HOST || 'https://partner.shopeemobile.com';
}

async function refreshShop(shop: ShopeeShopToken, partnerId: string, partnerKey: string) {
  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1_000);
  const sign = await signShopeePublic(path, timestamp, partnerId, partnerKey);
  const url = new URL(`${shopeeHost()}${path}`);
  url.search = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ partner_id: Number(partnerId), shop_id: Number(shop.shopId), refresh_token: shop.refreshToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('SHOPEE_REFRESH_UNAVAILABLE');
  }
  const payload = await response.json().catch(() => ({})) as ShopeeApiPayload;
  const accessToken = cleanText(payload.access_token, 4_096);
  const refreshToken = cleanText(payload.refresh_token, 4_096);
  const expiresIn = Number(payload.expire_in || 0);
  if (!response.ok || payload.error || accessToken.length < 8 || refreshToken.length < 8 || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('SHOPEE_AUTH_EXPIRED');
  return { ...shop, accessToken, refreshToken, expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() };
}

export async function loadShopeeCredential(projectId: string, accessToken: string, workspaceId: string, requiredShopId = '') {
  const partnerId = process.env.SHOPEE_PARTNER_ID || '';
  const partnerKey = process.env.SHOPEE_PARTNER_KEY || '';
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (!/^\d{1,20}$/.test(partnerId) || partnerKey.length < 16 || !encryptionKey) throw new Error('SHOPEE_NOT_CONFIGURED');
  const vaultPath = `workspaces/${workspaceId}/connectorVault/shopee`;
  const vault = await getDocument(projectId, accessToken, vaultPath);
  let credential = await decryptCredential(vault);
  if (!credential || credential.partnerId !== partnerId) throw new Error('SHOPEE_NOT_CONFIGURED');
  const target = requiredShopId ? credential.shops.find((shop) => shop.shopId === requiredShopId) : undefined;
  if (requiredShopId && !target) throw new Error('SHOPEE_ROUTE_NOT_FOUND');
  const shouldRefresh = (target ? [target] : credential.shops).some((shop) => new Date(shop.expiresAt).getTime() <= Date.now() + 5 * 60_000);
  if (!shouldRefresh) return credential;

  const refreshed: ShopeeShopToken[] = [];
  for (const shop of credential.shops) {
    const due = new Date(shop.expiresAt).getTime() <= Date.now() + 5 * 60_000;
    refreshed.push(due && (!requiredShopId || shop.shopId === requiredShopId) ? await refreshShop(shop, partnerId, partnerKey) : shop);
  }
  credential = { ...credential, shops: refreshed };
  const encrypted = await encryptJson(credential, encryptionKey);
  const earliestExpiry = credential.shops.map((shop) => shop.expiresAt).sort()[0];
  await commitWrites(projectId, accessToken, [
    {
      update: { name: documentName(projectId, vaultPath), fields: { ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv) } },
      updateMask: { fieldPaths: ['ciphertext', 'iv'] },
      updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: true },
    },
    {
      update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/shopee`), fields: { tokenExpiresAt: timestampValue(earliestExpiry) } },
      updateMask: { fieldPaths: ['tokenExpiresAt'] },
      updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: true },
    },
  ]);
  return credential;
}

function providerFailure(payload: ShopeeApiPayload) {
  const detail = `${payload.error || ''} ${payload.message || ''}`.toLowerCase();
  if (detail.includes('token') || detail.includes('auth')) return 'SHOPEE_AUTH_EXPIRED';
  if (detail.includes('permission') || detail.includes('no permission')) return 'SHOPEE_PERMISSION_REQUIRED';
  if (detail.includes('shop_bound_subaccount') || detail.includes('chat distribution')) return 'SHOPEE_CHAT_DISTRIBUTION_ACTIVE';
  if (detail.includes('repetitive') || detail.includes('same message')) return 'SHOPEE_DUPLICATE_CONTENT';
  if (detail.includes('limit') || detail.includes('frequency') || detail.includes('too many')) return 'SHOPEE_REPLY_LIMIT';
  return 'SHOPEE_REPLY_FAILED';
}

export async function sendShopeeText(credential: ShopeeCredential, shopId: string, buyerId: string, message: string) {
  const shop = credential.shops.find((candidate) => candidate.shopId === shopId);
  if (!shop || !/^\d{1,20}$/.test(buyerId)) throw new Error('SHOPEE_ROUTE_NOT_FOUND');
  const text = cleanText(message, 1_000);
  if (!text || text !== message.trim()) throw new Error('INVALID_REQUEST');
  const partnerKey = process.env.SHOPEE_PARTNER_KEY || '';
  if (partnerKey.length < 16) throw new Error('SHOPEE_NOT_CONFIGURED');
  const path = '/api/v2/sellerchat/send_message';
  const timestamp = Math.floor(Date.now() / 1_000);
  const sign = await signShopeeShop(path, timestamp, shop.accessToken, shopId, credential.partnerId, partnerKey);
  const url = new URL(`${shopeeHost()}${path}`);
  url.search = new URLSearchParams({
    partner_id: credential.partnerId,
    timestamp: String(timestamp),
    access_token: shop.accessToken,
    shop_id: shopId,
    sign,
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to_id: Number(buyerId), message_type: 'text', content: { text } }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('SHOPEE_DELIVERY_UNKNOWN');
  }
  const payload = await response.json().catch(() => ({})) as ShopeeApiPayload;
  const messageId = cleanText(String(payload.response?.message_id || ''), 180);
  if (!response.ok || payload.error) throw new Error(providerFailure(payload));
  if (!messageId) throw new Error('SHOPEE_DELIVERY_UNKNOWN');
  return messageId;
}
