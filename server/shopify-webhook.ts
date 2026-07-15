import {
  booleanValue,
  commitWrites,
  constantTimeEqual,
  documentName,
  fieldBoolean,
  fieldString,
  getDocument,
  googleAccessToken,
  headerValue,
  doubleValue,
  integerValue,
  stableId,
  stringValue,
  timestampValue,
} from './server-data';
import { normalizeShopDomain } from './shopify';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

type ShopifyCustomer = { id?: number | string; admin_graphql_api_id?: string; first_name?: string; last_name?: string; email?: string; updated_at?: string; created_at?: string };
type ShopifyPayload = {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  email?: string;
  created_at?: string;
  updated_at?: string;
  customer?: ShopifyCustomer;
  customer_id?: number | string;
  currency?: string;
  current_total_price?: string | number;
  total_price?: string | number;
  current_total_price_set?: {
    shop_money?: { amount?: string | number; currency_code?: string };
  };
};

export const config = { api: { bodyParser: false } };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum) : '';
}

function bytesToBase64(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

async function readRawBody(req: ApiRequest) {
  if (!req[Symbol.asyncIterator]) throw new Error('INVALID_BODY');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > 1_000_000) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => { raw.set(chunk, offset); offset += chunk.byteLength; });
  return raw;
}

export async function verifyShopifyWebhook(raw: Uint8Array, supplied: string, secret: string) {
  if (!supplied || !secret) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const body = new Uint8Array(raw.byteLength);
  body.set(raw);
  const digest = bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, body.buffer)));
  return constantTimeEqual(digest, supplied.trim());
}

function safeDate(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function customerFromPayload(payload: ShopifyPayload, topic: string) {
  if (topic.startsWith('customers/')) return payload as ShopifyCustomer;
  return payload.customer || null;
}

function exactShopifyId(resource: 'Order' | 'Customer', value: unknown, graphqlId: unknown) {
  if (typeof graphqlId === 'string') {
    const match = graphqlId.trim().match(new RegExp(`^gid://shopify/${resource}/(\\d+)$`));
    if (match) return match[1];
  }
  if (typeof value === 'string' && /^\d{1,24}$/.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return '';
}

function safeMoney(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '' || typeof normalized === 'string' && !/^\d+(?:\.\d{1,6})?$/.test(normalized)) return null;
  const amount = typeof normalized === 'number' ? normalized : Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return null;
  return Math.round(amount * 100) / 100;
}

export function normalizeShopifyPaidOrder(payload: ShopifyPayload, topic: string) {
  const externalOrderId = exactShopifyId('Order', payload.id, payload.admin_graphql_api_id);
  if (topic.toLowerCase() !== 'orders/paid' || !externalOrderId) return null;
  const shopMoney = payload.current_total_price_set?.shop_money;
  const amount = safeMoney(shopMoney?.amount ?? payload.current_total_price ?? payload.total_price);
  const currency = cleanText(shopMoney?.currency_code || payload.currency, 3).toUpperCase();
  if (amount === null || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount, currency, externalOrderId };
}

async function connectorRoute(projectId: string, accessToken: string, shop: string) {
  const routeId = `shopify_${await stableId('shopify-route', shop)}`;
  const route = await getDocument(projectId, accessToken, `connectorRoutes/${routeId}`);
  if (!route || fieldString(route, 'provider') !== 'shopify' || fieldString(route, 'shopDomain') !== shop || !fieldBoolean(route, 'active')) return null;
  const workspaceId = fieldString(route, 'workspaceId');
  if (!/^personal_[A-Za-z0-9_-]{8,180}$/.test(workspaceId)) return null;
  return { routeId, route, workspaceId };
}

async function removeConnector(projectId: string, accessToken: string, workspaceId: string, routeId: string) {
  await commitWrites(projectId, accessToken, [
    { delete: documentName(projectId, `workspaces/${workspaceId}/connections/shopify`) },
    { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/shopify`) },
    { delete: documentName(projectId, `connectorRoutes/${routeId}`) },
  ]);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const secret = process.env.SHOPIFY_CLIENT_SECRET || '';
    if (!secret) throw new Error('NOT_CONFIGURED');
    const raw = await readRawBody(req);
    if (!await verifyShopifyWebhook(raw, headerValue(req, 'x-shopify-hmac-sha256'), secret)) throw new Error('INVALID_SIGNATURE');
    const shop = normalizeShopDomain(headerValue(req, 'x-shopify-shop-domain'));
    const topic = cleanText(headerValue(req, 'x-shopify-topic'), 80).toLowerCase();
    const webhookId = cleanText(headerValue(req, 'x-shopify-webhook-id'), 160);
    if (!topic || !webhookId) throw new Error('INVALID_HEADERS');
    const payload = JSON.parse(decoder.decode(raw)) as ShopifyPayload;
    const { projectId, accessToken } = await googleAccessToken();
    const route = await connectorRoute(projectId, accessToken, shop);
    if (!route) return res.status(200).json({ ok: true, ignored: true });
    if (topic === 'app/uninstalled' || topic === 'shop/redact') {
      await removeConnector(projectId, accessToken, route.workspaceId, route.routeId);
      return res.status(200).json({ ok: true, disconnected: true });
    }

    const eventId = await stableId('shopify-event', shop, webhookId);
    const base = `workspaces/${route.workspaceId}`;
    const customer = customerFromPayload(payload, topic);
    const externalCustomerId = exactShopifyId('Customer', customer?.id ?? payload.customer_id, customer?.admin_graphql_api_id);
    const contactId = externalCustomerId ? await stableId('contact', 'shopify', shop, String(externalCustomerId)) : '';
    const occurredAt = safeDate(payload.updated_at, payload.created_at, customer?.updated_at, customer?.created_at, headerValue(req, 'x-shopify-triggered-at'));
    if (topic === 'customers/redact') {
      const complianceWrites: unknown[] = [{
        update: { name: documentName(projectId, `${base}/providerEvents/${eventId}`), fields: {
          provider: stringValue('shopify'), type: stringValue(topic), sourceEventHash: stringValue(eventId), receivedAt: timestampValue(new Date().toISOString()),
        } },
        currentDocument: { exists: false },
      }];
      if (contactId) complianceWrites.push({ delete: documentName(projectId, `${base}/contacts/${contactId}`) });
      const accepted = await commitWrites(projectId, accessToken, complianceWrites, true);
      return res.status(200).json({ ok: true, duplicate: !accepted });
    }
    const paidOrder = normalizeShopifyPaidOrder(payload, topic);
    const paidOrderHash = paidOrder ? await stableId('shopify-paid-order', shop, paidOrder.externalOrderId) : '';
    const normalizedType = paidOrder
      ? 'commerce.order_paid'
      : topic.startsWith('orders/')
        ? (topic.endsWith('/create') ? 'order.created' : 'order.updated')
      : topic.startsWith('customers/')
        ? (topic.endsWith('/create') ? 'customer.created' : 'customer.updated')
        : 'store.updated';
    const normalizedEventId = paidOrder ? `shopify_paid_${paidOrderHash}` : `shopify_${eventId}`;
    const writes: unknown[] = [
      {
        update: { name: documentName(projectId, `${base}/providerEvents/${eventId}`), fields: {
          provider: stringValue('shopify'), type: stringValue(topic), sourceEventHash: stringValue(eventId), receivedAt: timestampValue(new Date().toISOString()),
        } },
        currentDocument: { exists: false },
      },
      {
        update: { name: documentName(projectId, `${base}/events/${normalizedEventId}`), fields: {
          type: stringValue(normalizedType), provider: stringValue('shopify'), channel: stringValue('Shopify'), conversationId: stringValue(''), contactId: stringValue(contactId), occurredAt: timestampValue(occurredAt), value: paidOrder ? doubleValue(paidOrder.amount) : integerValue(0), currency: stringValue(paidOrder?.currency || ''), verified: booleanValue(Boolean(paidOrder)), outcomeType: stringValue(paidOrder ? 'order' : ''), externalRefHash: stringValue(paidOrderHash), sourceEventHash: stringValue(eventId),
        } },
        currentDocument: { exists: false },
      },
      {
        update: { name: documentName(projectId, `${base}/connections/shopify`), fields: {
          status: stringValue('connected'), health: stringValue('healthy'), lastWebhookTopic: stringValue(topic),
        } },
        updateMask: { fieldPaths: ['status', 'health', 'lastWebhookTopic'] },
        updateTransforms: [
          { fieldPath: 'lastWebhookAt', setToServerValue: 'REQUEST_TIME' },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
        ],
        currentDocument: { exists: true },
      },
    ];
    if (contactId && customer) {
      const name = [cleanText(customer.first_name, 100), cleanText(customer.last_name, 100)].filter(Boolean).join(' ') || 'Shopify customer';
      writes.push({
        update: { name: documentName(projectId, `${base}/contacts/${contactId}`), fields: {
          name: stringValue(name), handle: stringValue(cleanText(customer.email || payload.email, 240)), sourceProvider: stringValue('shopify'), lastSeenAt: timestampValue(occurredAt),
        } },
        updateMask: { fieldPaths: ['name', 'handle', 'sourceProvider', 'lastSeenAt'] },
        updateTransforms: [
          { fieldPath: 'channels', appendMissingElements: { values: [stringValue('Shopify')] } },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
        ],
      });
    }
    const accepted = await commitWrites(projectId, accessToken, writes, true);
    return res.status(200).json({ ok: true, duplicate: !accepted });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'INVALID_SIGNATURE') return res.status(401).json({ ok: false, error: 'Invalid Shopify signature' });
    if (message === 'PAYLOAD_TOO_LARGE') return res.status(413).json({ ok: false, error: 'Payload too large' });
    if (['INVALID_BODY', 'INVALID_HEADERS', 'INVALID_SHOP'].includes(message) || cause instanceof SyntaxError) return res.status(400).json({ ok: false, error: 'Invalid Shopify webhook' });
    if (message === 'NOT_CONFIGURED' || message === 'SERVER_STORAGE_NOT_CONFIGURED' || message === 'SERVER_STORAGE_AUTH_FAILED') return res.status(503).json({ ok: false, error: 'Shopify webhook handling is not configured' });
    console.error('Shopify webhook failed', cause);
    return res.status(500).json({ ok: false, error: 'Shopify webhook could not be completed' });
  }
}
