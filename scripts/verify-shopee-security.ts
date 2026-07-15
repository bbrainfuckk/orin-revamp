import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  normalizeShopeeMessage,
  parseShopeeCredential,
  signShopeePublic,
  signShopeeShop,
  verifyShopeeWebhook,
} from '../server/shopee.ts';

const partnerId = '2000002';
const partnerKey = 'a-production-shaped-shopee-partner-key';
const timestamp = 1784080000;
const publicPath = '/api/v2/auth/token/get';
const shopPath = '/api/v2/sellerchat/send_message';
const accessToken = 'shop-access-token-that-is-long';
const shopId = '947042923';

assert.equal(
  await signShopeePublic(publicPath, timestamp, partnerId, partnerKey),
  createHmac('sha256', partnerKey).update(`${partnerId}${publicPath}${timestamp}`).digest('hex'),
  'public requests must use Shopee HMAC-SHA256 signing order',
);
assert.equal(
  await signShopeeShop(shopPath, timestamp, accessToken, shopId, partnerId, partnerKey),
  createHmac('sha256', partnerKey).update(`${partnerId}${shopPath}${timestamp}${accessToken}${shopId}`).digest('hex'),
  'shop requests must include access token and shop ID in the signed base string',
);

const callbackUrl = 'https://www.orin.work/api/webhooks/shopee';
const raw = new TextEncoder().encode(JSON.stringify({ code: 10, shop_id: Number(shopId), data: { type: 'message' } }));
const authorization = createHmac('sha256', partnerKey).update(Buffer.concat([Buffer.from(`${callbackUrl}|`), Buffer.from(raw)])).digest('hex');
assert.equal(await verifyShopeeWebhook(raw, authorization, callbackUrl, partnerKey), true, 'exact callback URL and raw request body must verify');
assert.equal(await verifyShopeeWebhook(new TextEncoder().encode(`${new TextDecoder().decode(raw)} `), authorization, callbackUrl, partnerKey), false, 'tampered raw body must fail');
assert.equal(await verifyShopeeWebhook(raw, authorization, `${callbackUrl}/`, partnerKey), false, 'callback URL mismatch must fail');
assert.equal(await verifyShopeeWebhook(raw, '0'.repeat(64), callbackUrl, partnerKey), false, 'incorrect authorization must fail');

assert.ok(parseShopeeCredential({
  provider: 'shopee',
  partnerId,
  shops: [{
    shopId,
    accessToken,
    refreshToken: 'shop-refresh-token-that-is-long',
    expiresAt: '2026-08-01T00:00:00.000Z',
    shopName: 'ORIN Test Shop',
    region: 'PH',
  }],
}), 'encrypted multi-shop vault shape must validate');
assert.equal(parseShopeeCredential({ provider: 'shopee', partnerId, shops: [] }), null, 'empty credentials must fail closed');

const baseContent = {
  message_id: '2302748948493123953',
  shop_id: 165103149,
  request_id: '35f9478b-7482-46eb-a268-8f828fedb673',
  from_id: 165105353,
  from_user_name: 'buyer',
  to_id: 947151379,
  to_user_name: 'shop',
  from_shop_id: 165103149,
  to_shop_id: Number(shopId),
  message_type: 'text',
  content: { text: 'Do you have this in blue?' },
  conversation_id: '709122092476686867',
  created_timestamp: 1784080000,
  region: 'PH',
  status: 'normal',
  is_in_chatbot_session: false,
  source_content: {},
};
const message = normalizeShopeeMessage({ code: 10, shop_id: Number(shopId), timestamp, data: { type: 'message', region: 'PH', content: baseContent } });
assert.ok(message, 'valid buyer Webchat Push must normalize');
assert.equal(message.body, 'Do you have this in blue?');
assert.equal(message.shopId, shopId);
assert.equal(message.replyable, true);
assert.equal(normalizeShopeeMessage({ code: 10, shop_id: Number(shopId), data: { type: 'message', content: { ...baseContent, from_shop_id: Number(shopId), to_shop_id: 165103149 } } }), null, 'seller echoes must be ignored');
assert.equal(normalizeShopeeMessage({ code: 10, shop_id: Number(shopId), data: { type: 'message', content: { ...baseContent, status: 'auto-reply' } } }), null, 'provider auto-replies must be ignored');
const chatbot = normalizeShopeeMessage({ code: 10, shop_id: Number(shopId), data: { type: 'message', content: { ...baseContent, shopee_chatbot_replied: true } } });
assert.equal(chatbot?.replyable, false, 'Shopee chatbot involvement must block a second automatic reply');
const product = normalizeShopeeMessage({ code: 10, shop_id: Number(shopId), data: { type: 'message', content: { ...baseContent, message_type: 'item', content: { item_id: 99 } } } });
assert.equal(product?.body, 'Customer shared a product.');

const clientSource = readFileSync(resolve(process.cwd(), 'server/shopee-client.ts'), 'utf8');
assert.match(clientSource, /\/api\/v2\/sellerchat\/send_message/, 'outbound replies must use Shopee seller chat');
assert.match(clientSource, /to_id:\s*Number\(buyerId\)/, 'buyer ID must come only from the private conversation route');
assert.match(clientSource, /message_type:\s*'text'/, 'team and AI replies must use the documented text-message shape');

console.log('Shopee security checks passed');
