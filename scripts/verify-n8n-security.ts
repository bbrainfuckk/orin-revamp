import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import handler, {
  n8nOutcomeEventId,
  n8nRoleCanConnect,
  n8nRoleCanDisconnect,
  n8nWorkspaceIdIsValid,
  sanitizeN8nWorkflowList,
  validateN8nByok,
  validateN8nCloudInstance,
  validateN8nCloudWebhook,
  validateN8nWorkflow,
  validateN8nOutcome,
  validateOutcomeBearer,
} from '../api/integrations/n8n/connect';

assert.equal(n8nRoleCanConnect('owner'), true);
assert.equal(n8nRoleCanConnect('admin'), true);
assert.equal(n8nRoleCanConnect('editor'), true);
assert.equal(n8nRoleCanConnect('viewer'), false);
assert.equal(n8nRoleCanDisconnect('owner'), true);
assert.equal(n8nRoleCanDisconnect('admin'), true);
assert.equal(n8nRoleCanDisconnect('editor'), false);
assert.equal(n8nWorkspaceIdIsValid('personal_user_12345678'), true);
assert.equal(n8nWorkspaceIdIsValid('team_workspace_12345678'), true);
assert.equal(n8nWorkspaceIdIsValid('../workspace'), false);

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

const instance = validateN8nCloudInstance('https://marvin.app.n8n.cloud/settings/api');
assert.equal(instance.toString(), 'https://marvin.app.n8n.cloud/');
for (const value of ['https://app.n8n.cloud/', 'http://marvin.app.n8n.cloud/', 'https://n8n.example.com/', 'https://user:pass@marvin.app.n8n.cloud/']) {
  assert.throws(() => validateN8nCloudInstance(value), /INVALID_N8N_INSTANCE/);
}

const workflow = validateN8nWorkflow({
  id: 'do-not-forward-this-export-id',
  name: 'ORIN AI lead intake',
  nodes: [{ id: 'webhook', name: 'Webhook', type: 'n8n-nodes-base.webhook', position: [0, 0], parameters: {} }],
  connections: {},
  settings: { executionOrder: 'v1' },
  active: true,
});
assert.equal(workflow.name, 'ORIN AI lead intake');
assert.equal(workflow.nodeCount, 1);
assert.equal('id' in workflow.workflow, false);
assert.equal('active' in workflow.workflow, false);
assert.throws(() => validateN8nWorkflow({ name: 'Missing nodes', nodes: [], connections: {} }), /INVALID_N8N_WORKFLOW/);
assert.deepEqual(validateN8nByok([{ name: 'ElevenLabs', value: 'secret_value' }]), [{ name: 'ElevenLabs', value: 'secret_value' }]);
assert.throws(() => validateN8nByok([{ name: 'Twilio', value: 'one' }, { name: 'twilio', value: 'two' }]), /INVALID_BYOK/);
assert.deepEqual(sanitizeN8nWorkflowList({ data: [
  { id: 'workflow_123', name: 'Lead intake', active: true, nodes: [{}, {}], updatedAt: '2026-07-16T08:00:00.000Z', credentials: { secret: 'never-return-this' } },
  { id: '', name: 'Invalid workflow' },
] }), [{ id: 'workflow_123', name: 'Lead intake', active: true, nodeCount: 2, updatedAt: '2026-07-16T08:00:00.000Z' }]);
assert.throws(() => sanitizeN8nWorkflowList({ data: 'invalid' }), /N8N_API_RESPONSE/);

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

function responseRecorder() {
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
  return { response, statusCode: () => statusCode, payload: () => payload };
}

const keyPair = await crypto.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
}, true, ['sign', 'verify']);
const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
const privateKeyBody = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g)?.join('\n') || '';
process.env.FIREBASE_CLIENT_EMAIL = 'n8n-verifier@orin.test';
process.env.FIREBASE_PROJECT_ID = 'orin-n8n-verifier';
process.env.FIREBASE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----`;
process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

const originalFetch = globalThis.fetch;
let currentRole = 'editor';
let connectionIsActive = false;
let webhookDeliveries = 0;
let committedWrites: unknown[][] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('identitytoolkit.googleapis.com')) {
    return Response.json({ users: [{ localId: 'user_12345678', disabled: false }] });
  }
  if (url === 'https://oauth2.googleapis.com/token') {
    return Response.json({ access_token: 'google_access_token' });
  }
  if (url === 'https://marvin.app.n8n.cloud/webhook/orin-events') {
    webhookDeliveries += 1;
    assert.equal(init?.method, 'POST');
    assert.match(String((init?.headers as Record<string, string>)?.['X-ORIN-Signature-256'] || ''), /^sha256=[a-f0-9]{64}$/);
    return Response.json({ accepted: true });
  }
  if (url === 'https://marvin.app.n8n.cloud/api/v1/workflows') {
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>)?.['X-N8N-API-KEY'], 'n8n_api_secret');
    const workflowBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    assert.equal(workflowBody.name, 'ORIN AI lead intake');
    assert.equal('id' in workflowBody, false);
    assert.equal('active' in workflowBody, false);
    return Response.json({ id: 'workflow_123', name: workflowBody.name });
  }
  if (url.includes('/documents:commit')) {
    const body = JSON.parse(String(init?.body || '{}')) as { writes?: unknown[] };
    committedWrites.push(body.writes || []);
    return Response.json({ writeResults: [] });
  }
  if (url.endsWith('/documents/workspaces/team_workspace_12345678')) {
    return Response.json({ fields: { ownerId: { stringValue: 'workspace_owner_12345678' } } });
  }
  if (url.endsWith('/documents/workspaces/team_workspace_12345678/members/user_12345678')) {
    return Response.json({ fields: { role: { stringValue: currentRole } } });
  }
  if (url.endsWith('/documents/workspaces/team_workspace_12345678/connections/n8n')) {
    return connectionIsActive
      ? Response.json({ fields: {
        status: { stringValue: 'connected' },
        health: { stringValue: 'healthy' },
        outcomeRouteId: { stringValue: 'n8n_out_previous_route' },
      } })
      : new Response('', { status: 404 });
  }
  if (url.endsWith('/documents/workspaces/team_workspace_12345678/connectorVault/n8n_advanced')) {
    return new Response('', { status: 404 });
  }
  throw new Error(`Unexpected verification request: ${url}`);
};

try {
  const linked = responseRecorder();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer firebase_id_token' },
    body: {
      workspaceId: 'team_workspace_12345678',
      webhookUrl: 'https://marvin.app.n8n.cloud/webhook/orin-events',
      displayName: 'Shared sales workflow',
      desiredChannels: ['New conversation', 'Order or booking attributed'],
    },
  }, linked.response);
  assert.equal(linked.statusCode(), 200);
  const linkedPayload = linked.payload() as { status?: string; outcome?: { token?: string; url?: string } };
  assert.equal(linkedPayload.status, 'connected');
  assert.match(linkedPayload.outcome?.token || '', /^orin_out_[A-Za-z0-9_-]{43}$/);
  assert.equal(linkedPayload.outcome?.url, 'https://www.orin.work/api/integrations/n8n/outcomes');
  assert.equal(webhookDeliveries, 1);
  const serializedLink = JSON.stringify(committedWrites);
  assert.match(serializedLink, /team_workspace_12345678/);
  assert.match(serializedLink, /workspace_owner_12345678/);
  assert.match(serializedLink, /"status":\{"stringValue":"connected"\}/);

  committedWrites = [];
  const advanced = responseRecorder();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer firebase_id_token' },
    query: { action: 'advanced' },
    body: {
      workspaceId: 'team_workspace_12345678',
      instanceUrl: 'https://marvin.app.n8n.cloud/home/workflows',
      apiKey: 'n8n_api_secret',
      workflow: {
        id: 'exported_workflow_id',
        active: true,
        name: 'ORIN AI lead intake',
        nodes: [{ id: 'webhook', name: 'Webhook', type: 'n8n-nodes-base.webhook', position: [0, 0], parameters: {} }],
        connections: {},
        settings: { executionOrder: 'v1' },
      },
      byok: [{ name: 'ElevenLabs', value: 'elevenlabs_secret' }],
    },
  }, advanced.response);
  assert.equal(advanced.statusCode(), 200);
  const advancedPayload = advanced.payload() as { advanced?: { workflowId?: string; workflowUrl?: string; byokNames?: string[] } };
  assert.equal(advancedPayload.advanced?.workflowId, 'workflow_123');
  assert.equal(advancedPayload.advanced?.workflowUrl, 'https://marvin.app.n8n.cloud/workflow/workflow_123');
  assert.deepEqual(advancedPayload.advanced?.byokNames, ['ElevenLabs']);
  const serializedAdvanced = JSON.stringify(committedWrites);
  assert.match(serializedAdvanced, /connectorVault\/n8n_advanced/);
  assert.match(serializedAdvanced, /importedWorkflowName/);
  assert.doesNotMatch(serializedAdvanced, /n8n_api_secret|elevenlabs_secret/);

  currentRole = 'viewer';
  webhookDeliveries = 0;
  committedWrites = [];
  const viewerLink = responseRecorder();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer firebase_id_token' },
    body: {
      workspaceId: 'team_workspace_12345678',
      webhookUrl: 'https://marvin.app.n8n.cloud/webhook/orin-events',
      displayName: 'Blocked workflow',
      desiredChannels: ['New conversation'],
    },
  }, viewerLink.response);
  assert.equal(viewerLink.statusCode(), 403);
  assert.equal(webhookDeliveries, 0);
  assert.equal(committedWrites.length, 0);

  currentRole = 'editor';
  connectionIsActive = true;
  const rotated = responseRecorder();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer firebase_id_token' },
    query: { action: 'outcome-token' },
    body: { workspaceId: 'team_workspace_12345678' },
  }, rotated.response);
  assert.equal(rotated.statusCode(), 200);
  assert.match((rotated.payload() as { outcome?: { token?: string } }).outcome?.token || '', /^orin_out_[A-Za-z0-9_-]{43}$/);

  committedWrites = [];
  const editorDisconnect = responseRecorder();
  await handler({
    method: 'DELETE',
    headers: { authorization: 'Bearer firebase_id_token' },
    body: { workspaceId: 'team_workspace_12345678' },
  }, editorDisconnect.response);
  assert.equal(editorDisconnect.statusCode(), 403);
  assert.equal(committedWrites.length, 0);

  currentRole = 'admin';
  const adminDisconnect = responseRecorder();
  await handler({
    method: 'DELETE',
    headers: { authorization: 'Bearer firebase_id_token' },
    body: { workspaceId: 'team_workspace_12345678' },
  }, adminDisconnect.response);
  assert.equal(adminDisconnect.statusCode(), 200);
  assert.match(JSON.stringify(committedWrites), /connectorVault\/n8n/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('n8n Cloud URL and outcome-ingestion security checks passed.');
