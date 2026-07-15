import { strict as assert } from 'node:assert';
import handler from '../api/widget/message';
import {
  automationTriggerLabels,
  deliverAutomationEvent,
  normalizeAutomationTag,
  normalizeFollowUpDelay,
} from '../server/n8n-delivery';

assert.deepEqual(automationTriggerLabels('conversation.started'), ['New conversation']);
assert.deepEqual(automationTriggerLabels('lead.captured'), ['Lead captured']);
assert.deepEqual(automationTriggerLabels('conversation.escalated'), ['Human escalation', 'Human escalation requested']);
assert.deepEqual(automationTriggerLabels('conversation.resolved'), ['Conversation resolved']);
assert.deepEqual(automationTriggerLabels('value.attributed'), ['Order or booking attributed', 'Attributed order or booking']);

assert.equal(normalizeAutomationTag('  Qualified   lead  '), 'Qualified lead');
assert.equal(normalizeAutomationTag('x'.repeat(40)).length, 32);
assert.equal(normalizeFollowUpDelay(15), 15);
assert.equal(normalizeFollowUpDelay(1_440), 1_440);
assert.equal(normalizeFollowUpDelay('60'), 60);
assert.equal(normalizeFollowUpDelay(30), 0);
assert.equal(normalizeFollowUpDelay(Number.NaN), 0);

const event = {
  id: 'event_12345678901234567890',
  type: 'conversation.started' as const,
  workspaceId: 'personal_test_user_12345678',
  channel: 'Messenger',
  contactId: 'contact_12345678901234567890',
  contactName: 'Test customer',
  conversationId: 'conversation_12345678901234567890',
  occurredAt: '2026-07-15T08:00:00.000Z',
  preview: 'Can you help me?',
};
const originalFetch = globalThis.fetch;
const commits: Array<{ writes?: unknown[] }> = [];
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (init?.method === 'POST' && url.endsWith('/documents:commit')) {
    commits.push(JSON.parse(String(init.body)) as { writes?: unknown[] });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.includes('/contacts/')) return new Response(JSON.stringify({ name: `${url}`, fields: { name: { stringValue: 'Test customer' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  throw new Error(`Unexpected request: ${url}`);
}) as typeof fetch;

await deliverAutomationEvent('project-test', 'access-token', event, Promise.resolve({
  desiredChannels: [],
  n8nHealthy: false,
  n8nWebhookUrl: '',
  n8nSigningSecret: '',
  automations: [{
    id: 'automation_tag_1234567890',
    name: 'Tag new conversations',
    trigger: 'New conversation',
    action: 'Add a contact tag',
    config: { tag: { stringValue: 'Qualified lead' } },
  }],
}));

assert.equal(commits.length, 1);
const tagWrites = commits[0].writes as Array<{ transform?: { fieldTransforms?: Array<{ fieldPath?: string; appendMissingElements?: { values?: Array<{ stringValue?: string }> } }> }; update?: { fields?: { status?: { stringValue?: string } } } }>;
assert.equal(tagWrites.length, 2);
assert.equal(tagWrites[0].transform?.fieldTransforms?.[0].fieldPath, 'tags');
assert.equal(tagWrites[0].transform?.fieldTransforms?.[0].appendMissingElements?.values?.[0].stringValue, 'Qualified lead');
assert.equal(tagWrites[1].update?.fields?.status?.stringValue, 'succeeded');

commits.length = 0;
await deliverAutomationEvent('project-test', 'access-token', event, Promise.resolve({
  desiredChannels: [],
  n8nHealthy: false,
  n8nWebhookUrl: '',
  n8nSigningSecret: '',
  automations: [{
    id: 'automation_task_1234567890',
    name: 'Follow up with new conversations',
    trigger: 'New conversation',
    action: 'Create a follow-up task',
    config: { taskTitle: { stringValue: 'Call this customer' }, delayMinutes: { integerValue: '60' } },
  }],
}));

assert.equal(commits.length, 1);
const taskWrites = commits[0].writes as Array<{ update?: { name?: string; fields?: Record<string, { stringValue?: string; timestampValue?: string }> } }>;
assert.equal(taskWrites.length, 2);
assert.match(taskWrites[0].update?.name || '', /\/tasks\//);
assert.equal(taskWrites[0].update?.fields?.title?.stringValue, 'Call this customer');
assert.equal(taskWrites[0].update?.fields?.status?.stringValue, 'open');
assert.ok(new Date(taskWrites[0].update?.fields?.dueAt?.timestampValue || '').getTime() > Date.now());
assert.equal(taskWrites[1].update?.fields?.status?.stringValue, 'succeeded');
globalThis.fetch = originalFetch;

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
    mode: 'task_update',
    action: 'complete_task',
    workspaceId: 'personal_attacker',
    taskId: 'task_12345678901234567890',
    requestId: 'request_1234567890',
  },
}, response);

assert.equal(statusCode, 401);
assert.deepEqual(payload, { ok: false, error: 'Sign in again to manage this inbox.' });

console.log('Built-in automation labels, configuration guards, and task authentication checks passed.');
