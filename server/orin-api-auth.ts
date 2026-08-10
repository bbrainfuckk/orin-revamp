import {
  commitWrites,
  constantTimeEqual,
  documentName,
  fieldBoolean,
  fieldInteger,
  fieldString,
  getDocument,
  googleAccessToken,
  integerValue,
  stableId,
  timestampValue,
  type FirestoreDocument,
  type ServerRequest,
} from './server-data.js';

export type OrinApiPrincipal = {
  keyId: string;
  workspaceId: string;
  scopes: string[];
  actorId: string;
};

// 10 random bytes encode to a 14-character id; 32 random bytes encode to a
// 43-character secret. Fixed widths keep '_' inside base64url secrets from
// being mistaken for the id/secret delimiter.
const keyPattern = /^orin_live_([A-Za-z0-9_-]{14})_([A-Za-z0-9_-]{43})$/;
const stringArray = (document: FirestoreDocument | null, name: string) => (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);

function bearer(req: ServerRequest) {
  const value = req.headers?.authorization || req.headers?.Authorization;
  const header = Array.isArray(value) ? value[0] || '' : value || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

export async function hashOrinApiKey(key: string) {
  return stableId('orin-api-key-v1', key);
}

async function reserveRateLimit(projectId: string, accessToken: string, keyId: string) {
  const minute = Math.floor(Date.now() / 60_000);
  const bucketId = await stableId('orin-api-rate', keyId, String(minute));
  const path = `orinApiRateLimits/${bucketId}`;
  const created = await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, path), fields: { count: integerValue(1), expiresAt: timestampValue(new Date((minute + 3) * 60_000).toISOString()) } },
    currentDocument: { exists: false },
  }], true);
  if (created) return;
  const existing = await getDocument(projectId, accessToken, path);
  if (fieldInteger(existing, 'count') >= 120) throw new Error('RATE_LIMITED');
  await commitWrites(projectId, accessToken, [{
    transform: { document: documentName(projectId, path), fieldTransforms: [{ fieldPath: 'count', increment: integerValue(1) }] },
    currentDocument: { exists: true },
  }]);
}

export async function authorizeOrinApiKey(req: ServerRequest, requiredScope: string): Promise<OrinApiPrincipal> {
  const key = bearer(req);
  const match = key.match(keyPattern);
  if (!match) throw new Error('UNAUTHENTICATED');
  const [, keyId] = match;
  const { projectId, accessToken } = await googleAccessToken();
  const route = await getDocument(projectId, accessToken, `orinApiKeyRoutes/${keyId}`);
  const scopes = stringArray(route, 'scopes');
  if (!route || fieldBoolean(route, 'revoked') || !constantTimeEqual(fieldString(route, 'keyHash'), await hashOrinApiKey(key)) || !scopes.includes(requiredScope)) throw new Error('FORBIDDEN');
  await reserveRateLimit(projectId, accessToken, keyId);
  const workspaceId = fieldString(route, 'workspaceId');
  await commitWrites(projectId, accessToken, [
    {
      transform: { document: documentName(projectId, `orinApiKeyRoutes/${keyId}`), fieldTransforms: [{ fieldPath: 'usageCount', increment: integerValue(1) }, { fieldPath: 'lastUsedAt', setToServerValue: 'REQUEST_TIME' }] },
      currentDocument: { exists: true },
    },
    {
      transform: { document: documentName(projectId, `workspaces/${workspaceId}/apiKeys/${keyId}`), fieldTransforms: [{ fieldPath: 'usageCount', increment: integerValue(1) }, { fieldPath: 'lastUsedAt', setToServerValue: 'REQUEST_TIME' }] },
      currentDocument: { exists: true },
    },
  ]).catch(() => undefined);
  return { keyId, workspaceId, scopes, actorId: fieldString(route, 'createdBy') };
}
