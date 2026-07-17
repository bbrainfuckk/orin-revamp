import {
  base64ToBytes,
  booleanValue,
  commitWrites,
  documentName,
  encryptJson,
  getDocument,
  googleAccessToken,
  integerValue,
  requireWorkspaceRole,
  stableId,
  stringArrayValue,
  stringValue,
  timestampValue,
} from './server-data.ts';
import { signShopeePublic, signShopeeShop, type ShopeeShopToken } from './shopee.ts';

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

type ShopeeOAuthState = {
  provider: 'shopee';
  uid: string;
  workspaceId: string;
  agentId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

type TokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expire_in?: unknown;
  shop_id_list?: unknown;
  error?: unknown;
  message?: unknown;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function numericId(value: unknown) {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? String(Math.trunc(value)) : cleanText(value, 40);
  return /^\d{1,20}$/.test(normalized) ? normalized : '';
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function parseCookie(req: ApiRequest, name: string) {
  const raw = req.headers?.cookie;
  const cookieHeader = Array.isArray(raw) ? raw.join(';') : raw || '';
  const match = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

async function verifyState(value: string, secret: string): Promise<ShopeeOAuthState> {
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) throw new Error('INVALID_STATE');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('HMAC', key, base64ToBytes(signature), encoder.encode(payload))) throw new Error('INVALID_STATE');
  const parsed = JSON.parse(decoder.decode(base64ToBytes(payload))) as ShopeeOAuthState;
  if (
    parsed.provider !== 'shopee'
    || !parsed.uid
    || !/^[A-Za-z0-9_-]{8,200}$/.test(parsed.workspaceId)
    || !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.agentId)
    || !parsed.nonce
    || !Number.isFinite(parsed.issuedAt)
    || !Number.isFinite(parsed.expiresAt)
    || parsed.issuedAt > Date.now() + 60_000
    || parsed.expiresAt < Date.now()
    || parsed.expiresAt - parsed.issuedAt > 10 * 60 * 1_000
  ) throw new Error('INVALID_STATE');
  return parsed;
}

function redirect(res: ApiResponse, status: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'orin_shopee_oauth=; Max-Age=0; Path=/api/integrations/shopee; HttpOnly; Secure; SameSite=Lax');
  res.setHeader('Location', `https://www.orin.work/app/integrations?provider=shopee&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}

function readyAgent(agent: Awaited<ReturnType<typeof getDocument>>) {
  const readiness = Number(agent?.fields?.readiness?.integerValue || 0);
  const channels = agent?.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [];
  return readiness >= 6 && channels.some((channel) => channel.stringValue === 'Shopee');
}

function fieldStringArray(document: Awaited<ReturnType<typeof getDocument>>, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}

function shopeeHost() {
  return process.env.SHOPEE_API_HOST || 'https://partner.shopeemobile.com';
}

async function publicPost(path: string, body: Record<string, string | number>, partnerId: string, partnerKey: string) {
  const timestamp = Math.floor(Date.now() / 1_000);
  const sign = await signShopeePublic(path, timestamp, partnerId, partnerKey);
  const url = new URL(`${shopeeHost()}${path}`);
  url.search = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign }).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({})) as TokenPayload;
  if (!response.ok || cleanText(payload.error, 120)) throw new Error(`SHOPEE_API_${cleanText(payload.error, 80) || response.status}`);
  return payload;
}

function tokenFields(payload: TokenPayload) {
  const accessToken = cleanText(payload.access_token, 4_096);
  const refreshToken = cleanText(payload.refresh_token, 4_096);
  const expiresIn = positiveInteger(payload.expire_in);
  if (accessToken.length < 8 || refreshToken.length < 8 || !expiresIn) throw new Error('SHOPEE_TOKEN_EXCHANGE_FAILED');
  return { accessToken, refreshToken, expiresIn };
}

async function shopInfo(shopId: string, accessToken: string, partnerId: string, partnerKey: string) {
  const path = '/api/v2/shop/get_shop_info';
  const timestamp = Math.floor(Date.now() / 1_000);
  const sign = await signShopeeShop(path, timestamp, accessToken, shopId, partnerId, partnerKey);
  const url = new URL(`${shopeeHost()}${path}`);
  url.search = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), access_token: accessToken, shop_id: shopId, sign }).toString();
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const inner = payload.response && typeof payload.response === 'object' ? payload.response as Record<string, unknown> : {};
  return {
    shopName: cleanText(inner.shop_name, 160) || `Shopee shop ${shopId.slice(-4)}`,
    region: cleanText(inner.region, 8).toUpperCase(),
  };
}

async function exchangeTokens(code: string, shopId: string, mainAccountId: string, partnerId: string, partnerKey: string): Promise<ShopeeShopToken[]> {
  const first = await publicPost('/api/v2/auth/token/get', {
    code,
    partner_id: Number(partnerId),
    ...(shopId ? { shop_id: Number(shopId) } : { main_account_id: Number(mainAccountId) }),
  }, partnerId, partnerKey);
  const initial = tokenFields(first);
  const shopIds = shopId ? [shopId] : (Array.isArray(first.shop_id_list) ? first.shop_id_list : []).map(numericId).filter(Boolean);
  if (!shopIds.length) throw new Error('SHOPEE_NO_AUTHORIZED_SHOPS');

  const tokens: ShopeeShopToken[] = [];
  for (const authorizedShopId of [...new Set(shopIds)].slice(0, 100)) {
    const token = shopId
      ? initial
      : tokenFields(await publicPost('/api/v2/auth/access_token/get', {
        partner_id: Number(partnerId),
        shop_id: Number(authorizedShopId),
        refresh_token: initial.refreshToken,
      }, partnerId, partnerKey));
    const info = await shopInfo(authorizedShopId, token.accessToken, partnerId, partnerKey).catch(() => ({ shopName: `Shopee shop ${authorizedShopId.slice(-4)}`, region: '' }));
    tokens.push({
      shopId: authorizedShopId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: new Date(Date.now() + token.expiresIn * 1_000).toISOString(),
      ...info,
    });
  }
  return tokens;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method not allowed');
  }
  const partnerId = process.env.SHOPEE_PARTNER_ID || '';
  const partnerKey = process.env.SHOPEE_PARTNER_KEY || '';
  const stateSecret = process.env.OAUTH_STATE_SECRET || '';
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (!/^\d{1,20}$/.test(partnerId) || partnerKey.length < 16 || stateSecret.length < 32 || !encryptionKey) return redirect(res, 'not_configured');
  if (queryValue(req.query?.error)) return redirect(res, 'cancelled');

  try {
    const code = queryValue(req.query?.code);
    const stateValue = queryValue(req.query?.state);
    const shopId = numericId(queryValue(req.query?.shop_id));
    const mainAccountId = numericId(queryValue(req.query?.main_account_id));
    if (!code || code.length > 4_096 || !stateValue || (!shopId && !mainAccountId) || (shopId && mainAccountId)) return redirect(res, 'invalid_callback');
    const state = await verifyState(stateValue, stateSecret);
    if (parseCookie(req, 'orin_shopee_oauth') !== state.nonce) return redirect(res, 'invalid_state');
    const shops = await exchangeTokens(code, shopId, mainAccountId, partnerId, partnerKey);
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, state.workspaceId, state.uid);
    const agent = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/agents/${state.agentId}`);
    if (!readyAgent(agent)) return redirect(res, 'agent_not_ready');

    const existing = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/connections/shopee`);
    const routes = await Promise.all(shops.map(async (shop) => ({
      ...shop,
      shopHash: await stableId('shopee-shop', shop.shopId),
      routeId: `shopee_shop_${await stableId('shopee-shop', shop.shopId)}`,
    })));
    const routeIds = routes.map((route) => route.routeId);
    const staleRouteIds = fieldStringArray(existing, 'routeIds').filter((routeId) => /^shopee_shop_[A-Za-z0-9_-]{40}$/.test(routeId) && !routeIds.includes(routeId));
    const now = new Date().toISOString();
    const encrypted = await encryptJson({ provider: 'shopee', partnerId, shops }, encryptionKey);
    const webhookConfigured = process.env.SHOPEE_WEBHOOKS_CONFIGURED === 'true';
    const regions = [...new Set(shops.map((shop) => shop.region).filter(Boolean))];
    const displayName = shops.length === 1 ? shops[0].shopName : `${shops.length} Shopee shops`;
    const earliestExpiry = shops.map((shop) => shop.expiresAt).sort()[0];
    const writes: unknown[] = [
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connectorVault/shopee`), fields: {
          provider: stringValue('shopee'), ownerId: stringValue(state.uid), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), encryptionVersion: integerValue(1), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connections/shopee`), fields: {
          provider: stringValue('shopee'), displayName: stringValue(displayName), status: stringValue(webhookConfigured ? 'connected' : 'configuration_required'), authorizationStatus: stringValue('authorized'), credentialState: stringValue('stored_server_side'), health: stringValue(webhookConfigured ? 'awaiting_first_event' : 'webhook_not_configured'), desiredChannels: stringArrayValue(['Customer messages']), regions: stringArrayValue(regions), shopIdHashes: stringArrayValue(routes.map((route) => route.shopHash)), routeIds: stringArrayValue(routeIds), shopCount: integerValue(shops.length), agentId: stringValue(state.agentId), autoReplyEnabled: booleanValue(true), autoReplyChannels: stringArrayValue(['Shopee']), authorizedBy: stringValue(state.uid), tokenExpiresAt: timestampValue(earliestExpiry), partnerAccessStatus: stringValue('approved'), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/agents/${state.agentId}`), fields: { status: stringValue('active') } },
        updateMask: { fieldPaths: ['status'] },
        updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: true },
      },
      ...routes.map((route) => ({
        update: { name: documentName(projectId, `connectorRoutes/${route.routeId}`), fields: {
          provider: stringValue('shopee'), accountType: stringValue('seller'), providerAccountId: stringValue(route.shopId), displayName: stringValue(route.shopName), country: stringValue(route.region), workspaceId: stringValue(state.workspaceId), ownerId: stringValue(state.uid), active: booleanValue(true), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      })),
      ...staleRouteIds.map((routeId) => ({ delete: documentName(projectId, `connectorRoutes/${routeId}`) })),
    ];
    await commitWrites(projectId, accessToken, writes);
    return redirect(res, 'authorized');
  } catch (cause) {
    console.error('Shopee authorization callback failed', cause);
    return redirect(res, 'error');
  }
}
