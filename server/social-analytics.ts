import {
  commitWrites, decryptJson, documentName, fetchWithTransientRetry, fieldInteger, fieldString, fieldTimestamp,
  firestoreDocumentToJson, getDocument, integerValue, queryDocuments, stableId, stringValue, timestampValue,
  type FirestoreDocument,
} from './server-data.js';
import type { SocialProvider } from './social-core.js';

export const socialMetricKeys = [
  'impressions', 'reach', 'engagements', 'clicks', 'reactions', 'comments', 'shares', 'saves', 'videoViews',
] as const;
const analyticsWindowLimit = 150;
export type SocialMetricKey = typeof socialMetricKeys[number];
export type SocialMetrics = Partial<Record<SocialMetricKey, number>>;

type Credential = Record<string, unknown>;
type MetaPage = { id?: string; accessToken?: string; instagramBusinessAccount?: { id?: string } | null };
type MetaCredential = Credential & { graphVersion?: string; pages?: MetaPage[] };
type MetricResult = {
  state: 'live' | 'partial' | 'delivery_only' | 'unsupported';
  source: string;
  metrics: SocialMetrics;
  externalUrl?: string;
  error?: string;
};

const metricField = (key: SocialMetricKey) => `metric${key[0].toUpperCase()}${key.slice(1)}`;
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
const sumKnown = (...values: Array<number | undefined>) => values.some((value) => value !== undefined)
  ? values.reduce<number>((total, value) => total + (value || 0), 0)
  : undefined;

function metricValue(document: FirestoreDocument, key: SocialMetricKey) {
  const field = document.fields?.[metricField(key)];
  if (!field || (field.integerValue === undefined && field.doubleValue === undefined)) return undefined;
  return count(field.integerValue !== undefined ? Number(field.integerValue) : field.doubleValue);
}

function graphInsightValue(payload: unknown, name: string) {
  const entry = (payload as { data?: Array<{ name?: string; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } }> })?.data?.find((item) => item.name === name);
  return count(entry?.total_value?.value ?? entry?.values?.[0]?.value);
}

export function normalizeFacebookMetrics(basic: unknown, insights?: unknown): SocialMetrics {
  const post = basic as { reactions?: { summary?: { total_count?: unknown } }; comments?: { summary?: { total_count?: unknown } }; shares?: { count?: unknown } };
  const reactions = count(post.reactions?.summary?.total_count);
  const comments = count(post.comments?.summary?.total_count);
  const shares = count(post.shares?.count);
  return {
    ...(graphInsightValue(insights, 'post_impressions') !== undefined ? { impressions: graphInsightValue(insights, 'post_impressions') } : {}),
    ...(graphInsightValue(insights, 'post_impressions_unique') !== undefined ? { reach: graphInsightValue(insights, 'post_impressions_unique') } : {}),
    ...(graphInsightValue(insights, 'post_clicks') !== undefined ? { clicks: graphInsightValue(insights, 'post_clicks') } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(shares !== undefined ? { shares } : {}),
    ...(graphInsightValue(insights, 'post_engaged_users') ?? sumKnown(reactions, comments, shares)) !== undefined
      ? { engagements: graphInsightValue(insights, 'post_engaged_users') ?? sumKnown(reactions, comments, shares) }
      : {},
  };
}

export function normalizeInstagramMetrics(basic: unknown, insights?: unknown): SocialMetrics {
  const media = basic as { like_count?: unknown; comments_count?: unknown; media_type?: unknown };
  const reactions = count(media.like_count) ?? graphInsightValue(insights, 'likes');
  const comments = count(media.comments_count) ?? graphInsightValue(insights, 'comments');
  const shares = graphInsightValue(insights, 'shares');
  const saves = graphInsightValue(insights, 'saved');
  return {
    ...(graphInsightValue(insights, 'views') !== undefined ? { impressions: graphInsightValue(insights, 'views') } : {}),
    ...(graphInsightValue(insights, 'reach') !== undefined ? { reach: graphInsightValue(insights, 'reach') } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(shares !== undefined ? { shares } : {}),
    ...(saves !== undefined ? { saves } : {}),
    ...(['VIDEO', 'REELS'].includes(String(media.media_type || '').toUpperCase()) && graphInsightValue(insights, 'views') !== undefined ? { videoViews: graphInsightValue(insights, 'views') } : {}),
    ...(graphInsightValue(insights, 'total_interactions') ?? sumKnown(reactions, comments, shares, saves)) !== undefined
      ? { engagements: graphInsightValue(insights, 'total_interactions') ?? sumKnown(reactions, comments, shares, saves) }
      : {},
  };
}

export function normalizeMastodonMetrics(payload: unknown): SocialMetrics {
  const status = payload as { favourites_count?: unknown; replies_count?: unknown; reblogs_count?: unknown; quotes_count?: unknown };
  const reactions = count(status.favourites_count);
  const comments = count(status.replies_count);
  const shares = sumKnown(count(status.reblogs_count), count(status.quotes_count));
  return {
    ...(reactions !== undefined ? { reactions } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(shares !== undefined ? { shares } : {}),
    ...(sumKnown(reactions, comments, shares) !== undefined ? { engagements: sumKnown(reactions, comments, shares) } : {}),
  };
}

export function normalizeBlueskyMetrics(payload: unknown): SocialMetrics {
  const post = payload as { likeCount?: unknown; replyCount?: unknown; repostCount?: unknown; quoteCount?: unknown };
  const reactions = count(post.likeCount);
  const comments = count(post.replyCount);
  const shares = sumKnown(count(post.repostCount), count(post.quoteCount));
  return {
    ...(reactions !== undefined ? { reactions } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(shares !== undefined ? { shares } : {}),
    ...(sumKnown(reactions, comments, shares) !== undefined ? { engagements: sumKnown(reactions, comments, shares) } : {}),
  };
}

async function readJson(url: URL | string, token = '') {
  const response = await fetchWithTransientRetry(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, 8_000, 1);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerCode = Number((payload as { error?: { code?: unknown } })?.error?.code || 0);
    if (providerCode === 190 || response.status === 401) throw new Error('ANALYTICS_RECONNECT_REQUIRED');
    if ([10, 200].includes(providerCode) || response.status === 403) throw new Error('ANALYTICS_PERMISSION_REQUIRED');
    if ([4, 17, 32, 613].includes(providerCode) || response.status === 429) throw new Error('ANALYTICS_RATE_LIMITED');
    if (response.status === 404) throw new Error('ANALYTICS_POST_NOT_FOUND');
    if (response.status >= 500) throw new Error('ANALYTICS_PROVIDER_UNAVAILABLE');
    throw new Error('ANALYTICS_METRIC_UNAVAILABLE');
  }
  return payload;
}

function metaPage(credential: MetaCredential, provider: 'facebook' | 'instagram', accountId: string, externalId: string) {
  const pages = Array.isArray(credential.pages) ? credential.pages : [];
  const inferredPageId = provider === 'facebook' && externalId.includes('_') ? externalId.split('_')[0] : '';
  const eligible = pages.filter((page) => provider === 'facebook' ? Boolean(page.id) : Boolean(page.instagramBusinessAccount?.id));
  if (accountId) return eligible.find((page) => provider === 'facebook' ? page.id === accountId : page.instagramBusinessAccount?.id === accountId);
  if (inferredPageId) return eligible.find((page) => page.id === inferredPageId);
  return eligible.length === 1 ? eligible[0] : undefined;
}

async function facebookMetrics(credential: MetaCredential, externalId: string, accountId: string): Promise<MetricResult> {
  const page = metaPage(credential, 'facebook', accountId, externalId);
  if (!page) throw new Error('ANALYTICS_ACCOUNT_REQUIRED');
  if (!page.accessToken) throw new Error('ANALYTICS_RECONNECT_REQUIRED');
  const version = /^v\d+\.\d+$/.test(String(credential.graphVersion || '')) ? String(credential.graphVersion) : 'v24.0';
  const basicUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(externalId)}`);
  basicUrl.searchParams.set('fields', 'permalink_url,reactions.limit(0).summary(true),comments.limit(0).summary(true),shares');
  const basic = await readJson(basicUrl, page.accessToken) as { permalink_url?: string };
  const insightsUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(externalId)}/insights`);
  insightsUrl.searchParams.set('metric', 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks');
  try {
    const insights = await readJson(insightsUrl, page.accessToken);
    return { state: 'live', source: 'Meta Graph API', metrics: normalizeFacebookMetrics(basic, insights), externalUrl: basic.permalink_url };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'ANALYTICS_PROVIDER_UNAVAILABLE';
    return { state: 'partial', source: 'Meta Graph API', metrics: normalizeFacebookMetrics(basic), externalUrl: basic.permalink_url, error };
  }
}

async function instagramMetrics(credential: MetaCredential, externalId: string, accountId: string): Promise<MetricResult> {
  const page = metaPage(credential, 'instagram', accountId, externalId);
  if (!page) throw new Error('ANALYTICS_ACCOUNT_REQUIRED');
  if (!page.accessToken) throw new Error('ANALYTICS_RECONNECT_REQUIRED');
  const version = /^v\d+\.\d+$/.test(String(credential.graphVersion || '')) ? String(credential.graphVersion) : 'v24.0';
  const basicUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(externalId)}`);
  basicUrl.searchParams.set('fields', 'permalink,like_count,comments_count,media_type,timestamp');
  const basic = await readJson(basicUrl, page.accessToken) as { permalink?: string };
  const insightsUrl = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(externalId)}/insights`);
  insightsUrl.searchParams.set('metric', 'views,reach,total_interactions,likes,comments,shares,saved');
  try {
    const insights = await readJson(insightsUrl, page.accessToken);
    return { state: 'live', source: 'Instagram Graph API', metrics: normalizeInstagramMetrics(basic, insights), externalUrl: basic.permalink };
  } catch (cause) {
    const fallbackUrl = new URL(insightsUrl);
    fallbackUrl.searchParams.set('metric', 'reach,total_interactions');
    try {
      const fallback = await readJson(fallbackUrl, page.accessToken);
      return { state: 'partial', source: 'Instagram Graph API', metrics: normalizeInstagramMetrics(basic, fallback), externalUrl: basic.permalink, error: 'SOME_METRICS_UNAVAILABLE' };
    } catch {
      const error = cause instanceof Error ? cause.message : 'ANALYTICS_PROVIDER_UNAVAILABLE';
      return { state: 'partial', source: 'Instagram Graph API', metrics: normalizeInstagramMetrics(basic), externalUrl: basic.permalink, error };
    }
  }
}

async function mastodonMetrics(credential: Credential, externalId: string): Promise<MetricResult> {
  const instanceUrl = String(credential.instanceUrl || '').replace(/\/$/, '');
  const accessToken = String(credential.accessToken || '');
  if (!instanceUrl || !accessToken) throw new Error('ANALYTICS_RECONNECT_REQUIRED');
  const status = await readJson(`${instanceUrl}/api/v1/statuses/${encodeURIComponent(externalId)}`, accessToken) as { url?: string };
  return { state: 'live', source: 'Mastodon API', metrics: normalizeMastodonMetrics(status), externalUrl: status.url };
}

async function blueskyMetrics(externalId: string): Promise<MetricResult> {
  const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts');
  url.searchParams.append('uris', externalId);
  const payload = await readJson(url) as { posts?: Array<{ uri?: string; likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number; author?: { handle?: string } }> };
  const post = payload.posts?.find((item) => item.uri === externalId) || payload.posts?.[0];
  if (!post) throw new Error('ANALYTICS_POST_NOT_FOUND');
  const rkey = externalId.split('/').pop() || '';
  const externalUrl = post.author?.handle && rkey ? `https://bsky.app/profile/${encodeURIComponent(post.author.handle)}/post/${encodeURIComponent(rkey)}` : undefined;
  return { state: 'live', source: 'Bluesky AppView API', metrics: normalizeBlueskyMetrics(post), externalUrl };
}

async function fetchDeliveryMetrics(provider: SocialProvider, credential: Credential | null, externalId: string, accountId: string): Promise<MetricResult> {
  if (provider === 'facebook') return facebookMetrics((credential || {}) as MetaCredential, externalId, accountId);
  if (provider === 'instagram') return instagramMetrics((credential || {}) as MetaCredential, externalId, accountId);
  if (provider === 'mastodon') return mastodonMetrics(credential || {}, externalId);
  if (provider === 'bluesky') return blueskyMetrics(externalId);
  if (provider === 'telegram') return { state: 'delivery_only', source: 'Telegram Bot API', metrics: {} };
  return { state: 'unsupported', source: 'Delivery receipt only', metrics: {} };
}

async function credentialFor(projectId: string, accessToken: string, workspaceId: string, provider: SocialProvider) {
  if (!['facebook', 'instagram', 'mastodon'].includes(provider)) return null;
  const vaultId = provider === 'facebook' || provider === 'instagram' ? 'meta' : `social_${provider}`;
  const vault = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/${vaultId}`);
  if (!vault) throw new Error('ANALYTICS_RECONNECT_REQUIRED');
  return decryptJson<Credential>(fieldString(vault, 'ciphertext'), fieldString(vault, 'iv'), process.env.CONNECTOR_ENCRYPTION_KEY || '');
}

function deliveryMetrics(document: FirestoreDocument): SocialMetrics {
  return Object.fromEntries(socialMetricKeys.flatMap((key) => {
    const value = metricValue(document, key);
    return value === undefined ? [] : [[key, value]];
  })) as SocialMetrics;
}

function aggregateAnalytics(deliveries: FirestoreDocument[], posts: FirestoreDocument[]) {
  const postMap = new Map(posts.map((post) => [post.name?.split('/').pop() || '', firestoreDocumentToJson(post) as Record<string, unknown>]));
  const delivered = deliveries.filter((item) => fieldString(item, 'status') === 'delivered');
  const tracked = delivered.filter((item) => ['live', 'partial'].includes(fieldString(item, 'analyticsState')));
  const eligibleProviders = new Set(['facebook', 'instagram', 'mastodon', 'bluesky']);
  const eligible = delivered.filter((item) => eligibleProviders.has(fieldString(item, 'provider'))).length;
  const metricCoverage = Object.fromEntries(socialMetricKeys.map((key) => [key, tracked.filter((item) => metricValue(item, key) !== undefined).length])) as Record<SocialMetricKey, number>;
  const metricTotals = Object.fromEntries(socialMetricKeys.map((key) => [key, metricCoverage[key] ? tracked.reduce((sum, item) => sum + (metricValue(item, key) || 0), 0) : null])) as Record<SocialMetricKey, number | null>;
  const totals = { published: delivered.length, tracked: tracked.length, ...metricTotals };
  const rateRows = tracked.filter((item) => metricValue(item, 'impressions') !== undefined && metricValue(item, 'engagements') !== undefined);
  const rateImpressions = rateRows.reduce((sum, item) => sum + (metricValue(item, 'impressions') || 0), 0);
  const rateEngagements = rateRows.reduce((sum, item) => sum + (metricValue(item, 'engagements') || 0), 0);
  const channelMap = new Map<string, { provider: string; deliveries: number; tracked: number; metrics: Record<SocialMetricKey, number>; metricCoverage: Record<SocialMetricKey, number>; lastSyncedAt: string; states: Set<string>; errors: Set<string> }>();
  for (const item of delivered) {
    const provider = fieldString(item, 'provider');
    const channel = channelMap.get(provider) || { provider, deliveries: 0, tracked: 0, metrics: Object.fromEntries(socialMetricKeys.map((key) => [key, 0])) as Record<SocialMetricKey, number>, metricCoverage: Object.fromEntries(socialMetricKeys.map((key) => [key, 0])) as Record<SocialMetricKey, number>, lastSyncedAt: '', states: new Set<string>(), errors: new Set<string>() };
    channel.deliveries += 1;
    const state = fieldString(item, 'analyticsState') || 'not_synced';
    channel.states.add(state);
    if (fieldString(item, 'analyticsError')) channel.errors.add(fieldString(item, 'analyticsError'));
    if (['live', 'partial'].includes(state)) {
      channel.tracked += 1;
      for (const key of socialMetricKeys) {
        const value = metricValue(item, key);
        if (value !== undefined) { channel.metrics[key] += value; channel.metricCoverage[key] += 1; }
      }
    }
    const syncedAt = fieldTimestamp(item, 'analyticsUpdatedAt');
    if (syncedAt > channel.lastSyncedAt) channel.lastSyncedAt = syncedAt;
    channelMap.set(provider, channel);
  }
  const postRows = delivered
    .sort((a, b) => (fieldTimestamp(b, 'publishedAt') || fieldTimestamp(b, 'updatedAt')).localeCompare(fieldTimestamp(a, 'publishedAt') || fieldTimestamp(a, 'updatedAt')))
    .slice(0, 50)
    .map((item) => {
      const postId = fieldString(item, 'postId');
      const post = postMap.get(postId) || {};
      return {
        id: item.name?.split('/').pop() || '', deliveryId: item.name?.split('/').pop() || '', postId, provider: fieldString(item, 'provider'), accountId: fieldString(item, 'accountId'), status: 'delivered',
        externalId: fieldString(item, 'externalId'), externalUrl: fieldString(item, 'externalUrl'), state: fieldString(item, 'analyticsState') || 'not_synced',
        source: fieldString(item, 'analyticsSource'), error: fieldString(item, 'analyticsError'), publishedAt: fieldTimestamp(item, 'publishedAt') || fieldTimestamp(item, 'updatedAt'),
        syncedAt: fieldTimestamp(item, 'analyticsUpdatedAt'), lastSyncedAt: fieldTimestamp(item, 'analyticsUpdatedAt'), metrics: deliveryMetrics(item), text: String(post.text || '').slice(0, 280), mediaUrl: String(post.mediaUrl || '').slice(0, 2_000),
      };
    });
  const lastSyncedAt = tracked.reduce((latest, item) => Math.max(latest, Date.parse(fieldTimestamp(item, 'analyticsUpdatedAt')) || 0), 0);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    windowed: true,
    windowLimit: analyticsWindowLimit,
    window: { type: 'recent_deliveries', limit: analyticsWindowLimit, label: `Latest ${analyticsWindowLimit} deliveries` },
    lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : '',
    coverage: { delivered: delivered.length, total: delivered.length, eligible, tracked: tracked.length, percent: eligible ? Math.round(tracked.length / eligible * 100) : 0 },
    totals,
    metricCoverage,
    engagementRate: rateImpressions > 0 ? rateEngagements / rateImpressions * 100 : null,
    engagementRateCoverage: rateRows.length,
    channels: [...channelMap.values()].map((channel) => {
      const states = [...channel.states];
      const state = states.includes('partial') ? 'partial' : states.includes('live') ? 'live' : states.includes('error') ? 'error' : states.includes('delivery_only') ? 'delivery_only' : states[0] || 'not_synced';
      const metrics = Object.fromEntries(socialMetricKeys.map((key) => [key, channel.metricCoverage[key] ? channel.metrics[key] : null]));
      return { ...channel, posts: channel.deliveries, state, states, metrics, error: [...channel.errors][0] || '', errors: [...channel.errors] };
    }).sort((a, b) => Number(b.metrics.engagements || 0) - Number(a.metrics.engagements || 0)),
    posts: postRows,
  };
}

async function computeSocialAnalytics(projectId: string, accessToken: string, workspaceId: string) {
  const [deliveries, posts] = await Promise.all([
    queryDocuments(projectId, accessToken, `workspaces/${workspaceId}`, { from: [{ collectionId: 'socialDeliveries' }], orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'DESCENDING' }], limit: analyticsWindowLimit }),
    queryDocuments(projectId, accessToken, `workspaces/${workspaceId}`, { from: [{ collectionId: 'socialPosts' }], orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }], limit: analyticsWindowLimit }),
  ]);
  return aggregateAnalytics(deliveries, posts);
}

export async function readSocialAnalytics(projectId: string, accessToken: string, workspaceId: string) {
  const cached = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/socialAnalyticsState/summary`);
  if (cached) {
    try {
      const payload = JSON.parse(fieldString(cached, 'payloadJson')) as Record<string, unknown>;
      if (payload?.ok === true) return { ...payload, cached: true };
    } catch { /* Recompute a malformed or old cache. */ }
  }
  const analytics = await computeSocialAnalytics(projectId, accessToken, workspaceId);
  await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/socialAnalyticsState/summary`), fields: { payloadJson: stringValue(JSON.stringify(analytics)), updatedAt: timestampValue(new Date().toISOString()) } } }]);
  return { ...analytics, cached: false };
}

export async function refreshSocialAnalytics(projectId: string, accessToken: string, workspaceId: string) {
  const requestedAt = new Date();
  const leaseId = `refresh_${Math.floor(requestedAt.getTime() / (5 * 60_000))}`;
  const leasePath = `workspaces/${workspaceId}/socialAnalyticsState/${leaseId}`;
  const acquired = await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, leasePath), fields: { status: stringValue('running'), requestedAt: timestampValue(requestedAt.toISOString()), expiresAt: timestampValue(new Date(requestedAt.getTime() + 5 * 60_000).toISOString()) } },
    currentDocument: { exists: false },
  }], true);
  if (!acquired) return { ...await readSocialAnalytics(projectId, accessToken, workspaceId), refresh: { attempted: 0, refreshed: 0, failed: 0, busy: true, retryAfterSeconds: 300 } };
  const freshnessCutoff = Date.now() - 5 * 60_000;
  const deliveries = (await queryDocuments(projectId, accessToken, `workspaces/${workspaceId}`, { from: [{ collectionId: 'socialDeliveries' }], orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'DESCENDING' }], limit: analyticsWindowLimit }))
    .filter((item) => fieldString(item, 'status') === 'delivered' && fieldString(item, 'externalId'))
    .filter((item) => (Date.parse(fieldTimestamp(item, 'analyticsUpdatedAt')) || 0) < freshnessCutoff)
    .sort((a, b) => (fieldTimestamp(b, 'publishedAt') || fieldTimestamp(b, 'updatedAt')).localeCompare(fieldTimestamp(a, 'publishedAt') || fieldTimestamp(a, 'updatedAt')))
    .slice(0, 30);
  const credentials = new Map<string, Promise<Credential | null>>();
  const now = new Date().toISOString();
  const writes: unknown[] = [];
  let refreshed = 0; let failed = 0;

  for (let index = 0; index < deliveries.length; index += 10) {
    await Promise.all(deliveries.slice(index, index + 10).map(async (delivery) => {
      const deliveryId = delivery.name?.split('/').pop() || '';
      const provider = fieldString(delivery, 'provider') as SocialProvider;
      const externalId = fieldString(delivery, 'externalId');
      const accountId = fieldString(delivery, 'accountId');
      const path = `workspaces/${workspaceId}/socialDeliveries/${deliveryId}`;
      try {
        const credentialKey = provider === 'facebook' || provider === 'instagram' ? 'meta' : provider;
        if (!credentials.has(credentialKey)) credentials.set(credentialKey, credentialFor(projectId, accessToken, workspaceId, provider));
        const result = await fetchDeliveryMetrics(provider, await credentials.get(credentialKey)!, externalId, accountId);
        const fields: Record<string, unknown> = {
          analyticsState: stringValue(result.state), analyticsSource: stringValue(result.source), analyticsError: stringValue(result.error || ''), analyticsUpdatedAt: timestampValue(now),
          externalUrl: stringValue(result.externalUrl || fieldString(delivery, 'externalUrl')),
        };
        const fieldPaths = [...Object.keys(fields), ...socialMetricKeys.map(metricField)];
        for (const [key, value] of Object.entries(result.metrics) as Array<[SocialMetricKey, number]>) {
          fields[metricField(key)] = integerValue(value);
        }
        writes.push({ update: { name: documentName(projectId, path), fields }, updateMask: { fieldPaths } });
        if (result.state === 'live' || result.state === 'partial') {
          const snapshotId = await stableId('social-metric-snapshot', deliveryId, now.slice(0, 10), result.state);
          const snapshotFields: Record<string, unknown> = {
            deliveryId: stringValue(deliveryId), postId: stringValue(fieldString(delivery, 'postId')), provider: stringValue(provider),
            observedDate: stringValue(now.slice(0, 10)), observedAt: timestampValue(now), source: stringValue(result.source),
          };
          for (const [key, value] of Object.entries(result.metrics) as Array<[SocialMetricKey, number]>) snapshotFields[metricField(key)] = integerValue(value);
          writes.push({ update: { name: documentName(projectId, `workspaces/${workspaceId}/socialMetricSnapshots/${snapshotId}`), fields: snapshotFields } });
        }
        refreshed += 1;
      } catch (cause) {
        failed += 1;
        const error = cause instanceof Error ? cause.message.split(':')[0].slice(0, 80) : 'ANALYTICS_PROVIDER_FAILED';
        writes.push({ update: { name: documentName(projectId, path), fields: { analyticsState: stringValue('error'), analyticsError: stringValue(error), analyticsUpdatedAt: timestampValue(now) } }, updateMask: { fieldPaths: ['analyticsState', 'analyticsError', 'analyticsUpdatedAt'] } });
      }
    }));
  }
  for (let index = 0; index < writes.length; index += 400) await commitWrites(projectId, accessToken, writes.slice(index, index + 400));
  const analytics = await computeSocialAnalytics(projectId, accessToken, workspaceId);
  const completedAt = new Date().toISOString();
  await commitWrites(projectId, accessToken, [
    { update: { name: documentName(projectId, leasePath), fields: { status: stringValue('complete'), completedAt: timestampValue(completedAt) } }, updateMask: { fieldPaths: ['status', 'completedAt'] } },
    { update: { name: documentName(projectId, `workspaces/${workspaceId}/socialAnalyticsState/summary`), fields: { payloadJson: stringValue(JSON.stringify(analytics)), updatedAt: timestampValue(completedAt) } } },
  ]);
  return { ...analytics, cached: false, refresh: { attempted: deliveries.length, refreshed, failed, busy: false } };
}
