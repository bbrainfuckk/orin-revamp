import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import {
  base64ToBytes,
  booleanValue,
  bytesToBase64Url,
  commitWrites,
  documentName,
  encryptJson,
  fieldString,
  getDocument,
  stringValue,
  timestampValue,
  type FirebaseAccount,
  type FirestoreDocument,
} from './server-data.js';

export type VerifiedWebhookCredential = {
  provider: 'webhook';
  webhookUrl: string;
  signingSecret: string;
  hostname: string;
};

export type ResolvedWebhookHost = {
  address: string;
  family: 4 | 6;
};

export type WebhookPostRequest = {
  url: string;
  hostname: string;
  resolved: ResolvedWebhookHost;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export type WebhookPostResult = {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
};

export type WebhookTransport = (request: WebhookPostRequest) => Promise<WebhookPostResult>;

type WebhookBody = {
  workspaceId?: unknown;
  displayName?: unknown;
  webhookUrl?: unknown;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function clean(value: unknown, maximum: number) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum)
    : '';
}

function normalizedHostname(value: string) {
  return value.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function publicIpv4(value: string) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function publicIpv6(value: string) {
  const address = normalizedHostname(value);
  const sides = address.split('::');
  if (!address || sides.length > 2) return false;
  const parseSide = (side: string) => side ? side.split(':').map((part) => Number.parseInt(part, 16)) : [];
  const left = parseSide(sides[0]);
  const right = parseSide(sides[1] || '');
  const missing = 8 - left.length - right.length;
  const words = sides.length === 2 ? [...left, ...Array.from({ length: missing }, () => 0), ...right] : left;
  if ((sides.length === 2 && missing < 1) || words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return false;
  // Public webhook IPv6 destinations must be ordinary global-unicast addresses.
  if (words[0] < 0x2000 || words[0] > 0x3fff) return false;
  if (words[0] === 0x2002) return false; // 6to4 embeds an IPv4 route.
  if (words[0] === 0x2001 && words[1] === 0x0000) return false; // Teredo tunnel range.
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // Documentation range.
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010) return false; // ORCHID.
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) return false; // ORCHIDv2.
  return true;
}

export function isPublicWebhookAddress(value: string) {
  const version = isIP(normalizedHostname(value));
  if (version === 4) return publicIpv4(normalizedHostname(value));
  if (version === 6) return publicIpv6(normalizedHostname(value));
  return false;
}

export function validatePublicWebhookUrl(value: unknown) {
  const raw = clean(value, 1_000);
  if (!raw) throw new Error('WEBHOOK_URL_INVALID');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WEBHOOK_URL_INVALID');
  }
  const hostname = normalizedHostname(url.hostname);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || url.hash
  ) throw new Error('WEBHOOK_URL_INVALID');
  if (isIP(hostname) && !isPublicWebhookAddress(hostname)) throw new Error('WEBHOOK_URL_PRIVATE');
  return { url: url.toString(), hostname };
}

export async function assertPublicWebhookHost(hostname: string) {
  const normalized = normalizedHostname(hostname);
  if (isIP(normalized)) {
    if (!isPublicWebhookAddress(normalized)) throw new Error('WEBHOOK_URL_PRIVATE');
    return { address: normalized, family: isIP(normalized) as 4 | 6 };
  }
  const [ipv4, ipv6] = await Promise.allSettled([resolve4(normalized), resolve6(normalized)]);
  const addresses = [
    ...(ipv4.status === 'fulfilled' ? ipv4.value : []),
    ...(ipv6.status === 'fulfilled' ? ipv6.value : []),
  ];
  if (!addresses.length) throw new Error('WEBHOOK_HOST_UNAVAILABLE');
  if (addresses.some((address) => !isPublicWebhookAddress(address))) throw new Error('WEBHOOK_URL_PRIVATE');
  const address = addresses[0];
  return { address, family: isIP(address) as 4 | 6 };
}

export const postPinnedWebhook: WebhookTransport = async ({ url, hostname, resolved, headers, body, timeoutMs = 6_000, maxResponseBytes = 8_192 }) => {
  const destination = validatePublicWebhookUrl(url);
  if (destination.hostname !== normalizedHostname(hostname) || !isPublicWebhookAddress(resolved.address)) throw new Error('WEBHOOK_URL_PRIVATE');
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address: resolved.address, family: resolved.family }]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };
  return new Promise<WebhookPostResult>((resolve, reject) => {
    let settled = false;
    const fail = (cause: Error) => {
      if (settled) return;
      settled = true;
      reject(cause);
    };
    const request = httpsRequest(destination.url, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
      lookup,
      servername: isIP(destination.hostname) ? undefined : destination.hostname,
      agent: false,
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.byteLength;
        if (size > maxResponseBytes) {
          response.destroy(new Error('WEBHOOK_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(value);
      });
      response.once('error', fail);
      response.once('end', () => {
        if (settled) return;
        settled = true;
        const status = response.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          contentType: String(response.headers['content-type'] || ''),
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.once('timeout', () => {
      const timeout = new Error('WEBHOOK_TIMEOUT');
      timeout.name = 'TimeoutError';
      request.destroy(timeout);
    });
    request.once('error', fail);
    request.end(body);
  });
};

function readSmallJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error('WEBHOOK_VERIFICATION_FAILED');
  }
}

async function requireAdmin(projectId: string, accessToken: string, workspaceId: string, uid: string) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId)) throw new Error('INVALID_REQUEST');
  const membership = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`);
  if (!membership || !['owner', 'admin'].includes(fieldString(membership, 'role'))) throw new Error('FORBIDDEN');
}

export async function connectVerifiedWebhook(projectId: string, accessToken: string, account: FirebaseAccount, body: WebhookBody, transport: WebhookTransport = postPinnedWebhook) {
  const workspaceId = clean(body.workspaceId, 200);
  const displayName = clean(body.displayName, 100);
  const destination = validatePublicWebhookUrl(body.webhookUrl);
  if (!displayName) throw new Error('INVALID_REQUEST');
  await requireAdmin(projectId, accessToken, workspaceId, account.localId);
  const resolved = await assertPublicWebhookHost(destination.hostname);
  const challenge = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  let verification: WebhookPostResult;
  try {
    verification = await transport({
      url: destination.url,
      hostname: destination.hostname,
      resolved,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ORIN-AI-Webhook-Verifier/1.0',
        'X-ORIN-Event': 'endpoint.verification',
        'X-ORIN-Challenge': challenge,
      },
      body: JSON.stringify({ type: 'endpoint.verification', challenge, source: 'ORIN AI' }),
      timeoutMs: 6_000,
      maxResponseBytes: 8_192,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'WEBHOOK_RESPONSE_TOO_LARGE') throw new Error('WEBHOOK_VERIFICATION_FAILED');
    throw new Error('WEBHOOK_HOST_UNAVAILABLE');
  }
  if (!verification.ok || !verification.contentType.toLowerCase().includes('application/json')) throw new Error('WEBHOOK_VERIFICATION_FAILED');
  const responseBody = readSmallJson(verification.body);
  if (responseBody.challenge !== challenge) throw new Error('WEBHOOK_VERIFICATION_FAILED');
  const signingSecret = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  const encrypted = await encryptJson({ provider: 'webhook', webhookUrl: destination.url, signingSecret, hostname: destination.hostname }, encryptionKey);
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [
    {
      update: { name: documentName(projectId, `workspaces/${workspaceId}/connectorVault/webhook`), fields: {
        provider: stringValue('webhook'), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), version: stringValue('v1'), updatedAt: timestampValue(now),
      } },
    },
    {
      update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/webhook`), fields: {
        provider: stringValue('webhook'), displayName: stringValue(displayName), status: stringValue('connected'), health: stringValue('healthy'), authorizationStatus: stringValue('verified'), credentialState: stringValue('encrypted_server_side'), endpointHost: stringValue(destination.hostname), desiredChannels: { arrayValue: { values: [] } }, active: booleanValue(true), verifiedAt: timestampValue(now), updatedAt: timestampValue(now),
      } },
    },
  ]);
  return { ok: true, connected: true, endpointHost: destination.hostname, signingSecret };
}

export async function disconnectVerifiedWebhook(projectId: string, accessToken: string, account: FirebaseAccount, body: WebhookBody) {
  const workspaceId = clean(body.workspaceId, 200);
  await requireAdmin(projectId, accessToken, workspaceId, account.localId);
  await commitWrites(projectId, accessToken, [
    { delete: documentName(projectId, `workspaces/${workspaceId}/connections/webhook`) },
    { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/webhook`) },
  ]);
  return { ok: true, connected: false };
}

export async function decryptVerifiedWebhook(document: FirestoreDocument | null): Promise<VerifiedWebhookCredential | null> {
  const keyBytes = base64ToBytes((process.env.CONNECTOR_ENCRYPTION_KEY || '').trim());
  const ciphertext = fieldString(document, 'ciphertext');
  const iv = fieldString(document, 'iv');
  if (!document || keyBytes.byteLength !== 32 || !ciphertext || !iv) return null;
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), tagLength: 128 }, key, base64ToBytes(ciphertext));
    const value = JSON.parse(decoder.decode(plaintext)) as Partial<VerifiedWebhookCredential>;
    if (value.provider !== 'webhook' || typeof value.webhookUrl !== 'string' || typeof value.signingSecret !== 'string' || value.signingSecret.length < 32 || typeof value.hostname !== 'string') return null;
    const destination = validatePublicWebhookUrl(value.webhookUrl);
    if (destination.hostname !== normalizedHostname(value.hostname)) return null;
    return { provider: 'webhook', webhookUrl: destination.url, signingSecret: value.signingSecret, hostname: destination.hostname };
  } catch {
    return null;
  }
}
