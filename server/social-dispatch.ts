import {
  booleanValue, commitWrites, constantTimeEqual, decryptJson, documentName, encryptJson, fieldBoolean, fieldInteger, fieldString, fieldTimestamp, getDocument,
  googleAccessToken, integerValue, stableId, stringValue, timestampValue, verifyFirebaseAccount,
  type FirestoreDocument, type ServerRequest,
} from './server-data.js';
import {
  nextSocialOccurrence, socialCapabilities, validateSocialCredential, validateSocialPost,
  type SocialProvider, type SocialRecurrence,
} from './social-core.js';
import {
  denoSchedulerReadiness, listDueScheduledJobs, putScheduledJob, recordSchedulerHeartbeat, removeScheduledJob,
} from './scheduler-store.js';
import { authorizeOrinApiKey } from './orin-api.js';

type SocialRequest = ServerRequest & { method?: string; body?: unknown };
type Body = Record<string, unknown>;
type Credential = Record<string, string>;
type MetaCredential = { graphVersion: string; pages: Array<{ id: string; accessToken: string; instagramBusinessAccount?: { id?: string } | null }> };

function bodyOf(req: SocialRequest): Body {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_REQUEST');
  return body as Body;
}

function clean(value: unknown, maximum = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

async function requireEditor(projectId: string, accessToken: string, workspaceId: string, uid: string) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId)) throw new Error('INVALID_REQUEST');
  const [workspace, membership] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`),
  ]);
  const role = fieldString(membership, 'role');
  if (!workspace || !['owner', 'admin', 'editor'].includes(role)) throw new Error('FORBIDDEN');
  return fieldString(workspace, 'ownerId') || uid;
}

async function testCredential(provider: SocialProvider, credential: Credential) {
  if (provider === 'telegram') {
    const response = await fetch(`https://api.telegram.org/bot${credential.botToken}/getChat?chat_id=${encodeURIComponent(credential.chatId)}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok || !(await response.json() as { ok?: boolean }).ok) throw new Error('PROVIDER_REJECTED_CREDENTIALS');
  } else if (provider === 'mastodon') {
    const response = await fetch(`${credential.instanceUrl}/api/v1/accounts/verify_credentials`, { headers: { Authorization: `Bearer ${credential.accessToken}` }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('PROVIDER_REJECTED_CREDENTIALS');
  } else if (provider === 'bluesky') {
    const response = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: credential.handle, password: credential.appPassword }), signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('PROVIDER_REJECTED_CREDENTIALS');
  }
}

async function publish(provider: SocialProvider, credential: Credential, text: string, mediaUrl: string, idempotencyKey: string) {
  if (provider === 'facebook' || provider === 'instagram') {
    const meta = credential as unknown as MetaCredential; const page = meta.pages.find((item) => provider === 'facebook' ? true : Boolean(item.instagramBusinessAccount?.id));
    if (!page?.id || !page.accessToken) throw new Error('PROVIDER_ACCOUNT_NOT_FOUND');
    const version = /^v\d+\.\d+$/.test(meta.graphVersion) ? meta.graphVersion : 'v23.0';
    if (provider === 'facebook') {
      const endpoint = mediaUrl ? `${page.id}/photos` : `${page.id}/feed`; const form = new URLSearchParams(mediaUrl ? { url: mediaUrl, caption: text } : { message: text });
      const response = await fetch(`https://graph.facebook.com/${version}/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${page.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(20_000) });
      const data = await response.json().catch(() => ({})) as { id?: string; post_id?: string };
      if (!response.ok || (!data.id && !data.post_id)) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
      return data.post_id || data.id || '';
    }
    if (!mediaUrl) throw new Error('INSTAGRAM_MEDIA_REQUIRED');
    const instagramId = page.instagramBusinessAccount?.id || '';
    const container = await fetch(`https://graph.facebook.com/${version}/${instagramId}/media`, { method: 'POST', headers: { Authorization: `Bearer ${page.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ image_url: mediaUrl, caption: text }), signal: AbortSignal.timeout(20_000) });
    const containerData = await container.json().catch(() => ({})) as { id?: string }; if (!container.ok || !containerData.id) throw new Error(`PROVIDER_DELIVERY_FAILED:${container.status}`);
    const response = await fetch(`https://graph.facebook.com/${version}/${instagramId}/media_publish`, { method: 'POST', headers: { Authorization: `Bearer ${page.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ creation_id: containerData.id }), signal: AbortSignal.timeout(20_000) });
    const data = await response.json().catch(() => ({})) as { id?: string }; if (!response.ok || !data.id) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`); return data.id;
  }
  if (mediaUrl && provider !== 'telegram') throw new Error('MEDIA_UPLOAD_NOT_READY');
  if (provider === 'telegram') {
    const endpoint = mediaUrl ? 'sendPhoto' : 'sendMessage';
    const payload = mediaUrl ? { chat_id: credential.chatId, photo: mediaUrl, caption: text } : { chat_id: credential.chatId, text };
    const response = await fetch(`https://api.telegram.org/bot${credential.botToken}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: { message_id?: number }; description?: string };
    if (!response.ok || !data.ok || !data.result?.message_id) throw new Error(`PROVIDER_DELIVERY_FAILED:${data.description || response.status}`);
    return String(data.result.message_id);
  }
  if (provider === 'mastodon') {
    const response = await fetch(`${credential.instanceUrl}/api/v1/statuses`, { method: 'POST', headers: { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ status: text }), signal: AbortSignal.timeout(15_000) });
    const data = await response.json().catch(() => ({})) as { id?: string };
    if (!response.ok || !data.id) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
    return data.id;
  }
  if (provider === 'bluesky') {
    const sessionResponse = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: credential.handle, password: credential.appPassword }), signal: AbortSignal.timeout(8_000) });
    const session = await sessionResponse.json().catch(() => ({})) as { accessJwt?: string; did?: string };
    if (!sessionResponse.ok || !session.accessJwt || !session.did) throw new Error('PROVIDER_REJECTED_CREDENTIALS');
    const response = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', { method: 'POST', headers: { Authorization: `Bearer ${session.accessJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString() } }), signal: AbortSignal.timeout(15_000) });
    const data = await response.json().catch(() => ({})) as { uri?: string };
    if (!response.ok || !data.uri) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
    return data.uri;
  }
  throw new Error('PROVIDER_NOT_CONNECTED');
}

async function credentialFor(projectId: string, accessToken: string, workspaceId: string, provider: SocialProvider) {
  const vaultId = provider === 'facebook' || provider === 'instagram' ? 'meta' : `social_${provider}`;
  const vault = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/${vaultId}`);
  if (!vault) throw new Error('PROVIDER_NOT_CONNECTED');
  return decryptJson<Credential>(fieldString(vault, 'ciphertext'), fieldString(vault, 'iv'), process.env.CONNECTOR_ENCRYPTION_KEY || '');
}

async function deliverStoredPost(projectId: string, accessToken: string, workspaceId: string, postId: string, post: FirestoreDocument) {
  const text = fieldString(post, 'text');
  const mediaUrl = fieldString(post, 'mediaUrl');
  let targets: Array<{ provider: SocialProvider; variant?: string }>;
  try { targets = JSON.parse(fieldString(post, 'targetsJson')); } catch { throw new Error('INVALID_STORED_POST'); }
  const deliveries = await Promise.all(targets.map(async (target) => {
    const deliveryId = await stableId('social-delivery', postId, target.provider);
    let deliveryStatus = 'failed'; let externalId = ''; let error = '';
    try { externalId = await publish(target.provider, await credentialFor(projectId, accessToken, workspaceId, target.provider), target.variant || text, mediaUrl, deliveryId); deliveryStatus = 'delivered'; } catch (cause) { error = cause instanceof Error ? cause.message.slice(0, 300) : 'DELIVERY_FAILED'; }
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/socialDeliveries/${deliveryId}`), fields: { postId: stringValue(postId), provider: stringValue(target.provider), status: stringValue(deliveryStatus), externalId: stringValue(externalId), error: stringValue(error), requestCount: integerValue(1), bytesSent: integerValue(new TextEncoder().encode(target.variant || text).byteLength), updatedAt: timestampValue(new Date().toISOString()) } } }]);
    return { provider: target.provider, status: deliveryStatus, externalId, error };
  }));
  const delivered = deliveries.filter((delivery) => delivery.status === 'delivered').length;
  const status = delivered === targets.length ? 'delivered' : delivered ? 'partially_delivered' : 'failed';
  await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/socialPosts/${postId}`), fields: { status: stringValue(status), deliveredCount: integerValue(delivered), updatedAt: timestampValue(new Date().toISOString()), completed: booleanValue(true) } }, updateMask: { fieldPaths: ['status', 'deliveredCount', 'updatedAt', 'completed'] } }]);
  return { status, deliveries };
}

async function enqueuePost(projectId: string, accessToken: string, workspaceId: string, postId: string, scheduledAt: string) {
  await putScheduledJob(projectId, accessToken, 'social', workspaceId, postId, scheduledAt);
}

async function reserveScheduledPost(projectId: string, accessToken: string, workspaceId: string, postId: string, post: FirestoreDocument) {
  if (!post.updateTime) return false;
  return commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, `workspaces/${workspaceId}/socialPosts/${postId}`),
      fields: { status: stringValue('publishing'), updatedAt: timestampValue(new Date().toISOString()) },
    },
    updateMask: { fieldPaths: ['status', 'updatedAt'] },
    currentDocument: { updateTime: post.updateTime },
  }], true);
}

async function scheduleNextAutopost(projectId: string, accessToken: string, workspaceId: string, postId: string, post: FirestoreDocument) {
  const recurrence = fieldString(post, 'recurrence') as SocialRecurrence;
  const runNumber = Math.max(1, fieldInteger(post, 'runNumber'));
  const maxRuns = Math.max(1, fieldInteger(post, 'maxRuns'));
  if (recurrence === 'none' || !recurrence || runNumber >= maxRuns) return null;
  const nextAt = nextSocialOccurrence(fieldTimestamp(post, 'scheduledAt'), recurrence);
  const seriesId = fieldString(post, 'seriesId') || postId;
  const nextPostId = await stableId('social-post-run', seriesId, nextAt);
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [{
    update: {
      name: documentName(projectId, `workspaces/${workspaceId}/socialPosts/${nextPostId}`),
      fields: {
        text: stringValue(fieldString(post, 'text')),
        mediaUrl: stringValue(fieldString(post, 'mediaUrl')),
        targetsJson: stringValue(fieldString(post, 'targetsJson')),
        status: stringValue('scheduled'),
        scheduledAt: timestampValue(nextAt),
        recurrence: stringValue(recurrence),
        seriesId: stringValue(seriesId),
        runNumber: integerValue(runNumber + 1),
        maxRuns: integerValue(maxRuns),
        createdBy: stringValue(fieldString(post, 'createdBy')),
        createdAt: timestampValue(now),
        updatedAt: timestampValue(now),
        completed: booleanValue(false),
      },
    },
    currentDocument: { exists: false },
  }], true);
  // The deterministic job document safely repairs a missing route on retries.
  await enqueuePost(projectId, accessToken, workspaceId, nextPostId, nextAt);
  return { postId: nextPostId, scheduledAt: nextAt, runNumber: runNumber + 1, maxRuns };
}

async function runScheduledPost(projectId: string, accessToken: string, workspaceId: string, postId: string) {
  const post = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/socialPosts/${postId}`);
  if (!post) return { ok: true, duplicate: true };
  const status = fieldString(post, 'status');
  if (status === 'publishing' && !fieldBoolean(post, 'completed')) return { ok: true, busy: true };
  if (status !== 'scheduled') {
    const next = fieldBoolean(post, 'completed')
      ? await scheduleNextAutopost(projectId, accessToken, workspaceId, postId, post)
      : null;
    return { ok: true, duplicate: true, next };
  }
  if (!await reserveScheduledPost(projectId, accessToken, workspaceId, postId, post)) return { ok: true, busy: true };
  const outcome = await deliverStoredPost(projectId, accessToken, workspaceId, postId, post);
  const next = await scheduleNextAutopost(projectId, accessToken, workspaceId, postId, post);
  return { ok: true, postId, ...outcome, next };
}

async function sweepScheduledPosts(projectId: string, accessToken: string) {
  const jobs = await listDueScheduledJobs(projectId, accessToken, 'social', new Date().toISOString(), 100);
  const outcomes: Array<{ jobId: string; ok: boolean; busy?: boolean; duplicate?: boolean; error?: string }> = [];
  const startedAt = Date.now();
  for (let index = 0; index < jobs.length && Date.now() - startedAt < 45_000; index += 10) {
    outcomes.push(...await Promise.all(jobs.slice(index, index + 10).map(async (job) => {
      try {
        const result = await runScheduledPost(projectId, accessToken, job.workspaceId, job.jobId);
        if (!result.busy) await removeScheduledJob(projectId, accessToken, 'social', job.id);
        return { jobId: job.jobId, ok: true, busy: result.busy === true, duplicate: result.duplicate === true };
      } catch (cause) {
        return { jobId: job.jobId, ok: false, error: cause instanceof Error ? cause.message.slice(0, 120) : 'SOCIAL_JOB_FAILED' };
      }
    })));
  }
  return { ok: outcomes.every((item) => item.ok), checked: outcomes.length, deferred: jobs.length - outcomes.length, outcomes };
}

export async function handleSocial(req: SocialRequest, action: string) {
  if (req.method !== 'POST') throw new Error('METHOD_NOT_ALLOWED');
  const body = bodyOf(req);
  if (action === 'run_scheduled') {
    const supplied = typeof req.headers?.['x-orin-scheduler'] === 'string' ? req.headers['x-orin-scheduler'] : '';
    if (!process.env.ORIN_SCHEDULER_SECRET || !constantTimeEqual(supplied, process.env.ORIN_SCHEDULER_SECRET)) throw new Error('UNAUTHENTICATED');
    const workspaceId = clean(body.workspaceId); const postId = clean(body.postId, 80);
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId) || !/^[A-Za-z0-9_-]{20,80}$/.test(postId)) throw new Error('INVALID_REQUEST');
    const { projectId, accessToken } = await googleAccessToken();
    const result = await runScheduledPost(projectId, accessToken, workspaceId, postId);
    if (!result.busy) await removeScheduledJob(projectId, accessToken, 'social', postId);
    return result;
  }
  if (action === 'sweep') {
    const supplied = typeof req.headers?.['x-orin-scheduler'] === 'string' ? req.headers['x-orin-scheduler'] : '';
    if (!process.env.ORIN_SCHEDULER_SECRET || !constantTimeEqual(supplied, process.env.ORIN_SCHEDULER_SECRET)) throw new Error('UNAUTHENTICATED');
    const { projectId, accessToken } = await googleAccessToken();
    const lastSeenAt = await recordSchedulerHeartbeat(projectId, accessToken);
    return { ...await sweepScheduledPosts(projectId, accessToken), provider: 'deno', lastSeenAt };
  }
  const { projectId, accessToken } = await googleAccessToken();
  const authorization = Array.isArray(req.headers?.authorization) ? req.headers?.authorization[0] || '' : req.headers?.authorization || '';
  const apiPrincipal = authorization.startsWith('Bearer orin_live_') ? await authorizeOrinApiKey(req, 'publishing:write') : null;
  const account = apiPrincipal ? null : await verifyFirebaseAccount(req);
  const workspaceId = apiPrincipal?.workspaceId || clean(body.workspaceId);
  if (apiPrincipal && body.workspaceId && clean(body.workspaceId) !== workspaceId) throw new Error('FORBIDDEN');
  const workspace = await getDocument(projectId, accessToken, `workspaces/${workspaceId}`);
  const actorId = account?.localId || `api_${apiPrincipal?.keyId}`;
  const ownerId = apiPrincipal ? fieldString(workspace, 'ownerId') : await requireEditor(projectId, accessToken, workspaceId, actorId);
  if (!workspace || !ownerId) throw new Error('FORBIDDEN');
  if (apiPrincipal && !['create', 'publish', 'scheduler_status'].includes(action)) throw new Error('FORBIDDEN');
  const now = new Date().toISOString();

  if (action === 'scheduler_status') return { ok: true, scheduler: await denoSchedulerReadiness(projectId, accessToken) };

  if (action === 'disconnect') {
    const provider = clean(body.provider, 40) as SocialProvider;
    if (!socialCapabilities[provider] || socialCapabilities[provider].connection !== 'token') throw new Error('INVALID_CONNECTION');
    await commitWrites(projectId, accessToken, [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/social_${provider}`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/social_${provider}`) },
    ]);
    return { ok: true, provider, disconnected: true };
  }

  if (action === 'cancel' || action === 'retry') {
    const postId = clean(body.postId, 80);
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(postId)) throw new Error('INVALID_REQUEST');
    const postPath = `workspaces/${workspaceId}/socialPosts/${postId}`;
    const post = await getDocument(projectId, accessToken, postPath);
    if (!post) throw new Error('POST_NOT_FOUND');
    const currentStatus = fieldString(post, 'status');
    if (action === 'cancel') {
      if (!['scheduled', 'schedule_failed'].includes(currentStatus)) throw new Error('POST_NOT_CANCELLABLE');
      await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, postPath), fields: { status: stringValue('cancelled'), completed: booleanValue(true), cancelledBy: stringValue(actorId), updatedAt: timestampValue(now) } }, updateMask: { fieldPaths: ['status', 'completed', 'cancelledBy', 'updatedAt'] }, ...(post.updateTime ? { currentDocument: { updateTime: post.updateTime } } : {}) }]);
      return { ok: true, postId, status: 'cancelled' };
    }
    if (!['failed', 'partially_delivered'].includes(currentStatus)) throw new Error('POST_NOT_RETRYABLE');
    const reserved = await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, postPath), fields: { status: stringValue('publishing'), completed: booleanValue(false), updatedAt: timestampValue(now) } }, updateMask: { fieldPaths: ['status', 'completed', 'updatedAt'] }, ...(post.updateTime ? { currentDocument: { updateTime: post.updateTime } } : {}) }], true);
    if (!reserved) throw new Error('POST_CHANGED');
    return { ok: true, postId, ...await deliverStoredPost(projectId, accessToken, workspaceId, postId, post) };
  }

  if (action === 'connect') {
    const provider = clean(body.provider, 40) as SocialProvider;
    const credential = validateSocialCredential(provider, body.credential) as Credential;
    await testCredential(provider, credential);
    const encrypted = await encryptJson(credential, process.env.CONNECTOR_ENCRYPTION_KEY || '');
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/connectorVault/social_${provider}`), fields: { provider: stringValue(provider), ownerId: stringValue(ownerId), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), encryptionVersion: integerValue(1), updatedAt: timestampValue(now) } } }, { update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/social_${provider}`), fields: { provider: stringValue(provider), category: stringValue('social_publishing'), displayName: stringValue(socialCapabilities[provider].label), status: stringValue('connected'), health: stringValue('healthy'), credentialState: stringValue('stored_server_side'), connectionMode: stringValue('byok'), connectedBy: stringValue(actorId), updatedAt: timestampValue(now) } } }]);
    return { ok: true, provider };
  }

  if (action === 'create' || action === 'publish') {
    const post = validateSocialPost(body);
    const requestId = clean(body.requestId, 128);
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestId)) throw new Error('INVALID_REQUEST');
    const postId = await stableId('social-post', workspaceId, actorId, requestId);
    const postPath = `workspaces/${workspaceId}/socialPosts/${postId}`;
    if (await getDocument(projectId, accessToken, postPath)) return { ok: true, postId, duplicate: true };
    const status = post.scheduledAt ? 'scheduled' : 'publishing';
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, postPath), fields: { text: stringValue(post.text), mediaUrl: stringValue(post.mediaUrl), targetsJson: stringValue(JSON.stringify(post.targets)), status: stringValue(status), scheduledAt: post.scheduledAt ? timestampValue(post.scheduledAt) : timestampValue(now), recurrence: stringValue(post.recurrence), seriesId: stringValue(postId), runNumber: integerValue(1), maxRuns: integerValue(post.maxRuns), createdBy: stringValue(actorId), createdAt: timestampValue(now), updatedAt: timestampValue(now), completed: booleanValue(false) } }, currentDocument: { exists: false } }]);
    if (post.scheduledAt) {
      try { await enqueuePost(projectId, accessToken, workspaceId, postId, post.scheduledAt); }
      catch (cause) {
        await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, postPath), fields: { status: stringValue('schedule_failed'), updatedAt: timestampValue(new Date().toISOString()) } }, updateMask: { fieldPaths: ['status', 'updatedAt'] } }]);
        throw cause;
      }
      return { ok: true, postId, status: 'scheduled', recurrence: post.recurrence, maxRuns: post.maxRuns };
    }
    const stored = await getDocument(projectId, accessToken, postPath);
    return { ok: true, postId, ...await deliverStoredPost(projectId, accessToken, workspaceId, postId, stored!) };
  }
  throw new Error('INVALID_REQUEST');
}
