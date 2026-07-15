import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import handler from '../api/widget/message';

const uid = 'test_user_1234567890';
const workspaceId = `personal_${uid}`;
const originalFetch = globalThis.fetch;
const commits: Array<{ writes?: unknown[] }> = [];
const requests: string[] = [];
const signingKeys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', signingKeys.privateKey)).toString('base64').match(/.{1,64}/g)?.join('\n') || '';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@example.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
process.env.FIREBASE_PROJECT_ID = 'test';

globalThis.fetch = (async (input, init) => {
  const url = String(input);
  requests.push(`${init?.method || 'GET'} ${url}`);
  if (url.includes('identitytoolkit.googleapis.com')) return new Response(JSON.stringify({ users: [{ localId: uid, displayName: 'Test Owner', email: 'owner@example.com', emailVerified: true, photoUrl: '' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/documents:commit')) {
    commits.push(JSON.parse(String(init?.body)) as { writes?: unknown[] });
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.endsWith('/documents:runQuery')) {
    const body = JSON.parse(String(init?.body)) as { structuredQuery?: { from?: Array<{ collectionId?: string }>; where?: { fieldFilter?: { field?: { fieldPath?: string } } } } };
    const collectionId = body.structuredQuery?.from?.[0]?.collectionId;
    if (collectionId === 'workspaceInvitations') return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (collectionId === 'userWorkspaceMemberships') return new Response(JSON.stringify([{ document: {
      name: `projects/test/databases/(default)/documents/userWorkspaceMemberships/mirror_test`,
      fields: { userId: { stringValue: uid }, workspaceId: { stringValue: workspaceId }, role: { stringValue: 'owner' } },
    } }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.endsWith(`/documents/workspaces/${workspaceId}`)) return new Response(JSON.stringify({
    name: `projects/test/databases/(default)/documents/workspaces/${workspaceId}`,
    fields: { name: { stringValue: "Test Owner's workspace" }, ownerId: { stringValue: uid }, plan: { stringValue: 'starter' } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith(`/documents/workspaces/${workspaceId}/members/${uid}`)) return new Response(JSON.stringify({
    name: `projects/test/databases/(default)/documents/workspaces/${workspaceId}/members/${uid}`,
    fields: { userId: { stringValue: uid }, role: { stringValue: 'owner' }, joinedAt: { timestampValue: '2026-07-15T00:00:00.000Z' } },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  throw new Error(`Unexpected request: ${url}`);
}) as typeof fetch;

function responseCapture() {
  let statusCode = 0;
  let payload: unknown;
  const response = {
    setHeader: () => undefined,
    status(code: number) { statusCode = code; return response; },
    json(value: unknown) { payload = value; },
  };
  return { response, result: () => ({ statusCode, payload }) };
}

const workspaceResponse = responseCapture();
await handler({
  method: 'POST',
  headers: { authorization: 'Bearer test-token' },
  body: { mode: 'team_access', action: 'list_workspaces' },
}, workspaceResponse.response);
assert.equal(workspaceResponse.result().statusCode, 200, JSON.stringify({ result: workspaceResponse.result(), requests }, null, 2));
assert.deepEqual(workspaceResponse.result().payload, { ok: true, workspaces: [{ id: workspaceId, name: "Test Owner's workspace", role: 'owner', plan: 'starter' }] });
assert.ok(commits.length >= 2, 'personal membership profile and mirror should be server-synchronized');

const invalidInviteResponse = responseCapture();
await handler({
  method: 'POST',
  headers: { authorization: 'Bearer test-token' },
  body: { mode: 'team_access', action: 'invite_member', workspaceId, email: 'not-an-email', role: 'editor', requestId: 'request_1234567890' },
}, invalidInviteResponse.response);
assert.equal(invalidInviteResponse.result().statusCode, 400);
assert.deepEqual(invalidInviteResponse.result().payload, { ok: false, error: 'Check the team details and try again.' });

const unauthenticatedResponse = responseCapture();
await handler({ method: 'POST', headers: {}, body: { mode: 'team_access', action: 'list_workspaces' } }, unauthenticatedResponse.response);
assert.equal(unauthenticatedResponse.result().statusCode, 401);
assert.deepEqual(unauthenticatedResponse.result().payload, { ok: false, error: 'Sign in again to manage this workspace.' });

const rules = await readFile('firestore.rules', 'utf8');
assert.match(rules, /match \/workspaceInvitations\/\{invitationId\}[\s\S]*allow read, write: if false/);
assert.match(rules, /match \/notifications\/\{notificationId\}[\s\S]*resource\.data\.recipientId == request\.auth\.uid/);
assert.match(rules, /match \/members\/\{memberId\}[\s\S]*allow update, delete: if false/);

globalThis.fetch = originalFetch;
console.log('Team workspace discovery, invitation validation, authentication, and server-owned access rules passed.');
