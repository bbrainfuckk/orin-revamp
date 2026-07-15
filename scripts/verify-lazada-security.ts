import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  lazadaApiHost,
  normalizeLazadaMessage,
  parseLazadaToken,
  signLazadaRequest,
  verifyLazadaWebhook,
} from '../server/lazada';
import { buildLazadaSignedParameters, parseLazadaCredential } from '../server/lazada-client';

const appKey = '123456';
const appSecret = 'a-production-shaped-test-secret';
const path = '/auth/token/create';
const parameters = {
  timestamp: '1784080000000',
  sign_method: 'sha256',
  code: 'single-use-code',
  app_key: appKey,
};
const canonical = `${path}${Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}${value}`).join('')}`;
const expectedSignature = createHmac('sha256', appSecret).update(canonical).digest('hex').toUpperCase();
assert.equal(await signLazadaRequest(path, parameters, appSecret), expectedSignature, 'API requests must use Lazada canonical HMAC-SHA256 signing');
const outboundParameters = await buildLazadaSignedParameters('/im/message/send', { template_id: 1, session_id: 'session-88', txt: 'Hello' }, appKey, appSecret, 'seller-access-token-that-is-long', 1784080000000);
assert.equal(outboundParameters.app_key, appKey);
assert.equal(outboundParameters.access_token, 'seller-access-token-that-is-long');
assert.match(outboundParameters.sign, /^[0-9A-F]{64}$/);
assert.equal(await signLazadaRequest('/im/message/send', outboundParameters, appSecret), outboundParameters.sign, 'outbound signature must cover access token and message fields');

const raw = new TextEncoder().encode(JSON.stringify({ message_type: 2, seller_id: 'seller-42', data: '{}' }));
const webhookSignature = createHmac('sha256', appSecret).update(Buffer.concat([Buffer.from(appKey), Buffer.from(raw)])).digest('hex');
assert.equal(await verifyLazadaWebhook(raw, webhookSignature, appKey, appSecret), true, 'valid push signature must pass');
assert.equal(await verifyLazadaWebhook(raw, `sha256=${webhookSignature}`, appKey, appSecret), true, 'documented signature prefix must be tolerated');
const tampered = new TextEncoder().encode(`${new TextDecoder().decode(raw)} `);
assert.equal(await verifyLazadaWebhook(tampered, webhookSignature, appKey, appSecret), false, 'tampered push body must fail');
assert.equal(await verifyLazadaWebhook(raw, '0'.repeat(64), appKey, appSecret), false, 'incorrect signature must fail');

const token = parseLazadaToken({
  access_token: 'access-token-that-is-long-enough',
  refresh_token: 'refresh-token-that-is-long-enough',
  expires_in: 864000,
  refresh_expires_in: 2592000,
  account_platform: 'seller_center',
  country: 'ph',
  country_user_info: [
    { country: 'ph', user_id: 'user-1', seller_id: 'seller-1', short_code: 'PH123' },
    { country: 'sg', user_id: 'user-2', seller_id: 'seller-2', short_code: 'SG123' },
    { country: 'ph', user_id: 'user-1', seller_id: 'seller-1', short_code: 'duplicate' },
  ],
});
assert.ok(token, 'valid multi-country token must parse');
assert.equal(token.shops.length, 2, 'duplicate shop records must collapse');
assert.equal(parseLazadaToken({ access_token: 'short' }), null, 'partial token response must be rejected');
assert.ok(parseLazadaCredential({
  provider: 'lazada',
  accessToken: 'access-token-that-is-long-enough',
  refreshToken: 'refresh-token-that-is-long-enough',
  expiresAt: '2026-08-01T00:00:00.000Z',
  refreshExpiresAt: '2026-09-01T00:00:00.000Z',
  accountPlatform: 'seller_center',
  country: 'ph',
  shops: [{ country: 'ph', userId: 'user-1', sellerId: 'seller-1', shortCode: 'PH123' }],
}), 'encrypted vault credential shape must validate before use');
assert.equal(parseLazadaCredential({ provider: 'lazada', accessToken: 'missing-everything-else' }), null);
assert.equal(lazadaApiHost('ph'), 'https://api.lazada.com.ph/rest');
assert.throws(() => lazadaApiHost('xx'), /UNSUPPORTED_LAZADA_COUNTRY/);

const baseData = {
  session_id: 'session-88',
  message_id: 'message-99',
  content: JSON.stringify({ txt: 'Do you have this in blue?' }),
  from_account_id: 'buyer-22',
  from_account_type: 1,
  send_time: 1784080000000,
  template_id: 1,
  to_account_id: 'seller-42',
  to_account_type: 2,
  type: 1,
  site_id: 'ph',
  status: 0,
};
const message = normalizeLazadaMessage({ message_type: 2, seller_id: 'seller-42', data: baseData });
assert.ok(message, 'valid buyer text push must normalize');
assert.equal(message.body, 'Do you have this in blue?');
assert.equal(message.siteId, 'ph');
assert.equal(message.replyable, true);
assert.equal(normalizeLazadaMessage({ message_type: 2, seller_id: 'seller-42', data: { ...baseData, from_account_type: 2 } }), null, 'seller echoes must be ignored');
assert.equal(normalizeLazadaMessage({ message_type: 2, seller_id: 'seller-42', data: { ...baseData, status: 1 } }), null, 'recalled messages must be ignored');
assert.equal(normalizeLazadaMessage({ message_type: 0, seller_id: 'seller-42', data: baseData }), null, 'unimplemented push categories must be ignored safely');
const product = normalizeLazadaMessage({ message_type: 2, seller_id: 'seller-42', data: { ...baseData, template_id: 10006, content: '{}' } });
assert.equal(product?.body, 'Customer shared a product.');
const intercepted = normalizeLazadaMessage({ message_type: 2, seller_id: 'seller-42', data: { ...baseData, process_msg: 'This message requires seller review.' } });
assert.equal(intercepted?.replyable, false, 'safety-intercepted messages must never trigger an automatic reply');
assert.equal(intercepted?.body, 'Lazada safety notice: This message requires seller review.');
const providerAutoReply = normalizeLazadaMessage({ message_type: 2, seller_id: 'seller-42', data: { ...baseData, auto_reply: true } });
assert.equal(providerAutoReply?.replyable, false, 'provider automatic messages must not create an auto-reply loop');

console.log('Lazada security checks passed');
