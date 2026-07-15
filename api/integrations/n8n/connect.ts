import { waitUntil } from '@vercel/functions';
import { deliverAutomationEvent } from '../../../server/n8n-delivery';

type ConnectBody = {
  workspaceId?: string;
  webhookUrl?: string;
  displayName?: string;
  desiredChannels?: unknown;
};

type OutcomeBody = {
  type?: unknown;
  externalId?: unknown;
  amount?: unknown;
  currency?: unknown;
  occurredAt?: unknown;
  conversationId?: unknown;
  contactId?: unknown;
};

type FirestoreValue = {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
};

type FirestoreDocument = { name?: string; fields?: Record<string, FirestoreValue> };

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: ConnectBody | OutcomeBody | string;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

type FirebaseAccountLookup = { users?: Array<{ localId?: string; disabled?: boolean }> };
type GoogleTokenResponse = { access_token?: string };

const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY
  || process.env.VITE_FIREBASE_API_KEY
  || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk';
const encoder = new TextEncoder();
const outcomeTokenPrefix = 'orin_out_';
const outcomeEndpoint = 'https://www.orin.work/api/integrations/n8n/outcomes';
const maximumOutcomeAmount = 1_000_000_000;
const allowedEvents = new Set([
  'New conversation',
  'Lead captured',
  'Human escalation',
  'Order or booking attributed',
]);

function bytesToBase64Url(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesToHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function requestBody(req: ApiRequest) {
  try {
    const value = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
    return value as Record<string, unknown>;
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}

function headerValue(req: ApiRequest, name: string) {
  const value = req.headers?.[name] || req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

async function verifyFirebaseRequest(req: ApiRequest) {
  const header = req.headers?.authorization;
  const authorization = Array.isArray(header) ? header[0] : header;
  if (!authorization?.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new Error('UNAUTHENTICATED');

  let response: Response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    throw new Error('AUTH_SERVICE_UNAVAILABLE');
  }
  if (!response.ok) throw new Error('UNAUTHENTICATED');
  const account = ((await response.json()) as FirebaseAccountLookup).users?.[0];
  if (!account?.localId || account.disabled) throw new Error('UNAUTHENTICATED');
  return account.localId;
}

function validateWorkspace(workspaceId: unknown, uid: string) {
  if (workspaceId !== `personal_${uid}`) throw new Error('FORBIDDEN');
  return workspaceId;
}

export function validateN8nCloudWebhook(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('INVALID_WEBHOOK_URL');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('INVALID_WEBHOOK_URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || (hostname !== 'n8n.cloud' && !hostname.endsWith('.n8n.cloud'))
    || !url.pathname.startsWith('/webhook/')
    || url.pathname === '/webhook/'
    || url.hash
  ) throw new Error('INVALID_WEBHOOK_URL');
  return url;
}

function validateSetup(body: ConnectBody) {
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const desiredChannels = Array.isArray(body.desiredChannels)
    ? body.desiredChannels.filter((item): item is string => typeof item === 'string' && allowedEvents.has(item))
    : [];
  if (!displayName || displayName.length > 120 || !desiredChannels.length || desiredChannels.length > allowedEvents.size) {
    throw new Error('INVALID_SETUP');
  }
  return { displayName, desiredChannels: [...new Set(desiredChannels)] };
}

function validInternalId(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('INVALID_OUTCOME');
  return value;
}

export function validateOutcomeBearer(authorization: string) {
  if (!authorization.startsWith('Bearer ')) throw new Error('OUTCOME_UNAUTHENTICATED');
  const token = authorization.slice('Bearer '.length).trim();
  if (!new RegExp(`^${outcomeTokenPrefix}[A-Za-z0-9_-]{43}$`).test(token)) throw new Error('OUTCOME_UNAUTHENTICATED');
  return token;
}

export function validateN8nOutcome(value: unknown, idempotencyHeader: string, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_OUTCOME');
  const body = value as OutcomeBody;
  const idempotencyKey = idempotencyHeader.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(idempotencyKey)) throw new Error('INVALID_IDEMPOTENCY_KEY');
  if (body.type !== 'order' && body.type !== 'booking') throw new Error('INVALID_OUTCOME');
  const externalId = typeof body.externalId === 'string' ? body.externalId.trim() : '';
  if (!externalId || externalId.length > 256) throw new Error('INVALID_OUTCOME');
  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0 || body.amount > maximumOutcomeAmount) throw new Error('INVALID_OUTCOME');
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('INVALID_OUTCOME');

  let occurredAt = new Date(now).toISOString();
  if (body.occurredAt !== undefined && body.occurredAt !== null && body.occurredAt !== '') {
    if (typeof body.occurredAt !== 'string') throw new Error('INVALID_OUTCOME');
    const occurredTime = Date.parse(body.occurredAt);
    if (!Number.isFinite(occurredTime) || occurredTime > now + 5 * 60_000 || occurredTime < now - 366 * 24 * 60 * 60_000) throw new Error('INVALID_OUTCOME');
    occurredAt = new Date(occurredTime).toISOString();
  }

  return {
    type: body.type,
    externalId,
    amount: Math.round(body.amount * 100) / 100,
    currency,
    occurredAt,
    conversationId: validInternalId(body.conversationId),
    contactId: validInternalId(body.contactId),
    idempotencyKey,
  };
}

async function stableId(...parts: string[]) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(parts.join('\u001f')));
  return bytesToBase64Url(new Uint8Array(digest)).slice(0, 40);
}

export function n8nOutcomeEventId(workspaceId: string, idempotencyKey: string) {
  return stableId('n8n-outcome-event', workspaceId, idempotencyKey);
}

async function createOutcomeCredential() {
  const token = `${outcomeTokenPrefix}${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return {
    token,
    routeId: `n8n_out_${await stableId('n8n-outcome-token', token)}`,
    tokenHint: token.slice(-6),
  };
}

async function encryptCredential(payload: unknown, base64Key: string) {
  const keyBytes = base64ToBytes(base64Key.trim());
  if (keyBytes.byteLength !== 32) throw new Error('VAULT_NOT_CONFIGURED');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}

async function googleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'orin-ai-502503';
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error('VAULT_NOT_CONFIGURED');

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
  if (!response.ok || !payload.access_token) throw new Error('VAULT_AUTH_FAILED');
  return { accessToken: payload.access_token, projectId };
}

const stringValue = (value: string): FirestoreValue => ({ stringValue: value });
const booleanValue = (value: boolean): FirestoreValue => ({ booleanValue: value });
const integerValue = (value: number): FirestoreValue => ({ integerValue: String(Math.trunc(value)) });
const doubleValue = (value: number): FirestoreValue => ({ doubleValue: value });
const timestampValue = (value: string): FirestoreValue => ({ timestampValue: value });
const stringArrayValue = (values: string[]): FirestoreValue => ({ arrayValue: { values: values.map(stringValue) } });

function fieldString(document: FirestoreDocument | null, name: string) {
  return document?.fields?.[name]?.stringValue || '';
}

function fieldBoolean(document: FirestoreDocument | null, name: string) {
  return document?.fields?.[name]?.booleanValue === true;
}

function encodedPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function documentName(projectId: string, path: string) {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}

async function getDocument(projectId: string, accessToken: string, path: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath(path)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('VAULT_READ_FAILED');
  return response.json() as Promise<FirestoreDocument>;
}

async function commitWrites(projectId: string, accessToken: string, writes: unknown[], conflictIsDuplicate = false) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
    signal: AbortSignal.timeout(10_000),
  });
  if (conflictIsDuplicate && response.status === 409) return false;
  if (!response.ok) throw new Error('VAULT_WRITE_FAILED');
  return true;
}

async function commitConnection(
  projectId: string,
  accessToken: string,
  workspaceId: string,
  vaultFields: Record<string, unknown>,
  connectionFields: Record<string, unknown>,
  outcomeRouteId: string,
  outcomeRouteFields: Record<string, unknown>,
  previousOutcomeRouteId: string,
) {
  const baseName = documentName(projectId, `workspaces/${workspaceId}`);
  const writes: unknown[] = [
    { update: { name: `${baseName}/connectorVault/n8n`, fields: vaultFields } },
    { update: { name: `${baseName}/connections/n8n`, fields: connectionFields } },
    { update: { name: documentName(projectId, `connectorRoutes/${outcomeRouteId}`), fields: outcomeRouteFields } },
  ];
  if (previousOutcomeRouteId && previousOutcomeRouteId !== outcomeRouteId) {
    writes.push({ delete: documentName(projectId, `connectorRoutes/${previousOutcomeRouteId}`) });
  }
  await commitWrites(projectId, accessToken, writes);
}

async function deleteConnection(projectId: string, accessToken: string, workspaceId: string, outcomeRouteId: string) {
  const baseName = documentName(projectId, `workspaces/${workspaceId}`);
  const writes: unknown[] = [
    { delete: `${baseName}/connectorVault/n8n` },
    { delete: `${baseName}/connections/n8n` },
  ];
  if (outcomeRouteId) writes.push({ delete: documentName(projectId, `connectorRoutes/${outcomeRouteId}`) });
  await commitWrites(projectId, accessToken, writes);
}

async function linkN8nCloud(body: ConnectBody, workspaceId: string, uid: string) {
  const webhook = validateN8nCloudWebhook(body.webhookUrl);
  const setup = validateSetup(body);
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (base64ToBytes(encryptionKey.trim()).byteLength !== 32) throw new Error('VAULT_NOT_CONFIGURED');
  const { accessToken, projectId } = await googleAccessToken();
  const previousConnection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/n8n`);
  const previousOutcomeRouteId = fieldString(previousConnection, 'outcomeRouteId');
  const outcomeCredential = await createOutcomeCredential();
  const now = new Date().toISOString();
  const connectionKey = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const testPayload = JSON.stringify({
    event: 'connection.test',
    source: 'ORIN AI',
    workspace_id: workspaceId,
    sent_at: now,
    data: { message: 'ORIN AI successfully linked this n8n Cloud workflow.' },
  });
  const signatureKey = await crypto.subtle.importKey('raw', encoder.encode(connectionKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', signatureKey, encoder.encode(testPayload))));
  const delivery = await fetch(webhook, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ORIN-AI-Connector/1.0',
      'X-ORIN-Event': 'connection.test',
      'X-ORIN-Signature-256': `sha256=${signature}`,
    },
    body: testPayload,
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  if (!delivery.ok) throw new Error(`WEBHOOK_REJECTED:${delivery.status}`);

  const encrypted = await encryptCredential({
    provider: 'n8n',
    deployment: 'n8n_cloud',
    webhookUrl: webhook.toString(),
    signingSecret: connectionKey,
  }, encryptionKey);
  await commitConnection(projectId, accessToken, workspaceId, {
    provider: stringValue('n8n'),
    ownerId: stringValue(uid),
    ciphertext: stringValue(encrypted.ciphertext),
    iv: stringValue(encrypted.iv),
    encryptionVersion: integerValue(1),
    createdAt: timestampValue(now),
    updatedAt: timestampValue(now),
  }, {
    provider: stringValue('n8n'),
    displayName: stringValue(setup.displayName),
    status: stringValue('connected'),
    authorizationStatus: stringValue('not_required'),
    credentialState: stringValue('stored_server_side'),
    health: stringValue('healthy'),
    deployment: stringValue('n8n_cloud'),
    testedEndpointHost: stringValue(webhook.hostname),
    desiredChannels: stringArrayValue(setup.desiredChannels),
    connectedBy: stringValue(uid),
    lastTestAt: timestampValue(now),
    outcomeConfigured: booleanValue(true),
    outcomeRouteId: stringValue(outcomeCredential.routeId),
    outcomeTokenHint: stringValue(outcomeCredential.tokenHint),
    outcomeTokenCreatedAt: timestampValue(now),
    createdAt: timestampValue(now),
    updatedAt: timestampValue(now),
  }, outcomeCredential.routeId, {
    provider: stringValue('n8n'),
    routeType: stringValue('outcome_ingest'),
    workspaceId: stringValue(workspaceId),
    active: booleanValue(true),
    createdAt: timestampValue(now),
    updatedAt: timestampValue(now),
  }, previousOutcomeRouteId);
  return {
    url: outcomeEndpoint,
    token: outcomeCredential.token,
    tokenHint: outcomeCredential.tokenHint,
    shownOnce: true,
  };
}

async function rotateOutcomeToken(workspaceId: string) {
  const { accessToken, projectId } = await googleAccessToken();
  const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/n8n`);
  if (fieldString(connection, 'status') !== 'connected' || fieldString(connection, 'health') !== 'healthy') throw new Error('N8N_NOT_CONNECTED');
  const previousOutcomeRouteId = fieldString(connection, 'outcomeRouteId');
  const outcomeCredential = await createOutcomeCredential();
  const now = new Date().toISOString();
  const writes: unknown[] = [
    {
      update: {
        name: documentName(projectId, `workspaces/${workspaceId}/connections/n8n`),
        fields: {
          outcomeConfigured: booleanValue(true),
          outcomeRouteId: stringValue(outcomeCredential.routeId),
          outcomeTokenHint: stringValue(outcomeCredential.tokenHint),
          outcomeTokenCreatedAt: timestampValue(now),
          updatedAt: timestampValue(now),
        },
      },
      updateMask: { fieldPaths: ['outcomeConfigured', 'outcomeRouteId', 'outcomeTokenHint', 'outcomeTokenCreatedAt', 'updatedAt'] },
    },
    {
      update: {
        name: documentName(projectId, `connectorRoutes/${outcomeCredential.routeId}`),
        fields: {
          provider: stringValue('n8n'),
          routeType: stringValue('outcome_ingest'),
          workspaceId: stringValue(workspaceId),
          active: booleanValue(true),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now),
        },
      },
    },
  ];
  if (previousOutcomeRouteId && previousOutcomeRouteId !== outcomeCredential.routeId) {
    writes.push({ delete: documentName(projectId, `connectorRoutes/${previousOutcomeRouteId}`) });
  }
  await commitWrites(projectId, accessToken, writes);
  return {
    url: outcomeEndpoint,
    token: outcomeCredential.token,
    tokenHint: outcomeCredential.tokenHint,
    shownOnce: true,
  };
}

async function ingestOutcome(req: ApiRequest, body: Record<string, unknown>) {
  const token = validateOutcomeBearer(headerValue(req, 'authorization'));
  const outcome = validateN8nOutcome(body, headerValue(req, 'idempotency-key'));
  const routeId = `n8n_out_${await stableId('n8n-outcome-token', token)}`;
  const { accessToken, projectId } = await googleAccessToken();
  const route = await getDocument(projectId, accessToken, `connectorRoutes/${routeId}`);
  const workspaceId = fieldString(route, 'workspaceId');
  if (
    !route
    || fieldString(route, 'provider') !== 'n8n'
    || fieldString(route, 'routeType') !== 'outcome_ingest'
    || !fieldBoolean(route, 'active')
    || !/^personal_[A-Za-z0-9_-]{1,128}$/.test(workspaceId)
  ) throw new Error('OUTCOME_UNAUTHENTICATED');

  const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/n8n`);
  if (
    fieldString(connection, 'status') !== 'connected'
    || fieldString(connection, 'health') !== 'healthy'
    || fieldString(connection, 'outcomeRouteId') !== routeId
  ) throw new Error('OUTCOME_UNAUTHENTICATED');

  const [eventId, externalRefHash, idempotencyHash] = await Promise.all([
    n8nOutcomeEventId(workspaceId, outcome.idempotencyKey),
    stableId('n8n-outcome-external', workspaceId, outcome.externalId),
    stableId('n8n-outcome-idempotency', workspaceId, outcome.idempotencyKey),
  ]);
  const receivedAt = new Date().toISOString();
  const created = await commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, `workspaces/${workspaceId}/events/${eventId}`),
      fields: {
        type: stringValue('value.attributed'),
        provider: stringValue('n8n'),
        channel: stringValue('n8n'),
        outcomeType: stringValue(outcome.type),
        conversationId: stringValue(outcome.conversationId),
        contactId: stringValue(outcome.contactId),
        value: doubleValue(outcome.amount),
        currency: stringValue(outcome.currency),
        externalRefHash: stringValue(externalRefHash),
        idempotencyHash: stringValue(idempotencyHash),
        verified: booleanValue(true),
        occurredAt: timestampValue(outcome.occurredAt),
        receivedAt: timestampValue(receivedAt),
      },
    },
    currentDocument: { exists: false },
  }], true);
  if (created) {
    const contact = outcome.contactId
      ? await getDocument(projectId, accessToken, `workspaces/${workspaceId}/contacts/${outcome.contactId}`)
      : null;
    waitUntil(deliverAutomationEvent(projectId, accessToken, {
      id: eventId,
      type: 'value.attributed',
      workspaceId,
      channel: 'n8n',
      contactId: outcome.contactId,
      contactName: fieldString(contact, 'name') || 'Customer',
      conversationId: outcome.conversationId,
      occurredAt: outcome.occurredAt,
    }));
  }
  return {
    accepted: true,
    duplicate: !created,
    eventId,
    outcome: { type: outcome.type, amount: outcome.amount, currency: outcome.currency, occurredAt: outcome.occurredAt },
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const action = queryValue(req.query?.action);

  if (action === 'outcomes' && req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (action !== 'outcomes' && !['POST', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = requestBody(req);
    if (action === 'outcomes') {
      const result = await ingestOutcome(req, body);
      return res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
    }

    const uid = await verifyFirebaseRequest(req);
    const workspaceId = validateWorkspace(body.workspaceId, uid);

    if (action === 'outcome-token') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
      }
      const outcome = await rotateOutcomeToken(workspaceId);
      return res.status(200).json({ ok: true, outcome });
    }

    if (req.method === 'DELETE') {
      const { accessToken, projectId } = await googleAccessToken();
      const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/n8n`);
      await deleteConnection(projectId, accessToken, workspaceId, fieldString(connection, 'outcomeRouteId'));
      return res.status(200).json({ ok: true, status: 'disconnected' });
    }

    const outcome = await linkN8nCloud(body as ConnectBody, workspaceId, uid);
    return res.status(200).json({ ok: true, status: 'connected', deployment: 'n8n_cloud', outcome });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'OUTCOME_UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer realm="ORIN AI n8n outcomes"');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI outcome token is required' });
    }
    if (message === 'INVALID_IDEMPOTENCY_KEY') return res.status(400).json({ ok: false, error: 'Send a unique Idempotency-Key header using letters, numbers, dots, colons, dashes, or underscores.' });
    if (message === 'INVALID_OUTCOME' || (message === 'INVALID_REQUEST' && action === 'outcomes')) return res.status(400).json({ ok: false, error: 'Send a valid order or booking with externalId, positive amount, three-letter currency, and optional ISO occurredAt.' });
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    if (message === 'N8N_NOT_CONNECTED') return res.status(409).json({ ok: false, error: 'Link a healthy n8n Cloud workflow before creating an outcome token.' });
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    if (message === 'INVALID_REQUEST' || message === 'INVALID_SETUP') return res.status(400).json({ ok: false, error: 'Add a workflow name and choose at least one event.' });
    if (message === 'INVALID_WEBHOOK_URL') return res.status(400).json({ ok: false, error: 'Paste a production n8n Cloud URL that contains /webhook/. Test URLs and self-hosted servers are not supported yet.' });
    if (message.startsWith('WEBHOOK_REJECTED:')) return res.status(502).json({ ok: false, error: `The n8n workflow returned HTTP ${message.split(':')[1]}. Make sure the workflow is active.` });
    if (message === 'VAULT_NOT_CONFIGURED' || message === 'VAULT_AUTH_FAILED') return res.status(503).json({ ok: false, error: 'Secure connector storage is not available yet.' });
    if (message === 'VAULT_READ_FAILED' || message === 'VAULT_WRITE_FAILED') return res.status(action === 'outcomes' ? 503 : 502).json({ ok: false, error: action === 'outcomes' ? 'Outcome storage is temporarily unavailable.' : 'The connection could not be saved securely.' });
    if (cause instanceof Error && cause.name === 'TimeoutError') return res.status(504).json({ ok: false, error: 'The n8n workflow did not respond within 8 seconds.' });
    console.error(action === 'outcomes' ? 'n8n outcome ingestion failed' : 'n8n Cloud connection failed', cause);
    return res.status(502).json({ ok: false, error: action === 'outcomes' ? 'ORIN AI could not record this outcome.' : 'ORIN AI could not link this n8n Cloud workflow.' });
  }
}
