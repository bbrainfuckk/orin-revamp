import { bytesToBase64Url, googleAccessToken, requireWorkspaceRole, verifyFirebaseUid } from './server-data';
import { normalizeShopDomain } from './shopify';

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

const encoder = new TextEncoder();

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

async function signState(payload: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (process.env.SHOPIFY_PRODUCTION_APPROVED !== 'true') return res.status(503).json({ ok: false, error: 'Shopify production distribution is not approved yet' });

  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  const stateSecret = process.env.OAUTH_STATE_SECRET || '';
  if (!clientId || !clientSecret || stateSecret.length < 32 || !process.env.CONNECTOR_ENCRYPTION_KEY || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    return res.status(503).json({ ok: false, error: 'Shopify authorization is not configured for this deployment yet' });
  }

  try {
    const uid = await verifyFirebaseUid(req);
    const workspaceId = queryValue(req.query?.workspaceId);
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, workspaceId, uid);
    const shop = normalizeShopDomain(queryValue(req.query?.shop));
    const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
      provider: 'shopify',
      uid,
      workspaceId,
      shop,
      nonce,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 10 * 60 * 1000,
    })));
    const state = `${payload}.${await signState(payload, stateSecret)}`;
    const redirectUri = process.env.SHOPIFY_REDIRECT_URI || 'https://www.orin.work/api/integrations/shopify/callback';
    const authorizationUrl = new URL(`https://${shop}/admin/oauth/authorize`);
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      scope: process.env.SHOPIFY_SCOPES || 'read_orders,read_customers,read_products',
      redirect_uri: redirectUri,
      state,
    }).toString();
    res.setHeader('Set-Cookie', `orin_shopify_oauth=${encodeURIComponent(nonce)}; Max-Age=600; Path=/api/integrations/shopify; HttpOnly; Secure; SameSite=Lax`);
    return res.status(200).json({ ok: true, authorizationUrl: authorizationUrl.toString() });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    if (message === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'You do not have permission to connect Shopify in this workspace' });
    if (message === 'INVALID_SHOP') return res.status(400).json({ ok: false, error: 'Enter the permanent store domain, such as your-store.myshopify.com.' });
    console.error('Shopify authorization start failed', cause);
    return res.status(500).json({ ok: false, error: 'Shopify authorization could not be started' });
  }
}
