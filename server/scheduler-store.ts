import {
  commitWrites,
  documentName,
  fieldString,
  fieldTimestamp,
  fetchWithTransientRetry,
  getDocument,
  stringValue,
  timestampValue,
  type FirestoreDocument,
} from './server-data.js';

export type ScheduledJobKind = 'social' | 'followup';
export type ScheduledJob = { id: string; workspaceId: string; jobId: string; scheduledAt: string };

const collections: Record<ScheduledJobKind, string> = {
  social: 'socialScheduleJobs',
  followup: 'followUpScheduleJobs',
};

function validId(value: string, maximum = 200) {
  return value.length >= 8 && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}

export function denoSchedulerConfigured() {
  return process.env.ORIN_SCHEDULER_PROVIDER === 'deno' && (process.env.ORIN_SCHEDULER_SECRET || '').length >= 32;
}

export async function putScheduledJob(
  projectId: string,
  accessToken: string,
  kind: ScheduledJobKind,
  workspaceId: string,
  jobId: string,
  scheduledAt: string,
) {
  if (!denoSchedulerConfigured()) throw new Error(kind === 'social' ? 'SCHEDULER_NOT_CONFIGURED' : 'FOLLOWUP_SCHEDULER_NOT_CONFIGURED');
  if (!validId(workspaceId) || !validId(jobId, 128) || !Number.isFinite(Date.parse(scheduledAt))) throw new Error('INVALID_SCHEDULED_JOB');
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, `${collections[kind]}/${jobId}`),
      fields: {
        workspaceId: stringValue(workspaceId),
        jobId: stringValue(jobId),
        scheduledAt: timestampValue(scheduledAt),
        updatedAt: timestampValue(now),
      },
    },
  }]);
}

export async function removeScheduledJob(projectId: string, accessToken: string, kind: ScheduledJobKind, jobId: string) {
  if (!validId(jobId, 128)) return;
  await commitWrites(projectId, accessToken, [{ delete: documentName(projectId, `${collections[kind]}/${jobId}`) }]);
}

function documentId(document: FirestoreDocument) {
  return document.name?.split('/').pop() || '';
}

export async function listDueScheduledJobs(
  projectId: string,
  accessToken: string,
  kind: ScheduledJobKind,
  dueAt = new Date().toISOString(),
  maximum = 50,
) {
  const response = await fetchWithTransientRetry(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collections[kind] }],
        where: { fieldFilter: { field: { fieldPath: 'scheduledAt' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: dueAt } } },
        orderBy: [{ field: { fieldPath: 'scheduledAt' }, direction: 'ASCENDING' }],
        limit: Math.min(100, Math.max(1, maximum)),
      },
    }),
  });
  if (!response.ok) throw new Error('SCHEDULER_STORAGE_READ_FAILED');
  const payload = await response.json() as Array<{ document?: FirestoreDocument }>;
  return payload.flatMap(({ document }) => {
    if (!document) return [];
    const id = documentId(document);
    const workspaceId = fieldString(document, 'workspaceId');
    const jobId = fieldString(document, 'jobId') || id;
    const scheduledAt = fieldTimestamp(document, 'scheduledAt');
    return validId(id, 128) && validId(workspaceId) && validId(jobId, 128) && scheduledAt
      ? [{ id, workspaceId, jobId, scheduledAt } satisfies ScheduledJob]
      : [];
  });
}

export async function recordSchedulerHeartbeat(projectId: string, accessToken: string) {
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, 'schedulerState/deno'),
      fields: { provider: stringValue('deno'), status: stringValue('healthy'), lastSeenAt: timestampValue(now) },
    },
  }]);
  return now;
}

export async function denoSchedulerReadiness(projectId: string, accessToken: string) {
  if (!denoSchedulerConfigured()) return { ready: false, reason: 'not_configured', provider: 'deno' };
  try {
    const state = await getDocument(projectId, accessToken, 'schedulerState/deno');
    const lastSeenAt = fieldTimestamp(state, 'lastSeenAt');
    const age = Date.now() - Date.parse(lastSeenAt);
    return Number.isFinite(age) && age >= 0 && age <= 4 * 60_000
      ? { ready: true, reason: '', provider: 'deno', lastSeenAt }
      : { ready: false, reason: 'heartbeat_stale', provider: 'deno', lastSeenAt };
  } catch {
    return { ready: false, reason: 'scheduler_unavailable', provider: 'deno' };
  }
}
