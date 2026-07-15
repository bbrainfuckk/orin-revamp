import { whatsappCallback } from '../../../server/whatsapp-onboarding.ts';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  end: (payload?: string) => void;
  json: (payload: unknown) => void;
};

type MetaOAuthState = {
  provider: 'meta';
  uid: string;
  workspaceId: string;
  agentId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

type TikTokOAuthState = {
  provider: 'tiktok';
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
  tasks?: string[];
  instagram_business_account?: { id?: string; username?: string };
};
type MetaPageResponse = { data?: MetaPage[] };
type MetaSubscriptionResponse = { success?: boolean };
type TikTokTokenResponse = {
  access_token?: string;
  expires_in?: number;
  open_id?: string;
  refresh_expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};
type TikTokUserResponse = {
  data?: { user?: { open_id?: string; union_id?: string; avatar_url?: string; display_name?: string } };
  error?: { code?: string; message?: string; log_id?: string };
};
type GoogleTokenResponse = { access_token?: string; expires_in?: number; token_type?: string };
type FirestoreDocument = { fields?: Record<string, { stringValue?: string }> };

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

async function verifySignedState(state: string, secret: string) {
  const [payload, signature, extra] = state.split('.');
  if (!payload || !signature || extra) throw new Error('INVALID_STATE');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key, base64ToBytes(signature), encoder.encode(payload));
  if (!valid) throw new Error('INVALID_STATE');
  return JSON.parse(decoder.decode(base64ToBytes(payload))) as Record<string, unknown>;
}

function validStateLifetime(parsed: Record<string, unknown>) {
  return typeof parsed.uid === 'string'
    && parsed.workspaceId === `personal_${parsed.uid}`
    && typeof parsed.nonce === 'string'
    && Boolean(parsed.nonce)
    && typeof parsed.issuedAt === 'number'
    && Number.isFinite(parsed.issuedAt)
    && typeof parsed.expiresAt === 'number'
    && Number.isFinite(parsed.expiresAt)
    && parsed.issuedAt <= Date.now() + 60_000
    && parsed.expiresAt >= Date.now()
    && parsed.expiresAt - parsed.issuedAt <= 10 * 60 * 1000;
}

async function verifyMetaState(state: string, secret: string): Promise<MetaOAuthState> {
  const parsed = await verifySignedState(state, secret);
  if (
    parsed.provider !== 'meta'
    || !validStateLifetime(parsed)
    || typeof parsed.agentId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.agentId)
  ) throw new Error('INVALID_STATE');
  return parsed as MetaOAuthState;
}

async function verifyTikTokState(state: string, secret: string): Promise<TikTokOAuthState> {
  const parsed = await verifySignedState(state, secret);
  if (parsed.provider !== 'tiktok' || !validStateLifetime(parsed)) throw new Error('INVALID_STATE');
  return parsed as TikTokOAuthState;
}

function redirectMeta(res: ApiResponse, status: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'orin_meta_oauth=; Max-Age=0; Path=/api/integrations/meta; HttpOnly; Secure; SameSite=Lax');
  res.setHeader('Location', `https://www.orin.work/app/integrations?provider=meta&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}

function redirectTikTok(res: ApiResponse, status: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'orin_tiktok_oauth=; Max-Age=0; Path=/api/integrations/tiktok; HttpOnly; Secure; SameSite=Lax');
  res.setHeader('Location', `https://www.orin.work/app/integrations?provider=tiktok&status=${encodeURIComponent(status)}`);
  return res.status(302).end();
}

async function fetchJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `Provider request failed with HTTP ${response.status}`);
  return payload;
}

type SubscriptionResult = {
  accountId: string;
  accountType: 'page' | 'instagram';
  subscribed: boolean;
};

async function subscribeAccount(
  graphVersion: string,
  accountId: string,
  accountType: SubscriptionResult['accountType'],
  accessToken: string,
): Promise<SubscriptionResult> {
  const host = accountType === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const url = new URL(`https://${host}/${graphVersion}/${encodeURIComponent(accountId)}/subscribed_apps`);
  try {
    const result = await fetchJson<MetaSubscriptionResponse>(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ subscribed_fields: 'messages,messaging_postbacks' }),
    });
    return { accountId, accountType, subscribed: result.success === true };
  } catch {
    console.warn(`Meta ${accountType} subscription was not accepted`);
    return { accountId, accountType, subscribed: false };
  }
}

async function encryptCredential(payload: unknown, base64Key: string) {
  const keyBytes = base64ToBytes(base64Key.trim());
  if (keyBytes.byteLength !== 32) throw new Error('INVALID_ENCRYPTION_KEY');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}

async function stableId(...parts: string[]) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(parts.join('\u001f')));
  return bytesToBase64Url(new Uint8Array(digest)).slice(0, 40);
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
const booleanValue = (value: boolean) => ({ booleanValue: value });

async function commitFirestoreDocuments(
  projectId: string,
  accessToken: string,
  documents: Array<{ path: string; fields: Record<string, unknown>; updateMask?: string[]; updateTime?: boolean; mustExist?: boolean }>,
  deletePaths: string[] = [],
) {
  const baseName = `projects/${projectId}/databases/(default)/documents`;
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writes: [
        ...documents.map((document) => ({
          update: { name: `${baseName}/${document.path}`, fields: document.fields },
          ...(document.updateMask ? { updateMask: { fieldPaths: document.updateMask } } : {}),
          ...(document.updateTime ? { updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }] } : {}),
          ...(document.mustExist ? { currentDocument: { exists: true } } : {}),
        })),
        ...deletePaths.map((path) => ({ delete: `${baseName}/${path}` })),
      ],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`FIRESTORE_COMMIT_FAILED:${response.status}:${payload.slice(0, 160)}`);
  }
}

async function getFirestoreDocument(projectId: string, accessToken: string, path: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`FIRESTORE_READ_FAILED:${response.status}`);
  return response.json() as Promise<FirestoreDocument>;
}

async function fetchTikTokToken(code: string, redirectUri: string, clientKey: string, clientSecret: string) {
  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as TikTokTokenResponse;
  if (
    !response.ok
    || payload.error
    || typeof payload.access_token !== 'string'
    || payload.access_token.length < 20
    || typeof payload.refresh_token !== 'string'
    || payload.refresh_token.length < 20
    || typeof payload.open_id !== 'string'
    || !payload.open_id
    || typeof payload.scope !== 'string'
    || typeof payload.expires_in !== 'number'
    || !Number.isFinite(payload.expires_in)
    || payload.expires_in <= 0
    || typeof payload.refresh_expires_in !== 'number'
    || !Number.isFinite(payload.refresh_expires_in)
    || payload.refresh_expires_in <= 0
    || payload.token_type?.toLowerCase() !== 'bearer'
  ) {
    throw new Error(payload.error_description || payload.error || `TikTok token request failed with HTTP ${response.status}`);
  }
  return payload;
}

async function fetchTikTokUser(accessToken: string) {
  const url = new URL('https://open.tiktokapis.com/v2/user/info/');
  url.searchParams.set('fields', 'open_id,union_id,avatar_url,display_name');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as TikTokUserResponse;
  if (!response.ok || payload.error?.code !== 'ok' || !payload.data?.user?.open_id) {
    throw new Error(payload.error?.message || `TikTok account request failed with HTTP ${response.status}`);
  }
  return payload.data.user;
}

async function handleTikTokCallback(req: ApiRequest, res: ApiResponse) {
  const clientKey = process.env.TIKTOK_CLIENT_KEY || '';
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET || '';
  const stateSecret = process.env.OAUTH_STATE_SECRET || '';
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (!clientKey || !clientSecret || stateSecret.length < 32 || !encryptionKey) return redirectTikTok(res, 'not_configured');

  try {
    const providerError = stringQuery(req.query?.error);
    if (providerError) return redirectTikTok(res, providerError === 'access_denied' ? 'cancelled' : 'provider_error');
    const code = stringQuery(req.query?.code);
    const stateValue = stringQuery(req.query?.state);
    if (!code || !stateValue) return redirectTikTok(res, 'invalid_callback');
    const state = await verifyTikTokState(stateValue, stateSecret);
    if (parseCookie(req, 'orin_tiktok_oauth') !== state.nonce) return redirectTikTok(res, 'invalid_state');

    const redirectUri = process.env.TIKTOK_REDIRECT_URI || 'https://www.orin.work/api/integrations/tiktok/callback';
    const token = await fetchTikTokToken(code, redirectUri, clientKey, clientSecret);
    const grantedScopes = (token.scope || '').split(',').map((scope) => scope.trim()).filter(Boolean);
    if (!grantedScopes.includes('user.info.basic')) return redirectTikTok(res, 'scope_missing');
    const user = await fetchTikTokUser(token.access_token!);
    if (user.open_id !== token.open_id) throw new Error('TIKTOK_ACCOUNT_MISMATCH');

    const openIdHash = await stableId('tiktok-account', token.open_id!);
    const unionIdHash = user.union_id ? await stableId('tiktok-union', user.union_id) : '';
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + Math.max(0, token.expires_in || 0) * 1000).toISOString();
    const refreshExpiresAt = new Date(Date.now() + Math.max(0, token.refresh_expires_in || 0) * 1000).toISOString();
    const encrypted = await encryptCredential({
      provider: 'tiktok',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      openId: token.open_id,
      unionId: user.union_id || null,
      avatarUrl: user.avatar_url || null,
      grantedScopes,
      expiresAt,
      refreshExpiresAt,
    }, encryptionKey);
    const { accessToken: googleToken, projectId } = await googleAccessToken();
    const previousConnection = await getFirestoreDocument(projectId, googleToken, `workspaces/${state.workspaceId}/connections/tiktok`);
    const previousOpenIdHash = previousConnection?.fields?.openIdHash?.stringValue || '';
    const staleRoute = previousOpenIdHash && previousOpenIdHash !== openIdHash && /^[A-Za-z0-9_-]{20,64}$/.test(previousOpenIdHash)
      ? [`connectorRoutes/tiktok_user_${previousOpenIdHash}`]
      : [];
    const webhookConfigured = process.env.TIKTOK_WEBHOOKS_CONFIGURED === 'true';

    await commitFirestoreDocuments(projectId, googleToken, [
      {
        path: `workspaces/${state.workspaceId}/connectorVault/tiktok`,
        fields: {
          provider: stringValue('tiktok'),
          ownerId: stringValue(state.uid),
          ciphertext: stringValue(encrypted.ciphertext),
          iv: stringValue(encrypted.iv),
          encryptionVersion: integerValue(1),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now),
        },
      },
      {
        path: `workspaces/${state.workspaceId}/connections/tiktok`,
        fields: {
          provider: stringValue('tiktok'),
          displayName: stringValue(user.display_name?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'TikTok account'),
          status: stringValue('access_review'),
          authorizationStatus: stringValue('authorized'),
          credentialState: stringValue('stored_server_side'),
          health: stringValue('identity_verified'),
          identityAccess: stringValue('connected'),
          messagingAccess: stringValue('partner_approval_required'),
          shopAccess: stringValue('separate_partner_product_required'),
          webhookConfigured: booleanValue(webhookConfigured),
          desiredChannels: stringArrayValue(['TikTok account identity']),
          grantedScopes: stringArrayValue(grantedScopes),
          openIdHash: stringValue(openIdHash),
          unionIdHash: stringValue(unionIdHash),
          expiresAt: timestampValue(expiresAt),
          refreshExpiresAt: timestampValue(refreshExpiresAt),
          authorizedBy: stringValue(state.uid),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now),
        },
      },
      {
        path: `connectorRoutes/tiktok_user_${openIdHash}`,
        fields: {
          provider: stringValue('tiktok'),
          accountType: stringValue('user'),
          providerAccountId: stringValue(token.open_id!),
          workspaceId: stringValue(state.workspaceId),
          ownerId: stringValue(state.uid),
          active: booleanValue(true),
          updatedAt: timestampValue(now),
        },
      },
    ], staleRoute);
    return redirectTikTok(res, 'authorized');
  } catch (cause) {
    console.error('TikTok authorization callback failed', cause);
    return redirectTikTok(res, 'error');
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (stringQuery(req.query?.provider) === 'whatsapp') return whatsappCallback(req, res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end('Method not allowed');
  }

  if (stringQuery(req.query?.provider) === 'tiktok') return handleTikTokCallback(req, res);

  const appId = process.env.META_APP_ID || '';
  const appSecret = process.env.META_APP_SECRET || '';
  const stateSecret = process.env.OAUTH_STATE_SECRET || '';
  const encryptionKey = process.env.CONNECTOR_ENCRYPTION_KEY || '';
  if (!appId || !appSecret || stateSecret.length < 32 || !encryptionKey) return redirectMeta(res, 'not_configured');

  try {
    const providerError = stringQuery(req.query?.error);
    if (providerError) return redirectMeta(res, providerError === 'access_denied' ? 'cancelled' : 'provider_error');

    const code = stringQuery(req.query?.code);
    const stateValue = stringQuery(req.query?.state);
    if (!code || !stateValue) return redirectMeta(res, 'invalid_callback');
    const state = await verifyMetaState(stateValue, stateSecret);
    if (parseCookie(req, 'orin_meta_oauth') !== state.nonce) return redirectMeta(res, 'invalid_state');

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
      fields: 'id,name,access_token,tasks,instagram_business_account{id,username}',
      limit: '100',
    }).toString();
    const pageResponse = await fetchJson<MetaPageResponse>(pagesUrl, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const pages = (pageResponse.data || []).filter((page) => page.id && page.name && page.access_token);
    if (!pages.length) return redirectMeta(res, 'no_pages');

    const subscriptionResults = await Promise.all(pages.flatMap((page) => {
      const pageSubscription = subscribeAccount(graphVersion, page.id!, 'page', page.access_token!);
      const instagramId = page.instagram_business_account?.id;
      return instagramId
        ? [pageSubscription, subscribeAccount(graphVersion, instagramId, 'instagram', page.access_token!)]
        : [pageSubscription];
    }));
    const subscribedPageIds = subscriptionResults.filter((result) => result.accountType === 'page' && result.subscribed).map((result) => result.accountId);
    const failedPageIds = subscriptionResults.filter((result) => result.accountType === 'page' && !result.subscribed).map((result) => result.accountId);
    const subscribedInstagramIds = subscriptionResults.filter((result) => result.accountType === 'instagram' && result.subscribed).map((result) => result.accountId);
    const failedInstagramIds = subscriptionResults.filter((result) => result.accountType === 'instagram' && !result.subscribed).map((result) => result.accountId);
    const everyAccountSubscribed = subscriptionResults.length > 0 && subscriptionResults.every((result) => result.subscribed);
    const webhookConfigured = Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN);
    const subscriptionStatus = everyAccountSubscribed ? 'subscribed' : subscriptionResults.some((result) => result.subscribed) ? 'partial' : 'failed';

    const encrypted = await encryptCredential({
      provider: 'meta',
      graphVersion,
      userAccessToken: userToken,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        accessToken: page.access_token,
        tasks: Array.isArray(page.tasks) ? page.tasks : [],
        instagramBusinessAccount: page.instagram_business_account || null,
      })),
    }, encryptionKey);

    const { accessToken: googleToken, projectId } = await googleAccessToken();
    const agentResponse = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/workspaces/${encodeURIComponent(state.workspaceId)}/agents/${encodeURIComponent(state.agentId)}`, {
      headers: { Authorization: `Bearer ${googleToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!agentResponse.ok) return redirectMeta(res, 'agent_not_ready');
    const agentDocument = await agentResponse.json() as {
      fields?: {
        readiness?: { integerValue?: string };
        config?: { mapValue?: { fields?: { channels?: { arrayValue?: { values?: Array<{ stringValue?: string }> } } } } };
      };
    };
    const readiness = Number(agentDocument.fields?.readiness?.integerValue || 0);
    const autoReplyChannels = (agentDocument.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [])
      .flatMap((value) => value.stringValue && ['Messenger', 'Instagram'].includes(value.stringValue) ? [value.stringValue] : []);
    if (readiness < 6 || !autoReplyChannels.length) return redirectMeta(res, 'agent_not_ready');
    const now = new Date().toISOString();
    const pageIds = pages.map((page) => page.id!);
    const pageNames = pages.map((page) => page.name!);
    const instagramAccountIds = pages.map((page) => page.instagram_business_account?.id).filter((value): value is string => Boolean(value));
    const desiredChannels = ['Facebook Pages', 'Messenger', ...(instagramAccountIds.length ? ['Instagram'] : [])];

    const routeDocuments = pages.flatMap((page) => {
      const pageRoute = {
        path: `connectorRoutes/meta_page_${page.id}`,
        fields: {
          provider: stringValue('meta'),
          accountType: stringValue('page'),
          providerAccountId: stringValue(page.id!),
          pageId: stringValue(page.id!),
          workspaceId: stringValue(state.workspaceId),
          ownerId: stringValue(state.uid),
          active: booleanValue(true),
          updatedAt: timestampValue(now),
        },
      };
      const instagramId = page.instagram_business_account?.id;
      return instagramId ? [pageRoute, {
        path: `connectorRoutes/meta_instagram_${instagramId}`,
        fields: {
          provider: stringValue('meta'),
          accountType: stringValue('instagram'),
          providerAccountId: stringValue(instagramId),
          pageId: stringValue(page.id!),
          workspaceId: stringValue(state.workspaceId),
          ownerId: stringValue(state.uid),
          active: booleanValue(true),
          updatedAt: timestampValue(now),
        },
      }] : [pageRoute];
    });

    await commitFirestoreDocuments(projectId, googleToken, [
      {
        path: `workspaces/${state.workspaceId}/connectorVault/meta`,
        fields: {
          provider: stringValue('meta'),
          ownerId: stringValue(state.uid),
          ciphertext: stringValue(encrypted.ciphertext),
          iv: stringValue(encrypted.iv),
          encryptionVersion: integerValue(1),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now),
        },
      },
      {
        path: `workspaces/${state.workspaceId}/connections/meta`,
        fields: {
          provider: stringValue('meta'),
          displayName: stringValue(pageNames.length === 1 ? pageNames[0] : `${pageNames.length} Meta Pages`),
          status: stringValue(everyAccountSubscribed && webhookConfigured ? 'connected' : 'attention_required'),
          authorizationStatus: stringValue('authorized'),
          credentialState: stringValue('stored_server_side'),
          health: stringValue(!webhookConfigured ? 'webhook_not_configured' : everyAccountSubscribed ? 'awaiting_first_event' : 'subscription_partial'),
          subscriptionStatus: stringValue(subscriptionStatus),
          subscribedPageIds: stringArrayValue(subscribedPageIds),
          failedPageIds: stringArrayValue(failedPageIds),
          subscribedInstagramAccountIds: stringArrayValue(subscribedInstagramIds),
          failedInstagramAccountIds: stringArrayValue(failedInstagramIds),
          desiredChannels: stringArrayValue(desiredChannels),
          pageIds: stringArrayValue(pageIds),
          pageNames: stringArrayValue(pageNames),
          instagramAccountIds: stringArrayValue(instagramAccountIds),
          graphVersion: stringValue(graphVersion),
          agentId: stringValue(state.agentId),
          autoReplyEnabled: booleanValue(true),
          autoReplyChannels: stringArrayValue(autoReplyChannels),
          authorizedBy: stringValue(state.uid),
          createdAt: timestampValue(now),
          updatedAt: timestampValue(now),
        },
      },
      {
        path: `workspaces/${state.workspaceId}/agents/${state.agentId}`,
        fields: { status: stringValue('active') },
        updateMask: ['status'],
        updateTime: true,
        mustExist: true,
      },
      ...routeDocuments,
    ]);

    return redirectMeta(res, 'authorized');
  } catch (cause) {
    console.error('Meta authorization callback failed', cause);
    return redirectMeta(res, 'error');
  }
}
