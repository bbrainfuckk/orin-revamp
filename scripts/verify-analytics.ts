import assert from 'node:assert/strict';
import {
  buildAnalyticsRange,
  normalizeAnalyticsDays,
  normalizeTimezoneOffset,
  summarizeAnalytics,
  type AnalyticsEvent,
} from '../server/analytics';
import analyticsSummaryHandler from '../server/analytics-summary';

const event = (id: string, type: string, conversationId: string, occurredAt: string, overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  id,
  type,
  provider: 'meta',
  channel: 'Messenger',
  conversationId,
  contactId: `contact_${conversationId}`,
  value: 0,
  currency: '',
  firstResponseMs: null,
  occurredAt,
  ...overrides,
});

assert.equal(normalizeAnalyticsDays('7'), 7);
assert.equal(normalizeAnalyticsDays('365'), 30);
assert.equal(normalizeTimezoneOffset('-480'), -480);
assert.equal(normalizeTimezoneOffset('900'), 840);

const range = buildAnalyticsRange(7, -480, new Date('2026-07-15T12:00:00.000Z'));
assert.equal(range.currentStart, '2026-07-08T16:00:00.000Z');
assert.equal(range.currentEnd, '2026-07-15T12:00:00.000Z');

const current = [
  event('start_1', 'conversation.started', 'c1', '2026-07-10T01:00:00.000Z'),
  event('reply_1', 'conversation.responded', 'c1', '2026-07-10T01:00:00.500Z', { firstResponseMs: 500 }),
  event('start_2', 'conversation.started', 'c2', '2026-07-11T02:00:00.000Z', { channel: 'Website' }),
  event('escalate_2', 'conversation.escalated', 'c2', '2026-07-11T02:01:00.000Z', { channel: 'Website' }),
  event('start_3', 'conversation.started', 'c3', '2026-07-12T03:00:00.000Z'),
  event('reply_3', 'conversation.responded', 'c3', '2026-07-12T03:00:02.000Z', { firstResponseMs: 2_000 }),
  event('escalate_3', 'conversation.escalated', 'c3', '2026-07-12T03:00:03.000Z'),
  event('lead_1', 'lead.captured', 'c1', '2026-07-10T01:01:00.000Z'),
  event('value_1', 'value.attributed', 'c1', '2026-07-14T04:00:00.000Z', { value: 15_000, currency: 'PHP' }),
  event('shopify_paid_1', 'commerce.order_paid', '', '2026-07-14T05:00:00.000Z', { value: 24_995.5, currency: 'PHP', channel: 'Shopify' }),
  event('failure_1', 'automation.failed', 'c2', '2026-07-11T02:02:00.000Z'),
];
const previous = [event('prior_start', 'conversation.started', 'prior', '2026-07-05T01:00:00.000Z')];
const summary = summarizeAnalytics(current, previous, range);

assert.equal(summary.current.metrics.conversations, 3);
assert.equal(summary.current.metrics.aiHandled, 1);
assert.equal(summary.current.metrics.aiHandledRate, 33);
assert.equal(summary.current.metrics.escalated, 2);
assert.equal(summary.current.metrics.escalationRate, 67);
assert.equal(summary.current.metrics.leads, 1);
assert.equal(summary.current.metrics.attributedValue, 15_000);
assert.equal(summary.current.metrics.verifiedCommerceValue, 24_995.5);
assert.equal(summary.current.metrics.medianFirstResponseMs, 1_250);
assert.equal(summary.current.metrics.p90FirstResponseMs, 2_000);
assert.equal(summary.current.metrics.automationFailures, 1);
assert.deepEqual(summary.current.channels, [{ name: 'Messenger', count: 2 }, { name: 'Website', count: 1 }]);
assert.deepEqual(summary.current.currencies, [{ code: 'PHP', value: 15_000 }]);
assert.deepEqual(summary.current.commerceCurrencies, [{ code: 'PHP', value: 24_995.5 }]);
assert.equal(summary.previous.metrics.conversations, 1);
assert.equal(summary.trend.length, 7);
assert.equal(summary.trend.reduce((total, day) => total + day.conversations, 0), 3);
assert.equal(summary.trend.reduce((total, day) => total + day.aiResponses, 0), 2);

function responseRecorder() {
  const result = { code: 0, payload: null as unknown, headers: new Map<string, string>() };
  const response = {
    setHeader(name: string, value: string) { result.headers.set(name.toLowerCase(), value); },
    status(code: number) { result.code = code; return response; },
    json(payload: unknown) { result.payload = payload; },
  };
  return { response, result };
}

const unauthorized = responseRecorder();
await analyticsSummaryHandler({ method: 'GET', headers: {}, query: {} }, unauthorized.response);
assert.equal(unauthorized.result.code, 401);
assert.equal(unauthorized.result.headers.get('www-authenticate'), 'Bearer');

const wrongMethod = responseRecorder();
await analyticsSummaryHandler({ method: 'POST', headers: {}, query: {} }, wrongMethod.response);
assert.equal(wrongMethod.result.code, 405);
assert.equal(wrongMethod.result.headers.get('allow'), 'GET');

console.log('Authenticated analytics calculations passed');
