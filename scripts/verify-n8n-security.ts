import assert from 'node:assert/strict';
import { n8nOutcomeEventId, validateN8nCloudWebhook, validateN8nOutcome, validateOutcomeBearer } from '../api/integrations/n8n/connect';

const production = validateN8nCloudWebhook('https://marvin.app.n8n.cloud/webhook/orin-events');
assert.equal(production.hostname, 'marvin.app.n8n.cloud');
assert.equal(production.pathname, '/webhook/orin-events');

const rejected = [
  'http://marvin.app.n8n.cloud/webhook/orin-events',
  'https://localhost:5678/webhook/orin-events',
  'https://automation.example.com/webhook/orin-events',
  'https://marvin.app.n8n.cloud/webhook-test/orin-events',
  'https://marvin.app.n8n.cloud/webhook/',
  'https://user:password@marvin.app.n8n.cloud/webhook/orin-events',
  'https://marvin.app.n8n.cloud:8443/webhook/orin-events',
];

for (const value of rejected) {
  assert.throws(() => validateN8nCloudWebhook(value), /INVALID_WEBHOOK_URL/);
}

const rawOutcomeToken = `orin_out_${'A'.repeat(43)}`;
assert.equal(validateOutcomeBearer(`Bearer ${rawOutcomeToken}`), rawOutcomeToken);
for (const authorization of ['', 'Basic abc', 'Bearer orin_out_short', `Bearer ${'A'.repeat(43)}`]) {
  assert.throws(() => validateOutcomeBearer(authorization), /OUTCOME_UNAUTHENTICATED/);
}

const now = Date.parse('2026-07-15T04:00:00.000Z');
const outcome = validateN8nOutcome({
  type: 'order',
  externalId: 'ORDER-1042',
  amount: 15_000.129,
  currency: 'php',
  occurredAt: '2026-07-15T03:30:00.000Z',
  conversationId: 'conversation_1042',
  contactId: 'contact_1042',
}, 'ORDER-1042', now);
assert.deepEqual(outcome, {
  type: 'order',
  externalId: 'ORDER-1042',
  amount: 15_000.13,
  currency: 'PHP',
  occurredAt: '2026-07-15T03:30:00.000Z',
  conversationId: 'conversation_1042',
  contactId: 'contact_1042',
  idempotencyKey: 'ORDER-1042',
});

const invalidOutcomes: unknown[] = [
  { type: 'refund', externalId: '1', amount: 100, currency: 'PHP' },
  { type: 'order', externalId: '', amount: 100, currency: 'PHP' },
  { type: 'order', externalId: '1', amount: '100', currency: 'PHP' },
  { type: 'order', externalId: '1', amount: 0, currency: 'PHP' },
  { type: 'order', externalId: '1', amount: 1_000_000_001, currency: 'PHP' },
  { type: 'booking', externalId: '1', amount: 100, currency: 'PESO' },
  { type: 'booking', externalId: '1', amount: 100, currency: 'PHP', occurredAt: '2027-01-01T00:00:00.000Z' },
  { type: 'booking', externalId: '1', amount: 100, currency: 'PHP', conversationId: '../secret' },
];
for (const value of invalidOutcomes) {
  assert.throws(() => validateN8nOutcome(value, 'ORDER-1042', now), /INVALID_OUTCOME/);
}
for (const key of ['', 'contains space', '../path', 'a'.repeat(129)]) {
  assert.throws(() => validateN8nOutcome({ type: 'order', externalId: '1', amount: 100, currency: 'PHP' }, key, now), /INVALID_IDEMPOTENCY_KEY/);
}

assert.equal(
  await n8nOutcomeEventId('personal_user', 'ORDER-1042'),
  await n8nOutcomeEventId('personal_user', 'ORDER-1042'),
  'token rotation must not change the replay-safe event ID',
);
assert.notEqual(
  await n8nOutcomeEventId('personal_user', 'ORDER-1042'),
  await n8nOutcomeEventId('personal_other', 'ORDER-1042'),
  'idempotency keys remain isolated by workspace',
);

console.log('n8n Cloud URL and outcome-ingestion security checks passed.');
