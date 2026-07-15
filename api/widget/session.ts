type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
  end: () => void;
};

type GoogleTokenResponse = { access_token?: string };
type FirestoreValue = { stringValue?: string; arrayValue?: { values?: FirestoreValue[] } };
type FirestoreDocument = { fields?: Record<string, FirestoreValue> };

const encoder = new TextEncoder();

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function headerValue(req: ApiRequest, name: string) {
  const value = req.headers?.[name] || req.headers?.[name.toLowerCase()];
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

async function googleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'orin-ai-502503';
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error('NOT_CONFIGURED');
  const privateKeyBody = rawPrivateKey.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, '');
  const signingKey = await crypto.subtle.importKey('pkcs8', base64ToBytes(privateKeyBody), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (process.env.FIREBASE_PRIVATE_KEY_ID) header.kid = process.env.FIREBASE_PRIVATE_KEY_ID;
  const claims = { iss: clientEmail, sub: clientEmail, aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/datastore', iat: now, exp: now + 3_300 };
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
  if (!response.ok || !payload.access_token) throw new Error('STORAGE_UNAVAILABLE');
  return { projectId, accessToken: payload.access_token };
}

async function getWidget(projectId: string, accessToken: string, widgetKey: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/publicWidgets/${encodeURIComponent(widgetKey)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('STORAGE_UNAVAILABLE');
  return response.json() as Promise<FirestoreDocument>;
}

function fieldString(document: FirestoreDocument | null, name: string) {
  return document?.fields?.[name]?.stringValue || '';
}

function fieldStringArray(document: FirestoreDocument | null, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || []).map((value) => value.stringValue || '').filter(Boolean);
}

function publicConfig(document: FirestoreDocument) {
  return {
    assistantName: fieldString(document, 'assistantName') || 'ORIN AI',
    businessName: fieldString(document, 'businessName'),
    greeting: fieldString(document, 'greeting') || 'Hi. How can I help?',
  };
}

async function signedSession(widgetKey: string, origin: string, req: ApiRequest) {
  const secret = process.env.WIDGET_SIGNING_SECRET || process.env.OAUTH_STATE_SECRET || '';
  if (secret.length < 32) throw new Error('NOT_CONFIGURED');
  const now = Date.now();
  const forwarded = headerValue(req, 'x-forwarded-for').split(',')[0]?.trim().slice(0, 96) || 'unknown';
  const ipKey = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const ipHash = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', ipKey, encoder.encode(forwarded)))).slice(0, 32);
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
    version: 1,
    widgetKey,
    sessionId: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18))),
    origin,
    ipHash,
    issuedAt: now,
    expiresAt: now + 2 * 60 * 60 * 1000,
  })));
  const signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', ipKey, encoder.encode(payload))));
  return `${payload}.${signature}`;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const widgetKey = queryValue(req.query?.key);
  if (!/^ow_[A-Za-z0-9_-]{20,80}$/.test(widgetKey)) return res.status(404).json({ ok: false, error: 'Widget not found' });
  try {
    const { projectId, accessToken } = await googleAccessToken();
    const widget = await getWidget(projectId, accessToken, widgetKey);
    if (!widget || fieldString(widget, 'status') !== 'active') return res.status(404).json({ ok: false, error: 'Widget not found' });

    if (req.method === 'GET') return res.status(200).json({ ok: true, config: publicConfig(widget) });
    if (!['POST', 'OPTIONS'].includes(req.method || '')) {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const origin = headerValue(req, 'origin');
    const allowed = fieldStringArray(widget, 'allowedOrigins');
    if (!origin || (!allowed.includes(origin) && origin !== 'https://www.orin.work')) {
      return res.status(403).json({ ok: false, error: 'This website is not allowed to load the widget' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const token = await signedSession(widgetKey, origin, req);
    return res.status(200).json({ ok: true, token, config: publicConfig(widget) });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'NOT_CONFIGURED') return res.status(503).json({ ok: false, error: 'Website chat is not configured' });
    console.error('Widget session failed', cause);
    return res.status(502).json({ ok: false, error: 'Website chat is temporarily unavailable' });
  }
}
