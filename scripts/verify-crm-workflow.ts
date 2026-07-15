import { strict as assert } from 'node:assert';
import handler, { normalizeCrmTags, validateCrmUpdate } from '../api/widget/message';

assert.deepEqual(normalizeCrmTags([' VIP ', 'vip', 'Needs follow-up', '', 42]), ['VIP', 'Needs follow-up']);
assert.deepEqual(validateCrmUpdate({
  action: 'set_tags',
  requestId: 'request_1234567890',
  tags: ['Lead', 'Returning customer'],
}), {
  action: 'set_tags',
  requestId: 'request_1234567890',
  priority: 'normal',
  tags: ['Lead', 'Returning customer'],
  note: '',
});
assert.equal(validateCrmUpdate({
  action: 'set_priority',
  requestId: 'request_1234567890',
  priority: 'urgent',
}).priority, 'urgent');
assert.equal(validateCrmUpdate({
  action: 'add_note',
  requestId: 'request_1234567890',
  note: '  Customer asked us to call tomorrow.  ',
}).note, 'Customer asked us to call tomorrow.');
assert.throws(() => validateCrmUpdate({ action: 'set_priority', requestId: 'request_1234567890', priority: 'critical' }), /INVALID_REQUEST/);
assert.throws(() => validateCrmUpdate({ action: 'set_tags', requestId: 'request_1234567890', tags: Array.from({ length: 13 }, (_, index) => `Tag ${index}`) }), /INVALID_REQUEST/);
assert.throws(() => validateCrmUpdate({ action: 'add_note', requestId: 'short', note: 'Private note' }), /INVALID_REQUEST/);
assert.throws(() => validateCrmUpdate({ action: 'add_note', requestId: 'request_1234567890', note: 'x'.repeat(2_001) }), /INVALID_REQUEST/);

let statusCode = 0;
let payload: unknown;
const response = {
  setHeader: () => undefined,
  status(code: number) {
    statusCode = code;
    return response;
  },
  json(value: unknown) {
    payload = value;
  },
};

await handler({
  method: 'POST',
  headers: {},
  body: {
    mode: 'crm_update',
    action: 'add_note',
    workspaceId: 'personal_attacker',
    conversationId: 'conversation_1234567890',
    requestId: 'request_1234567890',
    note: 'This must never become a customer message.',
  },
}, response);

assert.equal(statusCode, 401);
assert.deepEqual(payload, { ok: false, error: 'Sign in again to manage this inbox.' });

console.log('Replay-safe CRM validation and authentication checks passed.');
