type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

type FirebaseAccountLookup = { users?: Array<{ localId?: string; disabled?: boolean }> };

const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY
  || process.env.VITE_FIREBASE_API_KEY
  || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk';

const encoder = new TextEncoder();

function stringQuery(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function base64Url(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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

async function signState(payload: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
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

  try {
    const identity = await verifyFirebaseRequest(req);
    const workspaceId = stringQuery(req.query?.workspaceId);
    if (workspaceId !== `personal_${identity.uid}`) {
      return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    }

    const nonceBytes = crypto.getRandomValues(new Uint8Array(24));
    const nonce = base64Url(nonceBytes);
    const payload = base64Url(encoder.encode(JSON.stringify({
      provider: 'meta',
      uid: identity.uid,
      workspaceId,
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
      scope: process.env.META_SCOPES || [
        'pages_show_list',
        'pages_messaging',
        'pages_manage_metadata',
        'pages_read_engagement',
        'instagram_basic',
        'instagram_manage_messages',
      ].join(','),
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
    console.error('Meta authorization start failed', cause);
    return res.status(500).json({ ok: false, error: 'Meta authorization could not be started' });
  }
}
