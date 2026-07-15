export type ServerRequest = {
  headers?: Record<string, string | string[] | undefined>;
};

export type FirestoreValue = {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

export type FirestoreDocument = { name?: string; fields?: Record<string, FirestoreValue>; createTime?: string; updateTime?: string };
export type FirebaseAccount = {
  localId: string;
  disabled?: boolean;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
  photoUrl?: string;
};
type FirebaseLookup = { users?: Array<Partial<FirebaseAccount>> };
type GoogleTokenResponse = { access_token?: string };

const encoder = new TextEncoder();
const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY
  || process.env.VITE_FIREBASE_API_KEY
  || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk';

export function bytesToBase64Url(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function headerValue(req: ServerRequest, name: string) {
  const value = req.headers?.[name] || req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) mismatch |= leftBytes[index] ^ rightBytes[index];
  return mismatch === 0;
}

export async function stableId(...parts: string[]) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(parts.join('\u001f')));
  return bytesToBase64Url(new Uint8Array(digest)).slice(0, 40);
}

export async function verifyFirebaseAccount(req: ServerRequest): Promise<FirebaseAccount> {
  const authorization = headerValue(req, 'authorization');
  if (!authorization.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');
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
  const account = ((await response.json()) as FirebaseLookup).users?.[0];
  if (!account?.localId || account.disabled) throw new Error('UNAUTHENTICATED');
  return account as FirebaseAccount;
}

export async function verifyFirebaseUid(req: ServerRequest) {
  return (await verifyFirebaseAccount(req)).localId;
}

export async function googleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'orin-ai-502503';
  if (!clientEmail || !rawPrivateKey || !projectId) throw new Error('SERVER_STORAGE_NOT_CONFIGURED');
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
  if (!response.ok || !payload.access_token) throw new Error('SERVER_STORAGE_AUTH_FAILED');
  return { projectId, accessToken: payload.access_token };
}

function encodedPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function documentName(projectId: string, path: string) {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}

export async function getDocument(projectId: string, accessToken: string, path: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath(path)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('SERVER_STORAGE_READ_FAILED');
  return response.json() as Promise<FirestoreDocument>;
}

export async function commitWrites(projectId: string, accessToken: string, writes: unknown[], conflictIsFalse = false) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
    signal: AbortSignal.timeout(10_000),
  });
  if (conflictIsFalse && response.status === 409) return false;
  if (!response.ok) throw new Error('SERVER_STORAGE_WRITE_FAILED');
  return true;
}

export async function encryptJson(payload: unknown, base64Key: string) {
  const keyBytes = base64ToBytes(base64Key.trim());
  if (keyBytes.byteLength !== 32) throw new Error('INVALID_ENCRYPTION_KEY');
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}

export const stringValue = (value: string): FirestoreValue => ({ stringValue: value });
export const integerValue = (value: number): FirestoreValue => ({ integerValue: String(Math.trunc(value)) });
export const doubleValue = (value: number): FirestoreValue => ({ doubleValue: value });
export const timestampValue = (value: string): FirestoreValue => ({ timestampValue: value });
export const booleanValue = (value: boolean): FirestoreValue => ({ booleanValue: value });
export const stringArrayValue = (values: string[]): FirestoreValue => ({ arrayValue: { values: values.map(stringValue) } });

export function fieldString(document: FirestoreDocument | null, name: string) {
  return document?.fields?.[name]?.stringValue || '';
}

export function fieldBoolean(document: FirestoreDocument | null, name: string) {
  return document?.fields?.[name]?.booleanValue === true;
}
