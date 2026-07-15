import {
  base64ToBytes,
  commitWrites,
  documentName,
  fieldString,
  getDocument,
  integerValue,
  stableId,
  stringArrayValue,
  stringValue,
  timestampValue,
  type FirestoreDocument,
  type FirestoreValue,
} from './server-data.js';
import { assertPublicWebhookHost, decryptVerifiedWebhook, postPinnedWebhook, type WebhookTransport } from './webhook-connector.js';

export type AutomationEvent = {
  id: string;
  type: 'conversation.started' | 'conversation.escalated' | 'conversation.resolved' | 'lead.captured' | 'value.attributed';
  workspaceId: string;
  channel: string;
  contactId: string;
  contactName: string;
  conversationId?: string;
  occurredAt: string;
  preview?: string;
  body?: string;
};

export type N8nEvent = AutomationEvent;

type AutomationDefinition = {
  id: string;
  name: string;
  trigger: string;
  action: string;
  config: Record<string, FirestoreValue>;
};

export type AutomationContext = {
  desiredChannels: string[];
  n8nHealthy: boolean;
  n8nWebhookUrl: string;
  n8nSigningSecret: string;
  webhookHealthy: boolean;
  webhookUrl: string;
  webhookHostname: string;
  webhookSigningSecret: string;
  webhookTransport?: WebhookTransport;
  automations: AutomationDefinition[];
};

type FirestoreList = { documents?: FirestoreDocument[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const followUpDelays = new Set([15, 60, 240, 1_440, 4_320, 10_080]);

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum) : '';
}

function fieldStringArray(document: FirestoreDocument | null, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}

function fieldMap(document: FirestoreDocument, name: string) {
  return document.fields?.[name]?.mapValue?.fields || {};
}

function configString(config: Record<string, FirestoreValue>, name: string) {
  return config[name]?.stringValue || '';
}

function configNumber(config: Record<string, FirestoreValue>, name: string) {
  const value = config[name];
  return Number(value?.integerValue ?? value?.doubleValue ?? Number.NaN);
}

function encodedPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function listDocuments(projectId: string, accessToken: string, path: string) {
  const documents: FirestoreDocument[] = [];
  let pageToken = '';
  for (let page = 0; page < 5; page += 1) {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath(path)}`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) return documents;
    if (!response.ok) throw new Error('SERVER_STORAGE_READ_FAILED');
    const payload = (await response.json()) as FirestoreList & { nextPageToken?: string };
    documents.push(...(payload.documents || []));
    pageToken = payload.nextPageToken || '';
    if (!pageToken) break;
  }
  return documents;
}

async function decryptN8n(document: FirestoreDocument | null) {
  const keyBytes = base64ToBytes((process.env.CONNECTOR_ENCRYPTION_KEY || '').trim());
  const ciphertext = fieldString(document, 'ciphertext');
  const iv = fieldString(document, 'iv');
  if (!document || keyBytes.byteLength !== 32 || !ciphertext || !iv) return null;
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const ivBytes = base64ToBytes(iv);
    const cipherBytes = base64ToBytes(ciphertext);
    const ivCopy = new Uint8Array(ivBytes.byteLength);
    const cipherCopy = new Uint8Array(cipherBytes.byteLength);
    ivCopy.set(ivBytes);
    cipherCopy.set(cipherBytes);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivCopy.buffer, tagLength: 128 }, key, cipherCopy.buffer);
    const value = JSON.parse(decoder.decode(plaintext)) as { provider?: unknown; deployment?: unknown; webhookUrl?: unknown; signingSecret?: unknown };
    if (value.provider !== 'n8n' || value.deployment !== 'n8n_cloud' || typeof value.webhookUrl !== 'string' || typeof value.signingSecret !== 'string' || value.signingSecret.length < 20) return null;
    const webhook = new URL(value.webhookUrl);
    if (webhook.protocol !== 'https:' || webhook.username || webhook.password || (webhook.port && webhook.port !== '443') || (webhook.hostname !== 'n8n.cloud' && !webhook.hostname.endsWith('.n8n.cloud')) || !webhook.pathname.startsWith('/webhook/')) return null;
    return { webhookUrl: webhook.toString(), signingSecret: value.signingSecret };
  } catch {
    return null;
  }
}

export function automationTriggerLabels(type: AutomationEvent['type']) {
  if (type === 'conversation.started') return ['New conversation'];
  if (type === 'lead.captured') return ['Lead captured'];
  if (type === 'conversation.escalated') return ['Human escalation', 'Human escalation requested'];
  if (type === 'conversation.resolved') return ['Conversation resolved'];
  return ['Order or booking attributed', 'Attributed order or booking'];
}

export function normalizeAutomationTag(value: unknown) {
  return cleanText(value, 32).replace(/\s+/g, ' ');
}

export function normalizeFollowUpDelay(value: unknown) {
  const delay = Number(value);
  return Number.isInteger(delay) && followUpDelays.has(delay) ? delay : 0;
}

export function normalizeNotificationTitle(value: unknown) {
  return cleanText(value, 100).replace(/\s+/g, ' ');
}

export async function loadAutomationContext(projectId: string, accessToken: string, workspaceId: string): Promise<AutomationContext> {
  const [connection, vault, webhookConnection, webhookVault, automationDocuments] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/n8n`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/n8n`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/webhook`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/webhook`),
    listDocuments(projectId, accessToken, `workspaces/${workspaceId}/automations`),
  ]);
  const [credential, webhookCredential] = await Promise.all([decryptN8n(vault), decryptVerifiedWebhook(webhookVault)]);
  const automations = automationDocuments.flatMap((document) => {
    const id = document.name?.split('/').pop() || '';
    if (!id || fieldString(document, 'status') !== 'active') return [];
    return [{
      id,
      name: fieldString(document, 'name') || 'Untitled automation',
      trigger: fieldString(document, 'trigger'),
      action: fieldString(document, 'action'),
      config: fieldMap(document, 'actionConfig'),
    }];
  });
  return {
    desiredChannels: fieldStringArray(connection, 'desiredChannels'),
    n8nHealthy: fieldString(connection, 'status') === 'connected' && fieldString(connection, 'health') === 'healthy' && Boolean(credential),
    n8nWebhookUrl: credential?.webhookUrl || '',
    n8nSigningSecret: credential?.signingSecret || '',
    webhookHealthy: fieldString(webhookConnection, 'status') === 'connected' && fieldString(webhookConnection, 'health') === 'healthy' && Boolean(webhookCredential),
    webhookUrl: webhookCredential?.webhookUrl || '',
    webhookHostname: webhookCredential?.hostname || '',
    webhookSigningSecret: webhookCredential?.signingSecret || '',
    automations,
  };
}

function runFields(event: AutomationEvent, automation: AutomationDefinition, destination: string, status: 'processing' | 'succeeded' | 'failed', error: string) {
  return {
    eventId: stringValue(event.id),
    eventType: stringValue(event.type),
    destination: stringValue(destination),
    status: stringValue(status),
    automationId: stringValue(automation.id),
    automationName: stringValue(automation.name),
    automationIds: stringArrayValue([automation.id]),
    action: stringValue(automation.action),
    error: stringValue(error.slice(0, 240)),
    occurredAt: timestampValue(event.occurredAt),
    updatedAt: timestampValue(new Date().toISOString()),
  };
}

async function recordBuiltInFailure(projectId: string, accessToken: string, event: AutomationEvent, automation: AutomationDefinition, destination: string, error: string) {
  const runId = await stableId('automation-run', event.id, automation.id);
  await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, `workspaces/${event.workspaceId}/automationRuns/${runId}`), fields: runFields(event, automation, destination, 'failed', error) },
    currentDocument: { exists: false },
  }], true);
}

async function addContactTag(projectId: string, accessToken: string, event: AutomationEvent, automation: AutomationDefinition) {
  const tag = normalizeAutomationTag(configString(automation.config, 'tag'));
  if (!tag) return recordBuiltInFailure(projectId, accessToken, event, automation, 'contact', 'Automation tag is missing');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(event.contactId)) return recordBuiltInFailure(projectId, accessToken, event, automation, 'contact', 'Event has no customer record');
  const contactPath = `workspaces/${event.workspaceId}/contacts/${event.contactId}`;
  if (!await getDocument(projectId, accessToken, contactPath)) return recordBuiltInFailure(projectId, accessToken, event, automation, 'contact', 'Customer record was not found');
  const runId = await stableId('automation-run', event.id, automation.id);
  const accepted = await commitWrites(projectId, accessToken, [
    {
      transform: {
        document: documentName(projectId, contactPath),
        fieldTransforms: [
          { fieldPath: 'tags', appendMissingElements: { values: [stringValue(tag)] } },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
        ],
      },
      currentDocument: { exists: true },
    },
    {
      update: { name: documentName(projectId, `workspaces/${event.workspaceId}/automationRuns/${runId}`), fields: runFields(event, automation, 'contact', 'succeeded', '') },
      currentDocument: { exists: false },
    },
  ], true);
  if (accepted || await getDocument(projectId, accessToken, `workspaces/${event.workspaceId}/automationRuns/${runId}`)) return;
  await recordBuiltInFailure(projectId, accessToken, event, automation, 'contact', 'Customer record was not found');
}

async function createFollowUpTask(projectId: string, accessToken: string, event: AutomationEvent, automation: AutomationDefinition) {
  const title = cleanText(configString(automation.config, 'taskTitle'), 120);
  const delayMinutes = normalizeFollowUpDelay(configNumber(automation.config, 'delayMinutes'));
  if (!title || !delayMinutes) return recordBuiltInFailure(projectId, accessToken, event, automation, 'follow-up tasks', 'Follow-up configuration is incomplete');
  const [taskId, runId] = await Promise.all([
    stableId('automation-task', event.id, automation.id),
    stableId('automation-run', event.id, automation.id),
  ]);
  const now = new Date().toISOString();
  const dueAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  await commitWrites(projectId, accessToken, [
    {
      update: { name: documentName(projectId, `workspaces/${event.workspaceId}/tasks/${taskId}`), fields: {
        title: stringValue(title),
        status: stringValue('open'),
        contactId: stringValue(event.contactId),
        contactName: stringValue(event.contactName || 'Customer'),
        conversationId: stringValue(event.conversationId || ''),
        channel: stringValue(event.channel),
        eventId: stringValue(event.id),
        eventType: stringValue(event.type),
        automationId: stringValue(automation.id),
        automationName: stringValue(automation.name),
        dueAt: timestampValue(dueAt),
        createdAt: timestampValue(now),
        updatedAt: timestampValue(now),
      } },
      currentDocument: { exists: false },
    },
    {
      update: { name: documentName(projectId, `workspaces/${event.workspaceId}/automationRuns/${runId}`), fields: runFields(event, automation, 'follow-up tasks', 'succeeded', '') },
      currentDocument: { exists: false },
    },
  ], true);
}

async function notifyTeamMember(projectId: string, accessToken: string, event: AutomationEvent, automation: AutomationDefinition) {
  const recipientId = cleanText(configString(automation.config, 'memberId'), 200);
  const title = normalizeNotificationTitle(configString(automation.config, 'notificationTitle'));
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(recipientId) || !title) return recordBuiltInFailure(projectId, accessToken, event, automation, 'team notification', 'Team notification configuration is incomplete');
  const member = await getDocument(projectId, accessToken, `workspaces/${event.workspaceId}/members/${recipientId}`);
  if (!member || !['owner', 'admin', 'editor', 'viewer'].includes(fieldString(member, 'role'))) return recordBuiltInFailure(projectId, accessToken, event, automation, 'team notification', 'The selected team member no longer has access');
  const [notificationId, runId] = await Promise.all([
    stableId('automation-notification', event.id, automation.id, recipientId),
    stableId('automation-run', event.id, automation.id),
  ]);
  const now = new Date().toISOString();
  const detail = [event.contactName || 'Customer', event.channel, cleanText(event.preview || event.body, 160)].filter(Boolean).join(' · ').slice(0, 240);
  const accepted = await commitWrites(projectId, accessToken, [
    {
      update: { name: documentName(projectId, `workspaces/${event.workspaceId}/notifications/${notificationId}`), fields: {
        recipientId: stringValue(recipientId),
        title: stringValue(title),
        body: stringValue(detail),
        status: stringValue('unread'),
        eventId: stringValue(event.id),
        eventType: stringValue(event.type),
        contactId: stringValue(event.contactId),
        conversationId: stringValue(event.conversationId || ''),
        automationId: stringValue(automation.id),
        automationName: stringValue(automation.name),
        createdAt: timestampValue(now),
        updatedAt: timestampValue(now),
      } },
      currentDocument: { exists: false },
    },
    {
      update: { name: documentName(projectId, `workspaces/${event.workspaceId}/automationRuns/${runId}`), fields: runFields(event, automation, 'team notification', 'succeeded', '') },
      currentDocument: { exists: false },
    },
  ], true);
  if (accepted || await getDocument(projectId, accessToken, `workspaces/${event.workspaceId}/automationRuns/${runId}`)) return;
  await recordBuiltInFailure(projectId, accessToken, event, automation, 'team notification', 'The notification could not be created');
}

async function recordN8nRun(projectId: string, accessToken: string, event: AutomationEvent, status: 'succeeded' | 'failed', automationIds: string[], responseStatus: number, error: string) {
  const runId = await stableId('automation-run', event.id, 'n8n');
  await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, `workspaces/${event.workspaceId}/automationRuns/${runId}`), fields: {
      eventId: stringValue(event.id), eventType: stringValue(event.type), destination: stringValue('n8n'), status: stringValue(status), automationIds: stringArrayValue(automationIds), responseStatus: integerValue(responseStatus), error: stringValue(error.slice(0, 240)), occurredAt: timestampValue(event.occurredAt), updatedAt: timestampValue(new Date().toISOString()),
    } },
  }]);
}

function bytesToHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deliverN8n(projectId: string, accessToken: string, event: AutomationEvent, context: AutomationContext, automationIds: string[]) {
  if (!context.n8nHealthy) {
    await recordN8nRun(projectId, accessToken, event, 'failed', automationIds, 0, 'n8n connection is not healthy');
    return;
  }
  const body = JSON.stringify({
    id: event.id,
    event: event.type,
    source: 'ORIN AI',
    workspace_id: event.workspaceId,
    occurred_at: event.occurredAt,
    channel: event.channel,
    contact: { id: event.contactId, name: event.contactName },
    conversation: event.conversationId ? { id: event.conversationId, preview: event.preview || '' } : null,
    data: event.body ? { message: event.body } : {},
    automation_ids: automationIds,
  });
  const key = await crypto.subtle.importKey('raw', encoder.encode(context.n8nSigningSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))));
  try {
    const response = await fetch(context.n8nWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ORIN-AI-Automation/1.0', 'X-ORIN-Event': event.type, 'X-ORIN-Delivery': event.id, 'X-ORIN-Signature-256': `sha256=${signature}` },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    await recordN8nRun(projectId, accessToken, event, response.ok ? 'succeeded' : 'failed', automationIds, response.status, response.ok ? '' : `n8n returned HTTP ${response.status}`);
  } catch (cause) {
    await recordN8nRun(projectId, accessToken, event, 'failed', automationIds, 0, cause instanceof Error && cause.name === 'TimeoutError' ? 'n8n timed out' : 'n8n delivery failed');
  }
}

async function deliverVerifiedWebhook(projectId: string, accessToken: string, event: AutomationEvent, automation: AutomationDefinition, context: AutomationContext) {
  if (!context.webhookHealthy) return recordBuiltInFailure(projectId, accessToken, event, automation, 'verified webhook', 'Verified webhook connection is not healthy');
  const runId = await stableId('automation-run', event.id, automation.id);
  const runPath = `workspaces/${event.workspaceId}/automationRuns/${runId}`;
  const reserved = await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, runPath), fields: {
      ...runFields(event, automation, 'verified webhook', 'processing', ''),
      responseStatus: integerValue(0),
    } },
    currentDocument: { exists: false },
  }], true);
  if (!reserved) return;
  const body = JSON.stringify({
    id: event.id,
    event: event.type,
    source: 'ORIN AI',
    workspace_id: event.workspaceId,
    occurred_at: event.occurredAt,
    channel: event.channel,
    contact: { id: event.contactId, name: event.contactName },
    conversation: event.conversationId ? { id: event.conversationId, preview: event.preview || '' } : null,
    data: event.body ? { message: event.body } : {},
    automation: { id: automation.id, name: automation.name },
  });
  try {
    const resolved = await assertPublicWebhookHost(context.webhookHostname);
    const key = await crypto.subtle.importKey('raw', encoder.encode(context.webhookSigningSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))));
    const response = await (context.webhookTransport || postPinnedWebhook)({
      url: context.webhookUrl,
      hostname: context.webhookHostname,
      resolved,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ORIN-AI-Automation/1.0', 'X-ORIN-Event': event.type, 'X-ORIN-Delivery': event.id, 'X-ORIN-Signature-256': `sha256=${signature}` },
      body,
      timeoutMs: 6_000,
      maxResponseBytes: 8_192,
    });
    await commitWrites(projectId, accessToken, [{
      update: { name: documentName(projectId, runPath), fields: {
        ...runFields(event, automation, 'verified webhook', response.ok ? 'succeeded' : 'failed', response.ok ? '' : `Webhook returned HTTP ${response.status}`),
        responseStatus: integerValue(response.status),
      } },
    }]);
  } catch (cause) {
    const error = cause instanceof Error && cause.message === 'WEBHOOK_URL_PRIVATE'
      ? 'Webhook hostname resolved to a private address'
      : cause instanceof Error && cause.name === 'TimeoutError'
        ? 'Webhook timed out'
        : 'Webhook delivery failed';
    await commitWrites(projectId, accessToken, [{
      update: { name: documentName(projectId, runPath), fields: {
        ...runFields(event, automation, 'verified webhook', 'failed', error),
        responseStatus: integerValue(0),
      } },
    }]);
  }
}

export async function deliverAutomationEvent(
  projectId: string,
  accessToken: string,
  event: AutomationEvent,
  contextPromise?: Promise<AutomationContext>,
) {
  const context = await (contextPromise || loadAutomationContext(projectId, accessToken, event.workspaceId));
  const labels = automationTriggerLabels(event.type);
  const matches = context.automations.filter((automation) => labels.includes(automation.trigger));
  const builtIns = matches.flatMap((automation) => {
    if (automation.action === 'Add a contact tag') return [addContactTag(projectId, accessToken, event, automation).catch(() => recordBuiltInFailure(projectId, accessToken, event, automation, 'contact', 'Contact tag action could not be completed'))];
    if (automation.action === 'Create a follow-up task') return [createFollowUpTask(projectId, accessToken, event, automation).catch(() => recordBuiltInFailure(projectId, accessToken, event, automation, 'follow-up tasks', 'Follow-up task could not be created'))];
    if (automation.action === 'Notify a team member') return [notifyTeamMember(projectId, accessToken, event, automation).catch(() => recordBuiltInFailure(projectId, accessToken, event, automation, 'team notification', 'Team notification could not be created'))];
    if (automation.action === 'Call a verified webhook') return [deliverVerifiedWebhook(projectId, accessToken, event, automation, context).catch(() => recordBuiltInFailure(projectId, accessToken, event, automation, 'verified webhook', 'Webhook delivery could not be completed'))];
    return [];
  });
  const n8nAutomationIds = matches.filter((automation) => automation.action === 'Send to n8n').map((automation) => automation.id);
  const n8nSubscribed = context.desiredChannels.some((channel) => labels.includes(channel)) || n8nAutomationIds.length > 0;
  await Promise.allSettled([
    ...builtIns,
    ...(n8nSubscribed ? [deliverN8n(projectId, accessToken, event, context, n8nAutomationIds)] : []),
  ]);
}

export async function deliverN8nEvent(projectId: string, accessToken: string, event: N8nEvent) {
  return deliverAutomationEvent(projectId, accessToken, event);
}
