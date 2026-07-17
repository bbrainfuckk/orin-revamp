import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { fetchWithTransientRetry, googleAccessToken } from '../server/server-data.js';

const originalFetch = globalThis.fetch;

try {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1 ? new Response('', { status: 503 }) : new Response('ok', { status: 200 });
  };
  assert.equal((await fetchWithTransientRetry('https://example.test', {}, 500)).status, 200);
  assert.equal(attempts, 2, 'transient upstream responses should be retried');

  attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response('', { status: 400 });
  };
  assert.equal((await fetchWithTransientRetry('https://example.test', {}, 500)).status, 400);
  assert.equal(attempts, 1, 'caller errors must not be retried');

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_CLIENT_EMAIL = 'resilience-test@example.test';
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.FIREBASE_PROJECT_ID = 'resilience-test';
  let tokenRequests = 0;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://oauth2.googleapis.com/token');
    tokenRequests += 1;
    return Response.json({ access_token: 'cached-test-token', expires_in: 3_600 });
  };
  const tokens = await Promise.all(Array.from({ length: 12 }, () => googleAccessToken()));
  assert.equal(tokenRequests, 1, 'concurrent callers should share one Google token request');
  assert.ok(tokens.every(({ accessToken }) => accessToken === 'cached-test-token'));
  assert.equal((await googleAccessToken()).accessToken, 'cached-test-token');
  assert.equal(tokenRequests, 1, 'warm invocations should reuse the cached Google token');

  console.log('Backend resilience verification passed.');
} finally {
  globalThis.fetch = originalFetch;
}
