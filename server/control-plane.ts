import {
  commitWrites,
  documentName,
  firestoreDocumentToJson,
  getDocument,
  integerValue,
  jsonToFirestoreValue,
  listDocuments,
  stableId,
  stringValue,
  timestampValue,
  type FirestoreDocument,
  type FirestoreValue,
} from './server-data.js';

type ControlAction = 'upsert' | 'update' | 'delete';
export type ControlOperation = {
  resource: string;
  action: ControlAction;
  id?: string;
  data?: Record<string, unknown>;
};

type ResourceDefinition = {
  collection?: string;
  parent?: 'conversation' | 'agent';
  mutable?: readonly ControlAction[];
  description: string;
};

const resources: Record<string, ResourceDefinition> = {
  workspace: { mutable: ['update'], description: 'Workspace identity and plan metadata.' },
  agents: { collection: 'agents', mutable: ['upsert'], description: 'AI agents and their complete behavior configuration.' },
  connections: { collection: 'connections', description: 'Sanitized provider and channel connection health.' },
  contacts: { collection: 'contacts', mutable: ['upsert'], description: 'CRM customer profiles and tags.' },
  conversations: { collection: 'conversations', description: 'Inbox conversations, assignment, state, and response metadata.' },
  messages: { collection: 'messages', parent: 'conversation', description: 'Messages inside one conversation. Requires parentId.' },
  notes: { collection: 'notes', parent: 'conversation', description: 'Internal notes inside one conversation. Requires parentId.' },
  automations: { collection: 'automations', mutable: ['upsert', 'delete'], description: 'Built-in automation definitions.' },
  automationRuns: { collection: 'automationRuns', description: 'Automation execution outcomes.' },
  tasks: { collection: 'tasks', mutable: ['update'], description: 'CRM follow-up tasks.' },
  followUps: { collection: 'followUps', description: 'Scheduled agent follow-up messages.' },
  socialPosts: { collection: 'socialPosts', description: 'Publishing campaigns and schedules.' },
  socialDeliveries: { collection: 'socialDeliveries', description: 'Per-channel social publishing delivery records.' },
  communicationDeliveries: { collection: 'communicationDeliveries', description: 'SMS and voice delivery records.' },
  catalogItems: { collection: 'catalogItems', mutable: ['upsert', 'delete'], description: 'Commerce products, services, materials, and inventory.' },
  orders: { collection: 'orders', description: 'Orders, quotations, and payment state.' },
  members: { collection: 'members', description: 'Workspace members and roles.' },
  apiKeys: { collection: 'apiKeys', description: 'Masked developer-key metadata. Secret values are never returned.' },
  usageMeters: { collection: 'usageMeters', description: 'Provider, model, token, and estimated-cost meters.' },
  events: { collection: 'events', description: 'Sanitized operational and audit events.' },
  knowledgeSources: { collection: 'knowledgeSources', parent: 'agent', description: 'Knowledge sources attached to one agent. Requires parentId.' },
  notifications: { collection: 'notifications', description: 'Workspace team notifications.' },
};

const secretField = /^(?:accessToken|refreshToken|apiKey|secret|token|ciphertext|iv|keyHash|password|privateKey|clientSecret|webhookSecret)$/i;
const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
const triggerOptions = new Set(['New conversation', 'Lead captured', 'Human escalation', 'Conversation resolved', 'Order or booking attributed']);
const actionOptions = new Set(['Send to n8n', 'Add a contact tag', 'Create a follow-up task', 'Notify a team member', 'Call a verified webhook']);
const automationStatuses = new Set(['draft', 'active', 'paused']);

function cleanText(value: unknown, maximum: number, required = false) {
  const result = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, maximum) : '';
  if (required && !result) throw new Error('INVALID_REQUEST');
  return result;
}

function safeId(value: unknown, required = true) {
  const id = cleanText(value, 200);
  if ((required && !id) || (id && !idPattern.test(id))) throw new Error('INVALID_REQUEST');
  return id;
}

function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  return value as Record<string, unknown>;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error('INVALID_REQUEST');
}

function assertNoSecrets(value: unknown, depth = 0) {
  if (depth > 12) throw new Error('INVALID_REQUEST');
  if (Array.isArray(value)) return value.forEach((item) => assertNoSecrets(item, depth + 1));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (secretField.test(key)) throw new Error('SECRET_FIELD_FORBIDDEN');
    assertNoSecrets(item, depth + 1);
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !secretField.test(key))
    .map(([key, item]) => [key, redact(item)]));
}

function documentJson(document: FirestoreDocument | null) {
  return redact(firestoreDocumentToJson(document));
}

function resourcePath(workspaceId: string, resource: string, id = '', parentId = '') {
  const definition = resources[resource];
  if (!definition) throw new Error('RESOURCE_NOT_FOUND');
  if (resource === 'workspace') return `workspaces/${workspaceId}`;
  if (definition.parent === 'conversation') return `workspaces/${workspaceId}/conversations/${safeId(parentId)}/${definition.collection}${id ? `/${safeId(id)}` : ''}`;
  if (definition.parent === 'agent') return `workspaces/${workspaceId}/agents/${safeId(parentId)}/${definition.collection}${id ? `/${safeId(id)}` : ''}`;
  return `workspaces/${workspaceId}/${definition.collection}${id ? `/${safeId(id)}` : ''}`;
}

export const controlPlaneManifest = {
  version: '2026-07-19',
  safety: {
    credentials: 'write-only through typed connection actions; never readable',
    changes: 'plan first, then apply with an idempotency key and optimistic concurrency',
    audit: 'every applied batch creates sanitized workspace events',
  },
  resources: Object.entries(resources).map(([name, definition]) => ({ name, ...definition })),
  externalActions: [
    { name: 'inbox.reply', endpoint: '/api/widget/message', method: 'POST', mode: 'team_reply' },
    { name: 'inbox.crm.update', endpoint: '/api/widget/message', method: 'POST', mode: 'crm_update' },
    { name: 'inbox.ai.resume', endpoint: '/api/widget/message', method: 'POST', mode: 'resume_ai' },
    { name: 'agents.test', endpoint: '/api/widget/message', method: 'POST', mode: 'studio_test' },
    { name: 'agents.knowledge', endpoint: '/api/agents/ai', method: 'POST' },
    { name: 'agents.credentials', endpoint: '/api/agents/ai', method: 'POST' },
    { name: 'team.access', endpoint: '/api/widget/message', method: 'POST', mode: 'team_access' },
    { name: 'publishing.create', endpoint: '/api/social/create', method: 'POST' },
    { name: 'publishing.publish', endpoint: '/api/social/publish', method: 'POST' },
    { name: 'publishing.cancel', endpoint: '/api/social/cancel', method: 'POST' },
    { name: 'publishing.retry', endpoint: '/api/social/retry', method: 'POST' },
    { name: 'commerce.catalog.upsert', endpoint: '/api/commerce/item_upsert', method: 'POST' },
    { name: 'commerce.catalog.delete', endpoint: '/api/commerce/item_delete', method: 'POST' },
    { name: 'commerce.order.markPaid', endpoint: '/api/commerce/mark_paid', method: 'POST' },
    { name: 'communications.sms.send', endpoint: '/api/communications/send_sms', method: 'POST' },
  ],
};

export async function readControlResource(
  projectId: string,
  accessToken: string,
  workspaceId: string,
  resource: string,
  id = '',
  parentId = '',
  requestedLimit = 100,
) {
  safeId(workspaceId);
  const definition = resources[resource];
  if (!definition) throw new Error('RESOURCE_NOT_FOUND');
  if (definition.parent && !parentId) throw new Error('PARENT_REQUIRED');
  const path = resourcePath(workspaceId, resource, id, parentId);
  if (resource === 'workspace' || id) return { resource, item: documentJson(await getDocument(projectId, accessToken, path)) };
  const limit = Math.min(200, Math.max(1, Number(requestedLimit) || 100));
  const documents = await listDocuments(projectId, accessToken, path, limit);
  return { resource, items: documents.map(documentJson), count: documents.length, limit };
}

function timestampOrEmpty(value: unknown) {
  if (value === undefined || value === '') throw new Error('INVALID_REQUEST');
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error('INVALID_REQUEST');
  return parsed.toISOString();
}

function stringList(value: unknown, maximumItems = 100, maximumLength = 200) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error('INVALID_REQUEST');
  return [...new Set(value.map((item) => cleanText(item, maximumLength, true)))];
}

function validateAgent(data: Record<string, unknown>, exists: boolean) {
  assertAllowedKeys(data, ['name', 'businessName', 'purpose', 'readiness', 'status', 'config']);
  assertNoSecrets(data);
  const result: Record<string, unknown> = {};
  if ('name' in data || !exists) result.name = cleanText(data.name, 120, true);
  if ('businessName' in data) result.businessName = cleanText(data.businessName, 160);
  if ('purpose' in data) result.purpose = cleanText(data.purpose, 2_000);
  if ('readiness' in data) {
    const readiness = Number(data.readiness);
    if (!Number.isInteger(readiness) || readiness < 0 || readiness > 9) throw new Error('INVALID_REQUEST');
    result.readiness = readiness;
  }
  if ('status' in data) {
    const status = cleanText(data.status, 20);
    if (!['draft', 'active', 'paused'].includes(status)) throw new Error('INVALID_REQUEST');
    result.status = status;
  }
  if ('config' in data) result.config = object(data.config);
  return result;
}

function validateAutomation(data: Record<string, unknown>, exists: boolean) {
  assertAllowedKeys(data, ['name', 'trigger', 'action', 'actionConfig', 'status']);
  const result: Record<string, unknown> = {};
  if ('name' in data || !exists) result.name = cleanText(data.name, 120, true);
  if ('trigger' in data || !exists) {
    const trigger = cleanText(data.trigger, 100, true);
    if (!triggerOptions.has(trigger)) throw new Error('INVALID_REQUEST');
    result.trigger = trigger;
  }
  if ('action' in data || !exists) {
    const action = cleanText(data.action, 100, true);
    if (!actionOptions.has(action)) throw new Error('INVALID_REQUEST');
    result.action = action;
  }
  if ('actionConfig' in data || !exists) {
    const config = data.actionConfig === undefined ? {} : object(data.actionConfig);
    assertAllowedKeys(config, ['tag', 'taskTitle', 'delayMinutes', 'memberId', 'memberName', 'notificationTitle']);
    assertNoSecrets(config);
    result.actionConfig = config;
  }
  if ('status' in data || !exists) {
    const status = cleanText(data.status ?? 'draft', 20, true);
    if (!automationStatuses.has(status)) throw new Error('INVALID_REQUEST');
    result.status = status;
  }
  return result;
}

function validateContact(data: Record<string, unknown>, exists: boolean) {
  assertAllowedKeys(data, ['name', 'handle', 'profilePhotoUrl', 'locale', 'timezone', 'sourceProvider', 'channels', 'tags', 'customFields']);
  assertNoSecrets(data);
  const result: Record<string, unknown> = {};
  if ('name' in data || !exists) result.name = cleanText(data.name, 160, true);
  for (const key of ['handle', 'profilePhotoUrl', 'locale', 'timezone', 'sourceProvider'] as const) if (key in data) result[key] = cleanText(data[key], key === 'profilePhotoUrl' ? 2_000 : 200);
  if ('channels' in data) result.channels = stringList(data.channels, 30, 100);
  if ('tags' in data) result.tags = stringList(data.tags, 100, 80);
  if ('customFields' in data) result.customFields = object(data.customFields);
  return result;
}

function validateCatalogItem(data: Record<string, unknown>, exists: boolean) {
  assertAllowedKeys(data, ['name', 'kind', 'description', 'priceCentavos', 'quoteOnly', 'stock', 'variants', 'imageUrl', 'active']);
  const result: Record<string, unknown> = {};
  if ('name' in data || !exists) result.name = cleanText(data.name, 120, true);
  if ('kind' in data || !exists) {
    const kind = cleanText(data.kind, 20, true);
    if (!['service', 'product', 'material'].includes(kind)) throw new Error('INVALID_REQUEST');
    result.kind = kind;
  }
  for (const key of ['priceCentavos', 'stock'] as const) if (key in data) {
    const number = Number(data[key]);
    if (!Number.isInteger(number) || number < (key === 'stock' ? -1 : 0) || number > 1_000_000_000) throw new Error('INVALID_REQUEST');
    result[key] = number;
  }
  for (const key of ['quoteOnly', 'active'] as const) if (key in data) {
    if (typeof data[key] !== 'boolean') throw new Error('INVALID_REQUEST');
    result[key] = data[key];
  }
  if ('description' in data) result.description = cleanText(data.description, 5_000);
  if ('variants' in data) result.variants = stringList(data.variants, 50, 120);
  if ('imageUrl' in data) {
    const imageUrl = cleanText(data.imageUrl, 2_000);
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new Error('INVALID_REQUEST');
    result.imageUrl = imageUrl;
  }
  return result;
}

function validateTask(data: Record<string, unknown>) {
  assertAllowedKeys(data, ['status', 'dueAt', 'title']);
  const result: Record<string, unknown> = {};
  if ('status' in data) {
    const status = cleanText(data.status, 20, true);
    if (!['open', 'completed'].includes(status)) throw new Error('INVALID_REQUEST');
    result.status = status;
  }
  if ('dueAt' in data) result.dueAt = timestampOrEmpty(data.dueAt);
  if ('title' in data) result.title = cleanText(data.title, 160, true);
  if (!Object.keys(result).length) throw new Error('INVALID_REQUEST');
  return result;
}

function validatedData(resource: string, data: unknown, exists: boolean) {
  const value = object(data);
  if (resource === 'workspace') {
    assertAllowedKeys(value, ['name']);
    return { name: cleanText(value.name, 120, true) };
  }
  if (resource === 'agents') return validateAgent(value, exists);
  if (resource === 'automations') return validateAutomation(value, exists);
  if (resource === 'contacts') return validateContact(value, exists);
  if (resource === 'catalogItems') return validateCatalogItem(value, exists);
  if (resource === 'tasks') return validateTask(value);
  throw new Error('RESOURCE_READ_ONLY');
}

function firestoreFields(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonToFirestoreValue(item)])) as Record<string, FirestoreValue>;
}

type PlannedOperation = {
  resource: string;
  action: ControlAction;
  id: string;
  effect: 'create' | 'update' | 'delete';
  path: string;
  current: unknown;
  desired: Record<string, unknown> | null;
  updateTime: string;
};

async function planOperation(projectId: string, accessToken: string, workspaceId: string, operation: ControlOperation): Promise<PlannedOperation> {
  const definition = resources[operation.resource];
  if (!definition || !definition.mutable?.includes(operation.action)) throw new Error(definition ? 'RESOURCE_READ_ONLY' : 'RESOURCE_NOT_FOUND');
  const id = operation.resource === 'workspace' ? workspaceId : safeId(operation.id);
  const path = resourcePath(workspaceId, operation.resource, operation.resource === 'workspace' ? '' : id);
  const current = await getDocument(projectId, accessToken, path);
  if (operation.action === 'delete') {
    if (!current) throw new Error('RESOURCE_NOT_FOUND');
    return { resource: operation.resource, action: operation.action, id, effect: 'delete', path, current: documentJson(current), desired: null, updateTime: current.updateTime || '' };
  }
  if (operation.action === 'update' && !current) throw new Error('RESOURCE_NOT_FOUND');
  const desired = validatedData(operation.resource, operation.data, Boolean(current));
  return { resource: operation.resource, action: operation.action, id, effect: current ? 'update' : 'create', path, current: documentJson(current), desired, updateTime: current?.updateTime || '' };
}

export async function planControlChanges(
  projectId: string,
  accessToken: string,
  workspaceId: string,
  operations: unknown,
) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 20) throw new Error('INVALID_REQUEST');
  if (JSON.stringify(operations).length > 900_000) throw new Error('REQUEST_TOO_LARGE');
  const planned: PlannedOperation[] = [];
  for (const rawOperation of operations) planned.push(await planOperation(projectId, accessToken, workspaceId, object(rawOperation) as ControlOperation));
  return { valid: true, operations: planned.map(({ path: _path, updateTime: _updateTime, ...operation }) => operation), creates: planned.filter((item) => item.effect === 'create').length, updates: planned.filter((item) => item.effect === 'update').length, deletes: planned.filter((item) => item.effect === 'delete').length, _planned: planned };
}

export async function applyControlChanges(
  projectId: string,
  accessToken: string,
  workspaceId: string,
  actorId: string,
  requestIdValue: unknown,
  operations: unknown,
) {
  const requestId = cleanText(requestIdValue, 128);
  if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestId)) throw new Error('INVALID_REQUEST');
  const plan = await planControlChanges(projectId, accessToken, workspaceId, operations);
  const fingerprint = await stableId('orin-control-v1', workspaceId, JSON.stringify(operations));
  const mutationId = await stableId('orin-control-mutation', workspaceId, actorId, requestId);
  const reservationPath = `outboundRequests/control_${mutationId}`;
  const now = new Date().toISOString();
  const writes: unknown[] = [{
    update: { name: documentName(projectId, reservationPath), fields: { workspaceId: stringValue(workspaceId), actorId: stringValue(actorId), fingerprint: stringValue(fingerprint), state: stringValue('applied'), createdAt: timestampValue(now), updatedAt: timestampValue(now) } },
    currentDocument: { exists: false },
  }];
  for (const [index, operation] of plan._planned.entries()) {
    if (operation.effect === 'delete') {
      writes.push({ delete: documentName(projectId, operation.path), ...(operation.updateTime ? { currentDocument: { updateTime: operation.updateTime } } : {}) });
    } else {
      const fields = firestoreFields(operation.desired || {});
      fields.updatedBy = stringValue(actorId);
      fields.updatedAt = timestampValue(now);
      if (operation.effect === 'create') {
        fields.createdBy = stringValue(actorId);
        fields.createdAt = timestampValue(now);
      }
      writes.push({
        update: { name: documentName(projectId, operation.path), fields },
        ...(operation.effect === 'update' ? { updateMask: { fieldPaths: Object.keys(fields) } } : {}),
        currentDocument: operation.effect === 'create' ? { exists: false } : operation.updateTime ? { updateTime: operation.updateTime } : { exists: true },
      });
    }
    const eventId = await stableId('orin-control-event', mutationId, String(index));
    writes.push({ update: { name: documentName(projectId, `workspaces/${workspaceId}/events/control_${eventId}`), fields: { type: stringValue('control.applied'), status: stringValue('succeeded'), resource: stringValue(operation.resource), action: stringValue(operation.action), resourceId: stringValue(operation.id), actorUserId: stringValue(actorId), occurredAt: timestampValue(now), value: integerValue(0) } }, currentDocument: { exists: false } });
  }
  const accepted = await commitWrites(projectId, accessToken, writes, true);
  if (!accepted) {
    const existing = await getDocument(projectId, accessToken, reservationPath);
    if (existing?.fields?.fingerprint?.stringValue === fingerprint && existing.fields?.state?.stringValue === 'applied') return { ok: true, duplicate: true, requestId, ...withoutPrivatePlan(plan) };
    throw new Error('CONTROL_CONFLICT');
  }
  return { ok: true, duplicate: false, requestId, ...withoutPrivatePlan(plan) };
}

function withoutPrivatePlan(plan: Awaited<ReturnType<typeof planControlChanges>>) {
  const { _planned: _ignored, ...result } = plan;
  return result;
}

export function verifyControlPlaneContract() {
  const names = new Set(controlPlaneManifest.resources.map((resource) => resource.name));
  if (!names.has('workspace') || !names.has('agents') || !names.has('messages') || !names.has('catalogItems')) throw new Error('CONTROL_PLANE_INVALID');
  if ((redact({ apiKey: 'secret', safe: 'yes' }) as Record<string, unknown>).apiKey) throw new Error('CONTROL_PLANE_REDACTION_FAILED');
  return true;
}
