type ConnectBody = {
  workspaceId?: string;
  webhookUrl?: string;
  displayName?: string;
  desiredChannels?: unknown;
};

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: ConnectBody | string;
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
    return (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}) as ConnectBody;
  } catch {
    throw new Error('INVALID_REQUEST');
  }
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

const stringValue = (value: string) => ({ stringValue: value });
const integerValue = (value: number) => ({ integerValue: String(Math.trunc(value)) });
const timestampValue = (value: string) => ({ timestampValue: value });
const stringArrayValue = (values: string[]) => ({ arrayValue: { values: values.map(stringValue) } });

async function commitConnection(
  projectId: string,
  accessToken: string,
  workspaceId: string,
  vaultFields: Record<string, unknown>,
  connectionFields: Record<string, unknown>,
) {
  const baseName = `projects/${projectId}/databases/(default)/documents/workspaces/${workspaceId}`;
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        { update: { name: `${baseName}/connectorVault/n8n`, fields: vaultFields } },
        { update: { name: `${baseName}/connections/n8n`, fields: connectionFields } },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('VAULT_WRITE_FAILED');
}

async function deleteConnection(projectId: string, accessToken: string, workspaceId: string) {
  const baseName = `projects/${projectId}/databases/(default)/documents/workspaces/${workspaceId}`;
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        { delete: `${baseName}/connectorVault/n8n` },
        { delete: `${baseName}/connections/n8n` },
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('VAULT_WRITE_FAILED');
}

async function linkN8nCloud(body: ConnectBody, workspaceId: string, uid: string) {
  const webhook = validateN8nCloudWebhook(body.webhookUrl);
  const setup = validateSetup(body);
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (base64ToBytes(encryptionKey.trim()).byteLength !== 32) throw new Error('VAULT_NOT_CONFIGURED');
  const { accessToken, projectId } = await googleAccessToken();
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
    createdAt: timestampValue(now),
    updatedAt: timestampValue(now),
  });
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['POST', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = requestBody(req);
    const uid = await verifyFirebaseRequest(req);
    const workspaceId = validateWorkspace(body.workspaceId, uid);

    if (req.method === 'DELETE') {
      const { accessToken, projectId } = await googleAccessToken();
      await deleteConnection(projectId, accessToken, workspaceId);
      return res.status(200).json({ ok: true, status: 'disconnected' });
    }

    await linkN8nCloud(body, workspaceId, uid);
    return res.status(200).json({ ok: true, status: 'connected', deployment: 'n8n_cloud' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    if (message === 'INVALID_REQUEST' || message === 'INVALID_SETUP') return res.status(400).json({ ok: false, error: 'Add a workflow name and choose at least one event.' });
    if (message === 'INVALID_WEBHOOK_URL') return res.status(400).json({ ok: false, error: 'Paste a production n8n Cloud URL that contains /webhook/. Test URLs and self-hosted servers are not supported yet.' });
    if (message.startsWith('WEBHOOK_REJECTED:')) return res.status(502).json({ ok: false, error: `The n8n workflow returned HTTP ${message.split(':')[1]}. Make sure the workflow is active.` });
    if (message === 'VAULT_NOT_CONFIGURED' || message === 'VAULT_AUTH_FAILED') return res.status(503).json({ ok: false, error: 'Secure connector storage is not available yet.' });
    if (message === 'VAULT_WRITE_FAILED') return res.status(502).json({ ok: false, error: 'The connection passed its test but could not be saved securely.' });
    if (cause instanceof Error && cause.name === 'TimeoutError') return res.status(504).json({ ok: false, error: 'The n8n workflow did not respond within 8 seconds.' });
    console.error('n8n Cloud connection failed', cause);
    return res.status(502).json({ ok: false, error: 'ORIN AI could not link this n8n Cloud workflow.' });
  }
}
