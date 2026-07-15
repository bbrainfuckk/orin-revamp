import { strict as assert } from 'node:assert';
import { normalizeShopDomain } from '../server/shopify';
import { verifyShopifyQuery } from '../server/shopify-callback';
import { normalizeShopifyPaidOrder, verifyShopifyWebhook } from '../server/shopify-webhook';

const encoder = new TextEncoder();

function bytesToHex(value: Uint8Array) {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

async function sign(message: string | Uint8Array, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = typeof message === 'string' ? encoder.encode(message) : message;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, copy.buffer));
}

const secret = 'shopify_test_secret_that_is_long_enough';
const callbackQuery = {
  code: 'temporary-code',
  shop: 'orin-demo.myshopify.com',
  state: 'state-token',
  timestamp: '1784044800',
};
const callbackMessage = Object.entries(callbackQuery).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&');
const callbackHmac = bytesToHex(await sign(callbackMessage, secret));
assert.equal(await verifyShopifyQuery({ ...callbackQuery, hmac: callbackHmac }, secret), true);
assert.equal(await verifyShopifyQuery({ ...callbackQuery, shop: 'attacker.myshopify.com', hmac: callbackHmac }, secret), false);

const webhookBody = encoder.encode(JSON.stringify({ id: 42, customer: { id: 7 } }));
const webhookHmac = bytesToBase64(await sign(webhookBody, secret));
assert.equal(await verifyShopifyWebhook(webhookBody, webhookHmac, secret), true);
assert.equal(await verifyShopifyWebhook(encoder.encode('{"id":43}'), webhookHmac, secret), false);

assert.equal(normalizeShopDomain('https://orin-demo.myshopify.com/'), 'orin-demo.myshopify.com');
assert.throws(() => normalizeShopDomain('shop.example.com'));

assert.deepEqual(normalizeShopifyPaidOrder({
  id: 820982911946154508,
  admin_graphql_api_id: 'gid://shopify/Order/820982911946154508',
  currency: 'USD',
  current_total_price: '419.95',
  current_total_price_set: { shop_money: { amount: '414.95', currency_code: 'USD' } },
}, 'orders/paid'), { amount: 414.95, currency: 'USD', externalOrderId: '820982911946154508' });
assert.deepEqual(normalizeShopifyPaidOrder({ id: '42', current_total_price: '15000.129', currency: 'php' }, 'ORDERS/PAID'), { amount: 15000.13, currency: 'PHP', externalOrderId: '42' });
assert.equal(normalizeShopifyPaidOrder({ id: 820982911946154508, current_total_price: '100.00', currency: 'USD' }, 'orders/paid'), null, 'unsafe numeric IDs require Shopify\'s exact GraphQL ID');
assert.equal(normalizeShopifyPaidOrder({ id: 42, current_total_price: '100.00', currency: 'USD' }, 'orders/create'), null);
assert.equal(normalizeShopifyPaidOrder({ id: 42, current_total_price: '-100.00', currency: 'USD' }, 'orders/paid'), null);
assert.equal(normalizeShopifyPaidOrder({ id: 42, current_total_price: '100.00', currency: 'US' }, 'orders/paid'), null);

console.log('Shopify OAuth and webhook security checks passed.');
