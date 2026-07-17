import {
  base64ToBytes,
  booleanValue,
  commitWrites,
  constantTimeEqual,
  documentName,
  encryptJson,
  googleAccessToken,
  integerValue,
  requireWorkspaceRole,
  stableId,
  stringArrayValue,
  stringValue,
  timestampValue,
} from './server-data';
import { normalizeShopDomain } from './shopify';

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
  provider: 'shopify';
  uid: string;
  workspaceId: string;
  shop: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

type ShopifyToken = { access_token?: string; scope?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number };
type ShopifyGraph = { data?: { shop?: { id?: string; name?: string; myshopifyDomain?: string; primaryDomain?: { url?: string } } }; errors?: Array<{ message?: string }> };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function parseCookie(req: ApiRequest, name: string) {
  const raw = req.headers?.cookie;
  const cookieHeader = Array.isArray(raw) ? raw.join(';') : raw || '';
  const match = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function bytesToHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(message: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}

export async function verifyShopifyQuery(query: ApiRequest['query'], secret: string) {
  const supplied = queryValue(query?.hmac).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
  const pairs = Object.entries(query || {})
    .filter(([key]) => !['hmac', 'signature'].includes(key))
    .map(([key, value]) => [key, queryValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const decodedMessage = pairs.map(([key, value]) => `${key}=${value}`).join('&');
  if (constantTimeEqual(await hmacHex(decodedMessage, secret), supplied)) return true;
  const encodedMessage = pairs.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  return constantTimeEqual(await hmacHex(encodedMessage, secret), supplied);
}

async function verifyState(value: string, secret: string): Promise<OAuthState> {
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) throw new Error('INVALID_STATE');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, base64ToBytes(signature), encoder.encode(payload));
  if (!valid) throw new Error('INVALID_STATE');
  const parsed = JSON.parse(decoder.decode(base64ToBytes(payload))) as OAuthState;
  if (
    parsed.provider !== 'shopify'
    || !parsed.uid
    || !/^[A-Za-z0-9_-]{8,200}$/.test(parsed.workspaceId)
    || normalizeShopDomain(parsed.shop) !== parsed.shop
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
  res.setHeader('Set-Cookie', 'orin_shopify_oauth=; Max-Age=0; Path=/api/integrations/shopify; HttpOnly; Secure; SameSite=Lax');
  res.setHeader('Location', `https://www.orin.work/app/integrations?provider=shopify&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}

async function exchangeToken(shop: string, code: string, clientId: string, clientSecret: string) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as ShopifyToken;
  if (!response.ok || !payload.access_token) throw new Error('SHOPIFY_TOKEN_EXCHANGE_FAILED');
  return payload;
}

async function shopIdentity(shop: string, accessToken: string, apiVersion: string) {
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query: 'query OrinShopIdentity { shop { id name myshopifyDomain primaryDomain { url } } }' }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as ShopifyGraph;
  const identity = payload.data?.shop;
  if (!response.ok || payload.errors?.length || !identity?.id || !identity.name || normalizeShopDomain(identity.myshopifyDomain || '') !== shop) {
    throw new Error('SHOPIFY_IDENTITY_FAILED');
  }
  return identity;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method not allowed');
  }
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  const stateSecret = process.env.OAUTH_STATE_SECRET || '';
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (!clientId || !clientSecret || stateSecret.length < 32 || !encryptionKey) return redirect(res, 'not_configured');

  try {
    if (!await verifyShopifyQuery(req.query, clientSecret)) return redirect(res, 'invalid_signature');
    const code = queryValue(req.query?.code);
    const stateValue = queryValue(req.query?.state);
    const shop = normalizeShopDomain(queryValue(req.query?.shop));
    if (!code || !stateValue) return redirect(res, 'invalid_callback');
    const state = await verifyState(stateValue, stateSecret);
    if (state.shop !== shop || parseCookie(req, 'orin_shopify_oauth') !== state.nonce) return redirect(res, 'invalid_state');

    const token = await exchangeToken(shop, code, clientId, clientSecret);
    const apiVersion = process.env.SHOPIFY_API_VERSION || '2026-07';
    const identity = await shopIdentity(shop, token.access_token!, apiVersion);
    const encrypted = await encryptJson({
      provider: 'shopify',
      shop,
      accessToken: token.access_token,
      scope: token.scope || '',
      apiVersion,
      refreshToken: token.refresh_token || null,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
      refreshTokenExpiresAt: token.refresh_token_expires_in ? new Date(Date.now() + token.refresh_token_expires_in * 1000).toISOString() : null,
    }, encryptionKey);
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, state.workspaceId, state.uid);
    const now = new Date().toISOString();
    const routeId = `shopify_${await stableId('shopify-route', shop)}`;
    await commitWrites(projectId, accessToken, [
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connectorVault/shopify`), fields: {
          provider: stringValue('shopify'), ownerId: stringValue(state.uid), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), encryptionVersion: integerValue(1), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connections/shopify`), fields: {
          provider: stringValue('shopify'), displayName: stringValue(identity.name!), shopDomain: stringValue(shop), shopId: stringValue(identity.id!), primaryDomain: stringValue(identity.primaryDomain?.url || ''), routeId: stringValue(routeId), apiVersion: stringValue(apiVersion), status: stringValue('configuration_required'), authorizationStatus: stringValue('authorized'), credentialState: stringValue('stored_server_side'), health: stringValue('webhook_pending'), desiredChannels: stringArrayValue(['Orders', 'Customers', 'Store events']), authorizedBy: stringValue(state.uid), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      },
      {
        update: { name: documentName(projectId, `connectorRoutes/${routeId}`), fields: {
          provider: stringValue('shopify'), accountType: stringValue('shop'), providerAccountId: stringValue(shop), shopDomain: stringValue(shop), workspaceId: stringValue(state.workspaceId), ownerId: stringValue(state.uid), active: booleanValue(true), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      },
    ]);
    return redirect(res, 'authorized');
  } catch (cause) {
    console.error('Shopify authorization callback failed', cause);
    return redirect(res, 'error');
  }
}
