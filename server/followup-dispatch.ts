import {
  booleanValue,
  commitWrites,
  constantTimeEqual,
  decryptJson,
  documentName,
  fieldBoolean,
  fieldInteger,
  fieldString,
  fieldTimestamp,
  getDocument,
  googleAccessToken,
  integerValue,
  listDocuments,
  stableId,
  stringValue,
  timestampValue,
  type FirestoreDocument,
  type ServerRequest,
} from './server-data.js';
import {
  listDueScheduledJobs, putScheduledJob, recordSchedulerHeartbeat, removeScheduledJob,
} from './scheduler-store.js';

type MetaCredential = { graphVersion: string; pages: Array<{ id: string; accessToken: string; instagramBusinessAccount?: { id?: string } | null }> };
type WhatsAppCredential = { graphVersion: string; accessToken: string; accounts: Array<{ phones: Array<{ id: string }> }> };
type FollowUpRoute = {
  workspaceId: string;
  followUpId: string;
  agentId: string;
  provider: 'meta' | 'whatsapp';
  channel: 'Messenger' | 'Instagram' | 'WhatsApp';
  providerAccountId: string;
  providerUserId: string;
  conversationId: string;
  contactId: string;
  sourceMessageAt: string;
  message: string;
  delayMinutes: number;
  sequence: number;
  maximum: number;
  cancelOnReply: boolean;
  quietHours: boolean;
  timeZone: string;
};

const clean = (value: unknown, maximum = 500) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const configBoolean = (config: Record<string, unknown>, name: string, fallback: boolean) => typeof config[name] === 'boolean' ? config[name] as boolean : fallback;
const configNumber = (config: Record<string, unknown>, name: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number(config[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : fallback;
};
const configString = (config: Record<string, unknown>, name: string, fallback = '') => clean(config[name], 900) || fallback;

function routeFromDocument(document: FirestoreDocument | null): FollowUpRoute | null {
  if (!document) return null;
  const provider = fieldString(document, 'provider');
  const channel = fieldString(document, 'channel');
  if (!['meta', 'whatsapp'].includes(provider) || !['Messenger', 'Instagram', 'WhatsApp'].includes(channel)) return null;
  return {
    workspaceId: fieldString(document, 'workspaceId'), followUpId: fieldString(document, 'followUpId'), agentId: fieldString(document, 'agentId'),
    provider: provider as FollowUpRoute['provider'], channel: channel as FollowUpRoute['channel'], providerAccountId: fieldString(document, 'providerAccountId'), providerUserId: fieldString(document, 'providerUserId'), conversationId: fieldString(document, 'conversationId'), contactId: fieldString(document, 'contactId'), sourceMessageAt: fieldTimestamp(document, 'sourceMessageAt'), message: fieldString(document, 'message'), delayMinutes: fieldInteger(document, 'delayMinutes'), sequence: fieldInteger(document, 'sequence'), maximum: fieldInteger(document, 'maximum'), cancelOnReply: fieldBoolean(document, 'cancelOnReply'), quietHours: fieldBoolean(document, 'quietHours'), timeZone: fieldString(document, 'timeZone') || 'Asia/Manila',
  };
}

function nextAllowedTime(input: string, timeZone: string) {
  const instant = new Date(input);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  if (hour >= 8 && hour < 20) return instant.toISOString();
  const delayHours = hour < 8 ? 8 - hour : 24 - hour + 8;
  instant.setTime(instant.getTime() + delayHours * 60 * 60_000);
  instant.setUTCMinutes(0, 0, 0);
  return instant.toISOString();
}

async function enqueueFollowUp(projectId: string, accessToken: string, workspaceId: string, followUpId: string, scheduledAt: string) {
  await putScheduledJob(projectId, accessToken, 'followup', workspaceId, followUpId, scheduledAt);
}

async function writeFollowUp(projectId: string, accessToken: string, route: FollowUpRoute, scheduledAt: string, status = 'scheduled') {
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, `workspaces/${route.workspaceId}/followUps/${route.followUpId}`), fields: { agentId: stringValue(route.agentId), provider: stringValue(route.provider), channel: stringValue(route.channel), conversationId: stringValue(route.conversationId), contactId: stringValue(route.contactId), status: stringValue(status), message: stringValue(route.message), sequence: integerValue(route.sequence), maximum: integerValue(route.maximum), scheduledAt: timestampValue(scheduledAt), sourceMessageAt: timestampValue(route.sourceMessageAt), cancelOnReply: booleanValue(route.cancelOnReply), quietHours: booleanValue(route.quietHours), createdAt: timestampValue(now), updatedAt: timestampValue(now) } } },
    { update: { name: documentName(projectId, `followUpRoutes/${route.followUpId}`), fields: { workspaceId: stringValue(route.workspaceId), followUpId: stringValue(route.followUpId), agentId: stringValue(route.agentId), provider: stringValue(route.provider), channel: stringValue(route.channel), providerAccountId: stringValue(route.providerAccountId), providerUserId: stringValue(route.providerUserId), conversationId: stringValue(route.conversationId), contactId: stringValue(route.contactId), sourceMessageAt: timestampValue(route.sourceMessageAt), message: stringValue(route.message), delayMinutes: integerValue(route.delayMinutes), sequence: integerValue(route.sequence), maximum: integerValue(route.maximum), cancelOnReply: booleanValue(route.cancelOnReply), quietHours: booleanValue(route.quietHours), timeZone: stringValue(route.timeZone), scheduledAt: timestampValue(scheduledAt), updatedAt: timestampValue(now) } } },
  ]);
}

async function updateFollowUpStatus(projectId: string, accessToken: string, route: FollowUpRoute, status: string, detail = '') {
  await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${route.workspaceId}/followUps/${route.followUpId}`), fields: { status: stringValue(status), detail: stringValue(detail) } }, updateMask: { fieldPaths: ['status', 'detail'] }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: true } }]);
}

export async function scheduleAgentFollowUp(input: {
  projectId: string; accessToken: string; workspaceId: string; agentId: string; provider: 'meta' | 'whatsapp'; channel: 'Messenger' | 'Instagram' | 'WhatsApp'; providerAccountId: string; providerUserId: string; conversationId: string; contactId: string; sourceMessageAt: string; sourceEventId: string; config: Record<string, unknown>;
}) {
  if (!configBoolean(input.config, 'followUpEnabled', false)) return null;
  const amount = configNumber(input.config, 'followUpDelayAmount', 2, 1, 30);
  const unit = configString(input.config, 'followUpDelayUnit', 'hours');
  const delayMinutes = amount * (unit === 'days' ? 1440 : unit === 'minutes' ? 1 : 60);
  const message = configString(input.config, 'followUpMessage', 'Just checking in—would you like help with anything else?');
  if (!message) return null;
  const scheduledAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  const maximum = configNumber(input.config, 'followUpMaxMessages', 1, 1, 3);
  const followUpId = await stableId('agent-followup', input.workspaceId, input.sourceEventId, '1');
  const route: FollowUpRoute = { ...input, followUpId, message, delayMinutes, sequence: 1, maximum, cancelOnReply: configBoolean(input.config, 'followUpCancelOnReply', true), quietHours: configBoolean(input.config, 'followUpQuietHours', true), timeZone: configString(input.config, 'followUpTimeZone', 'Asia/Manila') };
  if (['Messenger', 'Instagram', 'WhatsApp'].includes(route.channel) && new Date(scheduledAt).getTime() - new Date(route.sourceMessageAt).getTime() >= 24 * 60 * 60_000) {
    await writeFollowUp(input.projectId, input.accessToken, route, scheduledAt, 'policy_blocked');
    await updateFollowUpStatus(input.projectId, input.accessToken, route, 'policy_blocked', 'An approved message type is required outside the customer-service window.');
    return { followUpId, status: 'policy_blocked' };
  }
  const deliveryAt = route.quietHours ? nextAllowedTime(scheduledAt, route.timeZone) : scheduledAt;
  await writeFollowUp(input.projectId, input.accessToken, route, deliveryAt);
  try {
    await enqueueFollowUp(input.projectId, input.accessToken, route.workspaceId, followUpId, deliveryAt);
    return { followUpId, status: 'scheduled' };
  } catch {
    await updateFollowUpStatus(input.projectId, input.accessToken, route, 'scheduler_pending', 'Scheduling becomes active when the ORIN Deno scheduler is online.');
    return { followUpId, status: 'scheduler_pending' };
  }
}

async function providerCredential(projectId: string, accessToken: string, route: FollowUpRoute) {
  const vault = await getDocument(projectId, accessToken, `workspaces/${route.workspaceId}/connectorVault/${route.provider}`);
  if (!vault) throw new Error('FOLLOWUP_CONNECTION_MISSING');
  return decryptJson<MetaCredential | WhatsAppCredential>(fieldString(vault, 'ciphertext'), fieldString(vault, 'iv'), process.env.CONNECTOR_ENCRYPTION_KEY || '');
}

async function deliverFollowUp(projectId: string, accessToken: string, route: FollowUpRoute) {
  const credential = await providerCredential(projectId, accessToken, route);
  let token = '';
  let url = '';
  let body: unknown;
  if (route.provider === 'whatsapp') {
    const whatsapp = credential as WhatsAppCredential;
    if (!whatsapp.accounts.some((account) => account.phones.some((phone) => phone.id === route.providerAccountId))) throw new Error('FOLLOWUP_CONNECTION_MISSING');
    token = whatsapp.accessToken;
    url = `https://graph.facebook.com/${whatsapp.graphVersion}/${encodeURIComponent(route.providerAccountId)}/messages`;
    body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: route.providerUserId, type: 'text', text: { preview_url: false, body: route.message } };
  } else {
    const meta = credential as MetaCredential;
    const page = route.channel === 'Instagram' ? meta.pages.find((item) => item.instagramBusinessAccount?.id === route.providerAccountId) : meta.pages.find((item) => item.id === route.providerAccountId);
    if (!page?.accessToken) throw new Error('FOLLOWUP_CONNECTION_MISSING');
    token = page.accessToken;
    url = `https://${route.channel === 'Instagram' ? 'graph.instagram.com' : 'graph.facebook.com'}/${meta.graphVersion}/${encodeURIComponent(route.providerAccountId)}/messages`;
    body = route.channel === 'Messenger' ? { recipient: { id: route.providerUserId }, messaging_type: 'RESPONSE', message: { text: route.message } } : { recipient: { id: route.providerUserId }, message: { text: route.message } };
  }
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  const payload = await response.json().catch(() => ({})) as { message_id?: string; messages?: Array<{ id?: string }>; error?: { code?: number; message?: string } };
  if (!response.ok) throw new Error(payload.error?.code === 190 ? 'FOLLOWUP_AUTH_EXPIRED' : response.status === 429 || payload.error?.code === 613 ? 'FOLLOWUP_RATE_LIMITED' : 'FOLLOWUP_REJECTED');
  return payload.message_id || payload.messages?.[0]?.id || '';
}

async function scheduleNext(projectId: string, accessToken: string, route: FollowUpRoute) {
  if (route.sequence >= route.maximum) return null;
  const sequence = route.sequence + 1;
  const scheduledAt = new Date(Date.now() + route.delayMinutes * 60_000).toISOString();
  const nextRoute = { ...route, sequence, followUpId: await stableId('agent-followup', route.workspaceId, route.followUpId, String(sequence)) };
  if (new Date(scheduledAt).getTime() - new Date(route.sourceMessageAt).getTime() >= 24 * 60 * 60_000) {
    await writeFollowUp(projectId, accessToken, nextRoute, scheduledAt, 'policy_blocked');
    return null;
  }
  const deliveryAt = route.quietHours ? nextAllowedTime(scheduledAt, route.timeZone) : scheduledAt;
  await writeFollowUp(projectId, accessToken, nextRoute, deliveryAt);
  try { await enqueueFollowUp(projectId, accessToken, nextRoute.workspaceId, nextRoute.followUpId, deliveryAt); } catch { await updateFollowUpStatus(projectId, accessToken, nextRoute, 'scheduler_pending', 'Scheduling becomes active when the ORIN Deno scheduler is online.'); }
  return nextRoute.followUpId;
}

async function reserveFollowUp(projectId: string, accessToken: string, route: FollowUpRoute, followUp: FirestoreDocument) {
  if (!followUp.updateTime) return false;
  return commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, `workspaces/${route.workspaceId}/followUps/${route.followUpId}`),
      fields: { status: stringValue('delivering'), detail: stringValue('') },
    },
    updateMask: { fieldPaths: ['status', 'detail'] },
    updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
    currentDocument: { updateTime: followUp.updateTime },
  }], true);
}

export async function runScheduledFollowUp(req: ServerRequest & { body?: unknown }) {
  const supplied = typeof req.headers?.['x-orin-scheduler'] === 'string' ? req.headers['x-orin-scheduler'] : '';
  const secret = process.env.ORIN_SCHEDULER_SECRET || '';
  if (secret.length < 32 || !constantTimeEqual(supplied, secret)) throw new Error('FORBIDDEN');
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_REQUEST');
  const workspaceId = clean((body as Record<string, unknown>).workspaceId, 200);
  const followUpId = clean((body as Record<string, unknown>).followUpId, 128);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId) || !/^[A-Za-z0-9_-]{8,128}$/.test(followUpId)) throw new Error('INVALID_REQUEST');
  const { projectId, accessToken } = await googleAccessToken();
  const [followUp, routeDocument] = await Promise.all([getDocument(projectId, accessToken, `workspaces/${workspaceId}/followUps/${followUpId}`), getDocument(projectId, accessToken, `followUpRoutes/${followUpId}`)]);
  const route = routeFromDocument(routeDocument);
  if (!followUp || !route || route.workspaceId !== workspaceId) return { ok: true, status: 'ignored' };
  const status = fieldString(followUp, 'status');
  if (status === 'delivering') return { ok: true, status: 'busy' };
  if (status !== 'scheduled') return { ok: true, status: 'ignored' };
  const [conversation, messages] = await Promise.all([getDocument(projectId, accessToken, `workspaces/${workspaceId}/conversations/${route.conversationId}`), listDocuments(projectId, accessToken, `workspaces/${workspaceId}/conversations/${route.conversationId}/messages`, 200)]);
  if (!conversation || ['team_active', 'escalated'].includes(fieldString(conversation, 'status'))) { await updateFollowUpStatus(projectId, accessToken, route, 'cancelled', 'A person took over the conversation.'); return { ok: true, status: 'cancelled' }; }
  const sourceTime = new Date(route.sourceMessageAt).getTime();
  const replied = route.cancelOnReply && messages.some((message) => ['customer', 'team'].includes(fieldString(message, 'senderType')) && new Date(fieldTimestamp(message, 'sentAt')).getTime() > sourceTime + 1_000);
  if (replied) { await updateFollowUpStatus(projectId, accessToken, route, 'cancelled', 'The customer or team replied before delivery.'); return { ok: true, status: 'cancelled' }; }
  if (Date.now() - sourceTime >= 24 * 60 * 60_000) { await updateFollowUpStatus(projectId, accessToken, route, 'policy_blocked', 'The customer-service messaging window closed.'); return { ok: true, status: 'policy_blocked' }; }
  if (!await reserveFollowUp(projectId, accessToken, route, followUp)) return { ok: true, status: 'busy' };
  let externalId = '';
  try { externalId = await deliverFollowUp(projectId, accessToken, route); }
  catch (cause) {
    await updateFollowUpStatus(projectId, accessToken, route, 'scheduled', cause instanceof Error ? cause.message.slice(0, 200) : 'FOLLOWUP_DELIVERY_FAILED');
    throw cause;
  }
  const now = new Date().toISOString();
  const messageId = await stableId('agent-followup-message', route.followUpId);
  await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/conversations/${route.conversationId}/messages/${messageId}`), fields: { body: stringValue(route.message), senderType: stringValue('agent'), senderName: stringValue('ORIN AI'), provider: stringValue(route.provider), channel: stringValue(route.channel), followUp: booleanValue(true), sentAt: timestampValue(now), externalIdHash: stringValue(await stableId('followup-external', externalId)) } }, currentDocument: { exists: false } },
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/conversations/${route.conversationId}`), fields: { preview: stringValue(route.message.slice(0, 180)) } }, updateMask: { fieldPaths: ['preview'] }, updateTransforms: [{ fieldPath: 'lastMessageAt', setToServerValue: 'REQUEST_TIME' }, { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: true } },
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/events/followup_sent_${route.followUpId}`), fields: { type: stringValue('message.followup_sent'), provider: stringValue(route.provider), channel: stringValue(route.channel), conversationId: stringValue(route.conversationId), contactId: stringValue(route.contactId), occurredAt: timestampValue(now), value: integerValue(0) } }, currentDocument: { exists: false } },
  ]);
  await updateFollowUpStatus(projectId, accessToken, route, 'sent');
  const nextFollowUpId = await scheduleNext(projectId, accessToken, route);
  return { ok: true, status: 'sent', nextFollowUpId };
}

export async function runScheduledFollowUpSweep(req: ServerRequest) {
  const supplied = typeof req.headers?.['x-orin-scheduler'] === 'string' ? req.headers['x-orin-scheduler'] : '';
  const secret = process.env.ORIN_SCHEDULER_SECRET || '';
  if (secret.length < 32 || !constantTimeEqual(supplied, secret)) throw new Error('FORBIDDEN');
  const { projectId, accessToken } = await googleAccessToken();
  const lastSeenAt = await recordSchedulerHeartbeat(projectId, accessToken);
  const jobs = await listDueScheduledJobs(projectId, accessToken, 'followup', new Date().toISOString(), 100);
  const outcomes: Array<{ jobId: string; ok: boolean; status?: string; error?: string }> = [];
  const startedAt = Date.now();
  for (let index = 0; index < jobs.length && Date.now() - startedAt < 45_000; index += 10) {
    outcomes.push(...await Promise.all(jobs.slice(index, index + 10).map(async (job) => {
      try {
        const result = await runScheduledFollowUp({ headers: req.headers, body: { workspaceId: job.workspaceId, followUpId: job.jobId } });
        if (result.status !== 'busy') await removeScheduledJob(projectId, accessToken, 'followup', job.id);
        return { jobId: job.jobId, ok: true, status: result.status };
      } catch (cause) {
        return { jobId: job.jobId, ok: false, error: cause instanceof Error ? cause.message.slice(0, 120) : 'FOLLOWUP_JOB_FAILED' };
      }
    })));
  }
  return { ok: outcomes.every((item) => item.ok), provider: 'deno', checked: outcomes.length, deferred: jobs.length - outcomes.length, outcomes, lastSeenAt };
}
