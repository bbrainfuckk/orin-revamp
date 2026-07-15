type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  end: (payload?: string) => void;
};

type OAuthState = {
  provider: 'meta';
  uid: string;
  workspaceId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

type MetaTokenResponse = { access_token?: string; token_type?: string; expires_in?: number };
type MetaPage = {
  id?: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id?: string; username?: string };
};
type MetaPageResponse = { data?: MetaPage[] };
type GoogleTokenResponse = { access_token?: string; expires_in?: number; token_type?: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function stringQuery(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
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

function parseCookie(req: ApiRequest, name: string) {
  const raw = req.headers?.cookie;
  const cookieHeader = Array.isArray(raw) ? raw.join(';') : raw || '';
  const match = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

async function verifyState(state: string, secret: string): Promise<OAuthState> {
  const [payload, signature, extra] = state.split('.');
  if (!payload || !signature || extra) throw new Error('INVALID_STATE');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, base64ToBytes(signature), encoder.encode(payload));
  if (!valid) throw new Error('INVALID_STATE');
  const parsed = JSON.parse(decoder.decode(base64ToBytes(payload))) as OAuthState;
  if (
    parsed.provider !== 'meta'
    || !parsed.uid
    || parsed.workspaceId !== `personal_${parsed.uid}`
    || !parsed.nonce
    || !Number.isFinite(parsed.issuedAt)
    || !Number.isFinite(parsed.expiresAt)
    || parsed.issuedAt > Date.now() + 60_000
    || parsed.expiresAt < Date.now()
    || parsed.expiresAt - parsed.issuedAt > 10 * 60 * 1000
  ) throw new Error('INVALID_STATE');
  return parsed;
}

function redirect(res: ApiResponse, status: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'orin_meta_oauth=; Max-Age=0; Path=/api/integrations/meta; HttpOnly; Secure; SameSite=Lax');
  res.setHeader('Location', `https://www.orin.work/app/integrations?provider=meta&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}

async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `Provider request failed with HTTP ${response.status}`);
  return payload;
}

async function encryptCredential(payload: unknown, base64Key: string) {
  const keyBytes = base64ToBytes(base64Key.trim());
  if (keyBytes.byteLength !== 32) throw new Error('INVALID_ENCRYPTION_KEY');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
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

const stringValue = (value: string) => ({ stringValue: value });
const integerValue = (value: number) => ({ integerValue: String(Math.trunc(value)) });
const timestampValue = (value: string) => ({ timestampValue: value });
const stringArrayValue = (values: string[]) => ({ arrayValue: { values: values.map(stringValue) } });

async function writeFirestoreDocument(projectId: string, accessToken: string, documentPath: string, fields: Record<string, unknown>) {
  const encodedPath = documentPath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`FIRESTORE_WRITE_FAILED:${response.status}:${payload.slice(0, 160)}`);
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method not allowed');
  }

  const appId = process.env.META_APP_ID || '';
  const appSecret = process.env.META_APP_SECRET || '';
  const stateSecret = process.env.OAUTH_STATE_SECRET || '';
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (!appId || !appSecret || stateSecret.length < 32 || !encryptionKey) return redirect(res, 'not_configured');

  try {
    const providerError = stringQuery(req.query?.error);
    if (providerError) return redirect(res, providerError === 'access_denied' ? 'cancelled' : 'provider_error');

    const code = stringQuery(req.query?.code);
    const stateValue = stringQuery(req.query?.state);
    if (!code || !stateValue) return redirect(res, 'invalid_callback');
    const state = await verifyState(stateValue, stateSecret);
    if (parseCookie(req, 'orin_meta_oauth') !== state.nonce) return redirect(res, 'invalid_state');

    const graphVersion = process.env.META_GRAPH_VERSION || 'v24.0';
    const redirectUri = process.env.META_REDIRECT_URI || 'https://www.orin.work/api/integrations/meta/callback';
    const shortTokenUrl = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
    shortTokenUrl.search = new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }).toString();
    const shortToken = await fetchJson<MetaTokenResponse>(shortTokenUrl);
    if (!shortToken.access_token) throw new Error('META_TOKEN_MISSING');

    let userToken = shortToken.access_token;
    let expiresIn = shortToken.expires_in || 0;
    try {
      const longTokenUrl = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
      longTokenUrl.search = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken.access_token,
      }).toString();
      const longToken = await fetchJson<MetaTokenResponse>(longTokenUrl);
      if (longToken.access_token) {
        userToken = longToken.access_token;
        expiresIn = longToken.expires_in || expiresIn;
      }
    } catch (cause) {
      console.warn('Meta long-lived token exchange was unavailable; retaining the short-lived token', cause);
    }

    const pagesUrl = new URL(`https://graph.facebook.com/${graphVersion}/me/accounts`);
    pagesUrl.search = new URLSearchParams({
      access_token: userToken,
      fields: 'id,name,access_token,instagram_business_account{id,username}',
      limit: '100',
    }).toString();
    const pageResponse = await fetchJson<MetaPageResponse>(pagesUrl);
    const pages = (pageResponse.data || []).filter((page) => page.id && page.name && page.access_token);
    if (!pages.length) return redirect(res, 'no_pages');

    const encrypted = await encryptCredential({
      provider: 'meta',
      graphVersion,
      userAccessToken: userToken,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        accessToken: page.access_token,
        instagramBusinessAccount: page.instagram_business_account || null,
      })),
    }, encryptionKey);

    const { accessToken: googleToken, projectId } = await googleAccessToken();
    const now = new Date().toISOString();
    const pageIds = pages.map((page) => page.id!);
    const pageNames = pages.map((page) => page.name!);
    const instagramAccountIds = pages.map((page) => page.instagram_business_account?.id).filter((value): value is string => Boolean(value));
    const desiredChannels = ['Facebook Pages', 'Messenger', ...(instagramAccountIds.length ? ['Instagram'] : [])];

    await writeFirestoreDocument(projectId, googleToken, `workspaces/${state.workspaceId}/connectorVault/meta`, {
      provider: stringValue('meta'),
      ownerId: stringValue(state.uid),
      ciphertext: stringValue(encrypted.ciphertext),
      iv: stringValue(encrypted.iv),
      encryptionVersion: integerValue(1),
      createdAt: timestampValue(now),
      updatedAt: timestampValue(now),
    });
    await writeFirestoreDocument(projectId, googleToken, `workspaces/${state.workspaceId}/connections/meta`, {
      provider: stringValue('meta'),
      displayName: stringValue(pageNames.length === 1 ? pageNames[0] : `${pageNames.length} Meta Pages`),
      status: stringValue('configuration_required'),
      authorizationStatus: stringValue('authorized'),
      credentialState: stringValue('stored_server_side'),
      health: stringValue('webhook_pending'),
      desiredChannels: stringArrayValue(desiredChannels),
      pageIds: stringArrayValue(pageIds),
      pageNames: stringArrayValue(pageNames),
      instagramAccountIds: stringArrayValue(instagramAccountIds),
      graphVersion: stringValue(graphVersion),
      authorizedBy: stringValue(state.uid),
      createdAt: timestampValue(now),
      updatedAt: timestampValue(now),
    });

    return redirect(res, 'authorized');
  } catch (cause) {
    console.error('Meta authorization callback failed', cause);
    return redirect(res, 'error');
  }
}
