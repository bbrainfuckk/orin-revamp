import assert from 'node:assert/strict';
import { validTikTokSignature } from '../api/webhooks/meta';

const encoder = new TextEncoder();

function bytesToHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sign(body: Uint8Array, secret: string, timestamp: number) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const payload = encoder.encode(`${timestamp}.${new TextDecoder().decode(body)}`);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return `t=${timestamp},s=${bytesToHex(new Uint8Array(signature))}`;
}

const secret = 'tiktok_test_secret_with_enough_entropy';
const now = 1_800_000_000;
const body = encoder.encode(JSON.stringify({
  client_key: 'client-key',
  event: 'authorization.removed',
  create_time: now,
  user_openid: 'user-open-id',
  content: '{}',
}));
const signature = await sign(body, secret, now);

assert.equal(await validTikTokSignature(body, signature, secret, now), true, 'accepts a current official HMAC signature');
assert.equal(await validTikTokSignature(encoder.encode('{}'), signature, secret, now), false, 'rejects a changed payload');
assert.equal(await validTikTokSignature(body, signature, `${secret}-wrong`, now), false, 'rejects the wrong client secret');
assert.equal(await validTikTokSignature(body, signature, secret, now + 301), false, 'rejects replayed webhooks after five minutes');
assert.equal(await validTikTokSignature(body, 't=bad,s=nope', secret, now), false, 'rejects malformed signature headers');

console.log('TikTok webhook signature and replay checks passed.');
