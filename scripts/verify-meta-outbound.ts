import assert from 'node:assert/strict';
import { buildMetaOutboundRequest, parseMetaCredential } from '../api/widget/message';

const messenger = buildMetaOutboundRequest('Messenger', 'v24.0', '123456789', '987654321', 'Your order is ready.');
assert.equal(messenger.url, 'https://graph.facebook.com/v24.0/123456789/messages');
assert.deepEqual(messenger.body, {
  recipient: { id: '987654321' },
  messaging_type: 'RESPONSE',
  message: { text: 'Your order is ready.' },
});
assert.equal(JSON.stringify(messenger).includes('accessToken'), false, 'Provider credentials must never enter the request builder output');

const instagram = buildMetaOutboundRequest('Instagram', 'v24.0', '17841400000000000', '17841411111111111', 'Your booking is confirmed.');
assert.equal(instagram.url, 'https://graph.instagram.com/v24.0/17841400000000000/messages');
assert.deepEqual(instagram.body, {
  recipient: { id: '17841411111111111' },
  message: { text: 'Your booking is confirmed.' },
});

const credential = parseMetaCredential({
  provider: 'meta',
  graphVersion: 'v24.0',
  expiresAt: '2027-01-01T00:00:00.000Z',
  pages: [{
    id: '123456789',
    name: 'ORIN Store',
    accessToken: 'EAAB_secure_server_token_value',
    instagramBusinessAccount: { id: '17841400000000000', username: 'orin.store' },
  }],
});
assert.ok(credential);
assert.equal(credential?.pages[0].instagramBusinessAccount?.id, '17841400000000000');
assert.equal(parseMetaCredential({ provider: 'meta', graphVersion: 'latest', pages: [] }), null);

assert.throws(() => buildMetaOutboundRequest('TikTok', 'v24.0', '123', '456', 'Hello'), /UNSUPPORTED_REPLY_CHANNEL/);
assert.throws(() => buildMetaOutboundRequest('Messenger', 'v24.0', '../page', '456', 'Hello'), /META_ROUTE_NOT_FOUND/);
assert.throws(() => buildMetaOutboundRequest('Messenger', 'v24.0', '123', '456', 'x'.repeat(1_001)), /INVALID_REQUEST/);

process.stdout.write('Meta outbound verification passed: Messenger and Instagram request shapes, credential parsing, and route guards.\n');
