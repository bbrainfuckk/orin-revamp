type ConnectBody = {
  workspaceId?: string;
  displayName?: string;
  agentId?: string;
  allowedOrigins?: unknown;
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
type FirestoreValue = {
  stringValue?: string;
  integerValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};
type FirestoreDocument = { fields?: Record<string, FirestoreValue> };

const encoder = new TextEncoder();
const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY
  || process.env.VITE_FIREBASE_API_KEY
  || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk';
const allowedSubscriptions = new Set(['Website chat', 'Lead capture', 'Knowledge answers']);

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

async function googleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'orin-ai-502503';
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error('SERVER_STORAGE_NOT_CONFIGURED');
  const privateKeyBody = rawPrivateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const signingKey = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyBody), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
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
  if (!response.ok || !payload.access_token) throw new Error('SERVER_STORAGE_AUTH_FAILED');
  return { accessToken: payload.access_token, projectId };
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
  if (!response.ok) throw new Error('SERVER_STORAGE_READ_FAILED');
  return response.json() as Promise<FirestoreDocument>;
}

async function commitWrites(projectId: string, accessToken: string, writes: unknown[]) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('SERVER_STORAGE_WRITE_FAILED');
}

const stringValue = (value: string): FirestoreValue => ({ stringValue: value });
const integerValue = (value: number): FirestoreValue => ({ integerValue: String(Math.trunc(value)) });
const timestampValue = (value: string) => ({ timestampValue: value });
const stringArrayValue = (values: string[]): FirestoreValue => ({ arrayValue: { values: values.map(stringValue) } });

function fieldString(document: FirestoreDocument | null, field: string) {
  return document?.fields?.[field]?.stringValue || '';
}

function fieldInteger(document: FirestoreDocument | null, field: string) {
  return Number(document?.fields?.[field]?.integerValue || 0);
}

function nestedString(document: FirestoreDocument | null, map: string, field: string) {
  return document?.fields?.[map]?.mapValue?.fields?.[field]?.stringValue || '';
}

function nestedStringArray(document: FirestoreDocument | null, map: string, field: string) {
  return (document?.fields?.[map]?.mapValue?.fields?.[field]?.arrayValue?.values || [])
    .map((value) => value.stringValue || '')
    .filter(Boolean);
}

function validateOrigin(value: unknown) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('INVALID_ORIGINS');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('INVALID_ORIGINS');
  }
  if (url.origin !== value.trim().replace(/\/$/, '') || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('INVALID_ORIGINS');
  }
  return url.origin;
}

function validateSetup(body: ConnectBody) {
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const allowedOrigins = Array.isArray(body.allowedOrigins) ? [...new Set(body.allowedOrigins.map(validateOrigin))] : [];
  const desiredChannels = Array.isArray(body.desiredChannels)
    ? [...new Set(body.desiredChannels.filter((item): item is string => typeof item === 'string' && allowedSubscriptions.has(item)))]
    : [];
  if (!displayName || displayName.length > 120 || !/^[A-Za-z0-9_-]{8,128}$/.test(agentId) || !allowedOrigins.length || allowedOrigins.length > 5 || !desiredChannels.length) {
    throw new Error('INVALID_SETUP');
  }
  return { displayName, agentId, allowedOrigins, desiredChannels };
}

function embedCode(widgetKey: string) {
  return `<script src="https://www.orin.work/orin-widget.js" data-orin-widget="${widgetKey}" async></script>`;
}

async function connectWebsite(body: ConnectBody, workspaceId: string, uid: string, projectId: string, accessToken: string) {
  const setup = validateSetup(body);
  const [agent, existing] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/agents/${setup.agentId}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/website`),
  ]);
  if (!agent || fieldInteger(agent, 'readiness') < 6 || !nestedStringArray(agent, 'config', 'channels').includes('Website')) {
    throw new Error('AGENT_NOT_READY');
  }
  const agentName = fieldString(agent, 'name') || 'ORIN AI';
  const businessName = fieldString(agent, 'businessName') || nestedString(agent, 'config', 'businessName') || setup.displayName;
  const existingKey = fieldString(existing, 'publicWidgetKey');
  const widgetKey = /^ow_[A-Za-z0-9_-]{20,80}$/.test(existingKey)
    ? existingKey
    : `ow_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)))}`;
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [
    {
      update: { name: documentName(projectId, `publicWidgets/${widgetKey}`), fields: {
        widgetKey: stringValue(widgetKey),
        workspaceId: stringValue(workspaceId),
        ownerId: stringValue(uid),
        agentId: stringValue(setup.agentId),
        assistantName: stringValue(agentName),
        businessName: stringValue(businessName),
        greeting: stringValue(`Hi, I'm ${agentName}. How can I help?`),
        allowedOrigins: stringArrayValue(setup.allowedOrigins),
        status: stringValue('active'),
        createdAt: timestampValue(now),
        updatedAt: timestampValue(now),
      } },
    },
    {
      update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/website`), fields: {
        provider: stringValue('website'),
        displayName: stringValue(setup.displayName),
        status: stringValue('connected'),
        authorizationStatus: stringValue('not_required'),
        credentialState: stringValue('public_widget_key'),
        health: stringValue('healthy'),
        publicWidgetKey: stringValue(widgetKey),
        agentId: stringValue(setup.agentId),
        allowedOrigins: stringArrayValue(setup.allowedOrigins),
        desiredChannels: stringArrayValue(setup.desiredChannels),
        connectedBy: stringValue(uid),
        createdAt: timestampValue(now),
        updatedAt: timestampValue(now),
      } },
    },
    {
      update: { name: documentName(projectId, `workspaces/${workspaceId}/agents/${setup.agentId}`), fields: {
        status: stringValue('active'),
      } },
      updateMask: { fieldPaths: ['status'] },
      updateTransforms: [
        { fieldPath: 'publishedAt', setToServerValue: 'REQUEST_TIME' },
        { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
      ],
      currentDocument: { exists: true },
    },
  ]);
  return { widgetKey, embedCode: embedCode(widgetKey) };
}

async function disconnectWebsite(workspaceId: string, projectId: string, accessToken: string) {
  const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/website`);
  if (!connection) return;
  const widgetKey = fieldString(connection, 'publicWidgetKey');
  const agentId = fieldString(connection, 'agentId');
  const writes: unknown[] = [
    { delete: documentName(projectId, `workspaces/${workspaceId}/connections/website`) },
  ];
  if (/^ow_[A-Za-z0-9_-]{20,80}$/.test(widgetKey)) writes.push({ delete: documentName(projectId, `publicWidgets/${widgetKey}`) });
  if (/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) writes.push({
    update: { name: documentName(projectId, `workspaces/${workspaceId}/agents/${agentId}`), fields: { status: stringValue('draft') } },
    updateMask: { fieldPaths: ['status'] },
    updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { exists: true },
  });
  await commitWrites(projectId, accessToken, writes);
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
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    const { projectId, accessToken } = await googleAccessToken();
    if (req.method === 'DELETE') {
      await disconnectWebsite(workspaceId, projectId, accessToken);
      return res.status(200).json({ ok: true, status: 'disconnected' });
    }
    const result = await connectWebsite(body, workspaceId, uid, projectId, accessToken);
    return res.status(200).json({ ok: true, status: 'connected', ...result });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    if (message === 'INVALID_REQUEST' || message === 'INVALID_SETUP' || message === 'INVALID_ORIGINS') return res.status(400).json({ ok: false, error: 'Choose a ready Website AI and enter one to five exact website origins, such as https://shop.example.com.' });
    if (message === 'AGENT_NOT_READY') return res.status(409).json({ ok: false, error: 'Complete all six AI decisions and include Website as a channel before publishing this widget.' });
    if (message === 'SERVER_STORAGE_NOT_CONFIGURED' || message === 'SERVER_STORAGE_AUTH_FAILED') return res.status(503).json({ ok: false, error: 'Secure website publishing is not available yet.' });
    console.error('Website connection failed', cause);
    return res.status(502).json({ ok: false, error: 'ORIN AI could not publish this website connection.' });
  }
}
