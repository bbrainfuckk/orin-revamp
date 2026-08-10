import {
  booleanValue,
  bytesToBase64Url,
  commitWrites,
  documentName,
  fieldBoolean,
  fieldInteger,
  fieldString,
  fieldTimestamp,
  getDocument,
  googleAccessToken,
  integerValue,
  listDocuments,
  queryDocuments,
  requireWorkspaceRole,
  stringArrayValue,
  stringValue,
  timestampValue,
  verifyFirebaseAccount,
  type FirestoreDocument,
  type ServerRequest,
} from './server-data.js';
import { loadAnalyticsSummary } from './analytics-summary.js';
import { applyControlChanges, controlPlaneManifest, planControlChanges, readControlResource } from './control-plane.js';
import { authorizeOrinApiKey, hashOrinApiKey, type OrinApiPrincipal } from './orin-api-auth.js';

export { authorizeOrinApiKey, type OrinApiPrincipal } from './orin-api-auth.js';

type OrinRequest = ServerRequest & {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

const readScopes = ['workspace:read', 'inbox:read', 'analytics:read', 'publishing:read'];
const automationScopes = [...readScopes, 'publishing:write'];
const developerScopes = [
  ...automationScopes,
  'workspace:write',
  'agents:read',
  'agents:write',
  'contacts:read',
  'contacts:write',
  'inbox:write',
  'automations:read',
  'automations:write',
  'commerce:read',
  'commerce:write',
  'communications:read',
  'communications:write',
  'integrations:read',
  'integrations:write',
  'team:read',
  'team:write',
];

const queryValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || '' : value || '';
const clean = (value: unknown, maximum = 500) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const stringArray = (document: FirestoreDocument | null, name: string) => (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
const fieldNumber = (document: FirestoreDocument | null, name: string) => {
  const value = Number(document?.fields?.[name]?.doubleValue ?? document?.fields?.[name]?.integerValue ?? 0);
  return Number.isFinite(value) ? value : 0;
};

function bodyOf(req: OrinRequest) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) as Record<string, unknown>; } catch { return {}; }
  }
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

async function requireOwner(req: OrinRequest, workspaceId: string) {
  const account = await verifyFirebaseAccount(req);
  const { projectId, accessToken } = await googleAccessToken();
  await requireWorkspaceRole(projectId, accessToken, workspaceId, account.localId, ['owner']);
  return { account, projectId, accessToken };
}

async function listKeys(req: OrinRequest, workspaceId: string) {
  const { projectId, accessToken } = await requireOwner(req, workspaceId);
  const documents = await listDocuments(projectId, accessToken, `workspaces/${workspaceId}/apiKeys`, 50);
  return documents.map((document) => ({
    id: document.name?.split('/').pop() || '',
    name: fieldString(document, 'name'),
    hint: fieldString(document, 'hint'),
    scopes: stringArray(document, 'scopes'),
    revoked: fieldBoolean(document, 'revoked'),
    createdAt: fieldTimestamp(document, 'createdAt'),
    lastUsedAt: fieldTimestamp(document, 'lastUsedAt'),
    usageCount: fieldInteger(document, 'usageCount'),
  })).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function createKey(req: OrinRequest, workspaceId: string, body: Record<string, unknown>) {
  const { account, projectId, accessToken } = await requireOwner(req, workspaceId);
  const name = clean(body.name, 80) || 'ORIN CLI';
  const mode = body.mode === 'developer' ? 'developer' : body.mode === 'automation' ? 'automation' : 'read';
  const scopes = mode === 'developer' ? developerScopes : mode === 'automation' ? automationScopes : readScopes;
  const idBytes = crypto.getRandomValues(new Uint8Array(10));
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const keyId = bytesToBase64Url(idBytes);
  const apiKey = `orin_live_${keyId}_${bytesToBase64Url(secretBytes)}`;
  const now = new Date().toISOString();
  const fields = {
    keyId: stringValue(keyId),
    name: stringValue(name),
    mode: stringValue(mode),
    hint: stringValue(`orin_live_${keyId.slice(0, 6)}…${apiKey.slice(-4)}`),
    scopes: stringArrayValue(scopes),
    revoked: booleanValue(false),
    createdBy: stringValue(account.localId),
    createdAt: timestampValue(now),
    updatedAt: timestampValue(now),
    usageCount: integerValue(0),
  };
  await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/apiKeys/${keyId}`), fields }, currentDocument: { exists: false } },
    { update: { name: documentName(projectId, `orinApiKeyRoutes/${keyId}`), fields: { ...fields, keyHash: stringValue(await hashOrinApiKey(apiKey)), workspaceId: stringValue(workspaceId) } }, currentDocument: { exists: false } },
  ], true);
  return { id: keyId, name, apiKey, hint: fields.hint.stringValue, scopes, createdAt: now };
}

async function revokeKey(req: OrinRequest, workspaceId: string, body: Record<string, unknown>) {
  const { projectId, accessToken } = await requireOwner(req, workspaceId);
  const keyId = clean(body.keyId, 32);
  if (!/^[A-Za-z0-9_-]{12,24}$/.test(keyId)) throw new Error('INVALID_REQUEST');
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/apiKeys/${keyId}`), fields: { revoked: booleanValue(true), updatedAt: timestampValue(now) } }, updateMask: { fieldPaths: ['revoked', 'updatedAt'] }, currentDocument: { exists: true } },
    { update: { name: documentName(projectId, `orinApiKeyRoutes/${keyId}`), fields: { revoked: booleanValue(true), updatedAt: timestampValue(now) } }, updateMask: { fieldPaths: ['revoked', 'updatedAt'] }, currentDocument: { exists: true } },
  ]);
  return { revoked: keyId };
}

async function workspaceStatus(projectId: string, accessToken: string, workspaceId: string) {
  const [workspace, agents, connections] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
    listDocuments(projectId, accessToken, `workspaces/${workspaceId}/agents`, 100),
    listDocuments(projectId, accessToken, `workspaces/${workspaceId}/connections`, 100),
  ]);
  if (!workspace) throw new Error('FORBIDDEN');
  return {
    id: workspaceId,
    name: fieldString(workspace, 'name') || 'ORIN AI workspace',
    plan: fieldString(workspace, 'plan') || 'starter',
    agents: agents.map((agent) => ({ id: agent.name?.split('/').pop() || '', name: fieldString(agent, 'name'), status: fieldString(agent, 'status'), readiness: fieldInteger(agent, 'readiness') })),
    connections: connections.map((connection) => ({ provider: fieldString(connection, 'provider'), name: fieldString(connection, 'displayName'), status: fieldString(connection, 'status'), health: fieldString(connection, 'health') })),
  };
}

async function inbox(projectId: string, accessToken: string, workspaceId: string) {
  const conversations = await listDocuments(projectId, accessToken, `workspaces/${workspaceId}/conversations`, 100);
  return conversations.map((conversation) => ({
    id: conversation.name?.split('/').pop() || '',
    customer: fieldString(conversation, 'contactName') || 'Customer',
    channel: fieldString(conversation, 'channel'),
    account: fieldString(conversation, 'accountName'),
    preview: fieldString(conversation, 'preview'),
    status: fieldString(conversation, 'status') || 'open',
    priority: fieldString(conversation, 'priority') || 'normal',
    unreadCount: fieldInteger(conversation, 'unreadCount'),
    updatedAt: fieldTimestamp(conversation, 'updatedAt'),
  })).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function campaigns(projectId: string, accessToken: string, workspaceId: string) {
  const posts = await listDocuments(projectId, accessToken, `workspaces/${workspaceId}/socialPosts`, 100);
  return posts.map((post) => ({
    id: post.name?.split('/').pop() || '',
    text: fieldString(post, 'text'),
    mediaUrl: fieldString(post, 'mediaUrl'),
    status: fieldString(post, 'status'),
    scheduledAt: fieldTimestamp(post, 'scheduledAt'),
    recurrence: fieldString(post, 'recurrence') || 'none',
    runNumber: fieldInteger(post, 'runNumber') || 1,
    maxRuns: fieldInteger(post, 'maxRuns') || 1,
    targets: (() => { try { return JSON.parse(fieldString(post, 'targetsJson')); } catch { return []; } })(),
  })).sort((left, right) => right.scheduledAt.localeCompare(left.scheduledAt));
}

async function logs(projectId: string, accessToken: string, workspaceId: string, requestedLimit: string) {
  const maximum = Math.min(200, Math.max(1, Number(requestedLimit) || 50));
  const events = await queryDocuments(projectId, accessToken, `workspaces/${workspaceId}`, {
    from: [{ collectionId: 'events' }],
    orderBy: [{ field: { fieldPath: 'occurredAt' }, direction: 'DESCENDING' }],
    limit: maximum,
  });
  return events.map((event) => ({
    id: event.name?.split('/').pop() || '',
    type: fieldString(event, 'type') || 'activity',
    status: fieldString(event, 'status'),
    provider: fieldString(event, 'provider'),
    channel: fieldString(event, 'channel'),
    model: fieldString(event, 'model'),
    feature: fieldString(event, 'feature'),
    errorCode: fieldString(event, 'errorCode'),
    agentId: fieldString(event, 'agentId'),
    conversationId: fieldString(event, 'conversationId'),
    contactId: fieldString(event, 'contactId'),
    inputTokens: fieldInteger(event, 'inputTokens'),
    outputTokens: fieldInteger(event, 'outputTokens'),
    latencyMs: fieldInteger(event, 'latencyMs'),
    estimatedCostUsd: fieldNumber(event, 'estimatedCostUsd'),
    costStatus: fieldString(event, 'costStatus'),
    occurredAt: fieldTimestamp(event, 'occurredAt'),
  }));
}

export async function handleOrinApi(req: OrinRequest) {
  const action = clean(queryValue(req.query?.action), 40) || 'status';
  const body = bodyOf(req);
  const workspaceId = clean(body.workspaceId || queryValue(req.query?.workspaceId), 200);
  if (action === 'keys') {
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId)) throw new Error('INVALID_REQUEST');
    if (req.method === 'GET') return { ok: true, keys: await listKeys(req, workspaceId) };
    if (req.method === 'POST') return { ok: true, key: await createKey(req, workspaceId, body) };
    if (req.method === 'DELETE') return { ok: true, ...(await revokeKey(req, workspaceId, body)) };
    throw new Error('METHOD_NOT_ALLOWED');
  }
  const resource = clean(queryValue(req.query?.resource), 60);
  const resourceScope: Record<string, string> = {
    agents: 'agents:read', knowledgeSources: 'agents:read', contacts: 'contacts:read', conversations: 'inbox:read', messages: 'inbox:read', notes: 'inbox:read',
    automations: 'automations:read', automationRuns: 'automations:read', tasks: 'automations:read', followUps: 'automations:read',
    catalogItems: 'commerce:read', orders: 'commerce:read', communicationDeliveries: 'communications:read', connections: 'integrations:read',
    members: 'team:read', notifications: 'team:read', socialPosts: 'publishing:read', socialDeliveries: 'publishing:read',
    usageMeters: 'analytics:read', events: 'analytics:read', apiKeys: 'workspace:write', workspace: 'workspace:read',
  };
  const requiredScope = action === 'resource' ? resourceScope[resource] || 'workspace:read'
    : action === 'plan' || action === 'apply' ? 'workspace:write'
      : action === 'inbox' ? 'inbox:read'
        : action === 'analytics' || action === 'logs' ? 'analytics:read'
          : action === 'campaigns' ? 'publishing:read'
            : 'workspace:read';
  const principal = await authorizeOrinApiKey(req, requiredScope);
  const { projectId, accessToken } = await googleAccessToken();
  if (action === 'schema' && req.method === 'GET') return { ok: true, controlPlane: controlPlaneManifest };
  if (action === 'resource' && req.method === 'GET') return {
    ok: true,
    ...(await readControlResource(projectId, accessToken, principal.workspaceId, resource, clean(queryValue(req.query?.id), 200), clean(queryValue(req.query?.parentId), 200), Number(queryValue(req.query?.limit)) || 100)),
  };
  if (action === 'plan' && req.method === 'POST') {
    const plan = await planControlChanges(projectId, accessToken, principal.workspaceId, body.operations);
    const { _planned: _private, ...result } = plan;
    return { ok: true, plan: result };
  }
  if (action === 'apply' && req.method === 'POST') return applyControlChanges(projectId, accessToken, principal.workspaceId, `api_${principal.keyId}`, body.requestId, body.operations);
  if (action === 'status' && req.method === 'GET') return { ok: true, workspace: await workspaceStatus(projectId, accessToken, principal.workspaceId) };
  if (action === 'inbox' && req.method === 'GET') return { ok: true, conversations: await inbox(projectId, accessToken, principal.workspaceId) };
  if (action === 'campaigns' && req.method === 'GET') return { ok: true, campaigns: await campaigns(projectId, accessToken, principal.workspaceId) };
  if (action === 'analytics' && req.method === 'GET') return { ok: true, summary: await loadAnalyticsSummary(projectId, accessToken, principal.workspaceId, queryValue(req.query?.days), queryValue(req.query?.timezoneOffset)) };
  if (action === 'logs' && req.method === 'GET') return { ok: true, logs: await logs(projectId, accessToken, principal.workspaceId, queryValue(req.query?.limit)) };
  throw new Error('METHOD_NOT_ALLOWED');
}
