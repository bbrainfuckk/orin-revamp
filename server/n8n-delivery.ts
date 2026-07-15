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
} from './server-data';

export type N8nEvent = {
  id: string;
  type: 'conversation.started' | 'conversation.escalated' | 'lead.captured' | 'value.attributed';
  workspaceId: string;
  channel: string;
  contactId: string;
  contactName: string;
  conversationId: string;
  occurredAt: string;
  preview?: string;
  body?: string;
};

type FirestoreList = { documents?: FirestoreDocument[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fieldStringArray(document: FirestoreDocument | null, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}

function encodedPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function listDocuments(projectId: string, accessToken: string, path: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath(path)}?pageSize=100`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error('SERVER_STORAGE_READ_FAILED');
  return ((await response.json()) as FirestoreList).documents || [];
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
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivCopy.buffer }, key, cipherCopy.buffer);
    const value = JSON.parse(decoder.decode(plaintext)) as { provider?: unknown; deployment?: unknown; webhookUrl?: unknown; signingSecret?: unknown };
    if (value.provider !== 'n8n' || value.deployment !== 'n8n_cloud' || typeof value.webhookUrl !== 'string' || typeof value.signingSecret !== 'string' || value.signingSecret.length < 20) return null;
    const webhook = new URL(value.webhookUrl);
    if (webhook.protocol !== 'https:' || webhook.username || webhook.password || (webhook.port && webhook.port !== '443') || (webhook.hostname !== 'n8n.cloud' && !webhook.hostname.endsWith('.n8n.cloud')) || !webhook.pathname.startsWith('/webhook/')) return null;
    return { webhookUrl: webhook.toString(), signingSecret: value.signingSecret };
  } catch {
    return null;
  }
}

const labels: Record<N8nEvent['type'], string> = {
  'conversation.started': 'New conversation',
  'conversation.escalated': 'Human escalation',
  'lead.captured': 'Lead captured',
  'value.attributed': 'Order or booking attributed',
};

async function recordRun(projectId: string, accessToken: string, event: N8nEvent, status: 'succeeded' | 'failed', automationIds: string[], responseStatus: number, error: string) {
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

export async function deliverN8nEvent(projectId: string, accessToken: string, event: N8nEvent) {
  const [connection, vault, automationDocuments] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${event.workspaceId}/connections/n8n`),
    getDocument(projectId, accessToken, `workspaces/${event.workspaceId}/connectorVault/n8n`),
    listDocuments(projectId, accessToken, `workspaces/${event.workspaceId}/automations`),
  ]);
  const eventLabel = labels[event.type];
  const automationIds = automationDocuments
    .filter((document) => fieldString(document, 'status') === 'active' && fieldString(document, 'action') === 'Send to n8n' && fieldString(document, 'trigger') === eventLabel)
    .flatMap((document) => document.name?.split('/').pop() || []);
  const subscribed = fieldStringArray(connection, 'desiredChannels').includes(eventLabel) || automationIds.length > 0;
  if (!subscribed) return;
  const credential = await decryptN8n(vault);
  if (fieldString(connection, 'status') !== 'connected' || fieldString(connection, 'health') !== 'healthy' || !credential) {
    await recordRun(projectId, accessToken, event, 'failed', automationIds, 0, 'n8n connection is not healthy');
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
  const key = await crypto.subtle.importKey('raw', encoder.encode(credential.signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body))));
  try {
    const response = await fetch(credential.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ORIN-AI-Automation/1.0', 'X-ORIN-Event': event.type, 'X-ORIN-Delivery': event.id, 'X-ORIN-Signature-256': `sha256=${signature}` },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    await recordRun(projectId, accessToken, event, response.ok ? 'succeeded' : 'failed', automationIds, response.status, response.ok ? '' : `n8n returned HTTP ${response.status}`);
  } catch (cause) {
    await recordRun(projectId, accessToken, event, 'failed', automationIds, 0, cause instanceof Error && cause.name === 'TimeoutError' ? 'n8n timed out' : 'n8n delivery failed');
  }
}
