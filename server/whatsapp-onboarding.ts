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
  booleanValue?: boolean;
  integerValue?: string;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};
type FirestoreDocument = { name?: string; fields?: Record<string, FirestoreValue> };
type FirestoreRunQueryRow = { document?: FirestoreDocument };
type WhatsAppState = {
  provider: 'whatsapp';
  uid: string;
  workspaceId: string;
  agentId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};
type DebugTokenResponse = {
  data?: {
    app_id?: string;
    type?: string;
    is_valid?: boolean;
    expires_at?: number;
    scopes?: string[];
    granular_scopes?: Array<{ scope?: string; target_ids?: string[] }>;
  };
};
type WabaResponse = { id?: string; name?: string; account_review_status?: string; error?: { message?: string } };
type PhoneNumber = {
  id?: string;
  verified_name?: string;
  display_phone_number?: string;
  quality_rating?: string;
  code_verification_status?: string;
  platform_type?: string;
};
type PhoneNumberResponse = { data?: PhoneNumber[]; error?: { message?: string } };
type GraphSuccess = { success?: boolean | string; error?: { message?: string } };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY
  || process.env.VITE_FIREBASE_API_KEY
  || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk';

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function bodyValue(req: ApiRequest) {
  try {
    return (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}) as Record<string, unknown>;
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}

function clean(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum) : '';
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

function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) mismatch |= leftBytes[index] ^ rightBytes[index];
  return mismatch === 0;
}

async function stableId(...parts: string[]) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(parts.join('\u001f')));
  return base64Url(new Uint8Array(digest)).slice(0, 40);
}

async function signState(payload: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

async function verifyState(value: string, secret: string): Promise<WhatsAppState> {
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) throw new Error('INVALID_STATE');
  const expected = await signState(payload, secret);
  if (!constantTimeEqual(signature, expected)) throw new Error('INVALID_STATE');
  const state = JSON.parse(decoder.decode(base64ToBytes(payload))) as Partial<WhatsAppState>;
  if (
    state.provider !== 'whatsapp'
    || typeof state.uid !== 'string'
    || state.workspaceId !== `personal_${state.uid}`
    || typeof state.agentId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(state.agentId)
    || typeof state.nonce !== 'string'
    || state.nonce.length < 20
    || typeof state.issuedAt !== 'number'
    || typeof state.expiresAt !== 'number'
    || state.issuedAt > Date.now() + 60_000
    || state.expiresAt < Date.now()
    || state.expiresAt - state.issuedAt > 10 * 60 * 1000
  ) throw new Error('INVALID_STATE');
  return state as WhatsAppState;
}

function cookie(req: ApiRequest, name: string) {
  const raw = req.headers?.cookie;
  const header = Array.isArray(raw) ? raw.join(';') : raw || '';
  const part = header.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

async function verifyFirebase(req: ApiRequest) {
  const raw = req.headers?.authorization;
  const authorization = Array.isArray(raw) ? raw[0] : raw;
  if (!authorization?.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');
  const idToken = authorization.slice(7).trim();
  if (!idToken) throw new Error('UNAUTHENTICATED');
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
    signal: AbortSignal.timeout(6_000),
  }).catch(() => null);
  if (!response?.ok) throw new Error(response ? 'UNAUTHENTICATED' : 'AUTH_SERVICE_UNAVAILABLE');
  const account = ((await response.json()) as FirebaseAccountLookup).users?.[0];
  if (!account?.localId || account.disabled) throw new Error('UNAUTHENTICATED');
  return account.localId;
}

async function googleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'orin-ai-502503';
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error('STORAGE_NOT_CONFIGURED');
  const privateKey = base64ToBytes(rawPrivateKey.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\s/g, ''));
  const signingKey = await crypto.subtle.importKey('pkcs8', privateKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
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

function path(value: string) {
  return value.split('/').map(encodeURIComponent).join('/');
}

async function getDocument(projectId: string, accessToken: string, documentPath: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path(documentPath)}`, {
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

function fieldStrings(document: FirestoreDocument | null, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((item) => item.stringValue ? [item.stringValue] : []);
}

function agentReady(document: FirestoreDocument | null) {
  const readiness = Number(document?.fields?.readiness?.integerValue || 0);
  const channels = document?.fields?.config?.mapValue?.fields?.channels?.arrayValue?.values || [];
  return readiness >= 6 && channels.some((channel) => channel.stringValue === 'WhatsApp');
}

async function queryConversationRoutes(projectId: string, accessToken: string, workspaceId: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'conversationRoutes' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'workspaceId' }, op: 'EQUAL', value: { stringValue: workspaceId } } },
        { fieldFilter: { field: { fieldPath: 'provider' }, op: 'EQUAL', value: { stringValue: 'whatsapp' } } },
      ] } },
      limit: 250,
    } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  return ((await response.json()) as FirestoreRunQueryRow[]).flatMap((row) => row.document?.name ? [row.document.name] : []);
}

async function commit(projectId: string, accessToken: string, writes: unknown[]) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error('STORAGE_UNAVAILABLE');
}

const stringValue = (value: string): FirestoreValue => ({ stringValue: value });
const integerValue = (value: number): FirestoreValue => ({ integerValue: String(Math.trunc(value)) });
const timestampValue = (value: string): FirestoreValue => ({ timestampValue: value });
const booleanValue = (value: boolean): FirestoreValue => ({ booleanValue: value });
const stringsValue = (values: string[]): FirestoreValue => ({ arrayValue: { values: values.map(stringValue) } });
const documentName = (projectId: string, value: string) => `projects/${projectId}/databases/(default)/documents/${value}`;

async function encrypt(value: unknown) {
  const keyBytes = base64ToBytes((process.env.CONNECTOR_ENCRYPTION_KEY || '').trim());
  if (keyBytes.byteLength !== 32) throw new Error('INVALID_ENCRYPTION_KEY');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}

async function graphJson<T>(url: URL, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || `Meta request failed with HTTP ${response.status}`);
  return payload;
}

async function disconnect(req: ApiRequest, res: ApiResponse, uid: string) {
  const workspaceId = clean(bodyValue(req).workspaceId, 200);
  if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
  const { projectId, accessToken } = await googleAccessToken();
  const [connection, conversationRoutes] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/whatsapp`),
    queryConversationRoutes(projectId, accessToken, workspaceId),
  ]);
  const base = `projects/${projectId}/databases/(default)/documents`;
  const names = [
    `${base}/workspaces/${workspaceId}/connections/whatsapp`,
    `${base}/workspaces/${workspaceId}/connectorVault/whatsapp`,
    ...fieldStrings(connection, 'routeIds').map((routeId) => `${base}/connectorRoutes/${routeId}`),
    ...conversationRoutes,
  ];
  await commit(projectId, accessToken, [...new Set(names)].map((name) => ({ delete: name })));
  return res.status(200).json({ ok: true, status: 'disconnected' });
}

export async function whatsappStart(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const uid = await verifyFirebase(req);
    if (req.method === 'DELETE') return disconnect(req, res, uid);
    const workspaceId = clean(queryValue(req.query?.workspaceId), 200);
    const agentId = clean(queryValue(req.query?.agentId), 128);
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(agentId)) return res.status(400).json({ ok: false, error: 'Choose a completed WhatsApp-ready ORIN AI' });
    const { projectId, accessToken } = await googleAccessToken();
    const agent = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/agents/${agentId}`);
    if (!agentReady(agent)) return res.status(409).json({ ok: false, error: 'Complete all six AI decisions and include WhatsApp before connecting' });

    const appId = process.env.META_APP_ID || '';
    const configId = process.env.META_WHATSAPP_CONFIG_ID || '';
    const stateSecret = process.env.OAUTH_STATE_SECRET || '';
    if (!appId || !process.env.META_APP_SECRET || !configId || stateSecret.length < 32 || !process.env.CONNECTOR_ENCRYPTION_KEY) {
      return res.status(503).json({ ok: false, error: 'WhatsApp Embedded Signup is not configured for this deployment yet' });
    }
    const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    const payload = base64Url(encoder.encode(JSON.stringify({
      provider: 'whatsapp', uid, workspaceId, agentId, nonce,
      issuedAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000,
    })));
    const state = `${payload}.${await signState(payload, stateSecret)}`;
    res.setHeader('Set-Cookie', `orin_whatsapp_signup=${encodeURIComponent(nonce)}; Max-Age=600; Path=/api/integrations/whatsapp; HttpOnly; Secure; SameSite=Lax`);
    return res.status(200).json({
      ok: true,
      embeddedSignup: {
        appId,
        configId,
        graphVersion: process.env.META_GRAPH_VERSION || 'v24.0',
        state,
      },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') return res.status(401).json({ ok: false, error: 'Sign in again to connect WhatsApp' });
    if (message === 'AUTH_SERVICE_UNAVAILABLE' || message.startsWith('STORAGE_')) return res.status(503).json({ ok: false, error: 'Secure WhatsApp setup is temporarily unavailable' });
    console.error('WhatsApp signup start failed', cause);
    return res.status(500).json({ ok: false, error: 'WhatsApp signup could not be started' });
  }
}

export async function whatsappCallback(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', 'orin_whatsapp_signup=; Max-Age=0; Path=/api/integrations/whatsapp; HttpOnly; Secure; SameSite=Lax');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const uid = await verifyFirebase(req);
    const body = bodyValue(req);
    const code = clean(body.code, 2_048);
    const stateValue = clean(body.state, 4_096);
    const reportedWabaId = clean(body.wabaId, 128);
    const reportedPhoneId = clean(body.phoneNumberId, 128);
    if (!code || !stateValue) return res.status(400).json({ ok: false, error: 'Meta did not return a complete WhatsApp authorization' });
    const state = await verifyState(stateValue, process.env.OAUTH_STATE_SECRET || '');
    if (state.uid !== uid || cookie(req, 'orin_whatsapp_signup') !== state.nonce) return res.status(403).json({ ok: false, error: 'The WhatsApp signup session expired. Start again.' });

    const appId = process.env.META_APP_ID || '';
    const appSecret = process.env.META_APP_SECRET || '';
    const graphVersion = process.env.META_GRAPH_VERSION || 'v24.0';
    if (!appId || !appSecret || !process.env.CONNECTOR_ENCRYPTION_KEY) return res.status(503).json({ ok: false, error: 'WhatsApp Embedded Signup is not configured' });
    const tokenUrl = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
    tokenUrl.search = new URLSearchParams({ client_id: appId, client_secret: appSecret, code }).toString();
    const token = await graphJson<{ access_token?: string; token_type?: string; expires_in?: number }>(tokenUrl, `${appId}|${appSecret}`);
    if (!token.access_token || token.access_token.length < 20) throw new Error('META_TOKEN_MISSING');

    const debugUrl = new URL(`https://graph.facebook.com/${graphVersion}/debug_token`);
    debugUrl.searchParams.set('input_token', token.access_token);
    const debug = await graphJson<DebugTokenResponse>(debugUrl, `${appId}|${appSecret}`);
    const data = debug.data;
    const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
    if (!data?.is_valid || data.app_id !== appId) throw new Error('INVALID_META_TOKEN');
    if (!scopes.includes('whatsapp_business_management') || !scopes.includes('whatsapp_business_messaging')) throw new Error('WHATSAPP_SCOPES_MISSING');
    const targetIds = [...new Set((data.granular_scopes || [])
      .filter((scope) => scope.scope === 'whatsapp_business_management')
      .flatMap((scope) => Array.isArray(scope.target_ids) ? scope.target_ids : [])
      .filter((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value)))];
    if (reportedWabaId && targetIds.length && !targetIds.includes(reportedWabaId)) throw new Error('WABA_MISMATCH');
    const candidates = [...new Set([reportedWabaId, ...targetIds].filter(Boolean))].slice(0, 25);
    if (!candidates.length) throw new Error('WABA_NOT_SHARED');

    type DiscoveredAccount = { id: string; name: string; reviewStatus: string; subscribed: boolean; phones: Array<{ id: string; verifiedName: string; displayNumber: string; qualityRating: string; verificationStatus: string; platformType: string }> };
    const discoveredResults = await Promise.all(candidates.map(async (wabaId): Promise<DiscoveredAccount | null> => {
      try {
        const accountUrl = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(wabaId)}`);
        accountUrl.searchParams.set('fields', 'id,name,account_review_status');
        const account = await graphJson<WabaResponse>(accountUrl, token.access_token);
        if (!account.id || account.id !== wabaId) return null;
        const phonesUrl = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(wabaId)}/phone_numbers`);
        phonesUrl.searchParams.set('fields', 'id,verified_name,display_phone_number,quality_rating,code_verification_status,platform_type');
        phonesUrl.searchParams.set('limit', '100');
        const phonesResult = await graphJson<PhoneNumberResponse>(phonesUrl, token.access_token);
        const phones = (phonesResult.data || []).flatMap((phone) => {
          const id = clean(phone.id, 128);
          if (!id) return [];
          return [{
            id,
            verifiedName: clean(phone.verified_name, 160) || 'WhatsApp Business',
            displayNumber: clean(phone.display_phone_number, 80),
            qualityRating: clean(phone.quality_rating, 40),
            verificationStatus: clean(phone.code_verification_status, 60),
            platformType: clean(phone.platform_type, 60),
          }];
        });
        if (!phones.length) return null;
        const subscribeUrl = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(wabaId)}/subscribed_apps`);
        const subscription = await graphJson<GraphSuccess>(subscribeUrl, token.access_token, { method: 'POST' }).catch(() => ({ success: false }));
        return {
          id: wabaId,
          name: clean(account.name, 160) || 'WhatsApp Business Account',
          reviewStatus: clean(account.account_review_status, 40),
          subscribed: subscription.success === true || subscription.success === 'true',
          phones,
        };
      } catch {
        // Granular target IDs can include non-WABA assets. Ignore anything the WABA endpoints reject.
        return null;
      }
    }));
    const discovered = discoveredResults.filter((account): account is DiscoveredAccount => Boolean(account));
    const phones = discovered.flatMap((account) => account.phones.map((phone) => ({ ...phone, wabaId: account.id })));
    if (!phones.length) throw new Error('NO_WHATSAPP_NUMBERS');
    if (reportedPhoneId && !phones.some((phone) => phone.id === reportedPhoneId)) throw new Error('PHONE_NUMBER_MISMATCH');

    const now = new Date().toISOString();
    const expiresAt = data.expires_at && data.expires_at > 0
      ? new Date(data.expires_at * 1000).toISOString()
      : token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
    const encrypted = await encrypt({
      provider: 'whatsapp', graphVersion, accessToken: token.access_token, expiresAt,
      grantedScopes: scopes,
      accounts: discovered.map((account) => ({
        id: account.id, name: account.name, reviewStatus: account.reviewStatus,
        phones: account.phones,
      })),
    });
    const { projectId, accessToken } = await googleAccessToken();
    const agent = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/agents/${state.agentId}`);
    if (!agentReady(agent)) return res.status(409).json({ ok: false, error: 'The selected ORIN AI is no longer ready for WhatsApp' });
    const previous = await getDocument(projectId, accessToken, `workspaces/${state.workspaceId}/connections/whatsapp`);
    const previousRoutes = fieldStrings(previous, 'routeIds');
    const routes = await Promise.all(phones.map(async (phone) => ({
      ...phone,
      phoneHash: await stableId('whatsapp-phone', phone.id),
      wabaHash: await stableId('whatsapp-waba', phone.wabaId),
    })));
    const routeIds = routes.map((route) => `whatsapp_phone_${route.phoneHash}`);
    const subscribedAccounts = discovered.filter((account) => account.subscribed);
    const allSubscribed = subscribedAccounts.length === discovered.length;
    const webhookConfigured = Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN);
    const base = `projects/${projectId}/databases/(default)/documents`;
    const writes: unknown[] = [
      { update: { name: `${base}/workspaces/${state.workspaceId}/connectorVault/whatsapp`, fields: {
        provider: stringValue('whatsapp'), ownerId: stringValue(uid), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), encryptionVersion: integerValue(1), createdAt: timestampValue(now), updatedAt: timestampValue(now),
      } } },
      { update: { name: `${base}/workspaces/${state.workspaceId}/connections/whatsapp`, fields: {
        provider: stringValue('whatsapp'),
        displayName: stringValue(phones.length === 1 ? `${phones[0].verifiedName}${phones[0].displayNumber ? ` · ${phones[0].displayNumber}` : ''}` : `${phones.length} WhatsApp numbers`),
        status: stringValue(allSubscribed && webhookConfigured ? 'connected' : 'attention_required'),
        authorizationStatus: stringValue('authorized'), credentialState: stringValue('stored_server_side'),
        health: stringValue(!webhookConfigured ? 'webhook_not_configured' : allSubscribed ? 'awaiting_first_event' : 'subscription_partial'),
        subscriptionStatus: stringValue(allSubscribed ? 'subscribed' : subscribedAccounts.length ? 'partial' : 'failed'),
        desiredChannels: stringsValue(['WhatsApp messages']),
        accountCount: integerValue(discovered.length), phoneCount: integerValue(phones.length),
        routeIds: stringsValue(routeIds),
        phoneNumberHashes: stringsValue(routes.map((route) => route.phoneHash)),
        subscribedPhoneNumberHashes: stringsValue(routes.filter((route) => subscribedAccounts.some((account) => account.id === route.wabaId)).map((route) => route.phoneHash)),
        wabaHashes: stringsValue([...new Set(routes.map((route) => route.wabaHash))]),
        displayPhoneNumbers: stringsValue(phones.map((phone) => phone.displayNumber).filter(Boolean)),
        verifiedNames: stringsValue([...new Set(phones.map((phone) => phone.verifiedName))]),
        graphVersion: stringValue(graphVersion), agentId: stringValue(state.agentId),
        autoReplyEnabled: booleanValue(true), autoReplyChannels: stringsValue(['WhatsApp']),
        authorizedBy: stringValue(uid),
        ...(expiresAt ? { tokenExpiresAt: timestampValue(expiresAt) } : { tokenExpiryStatus: stringValue('not_reported') }),
        createdAt: timestampValue(now), updatedAt: timestampValue(now),
      } } },
      { update: { name: `${base}/workspaces/${state.workspaceId}/agents/${state.agentId}`, fields: { status: stringValue('active') } }, updateMask: { fieldPaths: ['status'] }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: true } },
      ...routes.map((route) => ({ update: { name: `${base}/connectorRoutes/whatsapp_phone_${route.phoneHash}`, fields: {
        provider: stringValue('whatsapp'), accountType: stringValue('phone_number'), providerAccountId: stringValue(route.id), wabaId: stringValue(route.wabaId), workspaceId: stringValue(state.workspaceId), ownerId: stringValue(uid), active: booleanValue(true), createdAt: timestampValue(now), updatedAt: timestampValue(now),
      } } })),
      ...previousRoutes.filter((routeId) => !routeIds.includes(routeId)).map((routeId) => ({ delete: `${base}/connectorRoutes/${routeId}` })),
    ];
    await commit(projectId, accessToken, writes);
    return res.status(200).json({ ok: true, status: 'authorized', accountCount: discovered.length, phoneCount: phones.length });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    const publicMessage = message === 'WHATSAPP_SCOPES_MISSING'
      ? 'Meta did not grant WhatsApp management and messaging access.'
      : message === 'NO_WHATSAPP_NUMBERS' || message === 'WABA_NOT_SHARED'
        ? 'No eligible WhatsApp Business phone number was shared with ORIN AI.'
        : message === 'INVALID_STATE'
          ? 'The WhatsApp signup session expired. Start again.'
          : message === 'UNAUTHENTICATED'
            ? 'Sign in again to finish connecting WhatsApp.'
            : 'WhatsApp authorization could not be completed. No account was marked connected.';
    console.error('WhatsApp signup callback failed', cause);
    return res.status(message === 'UNAUTHENTICATED' ? 401 : message.startsWith('STORAGE_') ? 503 : 400).json({ ok: false, error: publicMessage });
  }
}
