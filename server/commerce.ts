import {
  booleanValue,
  commitWrites,
  decryptJson,
  documentName,
  encryptJson,
  fieldBoolean,
  fieldInteger,
  fieldString,
  getDocument,
  googleAccessToken,
  integerValue,
  requireWorkspaceRole,
  stableId,
  stringArrayValue,
  stringValue,
  timestampValue,
  verifyFirebaseAccount,
  type FirestoreDocument,
  type ServerRequest,
} from './server-data.js';

type CommerceRequest = ServerRequest & { method?: string; body?: unknown };
type Body = Record<string, unknown>;
type MessengerButton = { type: 'postback'; title: string; payload: string } | { type: 'web_url'; title: string; url: string; webview_height_ratio: 'tall' };

export type CatalogItem = {
  id: string;
  name: string;
  kind: 'service' | 'product' | 'material';
  description: string;
  priceCentavos: number;
  quoteOnly: boolean;
  stock: number;
  variants: string[];
  imageUrl: string;
  active: boolean;
};

export type CommerceOrder = {
  id: string;
  reference: string;
  itemId: string;
  itemName: string;
  itemKind: CatalogItem['kind'];
  variant: string;
  quantity: number;
  unitPriceCentavos: number;
  totalCentavos: number;
  quoteOnly: boolean;
  status: string;
  contactId: string;
  contactName: string;
  conversationId: string;
};

export type PayMongoCredential = {
  provider: 'paymongo';
  secretKey: string;
  webhookSecret: string;
  liveMode: boolean;
  gcashNumber: string;
  gcashAccountName: string;
};

export type CommerceAction =
  | { type: 'catalog' }
  | { type: 'select'; itemId: string }
  | { type: 'add'; itemId: string; variantIndex: number }
  | { type: 'quantity'; orderId: string; delta: -1 | 1 }
  | { type: 'review' | 'quote' | 'qrph' | 'gcash' | 'cancel'; orderId: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clean = (value: unknown, maximum = 500) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, maximum)
  : '';
const safeId = (value: unknown) => {
  const result = clean(value, 128);
  return /^[A-Za-z0-9_-]{1,128}$/.test(result) ? result : '';
};

function bodyOf(req: CommerceRequest) {
  const value = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  return value as Body;
}

function documentId(document: FirestoreDocument) {
  return document.name?.split('/').pop() || '';
}

function stringList(document: FirestoreDocument, name: string) {
  return (document.fields?.[name]?.arrayValue?.values || []).map((value) => value.stringValue || '').filter(Boolean);
}

export function catalogItemFromDocument(document: FirestoreDocument | null): CatalogItem | null {
  if (!document) return null;
  const id = documentId(document);
  const kind = fieldString(document, 'kind');
  const name = fieldString(document, 'name');
  if (!safeId(id) || !name || !['service', 'product', 'material'].includes(kind)) return null;
  return {
    id,
    name,
    kind: kind as CatalogItem['kind'],
    description: fieldString(document, 'description'),
    priceCentavos: Math.max(0, fieldInteger(document, 'priceCentavos')),
    quoteOnly: fieldBoolean(document, 'quoteOnly'),
    stock: fieldInteger(document, 'stock'),
    variants: stringList(document, 'variants').slice(0, 3),
    imageUrl: fieldString(document, 'imageUrl'),
    active: fieldBoolean(document, 'active'),
  };
}

export function commerceOrderFromDocument(document: FirestoreDocument | null): CommerceOrder | null {
  if (!document) return null;
  const id = documentId(document);
  const itemKind = fieldString(document, 'itemKind');
  if (!safeId(id) || !['service', 'product', 'material'].includes(itemKind)) return null;
  return {
    id,
    reference: fieldString(document, 'reference'),
    itemId: fieldString(document, 'itemId'),
    itemName: fieldString(document, 'itemName'),
    itemKind: itemKind as CatalogItem['kind'],
    variant: fieldString(document, 'variant'),
    quantity: Math.max(1, fieldInteger(document, 'quantity')),
    unitPriceCentavos: Math.max(0, fieldInteger(document, 'unitPriceCentavos')),
    totalCentavos: Math.max(0, fieldInteger(document, 'totalCentavos')),
    quoteOnly: fieldBoolean(document, 'quoteOnly'),
    status: fieldString(document, 'status'),
    contactId: fieldString(document, 'contactId'),
    contactName: fieldString(document, 'contactName'),
    conversationId: fieldString(document, 'conversationId'),
  };
}

export function validateCatalogInput(value: unknown): Omit<CatalogItem, 'id'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CATALOG_ITEM');
  const item = value as Body;
  const name = clean(item.name, 80);
  const kind = clean(item.kind, 20);
  const description = clean(item.description, 240);
  const quoteOnly = item.quoteOnly === true;
  const price = Number(item.priceCentavos);
  const stock = item.stock === null || item.stock === '' || item.stock === undefined ? -1 : Number(item.stock);
  const variants = Array.isArray(item.variants) ? item.variants.map((variant) => clean(variant, 40)).filter(Boolean).slice(0, 3) : [];
  const imageUrl = clean(item.imageUrl, 500);
  if (!name || !['service', 'product', 'material'].includes(kind)) throw new Error('INVALID_CATALOG_ITEM');
  if (!quoteOnly && (!Number.isInteger(price) || price < 100 || price > 100_000_000)) throw new Error('INVALID_CATALOG_PRICE');
  if (!Number.isInteger(stock) || stock < -1 || stock > 10_000_000) throw new Error('INVALID_CATALOG_STOCK');
  if (imageUrl) {
    let parsed: URL;
    try { parsed = new URL(imageUrl); } catch { throw new Error('INVALID_CATALOG_IMAGE'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('INVALID_CATALOG_IMAGE');
  }
  return {
    name,
    kind: kind as CatalogItem['kind'],
    description,
    priceCentavos: quoteOnly ? 0 : Math.trunc(price),
    quoteOnly,
    stock: Math.trunc(stock),
    variants: [...new Set(variants)],
    imageUrl,
    active: item.active !== false,
  };
}

export function parseCommerceAction(payload: string): CommerceAction | null {
  if (!payload.startsWith('ORIN_COMMERCE:')) return null;
  const [command, first, second] = payload.slice('ORIN_COMMERCE:'.length).split(':');
  if (command === 'CATALOG') return { type: 'catalog' };
  if (command === 'SELECT' && safeId(first)) return { type: 'select', itemId: first };
  if (command === 'ADD' && safeId(first) && /^[0-2]$/.test(second || '0')) return { type: 'add', itemId: first, variantIndex: Number(second || 0) };
  if (command === 'QTY' && safeId(first) && ['-1', '1'].includes(second)) return { type: 'quantity', orderId: first, delta: Number(second) as -1 | 1 };
  const orderActions = { REVIEW: 'review', QUOTE: 'quote', QRPH: 'qrph', GCASH: 'gcash', CANCEL: 'cancel' } as const;
  const type = orderActions[command as keyof typeof orderActions];
  return type && safeId(first) ? { type, orderId: first } : null;
}

export function wantsCommerceCatalog(message: string) {
  const value = message.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return /^(?:(?:please|pls)\s+)?(?:(?:can i|could i|show me|show|view|open|browse|send me|see)\s+)*(?:the\s+)?(?:catalog|products|product list|services|service list|materials|material list|price list|menu)$/.test(value);
}

export function money(centavos: number) {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Math.max(0, centavos) / 100);
}

function itemSubtitle(item: CatalogItem) {
  const price = item.quoteOnly ? 'Quotation available' : money(item.priceCentavos);
  const stock = item.kind !== 'service' && item.stock >= 0 ? `${item.stock.toLocaleString('en-PH')} available` : '';
  return [price, stock, item.description].filter(Boolean).join(' · ').slice(0, 80);
}

export function buildMessengerCatalog(recipientId: string, items: CatalogItem[]) {
  return {
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: items.slice(0, 10).map((item) => ({
            title: item.name.slice(0, 80),
            subtitle: itemSubtitle(item),
            ...(item.imageUrl ? { image_url: item.imageUrl } : {}),
            buttons: [{
              type: 'postback',
              title: item.variants.length ? 'Choose options' : item.quoteOnly ? 'Request quote' : 'Select',
              payload: `ORIN_COMMERCE:${item.variants.length ? 'SELECT' : 'ADD'}:${item.id}:0`,
            }],
          })),
        },
      },
    },
  };
}

export function buildMessengerButtons(recipientId: string, text: string, buttons: MessengerButton[]) {
  return {
    recipient: { id: recipientId },
    messaging_type: 'RESPONSE',
    message: { attachment: { type: 'template', payload: { template_type: 'button', text: text.slice(0, 640), buttons: buttons.slice(0, 3) } } },
  };
}

export function buildMessengerText(recipientId: string, text: string) {
  return { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text: text.slice(0, 2_000) } };
}

export function orderSummary(order: CommerceOrder) {
  const variant = order.variant ? ` · ${order.variant}` : '';
  const total = order.quoteOnly ? 'Quotation required' : `${money(order.unitPriceCentavos)} × ${order.quantity} = ${money(order.totalCentavos)}`;
  return `${order.reference}\n${order.itemName}${variant}\nQuantity: ${order.quantity}\n${total}`;
}

export function buildVariantChoice(recipientId: string, item: CatalogItem) {
  return buildMessengerButtons(recipientId, `Choose an option for ${item.name}.`, item.variants.map((variant, index) => ({
    type: 'postback', title: variant.slice(0, 20), payload: `ORIN_COMMERCE:ADD:${item.id}:${index}`,
  })));
}

export function buildQuantityChoice(recipientId: string, order: CommerceOrder) {
  return buildMessengerButtons(recipientId, orderSummary(order), [
    order.quantity === 1
      ? { type: 'postback', title: 'Cancel', payload: `ORIN_COMMERCE:CANCEL:${order.id}` }
      : { type: 'postback', title: '−1', payload: `ORIN_COMMERCE:QTY:${order.id}:-1` },
    { type: 'postback', title: '+1', payload: `ORIN_COMMERCE:QTY:${order.id}:1` },
    { type: 'postback', title: 'Review order', payload: `ORIN_COMMERCE:REVIEW:${order.id}` },
  ]);
}

export function buildPaymentChoice(recipientId: string, order: CommerceOrder, nativeGcash: boolean) {
  if (order.quoteOnly) return buildMessengerButtons(recipientId, orderSummary(order), [
    { type: 'postback', title: 'Request quotation', payload: `ORIN_COMMERCE:QUOTE:${order.id}` },
    { type: 'postback', title: 'Change quantity', payload: `ORIN_COMMERCE:QTY:${order.id}:1` },
    { type: 'postback', title: 'Cancel', payload: `ORIN_COMMERCE:CANCEL:${order.id}` },
  ]);
  return buildMessengerButtons(recipientId, `${orderSummary(order)}\n\nChoose a payment method.`, [
    { type: 'postback', title: 'GCash / QRPh', payload: `ORIN_COMMERCE:QRPH:${order.id}` },
    nativeGcash
      ? { type: 'postback', title: 'GCash transfer', payload: `ORIN_COMMERCE:GCASH:${order.id}` }
      : { type: 'postback', title: 'Change quantity', payload: `ORIN_COMMERCE:QTY:${order.id}:1` },
    { type: 'postback', title: 'Cancel', payload: `ORIN_COMMERCE:CANCEL:${order.id}` },
  ]);
}

export function nativeGcashCommand(number: string) {
  return `GCash ${number}`;
}

function validatePayMongoCredential(value: Body): PayMongoCredential {
  const secretKey = clean(value.secretKey, 200);
  const webhookSecret = clean(value.webhookSecret, 300);
  const rawNumber = clean(value.gcashNumber, 20).replace(/[\s-]/g, '');
  const gcashNumber = rawNumber.startsWith('+63') ? `0${rawNumber.slice(3)}` : rawNumber;
  const gcashAccountName = clean(value.gcashAccountName, 100);
  if (!/^sk_(?:test|live)_[A-Za-z0-9_-]{16,}$/.test(secretKey) || webhookSecret.length < 16) throw new Error('INVALID_PAYMONGO_CREDENTIALS');
  if ((gcashNumber || gcashAccountName) && (!/^09\d{9}$/.test(gcashNumber) || !gcashAccountName)) throw new Error('INVALID_GCASH_ACCOUNT');
  return { provider: 'paymongo', secretKey, webhookSecret, liveMode: secretKey.startsWith('sk_live_'), gcashNumber, gcashAccountName };
}

async function testPayMongoSecret(secretKey: string) {
  const response = await fetch('https://api.paymongo.com/v1/webhooks', {
    headers: { Authorization: `Basic ${btoa(`${secretKey}:`)}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? 'PAYMONGO_REJECTED_CREDENTIALS' : 'PAYMONGO_UNAVAILABLE');
}

export async function loadPayMongoCredential(projectId: string, accessToken: string, workspaceId: string) {
  const vault = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/paymongo`);
  if (!vault) throw new Error('PAYMONGO_NOT_CONNECTED');
  const credential = await decryptJson<PayMongoCredential>(fieldString(vault, 'ciphertext'), fieldString(vault, 'iv'), process.env.CONNECTOR_ENCRYPTION_KEY || '');
  if (credential.provider !== 'paymongo' || !credential.secretKey || !credential.webhookSecret) throw new Error('PAYMONGO_NOT_CONNECTED');
  return credential;
}

export function checkoutAttributes(order: CommerceOrder) {
  return {
    line_items: [{
      name: `${order.itemName}${order.variant ? ` · ${order.variant}` : ''}`.slice(0, 120),
      amount: order.unitPriceCentavos,
      currency: 'PHP',
      quantity: order.quantity,
    }],
    payment_method_types: ['qrph'],
    success_url: `https://www.orin.work/payment/complete?status=submitted&order=${encodeURIComponent(order.reference)}`,
    cancel_url: `https://www.orin.work/payment/complete?status=cancelled&order=${encodeURIComponent(order.reference)}`,
    reference_number: order.reference,
    description: `ORIN AI order ${order.reference}`,
    send_email_receipt: false,
    show_description: true,
    show_line_items: true,
    metadata: { orin_order_id: order.id },
  };
}

export async function createPayMongoCheckout(projectId: string, accessToken: string, workspaceId: string, order: CommerceOrder) {
  if (order.quoteOnly || order.unitPriceCentavos < 100 || order.quantity < 1) throw new Error('ORDER_NOT_PAYABLE');
  const credential = await loadPayMongoCredential(projectId, accessToken, workspaceId);
  const response = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${credential.secretKey}:`)}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `orin-${order.id}`,
    },
    body: JSON.stringify({ data: { attributes: checkoutAttributes(order) } }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as { data?: { id?: string; attributes?: { checkout_url?: string } }; errors?: Array<{ detail?: string }> };
  const sessionId = clean(payload.data?.id, 160);
  const checkoutUrl = clean(payload.data?.attributes?.checkout_url, 1_000);
  if (!response.ok || !sessionId || !checkoutUrl) throw new Error(response.status === 401 ? 'PAYMONGO_REJECTED_CREDENTIALS' : 'PAYMONGO_CHECKOUT_FAILED');
  const parsed = new URL(checkoutUrl);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('paymongo.com')) throw new Error('PAYMONGO_CHECKOUT_INVALID');
  const routeId = `paymongo_${await stableId('paymongo-checkout', sessionId)}`;
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, `paymentRoutes/${routeId}`), fields: {
      provider: stringValue('paymongo'), workspaceId: stringValue(workspaceId), orderId: stringValue(order.id), sessionId: stringValue(sessionId), active: booleanValue(true), createdAt: timestampValue(now), updatedAt: timestampValue(now),
    } } },
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/orders/${order.id}`), fields: {
      status: stringValue('pending_payment'), paymentMethod: stringValue('paymongo_qrph'), checkoutSessionHash: stringValue(await stableId('checkout-session', sessionId)), checkoutCreatedAt: timestampValue(now),
    } }, updateMask: { fieldPaths: ['status', 'paymentMethod', 'checkoutSessionHash', 'checkoutCreatedAt'] }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: true } },
  ]);
  return { sessionId, checkoutUrl, credential };
}

export async function verifyPayMongoSignature(rawBody: Uint8Array, header: string, secret: string, liveMode: boolean, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const direct = /^[0-9a-f]{64}$/i.test(header) ? header : '';
  const parts = Object.fromEntries(header.split(',').map((part) => part.trim().split('=', 2)).filter((part) => part.length === 2)) as Record<string, string>;
  const timestamp = parts.t || '';
  const supplied = direct || (liveMode ? parts.li : parts.te) || '';
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;
  if (timestamp && (!/^\d{9,12}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 5 * 60)) return false;
  const content = timestamp ? `${timestamp}.${decoder.decode(rawBody)}` : decoder.decode(rawBody);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(content)));
  const suppliedBytes = Uint8Array.from(supplied.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
  if (expected.length !== suppliedBytes.length) return false;
  let mismatch = 0;
  expected.forEach((byte, index) => { mismatch |= byte ^ suppliedBytes[index]; });
  return mismatch === 0;
}

export function extractPaidCheckout(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const root = payload as Body;
  const envelope = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Body : {};
  const attributes = envelope.attributes && typeof envelope.attributes === 'object' && !Array.isArray(envelope.attributes) ? envelope.attributes as Body : {};
  const eventType = clean(attributes.type || envelope.type, 120);
  if (eventType !== 'checkout_session.payment.paid') return null;
  const resourceValue = attributes.data || envelope.data;
  if (!resourceValue || typeof resourceValue !== 'object' || Array.isArray(resourceValue)) return null;
  const resource = resourceValue as Body;
  const resourceAttributes = resource.attributes && typeof resource.attributes === 'object' && !Array.isArray(resource.attributes) ? resource.attributes as Body : {};
  const sessionId = clean(resource.id, 160);
  if (!sessionId) return null;
  return {
    sessionId,
    eventId: clean(envelope.id || root.id, 160),
    liveMode: attributes.livemode === true || envelope.livemode === true,
    reference: clean(resourceAttributes.reference_number, 120),
  };
}

type MetaVault = { provider?: string; graphVersion?: string; pages?: Array<{ id?: string; accessToken?: string }> };

async function sendPaidConfirmation(projectId: string, accessToken: string, workspaceId: string, order: CommerceOrder) {
  if (!order.conversationId) return false;
  const [route, vault] = await Promise.all([
    getDocument(projectId, accessToken, `conversationRoutes/meta_${order.conversationId}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/meta`),
  ]);
  const pageId = fieldString(route, 'providerAccountId');
  const userId = fieldString(route, 'providerUserId');
  if (!pageId || !userId || !vault) return false;
  const credential = await decryptJson<MetaVault>(fieldString(vault, 'ciphertext'), fieldString(vault, 'iv'), process.env.CONNECTOR_ENCRYPTION_KEY || '');
  const page = credential.pages?.find((candidate) => candidate.id === pageId);
  if (credential.provider !== 'meta' || !/^v\d+\.\d+$/.test(credential.graphVersion || '') || !page?.accessToken) return false;
  const text = `Payment confirmed for ${order.reference}. Thank you—your order is now recorded and the team can begin processing it.`;
  const response = await fetch(`https://graph.facebook.com/${credential.graphVersion}/${encodeURIComponent(pageId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${page.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMessengerText(userId, text)),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({})) as { message_id?: string };
  if (!response.ok || !result.message_id) return false;
  const messageId = await stableId('commerce-paid-message', workspaceId, order.id);
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/conversations/${order.conversationId}/messages/${messageId}`), fields: {
      body: stringValue(text), senderType: stringValue('agent'), senderName: stringValue('ORIN AI'), provider: stringValue('meta'), channel: stringValue('Messenger'), sentAt: timestampValue(now), externalIdHash: stringValue(await stableId('meta-provider-message', result.message_id)),
    } }, currentDocument: { exists: false } },
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/conversations/${order.conversationId}`), fields: { preview: stringValue(text.slice(0, 180)) } }, updateMask: { fieldPaths: ['preview'] }, updateTransforms: [{ fieldPath: 'lastMessageAt', setToServerValue: 'REQUEST_TIME' }, { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: true } },
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/orders/${order.id}`), fields: { confirmationSent: booleanValue(true) } }, updateMask: { fieldPaths: ['confirmationSent'] }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: true } },
  ]).catch(() => false);
  return true;
}

export async function confirmOrderPaid(projectId: string, accessToken: string, workspaceId: string, orderId: string, source: 'paymongo_qrph' | 'gcash_manual', evidence: string) {
  const orderDocument = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/orders/${orderId}`);
  const order = commerceOrderFromDocument(orderDocument);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status === 'paid') return { order, alreadyPaid: true, confirmationSent: false };
  const allowed = source === 'paymongo_qrph' ? order.status === 'pending_payment' : order.status === 'pending_gcash';
  if (!allowed) throw new Error('ORDER_STATUS_INVALID');
  const eventId = await stableId('commerce-payment', workspaceId, orderId, source, evidence);
  const now = new Date().toISOString();
  const saved = await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/providerEvents/payment_${eventId}`), fields: { provider: stringValue(source === 'paymongo_qrph' ? 'paymongo' : 'gcash'), type: stringValue('order.paid'), sourceEventHash: stringValue(eventId), receivedAt: timestampValue(now) } }, currentDocument: { exists: false } },
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/orders/${orderId}`), fields: { status: stringValue('paid'), paymentMethod: stringValue(source), paidAt: timestampValue(now), paymentEvidenceHash: stringValue(await stableId('payment-evidence', evidence)) } }, updateMask: { fieldPaths: ['status', 'paymentMethod', 'paidAt', 'paymentEvidenceHash'] }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: true } },
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/events/order_paid_${eventId}`), fields: { type: stringValue('order.paid'), provider: stringValue(source === 'paymongo_qrph' ? 'paymongo' : 'gcash'), channel: stringValue('Messenger'), conversationId: stringValue(order.conversationId), contactId: stringValue(order.contactId), occurredAt: timestampValue(now), value: integerValue(order.totalCentavos) } }, currentDocument: { exists: false } },
  ], true);
  const confirmationSent = saved ? await sendPaidConfirmation(projectId, accessToken, workspaceId, { ...order, status: 'paid' }).catch(() => false) : false;
  return { order: { ...order, status: 'paid' }, alreadyPaid: !saved, confirmationSent };
}

export async function handleCommerce(req: CommerceRequest, action: string) {
  if (req.method !== 'POST') throw new Error('METHOD_NOT_ALLOWED');
  const body = bodyOf(req);
  const account = await verifyFirebaseAccount(req);
  const { projectId, accessToken } = await googleAccessToken();
  const workspaceId = safeId(body.workspaceId);
  if (!workspaceId) throw new Error('INVALID_REQUEST');
  const adminOnly = ['disconnect', 'item_delete'].includes(action);
  await requireWorkspaceRole(projectId, accessToken, workspaceId, account.localId, adminOnly ? ['owner', 'admin'] : ['owner', 'admin', 'editor']);
  const now = new Date().toISOString();

  if (action === 'connect') {
    const credential = validatePayMongoCredential(body);
    await testPayMongoSecret(credential.secretKey);
    const encrypted = await encryptJson(credential, process.env.CONNECTOR_ENCRYPTION_KEY || '');
    await commitWrites(projectId, accessToken, [
      { update: { name: documentName(projectId, `workspaces/${workspaceId}/connectorVault/paymongo`), fields: { provider: stringValue('paymongo'), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), updatedAt: timestampValue(now) } } },
      { update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/paymongo`), fields: {
        provider: stringValue('paymongo'), displayName: stringValue('PayMongo QRPh'), status: stringValue('connected'), health: stringValue('healthy'), credentialState: stringValue('stored_server_side'), mode: stringValue(credential.liveMode ? 'live' : 'test'), qrphEnabled: booleanValue(true), nativeGcashEnabled: booleanValue(Boolean(credential.gcashNumber)), gcashAccountHint: stringValue(credential.gcashNumber ? `${credential.gcashNumber.slice(0, 4)}••••${credential.gcashNumber.slice(-3)}` : ''), connectedBy: stringValue(account.localId), connectionTestedAt: timestampValue(now), updatedAt: timestampValue(now),
      } } },
    ]);
    return { ok: true, connected: true, mode: credential.liveMode ? 'live' : 'test', nativeGcashEnabled: Boolean(credential.gcashNumber) };
  }

  if (action === 'disconnect') {
    await commitWrites(projectId, accessToken, [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/paymongo`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/paymongo`) },
    ]);
    return { ok: true, disconnected: true };
  }

  if (action === 'item_upsert') {
    const item = validateCatalogInput(body.item);
    const suppliedId = safeId((body.item as Body)?.id);
    const itemId = suppliedId || `item_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/catalogItems/${itemId}`), fields: {
      name: stringValue(item.name), kind: stringValue(item.kind), description: stringValue(item.description), priceCentavos: integerValue(item.priceCentavos), quoteOnly: booleanValue(item.quoteOnly), stock: integerValue(item.stock), variants: stringArrayValue(item.variants), imageUrl: stringValue(item.imageUrl), active: booleanValue(item.active), updatedBy: stringValue(account.localId), updatedAt: timestampValue(now),
    } } }]);
    return { ok: true, itemId };
  }

  if (action === 'item_delete') {
    const itemId = safeId(body.itemId);
    if (!itemId) throw new Error('INVALID_REQUEST');
    await commitWrites(projectId, accessToken, [{ delete: documentName(projectId, `workspaces/${workspaceId}/catalogItems/${itemId}`) }]);
    return { ok: true, itemId, deleted: true };
  }

  if (action === 'mark_paid') {
    const orderId = safeId(body.orderId);
    if (!orderId) throw new Error('INVALID_REQUEST');
    const result = await confirmOrderPaid(projectId, accessToken, workspaceId, orderId, 'gcash_manual', `${account.localId}:${now}`);
    return { ok: true, paid: true, confirmationSent: result.confirmationSent };
  }

  throw new Error('INVALID_REQUEST');
}
