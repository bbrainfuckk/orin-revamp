import { waitUntil } from '@vercel/functions';
import { deliverAutomationEvent } from '../../../server/n8n-delivery.js';

type ConnectBody = {
  workspaceId?: string;
  webhookUrl?: string;
  displayName?: string;
  desiredChannels?: unknown;
};

type AdvancedBody = {
  workspaceId?: string;
  instanceUrl?: unknown;
  apiKey?: unknown;
  workflow?: unknown;
  byok?: unknown;
};

type ByokEntry = { name: string; value: string };

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
  body?: ConnectBody | AdvancedBody | OutcomeBody | string;
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
const workspaceRoles = new Set(['owner', 'admin', 'editor', 'viewer']);

export function n8nRoleCanConnect(role: string) {
  return ['owner', 'admin', 'editor'].includes(role);
}

export function n8nRoleCanDisconnect(role: string) {
  return ['owner', 'admin'].includes(role);
}

export function n8nWorkspaceIdIsValid(workspaceId: string) {
  return /^[A-Za-z0-9_-]{8,200}$/.test(workspaceId);
}

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

export function validateN8nCloudInstance(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('INVALID_N8N_INSTANCE');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('INVALID_N8N_INSTANCE');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.app\.n8n\.cloud$/.test(hostname)
    || url.search
    || url.hash
  ) throw new Error('INVALID_N8N_INSTANCE');
  return new URL(url.origin);
}

export function validateN8nWorkflow(value: unknown) {
  let workflow = value;
  if (typeof workflow === 'string') {
    if (workflow.length > 1_000_000) throw new Error('INVALID_N8N_WORKFLOW');
    try {
      workflow = JSON.parse(workflow);
    } catch {
      throw new Error('INVALID_N8N_WORKFLOW');
    }
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('INVALID_N8N_WORKFLOW');
  const source = workflow as Record<string, unknown>;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  const connections = source.connections;
  if (
    !name
    || name.length > 128
    || !nodes.length
    || nodes.length > 500
    || nodes.some((node) => !node || typeof node !== 'object' || Array.isArray(node))
    || !connections
    || typeof connections !== 'object'
    || Array.isArray(connections)
  ) throw new Error('INVALID_N8N_WORKFLOW');
  const clean: Record<string, unknown> = {
    name,
    nodes,
    connections,
    settings: source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings) ? source.settings : {},
  };
  if (source.staticData === null || (source.staticData && typeof source.staticData === 'object' && !Array.isArray(source.staticData))) clean.staticData = source.staticData;
  if (source.pinData && typeof source.pinData === 'object' && !Array.isArray(source.pinData)) clean.pinData = source.pinData;
  if (JSON.stringify(clean).length > 1_000_000) throw new Error('INVALID_N8N_WORKFLOW');
  return { workflow: clean, name, nodeCount: nodes.length };
}

export function validateN8nByok(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new Error('INVALID_BYOK');
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('INVALID_BYOK');
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const secret = typeof candidate.value === 'string' ? candidate.value.trim() : '';
    const key = name.toLowerCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(name) || !secret || secret.length > 4096 || seen.has(key)) throw new Error('INVALID_BYOK');
    seen.add(key);
    return { name, value: secret };
  });
}

export function sanitizeN8nWorkflowList(value: unknown) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).data
    : value;
  if (!Array.isArray(source)) throw new Error('N8N_API_RESPONSE');
  return source.slice(0, 100).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const workflow = entry as Record<string, unknown>;
    const id = typeof workflow.id === 'string' || typeof workflow.id === 'number' ? String(workflow.id) : '';
    const name = typeof workflow.name === 'string' ? workflow.name.trim().slice(0, 128) : '';
    if (!id || id.length > 128 || !name) return [];
    const updatedAt = typeof workflow.updatedAt === 'string' && Number.isFinite(Date.parse(workflow.updatedAt))
      ? new Date(workflow.updatedAt).toISOString()
      : '';
    return [{
      id,
      name,
      active: workflow.active === true,
      nodeCount: Array.isArray(workflow.nodes) ? Math.min(workflow.nodes.length, 5_000) : 0,
      updatedAt,
    }];
  });
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

async function decryptCredential(ciphertext: string, iv: string, base64Key: string) {
  try {
    const keyBytes = base64ToBytes(base64Key.trim());
    if (keyBytes.byteLength !== 32) throw new Error('VAULT_NOT_CONFIGURED');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext));
    const value = JSON.parse(new TextDecoder().decode(plaintext));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('VAULT_READ_FAILED');
    return value as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'VAULT_NOT_CONFIGURED') throw cause;
    throw new Error('VAULT_READ_FAILED');
  }
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

async function requireWorkspaceAccess(projectId: string, accessToken: string, workspaceId: unknown, uid: string) {
  if (typeof workspaceId !== 'string' || !n8nWorkspaceIdIsValid(workspaceId)) throw new Error('INVALID_REQUEST');
  const [workspace, membership] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`),
  ]);
  const role = fieldString(membership, 'role');
  if (!workspace || !membership || !workspaceRoles.has(role)) throw new Error('FORBIDDEN');
  return { workspaceId, role, ownerId: fieldString(workspace, 'ownerId') || uid };
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
    { update: { name: `${baseName}/connections/n8n`, fields: connectionFields }, updateMask: { fieldPaths: Object.keys(connectionFields) } },
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
    { delete: `${baseName}/connectorVault/n8n_advanced` },
    { delete: `${baseName}/connections/n8n` },
  ];
  if (outcomeRouteId) writes.push({ delete: documentName(projectId, `connectorRoutes/${outcomeRouteId}`) });
  await commitWrites(projectId, accessToken, writes);
}

async function linkN8nCloud(
  body: ConnectBody,
  workspaceId: string,
  uid: string,
  ownerId: string,
  projectId: string,
  accessToken: string,
) {
  const webhook = validateN8nCloudWebhook(body.webhookUrl);
  const setup = validateSetup(body);
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (base64ToBytes(encryptionKey.trim()).byteLength !== 32) throw new Error('VAULT_NOT_CONFIGURED');
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
    ownerId: stringValue(ownerId),
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
    webhookConfigured: booleanValue(true),
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

async function connectN8nAdvanced(
  body: AdvancedBody,
  workspaceId: string,
  uid: string,
  ownerId: string,
  projectId: string,
  accessToken: string,
) {
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (base64ToBytes(encryptionKey.trim()).byteLength !== 32) throw new Error('VAULT_NOT_CONFIGURED');
  const vaultPath = `workspaces/${workspaceId}/connectorVault/n8n_advanced`;
  const [storedVault, connection] = await Promise.all([
    getDocument(projectId, accessToken, vaultPath),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/n8n`),
  ]);
  const stored = storedVault
    ? await decryptCredential(fieldString(storedVault, 'ciphertext'), fieldString(storedVault, 'iv'), encryptionKey)
    : {};
  const instance = validateN8nCloudInstance(body.instanceUrl || stored.instanceUrl);
  const suppliedApiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const apiKey = suppliedApiKey || (typeof stored.apiKey === 'string' ? stored.apiKey : '');
  if (!apiKey || apiKey.length > 4096) throw new Error('INVALID_N8N_API_KEY');
  const suppliedByok = validateN8nByok(body.byok);
  const storedByok = Array.isArray(stored.byok)
    ? stored.byok.filter((entry): entry is ByokEntry => Boolean(entry && typeof entry === 'object' && typeof (entry as ByokEntry).name === 'string' && typeof (entry as ByokEntry).value === 'string'))
    : [];
  const byok = suppliedByok === undefined
    ? storedByok
    : [...new Map([...storedByok, ...suppliedByok].map((entry) => [entry.name.toLowerCase(), entry])).values()];
  const preparedWorkflow = body.workflow === undefined ? null : validateN8nWorkflow(body.workflow);
  const apiUrl = new URL(preparedWorkflow ? '/api/v1/workflows' : '/api/v1/workflows?limit=1', instance);
  const response = await fetch(apiUrl, {
    method: preparedWorkflow ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json',
      'X-N8N-API-KEY': apiKey,
      ...(preparedWorkflow ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': 'ORIN-AI-Connector/1.0',
    },
    ...(preparedWorkflow ? { body: JSON.stringify(preparedWorkflow.workflow) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('N8N_API_UNAUTHORIZED');
  if (!response.ok) throw new Error(`N8N_API_REJECTED:${response.status}`);
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  const workflowId = preparedWorkflow && (typeof result.id === 'string' || typeof result.id === 'number') ? String(result.id) : '';
  if (preparedWorkflow && !workflowId) throw new Error('N8N_API_RESPONSE');

  const now = new Date().toISOString();
  const encrypted = await encryptCredential({
    provider: 'n8n',
    deployment: 'n8n_cloud',
    instanceUrl: instance.origin,
    apiKey,
    byok,
  }, encryptionKey);
  const vaultFields = {
    provider: stringValue('n8n'),
    ownerId: stringValue(ownerId),
    ciphertext: stringValue(encrypted.ciphertext),
    iv: stringValue(encrypted.iv),
    encryptionVersion: integerValue(1),
    createdAt: timestampValue(now),
    updatedAt: timestampValue(now),
  };
  const connectionFields: Record<string, FirestoreValue> = {
    provider: stringValue('n8n'),
    displayName: stringValue(fieldString(connection, 'displayName') || preparedWorkflow?.name || `${instance.hostname} workspace`),
    status: stringValue('connected'),
    authorizationStatus: stringValue('api_key_verified'),
    credentialState: stringValue('stored_server_side'),
    health: stringValue('healthy'),
    deployment: stringValue('n8n_cloud'),
    advancedConfigured: booleanValue(true),
    n8nInstanceHost: stringValue(instance.hostname),
    n8nEditorUrl: stringValue(instance.origin),
    byokNames: stringArrayValue(byok.map((entry) => entry.name)),
    connectedBy: stringValue(uid),
    apiVerifiedAt: timestampValue(now),
    advancedUpdatedAt: timestampValue(now),
    updatedAt: timestampValue(now),
  };
  if (!connection) connectionFields.createdAt = timestampValue(now);
  if (preparedWorkflow) {
    connectionFields.importedWorkflowId = stringValue(workflowId);
    connectionFields.importedWorkflowName = stringValue(preparedWorkflow.name);
    connectionFields.importedNodeCount = integerValue(preparedWorkflow.nodeCount);
  }
  await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, vaultPath), fields: vaultFields } },
    {
      update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/n8n`), fields: connectionFields },
      updateMask: { fieldPaths: Object.keys(connectionFields) },
    },
  ]);
  return {
    instanceHost: instance.hostname,
    editorUrl: instance.origin,
    workflowId,
    workflowName: preparedWorkflow?.name || '',
    workflowUrl: workflowId ? new URL(`/workflow/${encodeURIComponent(workflowId)}`, instance).toString() : instance.origin,
    byokNames: byok.map((entry) => entry.name),
  };
}

async function listN8nWorkflows(workspaceId: string, projectId: string, accessToken: string) {
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (base64ToBytes(encryptionKey.trim()).byteLength !== 32) throw new Error('VAULT_NOT_CONFIGURED');
  const storedVault = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/n8n_advanced`);
  if (!storedVault) throw new Error('N8N_API_NOT_CONFIGURED');
  const stored = await decryptCredential(fieldString(storedVault, 'ciphertext'), fieldString(storedVault, 'iv'), encryptionKey);
  const instance = validateN8nCloudInstance(stored.instanceUrl);
  const apiKey = typeof stored.apiKey === 'string' ? stored.apiKey : '';
  if (!apiKey) throw new Error('N8N_API_NOT_CONFIGURED');
  const response = await fetch(new URL('/api/v1/workflows?limit=100', instance), {
    headers: { Accept: 'application/json', 'X-N8N-API-KEY': apiKey, 'User-Agent': 'ORIN-AI-Connector/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('N8N_API_UNAUTHORIZED');
  if (!response.ok) throw new Error(`N8N_API_REJECTED:${response.status}`);
  return {
    instanceHost: instance.hostname,
    editorUrl: instance.origin,
    syncedAt: new Date().toISOString(),
    workflows: sanitizeN8nWorkflowList(await response.json().catch(() => null)),
  };
}

async function rotateOutcomeToken(workspaceId: string, projectId: string, accessToken: string) {
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
    || !n8nWorkspaceIdIsValid(workspaceId)
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
    const { accessToken, projectId } = await googleAccessToken();
    const access = await requireWorkspaceAccess(projectId, accessToken, body.workspaceId, uid);
    const { workspaceId } = access;

    if (action === 'outcome-token') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
      }
      if (!n8nRoleCanConnect(access.role)) throw new Error('FORBIDDEN');
      const outcome = await rotateOutcomeToken(workspaceId, projectId, accessToken);
      return res.status(200).json({ ok: true, outcome });
    }

    if (action === 'advanced') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
      }
      if (!n8nRoleCanConnect(access.role)) throw new Error('FORBIDDEN');
      const advanced = await connectN8nAdvanced(body as AdvancedBody, workspaceId, uid, access.ownerId, projectId, accessToken);
      return res.status(200).json({ ok: true, status: 'connected', deployment: 'n8n_cloud', advanced });
    }

    if (action === 'workflows') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
      }
      const workflows = await listN8nWorkflows(workspaceId, projectId, accessToken);
      return res.status(200).json({ ok: true, workflows });
    }

    if (req.method === 'DELETE') {
      if (!n8nRoleCanDisconnect(access.role)) throw new Error('FORBIDDEN');
      const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/n8n`);
      await deleteConnection(projectId, accessToken, workspaceId, fieldString(connection, 'outcomeRouteId'));
      return res.status(200).json({ ok: true, status: 'disconnected' });
    }

    if (!n8nRoleCanConnect(access.role)) throw new Error('FORBIDDEN');
    const outcome = await linkN8nCloud(body as ConnectBody, workspaceId, uid, access.ownerId, projectId, accessToken);
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
    if (message === 'N8N_API_NOT_CONFIGURED') return res.status(409).json({ ok: false, error: 'Connect the n8n Cloud API in Integrations before syncing workflows.' });
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    if (message === 'INVALID_REQUEST' || message === 'INVALID_SETUP') return res.status(400).json({ ok: false, error: 'Add a workflow name and choose at least one event.' });
    if (message === 'INVALID_WEBHOOK_URL') return res.status(400).json({ ok: false, error: 'Paste a production n8n Cloud URL that contains /webhook/. Test URLs and self-hosted servers are not supported yet.' });
    if (message === 'INVALID_N8N_INSTANCE') return res.status(400).json({ ok: false, error: 'Enter your n8n Cloud workspace URL, such as https://your-workspace.app.n8n.cloud.' });
    if (message === 'INVALID_N8N_API_KEY') return res.status(400).json({ ok: false, error: 'Enter an n8n API key, or keep the field blank only after one has already been saved.' });
    if (message === 'INVALID_N8N_WORKFLOW') return res.status(400).json({ ok: false, error: 'Choose a valid n8n workflow JSON file with a name, nodes, and connections.' });
    if (message === 'INVALID_BYOK') return res.status(400).json({ ok: false, error: 'Each BYOK entry needs a unique name and a secret value.' });
    if (message === 'N8N_API_UNAUTHORIZED') return res.status(401).json({ ok: false, error: 'n8n rejected the API key. Create or copy an API key from n8n Settings, then try again.' });
    if (message.startsWith('N8N_API_REJECTED:')) return res.status(502).json({ ok: false, error: `n8n Cloud returned HTTP ${message.split(':')[1]}. Confirm API access is enabled and the workflow JSON is supported.` });
    if (message === 'N8N_API_RESPONSE') return res.status(502).json({ ok: false, error: 'n8n accepted the request but did not return the imported workflow ID.' });
    if (message.startsWith('WEBHOOK_REJECTED:')) return res.status(502).json({ ok: false, error: `The n8n workflow returned HTTP ${message.split(':')[1]}. Make sure the workflow is active.` });
    if (message === 'VAULT_NOT_CONFIGURED' || message === 'VAULT_AUTH_FAILED') return res.status(503).json({ ok: false, error: 'Secure connector storage is not available yet.' });
    if (message === 'VAULT_READ_FAILED' || message === 'VAULT_WRITE_FAILED') return res.status(action === 'outcomes' ? 503 : 502).json({ ok: false, error: action === 'outcomes' ? 'Outcome storage is temporarily unavailable.' : 'The connection could not be saved securely.' });
    if (cause instanceof Error && cause.name === 'TimeoutError') return res.status(504).json({ ok: false, error: ['advanced', 'workflows'].includes(action) ? 'n8n Cloud did not respond within 12 seconds.' : 'The n8n workflow did not respond within 8 seconds.' });
    console.error(action === 'outcomes' ? 'n8n outcome ingestion failed' : 'n8n Cloud connection failed', cause);
    return res.status(502).json({ ok: false, error: action === 'outcomes' ? 'ORIN AI could not record this outcome.' : 'ORIN AI could not link this n8n Cloud workflow.' });
  }
}
