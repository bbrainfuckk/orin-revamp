import { bytesToBase64Url, getDocument, googleAccessToken, verifyFirebaseUid } from './server-data.ts';

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

function shopeeReadyAgent(agent: Awaited<ReturnType<typeof getDocument>>) {
  const readiness = Number(agent?.fields?.readiness?.integerValue || 0);
  const channels = agent?.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [];
  return readiness >= 6 && channels.some((channel) => channel.stringValue === 'Shopee');
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const partnerId = process.env.SHOPEE_PARTNER_ID || '';
  const partnerKey = process.env.SHOPEE_PARTNER_KEY || '';
  const stateSecret = process.env.OAUTH_STATE_SECRET || '';
  if (
    !/^\d{1,20}$/.test(partnerId)
    || partnerKey.length < 16
    || stateSecret.length < 32
    || !process.env.CONNECTOR_ENCRYPTION_KEY
    || !process.env.FIREBASE_CLIENT_EMAIL
    || !process.env.FIREBASE_PRIVATE_KEY
  ) return res.status(503).json({ ok: false, error: 'Shopee authorization is not configured for this deployment yet' });

  try {
    const uid = await verifyFirebaseUid(req);
    const workspaceId = queryValue(req.query?.workspaceId);
    const agentId = queryValue(req.query?.agentId);
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) return res.status(400).json({ ok: false, error: 'Choose a Shopee-ready ORIN AI first' });
    const { projectId, accessToken } = await googleAccessToken();
    const agent = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/agents/${agentId}`);
    if (!shopeeReadyAgent(agent)) return res.status(409).json({ ok: false, error: 'Complete all six AI decisions and include Shopee before connecting the seller account' });

    const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
    const issuedAt = Date.now();
    const payload = bytesToBase64Url(encoder.encode(JSON.stringify({
      provider: 'shopee',
      uid,
      workspaceId,
      agentId,
      nonce,
      issuedAt,
      expiresAt: issuedAt + 10 * 60 * 1_000,
    })));
    const state = `${payload}.${await signState(payload, stateSecret)}`;
    const redirectUri = process.env.SHOPEE_REDIRECT_URI || 'https://www.orin.work/api/integrations/shopee/callback';
    const authorizationUrl = new URL(process.env.SHOPEE_AUTH_URL || 'https://open.shopee.com/auth');
    authorizationUrl.search = new URLSearchParams({
      partner_id: partnerId,
      auth_type: 'seller',
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    }).toString();
    res.setHeader('Set-Cookie', `orin_shopee_oauth=${encodeURIComponent(nonce)}; Max-Age=600; Path=/api/integrations/shopee; HttpOnly; Secure; SameSite=Lax`);
    return res.status(200).json({ ok: true, authorizationUrl: authorizationUrl.toString() });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    console.error('Shopee authorization start failed', cause);
    return res.status(500).json({ ok: false, error: 'Shopee authorization could not be started' });
  }
}
