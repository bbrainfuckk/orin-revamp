import { whatsappStart } from '../../../server/whatsapp-onboarding.js';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
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
type FirestoreDocument = { name?: string; fields?: Record<string, FirestoreValue> };
type FirestoreRunQueryRow = { document?: FirestoreDocument };

const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY
  || process.env.VITE_FIREBASE_API_KEY
  || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function stringQuery(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function base64Url(value: Uint8Array) {
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
    return (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}) as { workspaceId?: unknown };
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
  return { uid: account.localId };
}

export function metaOAuthScopes(configured = process.env.META_SCOPES || '') {
  return [...new Set([
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'pages_manage_posts',
    'pages_read_engagement',
    ...configured.split(',').map((scope) => scope.trim()).filter(Boolean),
  ])];
}

async function signState(payload: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

async function googleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'orin-ai-502503';
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error('STORAGE_NOT_CONFIGURED');
  const privateKeyBody = rawPrivateKey.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
  const signingKey = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyBody), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (process.env.FIREBASE_PRIVATE_KEY_ID) header.kid = process.env.FIREBASE_PRIVATE_KEY_ID;
  const claims = { iss: clientEmail, sub: clientEmail, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/datastore', iat: now, exp: now + 3_300 };
  const unsigned = `${base64Url(encoder.encode(JSON.stringify(header)))}.${base64Url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, encoder.encode(unsigned));
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64Url(new Uint8Array(signature))}` }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as GoogleTokenResponse;
  if (!response.ok || !payload.access_token) throw new Error('STORAGE_UNAVAILABLE');
  return { projectId, accessToken: payload.access_token };
}

function encodedPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function getDocument(projectId: string, accessToken: string, path: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath(path)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('STORAGE_UNAVAILABLE');
  return response.json() as Promise<FirestoreDocument>;
}

function fieldStringArray(document: FirestoreDocument | null, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}

function fieldInteger(document: FirestoreDocument | null, name: string) {
  return Number(document?.fields?.[name]?.integerValue || 0);
}

function fieldString(document: FirestoreDocument | null, name: string) {
  return document?.fields?.[name]?.stringValue || '';
}

async function requireWorkspaceAccess(uid: string, workspaceId: string, ownerOnly = false) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId)) throw new Error('FORBIDDEN');
  const { projectId, accessToken } = await googleAccessToken();
  const [workspace, membership] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`),
  ]);
  const role = fieldString(membership, 'role');
  if (!workspace || !membership || !(ownerOnly ? ['owner', 'admin'] : ['owner', 'admin', 'editor']).includes(role)) throw new Error('FORBIDDEN');
}

function nestedStringArray(document: FirestoreDocument | null, parent: string, name: string) {
  return (document?.fields?.[parent]?.mapValue?.fields?.[name]?.arrayValue?.values || [])
    .flatMap((value) => value.stringValue ? [value.stringValue] : []);
}

async function findConversationRouteNames(projectId: string, accessToken: string, workspaceId: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'conversationRoutes' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'workspaceId' }, op: 'EQUAL', value: { stringValue: workspaceId } } },
        { fieldFilter: { field: { fieldPath: 'provider' }, op: 'EQUAL', value: { stringValue: 'meta' } } },
      ] } },
      limit: 250,
    } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  const rows = await response.json() as FirestoreRunQueryRow[];
  return rows.flatMap((row) => row.document?.name ? [row.document.name] : []);
}

async function deleteMetaConnection(uid: string, workspaceId: string) {
  const { projectId, accessToken } = await googleAccessToken();
  const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/meta`);
  const pageIds = fieldStringArray(connection, 'pageIds');
  const instagramIds = fieldStringArray(connection, 'instagramAccountIds');
  const baseName = `projects/${projectId}/databases/(default)/documents`;
  const conversationRouteNames = await findConversationRouteNames(projectId, accessToken, workspaceId);
  const names = [
    `${baseName}/workspaces/${workspaceId}/connections/meta`,
    `${baseName}/workspaces/${workspaceId}/connectorVault/meta`,
    ...pageIds.map((id) => `${baseName}/connectorRoutes/meta_page_${id}`),
    ...instagramIds.map((id) => `${baseName}/connectorRoutes/meta_instagram_${id}`),
    ...conversationRouteNames,
  ];
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [...new Set(names)].map((name) => ({ delete: name })) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('STORAGE_UNAVAILABLE');
  return { ok: true, status: 'disconnected' };
}

async function decryptTikTokCredential(document: FirestoreDocument | null) {
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  const keyBytes = base64ToBytes(encryptionKey.trim());
  const ciphertext = fieldString(document, 'ciphertext');
  const iv = fieldString(document, 'iv');
  if (!document || keyBytes.byteLength !== 32 || !ciphertext || !iv) return null;
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv) }, key, base64ToBytes(ciphertext));
  const credential = JSON.parse(decoder.decode(plaintext)) as {
    provider?: unknown;
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    refreshExpiresAt?: unknown;
  };
  if (
    credential.provider !== 'tiktok'
    || typeof credential.accessToken !== 'string'
    || credential.accessToken.length < 20
    || typeof credential.refreshToken !== 'string'
    || credential.refreshToken.length < 20
  ) return null;
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: typeof credential.expiresAt === 'string' ? credential.expiresAt : '',
    refreshExpiresAt: typeof credential.refreshExpiresAt === 'string' ? credential.refreshExpiresAt : '',
  };
}

async function refreshTikTokAccessToken(refreshToken: string, clientKey: string, clientSecret: string) {
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => ({})) as { access_token?: string };
  return response.ok && typeof payload.access_token === 'string' && payload.access_token.length >= 20 ? payload.access_token : '';
}

async function revokeTikTokAccessToken(token: string, clientKey: string, clientSecret: string) {
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/revoke/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, token }),
    signal: AbortSignal.timeout(8_000),
  });
  return response.ok;
}

async function deleteTikTokConnection(uid: string, workspaceId: string) {
  const { projectId, accessToken } = await googleAccessToken();
  const [connection, vault] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/tiktok`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/tiktok`),
  ]);
  const credential = await decryptTikTokCredential(vault).catch(() => null);
  const clientKey = process.env.TIKTOK_CLIENT_KEY || '';
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET || '';
  let providerRevoked = false;
  if (credential && clientKey && clientSecret) {
    try {
      const accessExpired = Number.isFinite(new Date(credential.expiresAt).getTime())
        && new Date(credential.expiresAt).getTime() <= Date.now() + 60_000;
      const refreshValid = !credential.refreshExpiresAt
        || !Number.isFinite(new Date(credential.refreshExpiresAt).getTime())
        || new Date(credential.refreshExpiresAt).getTime() > Date.now() + 60_000;
      let token = credential.accessToken;
      if (accessExpired && refreshValid) token = await refreshTikTokAccessToken(credential.refreshToken, clientKey, clientSecret) || token;
      providerRevoked = await revokeTikTokAccessToken(token, clientKey, clientSecret);
      if (!providerRevoked && refreshValid && token === credential.accessToken) {
        const refreshedToken = await refreshTikTokAccessToken(credential.refreshToken, clientKey, clientSecret);
        if (refreshedToken) providerRevoked = await revokeTikTokAccessToken(refreshedToken, clientKey, clientSecret);
      }
    } catch {
      console.warn('TikTok token revocation was unavailable; local access will still be removed');
    }
  }

  const openIdHash = fieldString(connection, 'openIdHash');
  const baseName = `projects/${projectId}/databases/(default)/documents`;
  const names = [
    `${baseName}/workspaces/${workspaceId}/connections/tiktok`,
    `${baseName}/workspaces/${workspaceId}/connectorVault/tiktok`,
    ...(/^[A-Za-z0-9_-]{20,64}$/.test(openIdHash) ? [`${baseName}/connectorRoutes/tiktok_user_${openIdHash}`] : []),
  ];
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: names.map((name) => ({ delete: name })) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('STORAGE_UNAVAILABLE');
  return { ok: true, status: 'disconnected', providerRevoked };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (stringQuery(req.query?.provider) === 'whatsapp') return whatsappStart(req, res);
  if (!['GET', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const identity = await verifyFirebaseRequest(req);
    const body = req.method === 'DELETE' ? requestBody(req) : null;
    const workspaceId = body && typeof body.workspaceId === 'string' ? body.workspaceId : stringQuery(req.query?.workspaceId);
    const provider = stringQuery(req.query?.provider) === 'tiktok' ? 'tiktok' : 'meta';
    await requireWorkspaceAccess(identity.uid, workspaceId, req.method === 'DELETE');
    if (req.method === 'DELETE') {
      return res.status(200).json(provider === 'tiktok'
        ? await deleteTikTokConnection(identity.uid, workspaceId)
        : await deleteMetaConnection(identity.uid, workspaceId));
    }

    if (provider === 'tiktok') {
      if (process.env.TIKTOK_PRODUCTION_APPROVED !== 'true') return res.status(503).json({ ok: false, error: 'TikTok production access is awaiting provider approval' });
      const clientKey = process.env.TIKTOK_CLIENT_KEY || '';
      const clientSecret = process.env.TIKTOK_CLIENT_SECRET || '';
      const stateSecret = process.env.OAUTH_STATE_SECRET || '';
      const vaultConfigured = Boolean(
        process.env.CONNECTOR_ENCRYPTION_KEY
        && process.env.FIREBASE_CLIENT_EMAIL
        && process.env.FIREBASE_PRIVATE_KEY,
      );
      if (!clientKey || !clientSecret || stateSecret.length < 32 || !vaultConfigured) {
        return res.status(503).json({ ok: false, error: 'TikTok authorization is not configured for this deployment yet' });
      }
      const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
      const payload = base64Url(encoder.encode(JSON.stringify({
        provider: 'tiktok',
        uid: identity.uid,
        workspaceId,
        nonce,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
      })));
      const state = `${payload}.${await signState(payload, stateSecret)}`;
      const redirectUri = process.env.TIKTOK_REDIRECT_URI || 'https://www.orin.work/api/integrations/tiktok/callback';
      const authorizationUrl = new URL('https://www.tiktok.com/v2/auth/authorize/');
      authorizationUrl.search = new URLSearchParams({
        client_key: clientKey,
        response_type: 'code',
        scope: 'user.info.basic',
        redirect_uri: redirectUri,
        state,
      }).toString();
      res.setHeader('Set-Cookie', `orin_tiktok_oauth=${encodeURIComponent(nonce)}; Max-Age=600; Path=/api/integrations/tiktok; HttpOnly; Secure; SameSite=Lax`);
      return res.status(200).json({ ok: true, authorizationUrl: authorizationUrl.toString() });
    }

    const agentId = stringQuery(req.query?.agentId);
    if (process.env.META_PRODUCTION_APPROVED !== 'true' && !(process.env.META_TEST_MODE === 'true' && process.env.META_TEST_PAGE_ID)) return res.status(503).json({ ok: false, error: 'Meta production access is awaiting App Review approval' });
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) {
      return res.status(400).json({ ok: false, error: 'Choose a completed ORIN AI before connecting Meta' });
    }
    const { projectId, accessToken } = await googleAccessToken();
    const agent = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/agents/${agentId}`);
    const metaChannels = nestedStringArray(agent, 'config', 'channels').filter((channel) => ['Messenger', 'Instagram'].includes(channel));
    if (!agent || fieldInteger(agent, 'readiness') < 6 || !metaChannels.length) {
      return res.status(409).json({ ok: false, error: 'Complete all six AI decisions and include Messenger or Instagram before connecting Meta' });
    }

    const appId = process.env.META_APP_ID || '';
    const stateSecret = process.env.OAUTH_STATE_SECRET || '';
    const vaultConfigured = Boolean(
      process.env.META_APP_SECRET
      && process.env.CONNECTOR_ENCRYPTION_KEY
      && process.env.FIREBASE_CLIENT_EMAIL
      && process.env.FIREBASE_PRIVATE_KEY,
    );
    if (!appId || stateSecret.length < 32 || !vaultConfigured) {
      return res.status(503).json({ ok: false, error: 'Meta authorization is not configured for this deployment yet' });
    }

    const nonceBytes = crypto.getRandomValues(new Uint8Array(24));
    const nonce = base64Url(nonceBytes);
    const payload = base64Url(encoder.encode(JSON.stringify({
      provider: 'meta',
      uid: identity.uid,
      workspaceId,
      agentId,
      nonce,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    })));
    const signature = await signState(payload, stateSecret);
    const state = `${payload}.${signature}`;
    const redirectUri = process.env.META_REDIRECT_URI || 'https://www.orin.work/api/integrations/meta/callback';
    const authorizationUrl = new URL('https://www.facebook.com/dialog/oauth');
    authorizationUrl.search = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      scope: metaOAuthScopes().join(','),
      auth_type: 'rerequest',
      return_scopes: 'true',
    }).toString();

    res.setHeader('Set-Cookie', `orin_meta_oauth=${encodeURIComponent(nonce)}; Max-Age=600; Path=/api/integrations/meta; HttpOnly; Secure; SameSite=Lax`);
    return res.status(200).json({ ok: true, authorizationUrl: authorizationUrl.toString() });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'AUTH_SERVICE_UNAVAILABLE') {
      return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    }
    if (message === 'INVALID_REQUEST') return res.status(400).json({ ok: false, error: 'The disconnect request is invalid' });
    if (message === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    if (message === 'STORAGE_NOT_CONFIGURED' || message === 'STORAGE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Secure Meta storage is temporarily unavailable' });
    console.error('Meta authorization start failed', cause);
    return res.status(500).json({ ok: false, error: 'Meta authorization could not be started' });
  }
}
