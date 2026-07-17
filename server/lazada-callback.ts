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
} from './server-data';
import { parseLazadaToken, signLazadaRequest, type LazadaToken } from './lazada';

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

type LazadaOAuthState = {
  provider: 'lazada';
  uid: string;
  workspaceId: string;
  agentId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

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

async function verifyState(value: string, secret: string): Promise<LazadaOAuthState> {
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) throw new Error('INVALID_STATE');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, base64ToBytes(signature), encoder.encode(payload));
  if (!valid) throw new Error('INVALID_STATE');
  const parsed = JSON.parse(decoder.decode(base64ToBytes(payload))) as LazadaOAuthState;
  if (
    parsed.provider !== 'lazada'
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
  res.setHeader('Set-Cookie', 'orin_lazada_oauth=; Max-Age=0; Path=/api/integrations/lazada; HttpOnly; Secure; SameSite=Lax');
  res.setHeader('Location', `https://www.orin.work/app/integrations?provider=lazada&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}

function readyAgent(agent: Awaited<ReturnType<typeof getDocument>>) {
  const readiness = Number(agent?.fields?.readiness?.integerValue || 0);
  const channels = agent?.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [];
  return readiness >= 6 && channels.some((channel) => channel.stringValue === 'Lazada');
}

function fieldStringArray(document: Awaited<ReturnType<typeof getDocument>>, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}

async function exchangeToken(code: string, appKey: string, appSecret: string): Promise<LazadaToken> {
  const path = '/auth/token/create';
  const parameters: Record<string, string> = {
    app_key: appKey,
    code,
    sign_method: 'sha256',
    timestamp: String(Date.now()),
  };
  parameters.sign = await signLazadaRequest(path, parameters, appSecret);
  const response = await fetch(`https://auth.lazada.com/rest${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const token = parseLazadaToken(payload) || parseLazadaToken(payload.data);
  if (!response.ok || !token) throw new Error('LAZADA_TOKEN_EXCHANGE_FAILED');
  return token;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method not allowed');
  }
  const appKey = process.env.LAZADA_APP_KEY || '';
  const appSecret = process.env.LAZADA_APP_SECRET || '';
  const stateSecret = process.env.OAUTH_STATE_SECRET || '';
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (!appKey || !appSecret || stateSecret.length < 32 || !encryptionKey) return redirect(res, 'not_configured');
  if (queryValue(req.query?.error)) return redirect(res, 'cancelled');

  try {
    const code = queryValue(req.query?.code);
    const stateValue = queryValue(req.query?.state);
    if (!code || !stateValue || code.length > 4_096) return redirect(res, 'invalid_callback');
    const state = await verifyState(stateValue, stateSecret);
    if (parseCookie(req, 'orin_lazada_oauth') !== state.nonce) return redirect(res, 'invalid_state');
    const token = await exchangeToken(code, appKey, appSecret);
    const { projectId, accessToken } = await googleAccessToken();
    await requireWorkspaceRole(projectId, accessToken, state.workspaceId, state.uid);
    const agent = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/agents/${state.agentId}`);
    if (!readyAgent(agent)) return redirect(res, 'agent_not_ready');

    const existing = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/connections/lazada`);
    const newRoutes = await Promise.all(token.shops.map(async (shop) => ({
      ...shop,
      sellerHash: await stableId('lazada-seller', shop.sellerId),
      routeId: `lazada_seller_${await stableId('lazada-seller', shop.sellerId)}`,
    })));
    const routeIds = newRoutes.map((route) => route.routeId);
    const staleRouteIds = fieldStringArray(existing, 'routeIds').filter((routeId) => /^lazada_seller_[A-Za-z0-9_-]{40}$/.test(routeId) && !routeIds.includes(routeId));
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + token.expiresIn * 1_000).toISOString();
    const refreshExpiresAt = new Date(Date.now() + token.refreshExpiresIn * 1_000).toISOString();
    const encrypted = await encryptJson({
      provider: 'lazada',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt,
      refreshExpiresAt,
      accountPlatform: token.accountPlatform,
      country: token.country,
      shops: token.shops,
    }, encryptionKey);
    const webhookConfigured = process.env.LAZADA_WEBHOOKS_CONFIGURED === 'true';
    const countries = [...new Set(token.shops.map((shop) => shop.country.toUpperCase()))];
    const displayName = token.shops.length === 1 ? `Lazada shop · ${countries[0]}` : `${token.shops.length} Lazada shops`;
    const writes: unknown[] = [
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connectorVault/lazada`), fields: {
          provider: stringValue('lazada'), ownerId: stringValue(state.uid), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), encryptionVersion: integerValue(1), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/connections/lazada`), fields: {
          provider: stringValue('lazada'), displayName: stringValue(displayName), status: stringValue(webhookConfigured ? 'connected' : 'configuration_required'), authorizationStatus: stringValue('authorized'), credentialState: stringValue('stored_server_side'), health: stringValue(webhookConfigured ? 'awaiting_first_event' : 'webhook_not_configured'), desiredChannels: stringArrayValue(['Customer messages']), countries: stringArrayValue(countries), sellerIdHashes: stringArrayValue(newRoutes.map((route) => route.sellerHash)), routeIds: stringArrayValue(routeIds), shopCount: integerValue(token.shops.length), agentId: stringValue(state.agentId), autoReplyEnabled: booleanValue(true), autoReplyChannels: stringArrayValue(['Lazada']), authorizedBy: stringValue(state.uid), tokenExpiresAt: timestampValue(expiresAt), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      },
      {
        update: { name: documentName(projectId, `workspaces/${state.workspaceId}/agents/${state.agentId}`), fields: { status: stringValue('active') } },
        updateMask: { fieldPaths: ['status'] },
        updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
        currentDocument: { exists: true },
      },
      ...newRoutes.map((route) => ({
        update: { name: documentName(projectId, `connectorRoutes/${route.routeId}`), fields: {
          provider: stringValue('lazada'), accountType: stringValue('seller'), providerAccountId: stringValue(route.sellerId), providerUserId: stringValue(route.userId), country: stringValue(route.country), workspaceId: stringValue(state.workspaceId), ownerId: stringValue(state.uid), active: booleanValue(true), createdAt: timestampValue(now), updatedAt: timestampValue(now),
        } },
      })),
      ...staleRouteIds.map((routeId) => ({ delete: documentName(projectId, `connectorRoutes/${routeId}`) })),
    ];
    await commitWrites(projectId, accessToken, writes);
    return redirect(res, 'authorized');
  } catch (cause) {
    console.error('Lazada authorization callback failed', cause);
    return redirect(res, 'error');
  }
}
