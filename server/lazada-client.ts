import {
  commitWrites,
  documentName,
  encryptJson,
  fieldString,
  getDocument,
  stringValue,
  timestampValue,
  type FirestoreDocument,
} from './server-data.ts';
import { lazadaApiHost, parseLazadaToken, signLazadaRequest, type LazadaCountryUser } from './lazada.ts';

export type LazadaCredential = {
  provider: 'lazada';
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
  accountPlatform: string;
  country: string;
  shops: LazadaCountryUser[];
};

type LazadaApiPayload = {
  code?: string | number;
  message_id?: string | number;
  error_code?: string | number;
  error_msg?: string;
  message?: string;
  data?: { message_id?: string | number } | Record<string, unknown>;
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

function validDate(value: unknown) {
  return typeof value === 'string' && value && !Number.isNaN(new Date(value).getTime()) ? value : '';
}

function validShop(value: unknown): LazadaCountryUser | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const country = cleanText(item.country, 8).toLowerCase();
  const sellerId = cleanText(item.sellerId, 180);
  const userId = cleanText(item.userId, 180);
  if (!['sg', 'my', 'ph', 'th', 'id', 'vn'].includes(country) || !/^[A-Za-z0-9._:-]{1,180}$/.test(sellerId) || !/^[A-Za-z0-9._:-]{1,180}$/.test(userId)) return null;
  return { country, sellerId, userId, shortCode: cleanText(item.shortCode, 80) };
}

export function parseLazadaCredential(value: unknown): LazadaCredential | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.provider !== 'lazada') return null;
  const accessToken = cleanText(candidate.accessToken, 4_096);
  const refreshToken = cleanText(candidate.refreshToken, 4_096);
  const expiresAt = validDate(candidate.expiresAt);
  const refreshExpiresAt = validDate(candidate.refreshExpiresAt);
  const shops = (Array.isArray(candidate.shops) ? candidate.shops : []).flatMap((shop) => {
    const parsed = validShop(shop);
    return parsed ? [parsed] : [];
  });
  if (accessToken.length < 20 || refreshToken.length < 20 || !expiresAt || !refreshExpiresAt || !shops.length) return null;
  return {
    provider: 'lazada',
    accessToken,
    refreshToken,
    expiresAt,
    refreshExpiresAt,
    accountPlatform: cleanText(candidate.accountPlatform, 100),
    country: cleanText(candidate.country, 8).toLowerCase(),
    shops,
  };
}

async function decryptCredential(document: FirestoreDocument | null) {
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  const keyBytes = base64ToBytes(encryptionKey.trim());
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
    return parseLazadaCredential(JSON.parse(decoder.decode(plaintext)));
  } catch {
    return null;
  }
}

export async function buildLazadaSignedParameters(
  path: string,
  parameters: Record<string, string | number>,
  appKey: string,
  appSecret: string,
  accessToken = '',
  timestamp = Date.now(),
) {
  const signed: Record<string, string> = {
    ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)])),
    app_key: appKey,
    sign_method: 'sha256',
    timestamp: String(timestamp),
  };
  if (accessToken) signed.access_token = accessToken;
  signed.sign = await signLazadaRequest(path, signed, appSecret);
  return signed;
}

async function refreshCredential(current: LazadaCredential, appKey: string, appSecret: string) {
  if (new Date(current.refreshExpiresAt).getTime() <= Date.now() + 60_000) throw new Error('LAZADA_AUTH_EXPIRED');
  const path = '/auth/token/refresh';
  const parameters = await buildLazadaSignedParameters(path, { refresh_token: current.refreshToken }, appKey, appSecret);
  let response: Response;
  try {
    response = await fetch(`https://auth.lazada.com/rest${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(parameters),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('LAZADA_REFRESH_UNAVAILABLE');
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const source = payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : payload;
  const merged = {
    ...source,
    refresh_token: source.refresh_token || current.refreshToken,
    country: source.country || current.country,
    account_platform: source.account_platform || current.accountPlatform,
    country_user_info: source.country_user_info || current.shops.map((shop) => ({
      country: shop.country,
      seller_id: shop.sellerId,
      user_id: shop.userId,
      short_code: shop.shortCode,
    })),
  };
  const token = parseLazadaToken(merged);
  if (!response.ok || !token) throw new Error('LAZADA_AUTH_EXPIRED');
  return {
    provider: 'lazada' as const,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: new Date(Date.now() + token.expiresIn * 1_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + token.refreshExpiresIn * 1_000).toISOString(),
    accountPlatform: token.accountPlatform,
    country: token.country,
    shops: token.shops,
  };
}

export async function loadLazadaCredential(projectId: string, accessToken: string, workspaceId: string) {
  const appKey = process.env.LAZADA_APP_KEY || '';
  const appSecret = process.env.LAZADA_APP_SECRET || '';
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (!appKey || !appSecret || !encryptionKey) throw new Error('LAZADA_NOT_CONFIGURED');
  const vaultPath = `workspaces/${workspaceId}/connectorVault/lazada`;
  const vault = await getDocument(projectId, accessToken, vaultPath);
  let credential = await decryptCredential(vault);
  if (!credential) throw new Error('LAZADA_NOT_CONFIGURED');
  if (new Date(credential.expiresAt).getTime() > Date.now() + 5 * 60_000) return credential;
  credential = await refreshCredential(credential, appKey, appSecret);
  const encrypted = await encryptJson(credential, encryptionKey);
  await commitWrites(projectId, accessToken, [
    {
      update: { name: documentName(projectId, vaultPath), fields: {
        ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv),
      } },
      updateMask: { fieldPaths: ['ciphertext', 'iv'] },
      updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: true },
    },
    {
      update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/lazada`), fields: {
        tokenExpiresAt: timestampValue(credential.expiresAt),
      } },
      updateMask: { fieldPaths: ['tokenExpiresAt'] },
      updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
      currentDocument: { exists: true },
    },
  ]);
  return credential;
}

function providerFailure(payload: LazadaApiPayload) {
  const detail = `${payload.error_msg || ''} ${payload.message || ''}`.toLowerCase();
  if (detail.includes('token') || detail.includes('auth')) return 'LAZADA_AUTH_EXPIRED';
  if (detail.includes('permission') || detail.includes('unauthorized')) return 'LAZADA_PERMISSION_REQUIRED';
  if (detail.includes('limit') || detail.includes('frequency') || detail.includes('too many')) return 'LAZADA_REPLY_LIMIT';
  if (detail.includes('session')) return 'LAZADA_SESSION_UNAVAILABLE';
  return 'LAZADA_REPLY_FAILED';
}

export async function sendLazadaText(
  credential: LazadaCredential,
  sellerId: string,
  sessionId: string,
  country: string,
  message: string,
) {
  const shop = credential.shops.find((candidate) => candidate.sellerId === sellerId && (!country || candidate.country === country));
  if (!shop) throw new Error('LAZADA_ROUTE_NOT_FOUND');
  const text = cleanText(message, 1_000);
  if (!text || text !== message.trim()) throw new Error('INVALID_REQUEST');
  const appKey = process.env.LAZADA_APP_KEY || '';
  const appSecret = process.env.LAZADA_APP_SECRET || '';
  if (!appKey || !appSecret) throw new Error('LAZADA_NOT_CONFIGURED');
  const path = '/im/message/send';
  const parameters = await buildLazadaSignedParameters(path, { template_id: 1, session_id: sessionId, txt: text }, appKey, appSecret, credential.accessToken);
  let response: Response;
  try {
    response = await fetch(`${lazadaApiHost(shop.country)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(parameters),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('LAZADA_DELIVERY_UNKNOWN');
  }
  const payload = await response.json().catch(() => ({})) as LazadaApiPayload;
  const nestedMessageId = payload.data && 'message_id' in payload.data ? payload.data.message_id : undefined;
  const messageId = cleanText(String(payload.message_id || nestedMessageId || ''), 180);
  const errorCode = String(payload.error_code ?? payload.code ?? '0');
  if (!response.ok || (errorCode !== '0' && !messageId)) throw new Error(providerFailure(payload));
  if (!messageId) throw new Error('LAZADA_DELIVERY_UNKNOWN');
  return messageId;
}
