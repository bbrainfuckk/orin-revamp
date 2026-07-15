import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import websiteHandler, { websiteRoleCanDisconnect, websiteRoleCanPublish } from '../api/integrations/website/connect';
import vaultHandler, { vaultRoleCanAccess } from '../api/integrations/vault/health';
import { widgetWorkspaceIdIsValid } from '../api/widget/message';

assert.equal(websiteRoleCanPublish('owner'), true);
assert.equal(websiteRoleCanPublish('admin'), true);
assert.equal(websiteRoleCanPublish('editor'), true);
assert.equal(websiteRoleCanPublish('viewer'), false);
assert.equal(websiteRoleCanDisconnect('owner'), true);
assert.equal(websiteRoleCanDisconnect('admin'), true);
assert.equal(websiteRoleCanDisconnect('editor'), false);
assert.equal(websiteRoleCanDisconnect('viewer'), false);

assert.equal(vaultRoleCanAccess('owner'), true);
assert.equal(vaultRoleCanAccess('admin'), true);
assert.equal(vaultRoleCanAccess('editor'), true);
assert.equal(vaultRoleCanAccess('viewer'), true);
assert.equal(vaultRoleCanAccess('unknown'), false);

assert.equal(widgetWorkspaceIdIsValid('personal_user_12345678'), true);
assert.equal(widgetWorkspaceIdIsValid('team_workspace_12345678'), true);
assert.equal(widgetWorkspaceIdIsValid('../workspace'), false);
assert.equal(widgetWorkspaceIdIsValid('short'), false);

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

const websiteResponse = responseRecorder();
await websiteHandler({
  method: 'POST',
  headers: {},
  body: { workspaceId: 'team_workspace_12345678' },
}, websiteResponse.response);
assert.equal(websiteResponse.statusCode(), 401);
assert.deepEqual(websiteResponse.payload(), { ok: false, error: 'A valid ORIN AI session is required' });

const vaultResponse = responseRecorder();
await vaultHandler({
  method: 'GET',
  headers: {},
  query: { workspaceId: 'team_workspace_12345678' },
}, vaultResponse.response);
assert.equal(vaultResponse.statusCode(), 401);
assert.deepEqual(vaultResponse.payload(), { ok: false, error: 'A valid ORIN AI session is required' });

const keyPair = await crypto.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
}, true, ['sign', 'verify']);
const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
const privateKeyBody = Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g)?.join('\n') || '';
process.env.FIREBASE_CLIENT_EMAIL = 'website-verifier@orin.test';
process.env.FIREBASE_PROJECT_ID = 'orin-website-verifier';
process.env.FIREBASE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${privateKeyBody}\n-----END PRIVATE KEY-----`;
process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const originalFetch = globalThis.fetch;
let currentRole = 'editor';
let committedWrites: unknown[][] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('identitytoolkit.googleapis.com')) {
    return Response.json({ users: [{ localId: 'user_12345678', disabled: false }] });
  }
  if (url === 'https://oauth2.googleapis.com/token') {
    return Response.json({ access_token: 'google_access_token' });
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
  if (url.endsWith('/documents/workspaces/team_workspace_12345678/agents/agent_12345678')) {
    return Response.json({ fields: {
      readiness: { integerValue: '6' },
      name: { stringValue: 'Website concierge' },
      businessName: { stringValue: 'ORIN QA' },
      config: { mapValue: { fields: { channels: { arrayValue: { values: [{ stringValue: 'Website' }] } } } } },
    } });
  }
  if (url.endsWith('/documents/workspaces/team_workspace_12345678/connections/website')) {
    return new Response('', { status: 404 });
  }
  throw new Error(`Unexpected verification request: ${url}`);
};

try {
  const teamPublish = responseRecorder();
  await websiteHandler({
    method: 'POST',
    headers: { authorization: 'Bearer firebase_id_token' },
    body: {
      workspaceId: 'team_workspace_12345678',
      displayName: 'ORIN QA website',
      agentId: 'agent_12345678',
      allowedOrigins: ['https://shop.example.com'],
      desiredChannels: ['Website chat', 'Lead capture'],
    },
  }, teamPublish.response);
  assert.equal(teamPublish.statusCode(), 200);
  const publishPayload = teamPublish.payload() as { status?: string; widgetKey?: string; embedCode?: string };
  assert.equal(publishPayload.status, 'connected');
  assert.match(publishPayload.widgetKey || '', /^ow_[A-Za-z0-9_-]{20,80}$/);
  assert.match(publishPayload.embedCode || '', /data-orin-widget="ow_/);
  const serializedPublish = JSON.stringify(committedWrites);
  assert.match(serializedPublish, /team_workspace_12345678/);
  assert.match(serializedPublish, /workspace_owner_12345678/);
  assert.match(serializedPublish, /"status":\{"stringValue":"connected"\}/);

  currentRole = 'viewer';
  committedWrites = [];
  const viewerPublish = responseRecorder();
  await websiteHandler({
    method: 'POST',
    headers: { authorization: 'Bearer firebase_id_token' },
    body: {
      workspaceId: 'team_workspace_12345678',
      displayName: 'Blocked website',
      agentId: 'agent_12345678',
      allowedOrigins: ['https://shop.example.com'],
      desiredChannels: ['Website chat'],
    },
  }, viewerPublish.response);
  assert.equal(viewerPublish.statusCode(), 403);
  assert.equal(committedWrites.length, 0);

  currentRole = 'editor';
  const teamVault = responseRecorder();
  await vaultHandler({
    method: 'GET',
    headers: { authorization: 'Bearer firebase_id_token' },
    query: { workspaceId: 'team_workspace_12345678' },
  }, teamVault.response);
  assert.equal(teamVault.statusCode(), 200);
  assert.deepEqual(teamVault.payload(), { ok: true, ready: true });
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Shared-workspace Website Chat authorization checks passed.');
