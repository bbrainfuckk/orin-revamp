type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  send: (payload: string) => void;
  json: (payload: unknown) => void;
};

type FirestoreValue = {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
};
type FirestoreDocument = { name?: string; fields?: Record<string, FirestoreValue> };
type FirestoreList = { documents?: FirestoreDocument[] };
type GoogleTokenResponse = { access_token?: string };

type MetaMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: Array<{ type?: string }>;
  };
  postback?: { mid?: string; title?: string; payload?: string };
  referral?: unknown;
};

type MetaLeadChange = {
  field?: string;
  value?: {
    leadgen_id?: string;
    page_id?: string;
    form_id?: string;
    created_time?: number;
  };
};

type MetaEntry = {
  id?: string;
  time?: number;
  messaging?: MetaMessagingEvent[];
  changes?: MetaLeadChange[];
};

export type MetaWebhookPayload = {
  object?: string;
  entry?: MetaEntry[];
};

export type NormalizedProviderEvent = {
  id: string;
  type: 'message.received' | 'lead.captured';
  provider: 'meta';
  channel: 'Messenger' | 'Instagram' | 'Facebook Lead';
  routeId: string;
  contactId: string;
  contactName: string;
  conversationId?: string;
  messageId?: string;
  body?: string;
  preview?: string;
  providerAccountId?: string;
  providerUserId?: string;
  occurredAt: string;
};

type RoutedEvent = NormalizedProviderEvent & { workspaceId: string };
type TriggerEvent = Omit<RoutedEvent, 'type'> & { type: 'conversation.started' | 'lead.captured' };

type N8nContext = {
  desiredChannels: string[];
  healthy: boolean;
  webhookUrl: string;
  signingSecret: string;
  automations: Array<{ id: string; trigger: string }>;
};

export const config = { api: { bodyParser: false } };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function stringQuery(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function headerValue(req: ApiRequest, name: string) {
  const value = req.headers?.[name] || req.headers?.[name.toLowerCase()];
  return stringQuery(value);
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) mismatch |= leftBytes[index] ^ rightBytes[index];
  return mismatch === 0;
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return new Uint8Array();
  return Uint8Array.from(value.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
}

function bytesToHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function stableId(...parts: string[]) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(parts.join('\u001f')));
  return bytesToBase64Url(new Uint8Array(digest)).slice(0, 40);
}

function safeDate(value: number | undefined, seconds = false) {
  const milliseconds = typeof value === 'number' && Number.isFinite(value)
    ? (seconds ? value * 1000 : value)
    : Date.now();
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum) : '';
}

function attachmentSummary(attachments: Array<{ type?: string }> | undefined) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const labels = attachments
    .map((attachment) => cleanText((attachment as { type?: string }).type, 30).toLowerCase())
    .filter(Boolean)
    .map((type) => type === 'image' ? 'photo' : type);
  return labels.length ? `Shared ${labels.join(', ')}` : 'Shared an attachment';
}

async function normalizeMessage(object: string, entry: MetaEntry, event: MetaMessagingEvent, index: number) {
  if (event.message?.is_echo) return null;
  const accountId = cleanText(entry.id || event.recipient?.id, 128);
  const senderId = cleanText(event.sender?.id, 128);
  if (!accountId || !senderId || (!event.message && !event.postback && !event.referral)) return null;

  const channel: 'Instagram' | 'Messenger' = object === 'instagram' ? 'Instagram' : 'Messenger';
  const accountType = object === 'instagram' ? 'instagram' : 'page';
  const body = cleanText(event.message?.text, 4_000)
    || attachmentSummary(event.message?.attachments)
    || cleanText(event.postback?.title || event.postback?.payload, 4_000)
    || (event.referral ? 'Opened a referral' : '');
  if (!body) return null;

  const occurredAt = safeDate(event.timestamp || entry.time);
  const externalEventKey = cleanText(event.message?.mid || event.postback?.mid, 512)
    || `${accountId}:${senderId}:${occurredAt}:${index}:${body}`;
  const id = await stableId('meta-event', accountId, externalEventKey);
  const contactId = await stableId('contact', 'meta', channel, senderId);
  const conversationId = await stableId('conversation', 'meta', accountId, senderId);
  const messageId = await stableId('message', 'meta', externalEventKey);
  return {
    id,
    type: 'message.received' as const,
    provider: 'meta' as const,
    channel,
    routeId: `meta_${accountType}_${accountId}`,
    contactId,
    contactName: `${channel} customer`,
    conversationId,
    messageId,
    body,
    preview: body.slice(0, 180),
    providerAccountId: accountId,
    providerUserId: senderId,
    occurredAt,
  };
}

async function normalizeLead(entry: MetaEntry, change: MetaLeadChange) {
  if (change.field !== 'leadgen') return null;
  const leadId = cleanText(change.value?.leadgen_id, 256);
  const pageId = cleanText(change.value?.page_id || entry.id, 128);
  if (!leadId || !pageId) return null;
  return {
    id: await stableId('meta-lead', pageId, leadId),
    type: 'lead.captured' as const,
    provider: 'meta' as const,
    channel: 'Facebook Lead' as const,
    routeId: `meta_page_${pageId}`,
    contactId: await stableId('contact', 'meta', 'lead', leadId),
    contactName: 'Facebook lead',
    occurredAt: safeDate(change.value?.created_time || entry.time, Boolean(change.value?.created_time)),
  };
}

export async function normalizeMetaPayload(payload: MetaWebhookPayload) {
  const object = cleanText(payload.object, 40).toLowerCase();
  if (!['page', 'instagram'].includes(object) || !Array.isArray(payload.entry)) throw new Error('INVALID_META_PAYLOAD');
  const normalized: NormalizedProviderEvent[] = [];
  for (const entry of payload.entry) {
    for (const [index, event] of (entry.messaging || []).entries()) {
      const message = await normalizeMessage(object, entry, event, index);
      if (message) normalized.push(message);
      if (normalized.length > 100) throw new Error('EVENT_LIMIT');
    }
    for (const change of entry.changes || []) {
      const lead = await normalizeLead(entry, change);
      if (lead) normalized.push(lead);
      if (normalized.length > 100) throw new Error('EVENT_LIMIT');
    }
  }
  return normalized;
}

async function readRawBody(req: ApiRequest) {
  if (typeof req.body === 'string') return encoder.encode(req.body);
  if (req.body instanceof Uint8Array) return req.body;
  if (typeof req[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of req as ApiRequest & AsyncIterable<Uint8Array>) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      length += bytes.byteLength;
      if (length > 1_000_000) throw new Error('PAYLOAD_TOO_LARGE');
      chunks.push(bytes);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    chunks.forEach((chunk) => { body.set(chunk, offset); offset += chunk.byteLength; });
    return body;
  }
  throw new Error('RAW_BODY_UNAVAILABLE');
}

async function validSignature(rawBody: Uint8Array, signatureHeader: string, appSecret: string) {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const signature = hexToBytes(signatureHeader.slice('sha256='.length));
  if (signature.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const body = new Uint8Array(rawBody.byteLength);
  body.set(rawBody);
  return crypto.subtle.verify('HMAC', key, signature, body.buffer);
}

async function googleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'orin-ai-502503';
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error('FIREBASE_ADMIN_NOT_CONFIGURED');

  const privateKeyBody = rawPrivateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKeyBody),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (process.env.FIREBASE_PRIVATE_KEY_ID) header.kid = process.env.FIREBASE_PRIVATE_KEY_ID;
  const claims = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
    iat: now,
    exp: now + 3_300,
  };
  const unsigned = `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.${bytesToBase64Url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, encoder.encode(unsigned));
  const assertion = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token) throw new Error('FIREBASE_ADMIN_AUTH_FAILED');
  return { accessToken: payload.access_token, projectId };
}

const stringValue = (value: string): FirestoreValue => ({ stringValue: value });
const integerValue = (value: number): FirestoreValue => ({ integerValue: String(Math.trunc(value)) });
const timestampValue = (value: string): FirestoreValue => ({ timestampValue: value });
const stringArrayValue = (values: string[]): FirestoreValue => ({ arrayValue: { values: values.map(stringValue) } });

function fieldString(document: FirestoreDocument | null, name: string) {
  return document?.fields?.[name]?.stringValue || '';
}

function fieldBoolean(document: FirestoreDocument | null, name: string) {
  return document?.fields?.[name]?.booleanValue === true;
}

function fieldStringArray(document: FirestoreDocument | null, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || [])
    .map((value) => value.stringValue || '')
    .filter(Boolean);
}

function encodedDocumentPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function documentName(projectId: string, path: string) {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}

async function getDocument(projectId: string, accessToken: string, path: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedDocumentPath(path)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`FIRESTORE_READ_FAILED:${response.status}`);
  return response.json() as Promise<FirestoreDocument>;
}

async function listDocuments(projectId: string, accessToken: string, path: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedDocumentPath(path)}?pageSize=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`FIRESTORE_LIST_FAILED:${response.status}`);
  return ((await response.json()) as FirestoreList).documents || [];
}

async function commitWrites(projectId: string, accessToken: string, writes: unknown[]) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 409) return false;
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`FIRESTORE_COMMIT_FAILED:${response.status}:${payload.slice(0, 180)}`);
  }
  return true;
}

async function lookupRoute(projectId: string, accessToken: string, routeId: string) {
  const document = await getDocument(projectId, accessToken, `connectorRoutes/${routeId}`);
  const workspaceId = fieldString(document, 'workspaceId');
  if (!document || !workspaceId || !fieldBoolean(document, 'active')) return '';
  return workspaceId;
}

async function persistMessage(projectId: string, accessToken: string, event: RoutedEvent) {
  if (!event.conversationId || !event.messageId || !event.body || !event.preview || !event.providerAccountId || !event.providerUserId) return { accepted: false, started: false };
  const workspaceBase = `workspaces/${event.workspaceId}`;
  const providerEventName = documentName(projectId, `${workspaceBase}/providerEvents/${event.id}`);
  const contactName = documentName(projectId, `${workspaceBase}/contacts/${event.contactId}`);
  const conversationName = documentName(projectId, `${workspaceBase}/conversations/${event.conversationId}`);
  const messageName = documentName(projectId, `${workspaceBase}/conversations/${event.conversationId}/messages/${event.messageId}`);
  const receivedEventName = documentName(projectId, `${workspaceBase}/events/received_${event.id}`);
  const accepted = await commitWrites(projectId, accessToken, [
    {
      update: { name: providerEventName, fields: {
        provider: stringValue(event.provider),
        type: stringValue(event.type),
        sourceEventHash: stringValue(event.id),
        receivedAt: timestampValue(new Date().toISOString()),
      } },
      currentDocument: { exists: false },
    },
    {
      update: { name: contactName, fields: {
        name: stringValue(event.contactName),
        handle: stringValue(''),
        sourceProvider: stringValue(event.provider),
        lastSeenAt: timestampValue(event.occurredAt),
      } },
      updateMask: { fieldPaths: ['name', 'handle', 'sourceProvider', 'lastSeenAt'] },
      updateTransforms: [
        { fieldPath: 'channels', appendMissingElements: { values: [stringValue(event.channel)] } },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    },
    {
      update: { name: conversationName, fields: {
        contactId: stringValue(event.contactId),
        contactName: stringValue(event.contactName),
        channel: stringValue(event.channel),
        sourceProvider: stringValue(event.provider),
        preview: stringValue(event.preview),
        status: stringValue('open'),
      } },
      updateMask: { fieldPaths: ['contactId', 'contactName', 'channel', 'sourceProvider', 'preview', 'status'] },
      updateTransforms: [
        { fieldPath: 'unreadCount', increment: integerValue(1) },
        { fieldPath: 'lastMessageAt', setToServerValue: 'REQUEST_TIME' },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    },
    {
      update: { name: documentName(projectId, `conversationRoutes/meta_${event.conversationId}`), fields: {
        provider: stringValue('meta'),
        channel: stringValue(event.channel),
        workspaceId: stringValue(event.workspaceId),
        providerAccountId: stringValue(event.providerAccountId),
        providerUserId: stringValue(event.providerUserId),
        connectorRouteId: stringValue(event.routeId),
        active: { booleanValue: true },
        lastInboundAt: timestampValue(event.occurredAt),
      } },
      updateMask: { fieldPaths: ['provider', 'channel', 'workspaceId', 'providerAccountId', 'providerUserId', 'connectorRouteId', 'active', 'lastInboundAt'] },
      updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
    },
    {
      update: { name: messageName, fields: {
        body: stringValue(event.body),
        senderType: stringValue('customer'),
        senderName: stringValue(event.contactName),
        provider: stringValue(event.provider),
        channel: stringValue(event.channel),
        externalIdHash: stringValue(event.id),
        sentAt: timestampValue(event.occurredAt),
      } },
      currentDocument: { exists: false },
    },
    {
      update: { name: receivedEventName, fields: {
        type: stringValue('message.received'),
        provider: stringValue(event.provider),
        channel: stringValue(event.channel),
        conversationId: stringValue(event.conversationId),
        contactId: stringValue(event.contactId),
        occurredAt: timestampValue(event.occurredAt),
        value: integerValue(0),
      } },
      currentDocument: { exists: false },
    },
  ]);
  const started = await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, `${workspaceBase}/events/conversation_${event.conversationId}`), fields: {
      type: stringValue('conversation.started'),
      provider: stringValue(event.provider),
      channel: stringValue(event.channel),
      conversationId: stringValue(event.conversationId),
      contactId: stringValue(event.contactId),
      occurredAt: timestampValue(event.occurredAt),
      value: integerValue(0),
    } },
    currentDocument: { exists: false },
  }]);
  return { accepted, started };
}

async function persistLead(projectId: string, accessToken: string, event: RoutedEvent) {
  const workspaceBase = `workspaces/${event.workspaceId}`;
  return commitWrites(projectId, accessToken, [
    {
      update: { name: documentName(projectId, `${workspaceBase}/providerEvents/${event.id}`), fields: {
        provider: stringValue(event.provider),
        type: stringValue(event.type),
        sourceEventHash: stringValue(event.id),
        receivedAt: timestampValue(new Date().toISOString()),
      } },
      currentDocument: { exists: false },
    },
    {
      update: { name: documentName(projectId, `${workspaceBase}/contacts/${event.contactId}`), fields: {
        name: stringValue(event.contactName),
        handle: stringValue(''),
        sourceProvider: stringValue(event.provider),
        lastSeenAt: timestampValue(event.occurredAt),
      } },
      updateMask: { fieldPaths: ['name', 'handle', 'sourceProvider', 'lastSeenAt'] },
      updateTransforms: [
        { fieldPath: 'channels', appendMissingElements: { values: [stringValue(event.channel)] } },
        { fieldPath: 'tags', appendMissingElements: { values: [stringValue('Lead')] } },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
    },
    {
      update: { name: documentName(projectId, `${workspaceBase}/events/lead_${event.id}`), fields: {
        type: stringValue('lead.captured'),
        provider: stringValue(event.provider),
        channel: stringValue(event.channel),
        conversationId: stringValue(''),
        contactId: stringValue(event.contactId),
        occurredAt: timestampValue(event.occurredAt),
        value: integerValue(0),
      } },
      currentDocument: { exists: false },
    },
  ]);
}

async function markMetaHealthy(projectId: string, accessToken: string, workspaceId: string) {
  const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/meta`);
  const fullySubscribed = fieldString(connection, 'subscriptionStatus') === 'subscribed';
  return commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/meta`), fields: {
      status: stringValue(fullySubscribed ? 'connected' : 'attention_required'),
      health: stringValue(fullySubscribed ? 'healthy' : 'subscription_partial'),
      webhookVerified: { booleanValue: true },
    } },
    updateMask: { fieldPaths: ['status', 'health', 'webhookVerified'] },
    updateTransforms: [
      { fieldPath: 'lastWebhookAt', setToServerValue: 'REQUEST_TIME' },
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
    currentDocument: { exists: true },
  }]);
}

async function decryptN8nCredential(document: FirestoreDocument | null) {
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  const ciphertext = fieldString(document, 'ciphertext');
  const iv = fieldString(document, 'iv');
  const keyBytes = base64ToBytes(encryptionKey.trim());
  if (!document || keyBytes.byteLength !== 32 || !ciphertext || !iv) return null;
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext));
  const value = JSON.parse(decoder.decode(plaintext)) as { provider?: string; deployment?: string; webhookUrl?: string; signingSecret?: string };
  if (value.provider !== 'n8n' || value.deployment !== 'n8n_cloud' || !value.webhookUrl || !value.signingSecret) return null;
  const webhook = new URL(value.webhookUrl);
  if (webhook.protocol !== 'https:' || (webhook.hostname !== 'n8n.cloud' && !webhook.hostname.endsWith('.n8n.cloud')) || !webhook.pathname.startsWith('/webhook/')) return null;
  return { webhookUrl: webhook.toString(), signingSecret: value.signingSecret };
}

async function loadN8nContext(projectId: string, accessToken: string, workspaceId: string): Promise<N8nContext> {
  const [connection, vault, automationDocuments] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/n8n`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/n8n`),
    listDocuments(projectId, accessToken, `workspaces/${workspaceId}/automations`),
  ]);
  const credential = await decryptN8nCredential(vault).catch(() => null);
  const automations = automationDocuments
    .filter((document) => fieldString(document, 'status') === 'active' && fieldString(document, 'action') === 'Send to n8n')
    .map((document) => ({
      id: (document.name || '').split('/').pop() || '',
      trigger: fieldString(document, 'trigger'),
    }))
    .filter((automation) => automation.id && automation.trigger);
  return {
    desiredChannels: fieldStringArray(connection, 'desiredChannels'),
    healthy: fieldString(connection, 'status') === 'connected' && fieldString(connection, 'health') === 'healthy' && Boolean(credential),
    webhookUrl: credential?.webhookUrl || '',
    signingSecret: credential?.signingSecret || '',
    automations,
  };
}

const triggerMap: Record<TriggerEvent['type'], { integration: string; automation: string }> = {
  'conversation.started': { integration: 'New conversation', automation: 'New conversation' },
  'lead.captured': { integration: 'Lead captured', automation: 'Lead captured' },
};

async function recordAutomationRun(
  projectId: string,
  accessToken: string,
  event: TriggerEvent,
  status: 'succeeded' | 'failed',
  automationIds: string[],
  responseStatus: number,
  error: string,
) {
  const runId = await stableId('automation-run', event.id, 'n8n');
  await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, `workspaces/${event.workspaceId}/automationRuns/${runId}`), fields: {
      eventId: stringValue(event.id),
      eventType: stringValue(event.type),
      destination: stringValue('n8n'),
      status: stringValue(status),
      automationIds: stringArrayValue(automationIds),
      responseStatus: integerValue(responseStatus),
      error: stringValue(error.slice(0, 240)),
      occurredAt: timestampValue(event.occurredAt),
      updatedAt: timestampValue(new Date().toISOString()),
    } },
  }]);
}

async function deliverToN8n(
  projectId: string,
  accessToken: string,
  event: TriggerEvent,
  contextPromise: Promise<N8nContext>,
) {
  const context = await contextPromise;
  const labels = triggerMap[event.type];
  const automationIds = context.automations
    .filter((automation) => automation.trigger === labels.automation)
    .map((automation) => automation.id);
  const subscribed = context.desiredChannels.includes(labels.integration) || automationIds.length > 0;
  if (!subscribed) return;
  if (!context.healthy) {
    await recordAutomationRun(projectId, accessToken, event, 'failed', automationIds, 0, 'n8n connection is not healthy');
    return;
  }

  const body = JSON.stringify({
    id: event.id,
    event: event.type,
    source: 'ORIN AI',
    workspace_id: event.workspaceId,
    occurred_at: event.occurredAt,
    channel: event.channel,
    contact: { id: event.contactId, name: event.contactName },
    conversation: event.conversationId ? { id: event.conversationId, preview: event.preview || '' } : null,
    data: event.body ? { message: event.body } : {},
    automation_ids: automationIds,
  });
  const key = await crypto.subtle.importKey('raw', encoder.encode(context.signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))));
  try {
    const delivery = await fetch(context.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ORIN-AI-Automation/1.0',
        'X-ORIN-Event': event.type,
        'X-ORIN-Delivery': event.id,
        'X-ORIN-Signature-256': `sha256=${signature}`,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    await recordAutomationRun(
      projectId,
      accessToken,
      event,
      delivery.ok ? 'succeeded' : 'failed',
      automationIds,
      delivery.status,
      delivery.ok ? '' : `n8n returned HTTP ${delivery.status}`,
    );
  } catch (cause) {
    const message = cause instanceof Error && cause.name === 'TimeoutError' ? 'n8n timed out' : 'n8n delivery failed';
    await recordAutomationRun(projectId, accessToken, event, 'failed', automationIds, 0, message);
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
  const appSecret = process.env.META_APP_SECRET || '';

  if (req.method === 'GET') {
    const mode = stringQuery(req.query?.['hub.mode']);
    const token = stringQuery(req.query?.['hub.verify_token']);
    const challenge = stringQuery(req.query?.['hub.challenge']);
    if (verifyToken && mode === 'subscribe' && challenge && constantTimeEqual(token, verifyToken)) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Webhook verification failed');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!appSecret || !verifyToken) return res.status(503).json({ ok: false, error: 'Meta webhooks are not configured' });

  try {
    const rawBody = await readRawBody(req);
    if (!(await validSignature(rawBody, headerValue(req, 'x-hub-signature-256'), appSecret))) {
      return res.status(401).json({ ok: false, error: 'Invalid webhook signature' });
    }
    const payload = JSON.parse(decoder.decode(rawBody)) as MetaWebhookPayload;
    const normalized = await normalizeMetaPayload(payload);
    if (!normalized.length) return res.status(200).send('EVENT_RECEIVED');

    const { accessToken, projectId } = await googleAccessToken();
    const routeCache = new Map<string, Promise<string>>();
    const healthyWorkspaces = new Set<string>();
    const triggered: TriggerEvent[] = [];
    for (const event of normalized) {
      if (!routeCache.has(event.routeId)) routeCache.set(event.routeId, lookupRoute(projectId, accessToken, event.routeId));
      const workspaceId = await routeCache.get(event.routeId)!;
      if (!workspaceId) continue;
      const routed = { ...event, workspaceId };
      if (event.type === 'message.received') {
        const result = await persistMessage(projectId, accessToken, routed);
        healthyWorkspaces.add(workspaceId);
        if (result.started) triggered.push({ ...routed, type: 'conversation.started' });
      } else {
        const accepted = await persistLead(projectId, accessToken, routed);
        healthyWorkspaces.add(workspaceId);
        if (accepted) triggered.push(routed as TriggerEvent);
      }
    }

    await Promise.allSettled([...healthyWorkspaces].map((workspaceId) => markMetaHealthy(projectId, accessToken, workspaceId)));
    const n8nContexts = new Map<string, Promise<N8nContext>>();
    await Promise.allSettled(triggered.map((event) => {
      if (!n8nContexts.has(event.workspaceId)) n8nContexts.set(event.workspaceId, loadN8nContext(projectId, accessToken, event.workspaceId));
      return deliverToN8n(projectId, accessToken, event, n8nContexts.get(event.workspaceId)!);
    }));
    return res.status(200).send('EVENT_RECEIVED');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'PAYLOAD_TOO_LARGE' || message === 'EVENT_LIMIT') {
      return res.status(413).json({ ok: false, error: 'Webhook payload is too large' });
    }
    if (message === 'INVALID_META_PAYLOAD') return res.status(400).json({ ok: false, error: 'Invalid Meta webhook payload' });
    if (message === 'FIREBASE_ADMIN_NOT_CONFIGURED' || message === 'FIREBASE_ADMIN_AUTH_FAILED') {
      return res.status(503).json({ ok: false, error: 'Webhook storage is not configured' });
    }
    console.error('Meta webhook processing failed', cause);
    return res.status(500).json({ ok: false, error: 'Meta webhook could not be processed' });
  }
}
