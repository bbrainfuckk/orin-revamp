import { strict as assert } from 'node:assert';
import shopifyHandler from '../server/shopify-dispatch.js';
import {
  normalizeBlueskyMetrics,
  normalizeFacebookMetrics,
  normalizeInstagramMetrics,
  normalizeMastodonMetrics,
} from '../server/social-analytics.js';
import { nextSocialOccurrence, validateSocialCredential, validateSocialPost } from '../server/social-core.js';

const now = Date.parse('2026-07-16T00:00:00.000Z');
const post = validateSocialPost({ text: 'A useful update.', mediaUrl: '', targets: [{ provider: 'facebook', accountId: 'page_123' }, { provider: 'threads', variant: 'For Threads.' }], scheduledAt: '2026-07-17T00:00:00.000Z' }, now);
assert.equal(post.targets.length, 2);
assert.equal(post.targets[0].accountId, 'page_123');
assert.equal(post.scheduledAt, '2026-07-17T00:00:00.000Z');
assert.equal(post.recurrence, 'none');
const autopost = validateSocialPost({ text: 'Daily update.', targets: [{ provider: 'telegram' }], scheduledAt: '2026-07-17T00:00:00.000Z', recurrence: 'weekdays', maxRuns: 30 }, now);
assert.equal(autopost.maxRuns, 30);
assert.equal(nextSocialOccurrence('2026-07-17T00:00:00.000Z', 'weekdays'), '2026-07-20T00:00:00.000Z');
assert.equal(nextSocialOccurrence('2026-01-31T08:00:00.000Z', 'monthly'), '2026-02-28T08:00:00.000Z');
assert.deepEqual(validateSocialCredential('telegram', { botToken: '123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345', chatId: '@orin_updates' }), { botToken: '123456789:abcdefghijklmnopqrstuvwxyzABCDE_12345', chatId: '@orin_updates' });
assert.deepEqual(validateSocialCredential('mastodon', { instanceUrl: 'https://mastodon.social/', accessToken: 'public-instance-token' }), { instanceUrl: 'https://mastodon.social', accessToken: 'public-instance-token' });
for (const instanceUrl of [
  'https://localhost', 'https://localhost.', 'https://service.local', 'https://service.local.', 'https://service.internal', 'https://service.localhost',
  'https://127.0.0.1', 'https://10.0.0.1', 'https://172.16.0.1', 'https://172.31.255.255', 'https://192.168.1.1', 'https://169.254.1.1',
  'https://[::1]', 'https://[fc00::1]', 'https://[fd12::1]', 'https://[fe80::1]', 'https://[::ffff:127.0.0.1]',
]) assert.throws(() => validateSocialCredential('mastodon', { instanceUrl, accessToken: 'token' }), /INVALID_CONNECTION/);
assert.throws(() => validateSocialPost({ text: 'x', targets: [{ provider: 'telegram' }, { provider: 'telegram' }] }, now), /INVALID_TARGET/);
assert.throws(() => validateSocialPost({ text: 'x', mediaUrl: 'http://insecure.test/file.jpg', targets: [{ provider: 'telegram' }] }, now), /INVALID_MEDIA_URL/);
assert.throws(() => validateSocialPost({ text: 'x', mediaUrl: 'https://cdn.example.test/video.mp4', targets: [{ provider: 'telegram' }] }, now), /UNSUPPORTED_MEDIA_TYPE/);
assert.equal(validateSocialPost({ text: 'x', mediaUrl: 'https://cdn.example.test/image.jpg', targets: [{ provider: 'telegram' }] }, now).mediaUrl, 'https://cdn.example.test/image.jpg');
assert.equal(validateSocialPost({ text: 'x', mediaUrl: 'https://cdn.example.test/render?id=1', targets: [{ provider: 'telegram' }] }, now).mediaUrl, 'https://cdn.example.test/render?id=1');
assert.throws(() => validateSocialCredential('reddit', { accessToken: 'secret' }), /MANAGED_OAUTH_REQUIRED/);
assert.throws(() => validateSocialPost({ text: 'x', targets: [{ provider: 'telegram' }], recurrence: 'daily', maxRuns: 3 }, now), /AUTOPOST_REQUIRES_SCHEDULE/);

const insight = (name: string, value: number) => ({ name, total_value: { value } });
assert.deepEqual(normalizeFacebookMetrics(
  { reactions: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } }, shares: { count: 2 } },
  { data: [insight('post_impressions', 1_000), insight('post_impressions_unique', 800), insight('post_engaged_users', 50), insight('post_clicks', 20)] },
), { impressions: 1_000, reach: 800, clicks: 20, reactions: 12, comments: 3, shares: 2, engagements: 50 });
assert.deepEqual(normalizeInstagramMetrics(
  { like_count: 20, comments_count: 5, media_type: 'REELS' },
  { data: [insight('views', 500), insight('reach', 300), insight('total_interactions', 40), insight('shares', 4), insight('saved', 6)] },
), { impressions: 500, reach: 300, reactions: 20, comments: 5, shares: 4, saves: 6, videoViews: 500, engagements: 40 });
assert.deepEqual(normalizeMastodonMetrics({ favourites_count: 3, replies_count: 2, reblogs_count: 5, quotes_count: 1 }), { reactions: 3, comments: 2, shares: 6, engagements: 11 });
assert.deepEqual(normalizeBlueskyMetrics({ likeCount: 7, replyCount: 2, repostCount: 4, quoteCount: 1 }), { reactions: 7, comments: 2, shares: 5, engagements: 14 });

let sweepStatus = 0;
let sweepPayload: unknown;
const sweepResponse = {
  setHeader: () => undefined,
  status(value: number) { sweepStatus = value; return sweepResponse; },
  json(value: unknown) { sweepPayload = value; },
  end: () => undefined,
};
await shopifyHandler({ method: 'POST', headers: {}, query: { provider: 'social', action: 'sweep' }, body: {} }, sweepResponse);
assert.equal(sweepStatus, 401);
assert.deepEqual(sweepPayload, { ok: false, error: 'UNAUTHENTICATED' });
sweepStatus = 0;
sweepPayload = undefined;
await shopifyHandler({ method: 'POST', headers: {}, query: { provider: 'social', action: 'analytics' }, body: { workspaceId: 'workspace_test' } }, sweepResponse);
assert.equal(sweepStatus, 401);
assert.deepEqual(sweepPayload, { ok: false, error: 'UNAUTHENTICATED' });
console.log('Social publishing validation passed.');
