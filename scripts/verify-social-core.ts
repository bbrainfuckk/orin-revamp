import { strict as assert } from 'node:assert';
import shopifyHandler from '../server/shopify-dispatch.js';
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
assert.throws(() => validateSocialPost({ text: 'x', targets: [{ provider: 'telegram' }, { provider: 'telegram' }] }, now), /INVALID_TARGET/);
assert.throws(() => validateSocialPost({ text: 'x', mediaUrl: 'http://insecure.test/file.jpg', targets: [{ provider: 'telegram' }] }, now), /INVALID_MEDIA_URL/);
assert.throws(() => validateSocialCredential('reddit', { accessToken: 'secret' }), /MANAGED_OAUTH_REQUIRED/);
assert.throws(() => validateSocialPost({ text: 'x', targets: [{ provider: 'telegram' }], recurrence: 'daily', maxRuns: 3 }, now), /AUTOPOST_REQUIRES_SCHEDULE/);

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
console.log('Social publishing validation passed.');
