import { strict as assert } from 'node:assert';
import {
  connectVerifiedWebhook,
  isPublicWebhookAddress,
  validatePublicWebhookUrl,
} from '../server/webhook-connector';

assert.equal(validatePublicWebhookUrl('https://hooks.example.com/orin/events').hostname, 'hooks.example.com');
assert.equal(validatePublicWebhookUrl('https://8.8.8.8/orin').hostname, '8.8.8.8');
assert.equal(isPublicWebhookAddress('8.8.8.8'), true);
assert.equal(isPublicWebhookAddress('1.1.1.1'), true);
assert.equal(isPublicWebhookAddress('127.0.0.1'), false);
assert.equal(isPublicWebhookAddress('10.0.0.4'), false);
assert.equal(isPublicWebhookAddress('169.254.169.254'), false);
assert.equal(isPublicWebhookAddress('192.168.1.10'), false);
assert.equal(isPublicWebhookAddress('::1'), false);
assert.equal(isPublicWebhookAddress('::127.0.0.1'), false);
assert.equal(isPublicWebhookAddress('64:ff9b::7f00:1'), false);
assert.equal(isPublicWebhookAddress('2001:db8::1'), false);
assert.equal(isPublicWebhookAddress('2001:4860:4860::8888'), true);
assert.throws(() => validatePublicWebhookUrl('http://hooks.example.com/orin'), /WEBHOOK_URL_INVALID/);
assert.throws(() => validatePublicWebhookUrl('https://user:secret@hooks.example.com/orin'), /WEBHOOK_URL_INVALID/);
assert.throws(() => validatePublicWebhookUrl('https://hooks.example.com:8443/orin'), /WEBHOOK_URL_INVALID/);
assert.throws(() => validatePublicWebhookUrl('https://localhost/orin'), /WEBHOOK_URL_INVALID/);
assert.throws(() => validatePublicWebhookUrl('https://127.0.0.1/orin'), /WEBHOOK_URL_PRIVATE/);
assert.throws(() => validatePublicWebhookUrl('https://169.254.169.254/latest/meta-data'), /WEBHOOK_URL_PRIVATE/);

process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64url');
const originalFetch = globalThis.fetch;
const commits: Array<{ writes?: Array<{ update?: { name?: string; fields?: Record<string, { stringValue?: string }> } }> }> = [];

globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.endsWith('/documents/workspaces/personal_test_user_12345678/members/test_user_12345678')) return new Response(JSON.stringify({ fields: { role: { stringValue: 'owner' } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/documents:commit')) {
    commits.push(JSON.parse(String(init?.body)) as typeof commits[number]);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`Unexpected request: ${url}`);
}) as typeof fetch;

const result = await connectVerifiedWebhook('project-test', 'access-token', {
  localId: 'test_user_12345678',
  email: 'owner@example.com',
  emailVerified: true,
}, {
  workspaceId: 'personal_test_user_12345678',
  displayName: 'Operations API',
  webhookUrl: 'https://8.8.8.8/orin',
}, async (request) => {
  const body = JSON.parse(request.body) as { challenge?: string };
  assert.equal(request.resolved.address, '8.8.8.8');
  assert.equal(request.resolved.family, 4);
  assert.equal(request.headers['X-ORIN-Challenge'], body.challenge);
  return { ok: true, status: 200, contentType: 'application/json', body: JSON.stringify({ challenge: body.challenge }) };
});

assert.equal(result.connected, true);
assert.equal(result.endpointHost, '8.8.8.8');
assert.ok(result.signingSecret.length >= 40);
assert.equal(commits.length, 1);
const writes = commits[0].writes || [];
assert.match(writes[0].update?.name || '', /\/connectorVault\/webhook$/);
assert.equal(writes[0].update?.fields?.provider?.stringValue, 'webhook');
assert.ok(writes[0].update?.fields?.ciphertext?.stringValue);
assert.doesNotMatch(writes[0].update?.fields?.ciphertext?.stringValue || '', /8\.8\.8\.8/);
assert.match(writes[1].update?.name || '', /\/connections\/webhook$/);
assert.equal(writes[1].update?.fields?.endpointHost?.stringValue, '8.8.8.8');
assert.equal(writes[1].update?.fields?.health?.stringValue, 'healthy');
assert.equal(writes[1].update?.fields?.credentialState?.stringValue, 'encrypted_server_side');

globalThis.fetch = originalFetch;
console.log('Verified webhook URL policy, SSRF guards, challenge handshake, encryption, and connection writes passed.');
