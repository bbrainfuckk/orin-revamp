import assert from 'node:assert/strict';
import { calculateInboxResponseMetrics } from '../workspace/inbox-metrics';

const at = (millis: number) => ({ toMillis: () => millis });
const metrics = calculateInboxResponseMetrics([
  { senderType: 'customer', sentAt: at(0) },
  { senderType: 'customer', sentAt: at(10_000) },
  { senderType: 'agent', sentAt: at(40_000) },
  { senderType: 'customer', sentAt: at(100_000) },
  { senderType: 'team', sentAt: at(160_000) },
]);

assert.equal(metrics.firstResponseMs, 40_000);
assert.equal(metrics.averageBusinessResponseMs, 45_000);
assert.equal(metrics.averageCustomerResponseMs, 60_000);
assert.equal(metrics.customerMessages, 3);
assert.equal(metrics.businessMessages, 2);

assert.deepEqual(calculateInboxResponseMetrics([]), {
  firstResponseMs: null,
  averageBusinessResponseMs: null,
  averageCustomerResponseMs: null,
  customerMessages: 0,
  businessMessages: 0,
});

process.stdout.write('Inbox response metric verification passed.\n');
