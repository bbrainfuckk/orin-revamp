import assert from 'node:assert/strict';
import { normalizeMetaPayload } from '../api/webhooks/meta';

const messenger = await normalizeMetaPayload({
  object: 'page',
  entry: [{
    id: 'page_100',
    time: 1_720_000_000_000,
    messaging: [{
      sender: { id: 'customer_200' },
      recipient: { id: 'page_100' },
      timestamp: 1_720_000_001_000,
      message: { mid: 'message_300', text: 'Do you deliver tomorrow?' },
    }],
  }],
});

assert.equal(messenger.length, 1);
assert.equal(messenger[0].channel, 'Messenger');
assert.equal(messenger[0].type, 'message.received');
assert.equal(messenger[0].routeId, 'meta_page_page_100');
assert.equal(messenger[0].body, 'Do you deliver tomorrow?');
assert.equal(messenger[0].providerAccountId, 'page_100');
assert.equal(messenger[0].providerUserId, 'customer_200');
assert.ok(messenger[0].contactId.length >= 32);
assert.ok(messenger[0].conversationId);
assert.ok(messenger[0].messageId);

const replay = await normalizeMetaPayload({
  object: 'page',
  entry: [{ id: 'page_100', messaging: [{ sender: { id: 'customer_200' }, message: { mid: 'message_300', text: 'Do you deliver tomorrow?' } }] }],
});
assert.equal(replay[0].id, messenger[0].id, 'Provider replay IDs must be deterministic');

const postback = await normalizeMetaPayload({
  object: 'page',
  entry: [{ id: 'page_100', messaging: [{ sender: { id: 'customer_200' }, timestamp: 1_720_000_001_500, postback: { mid: 'postback_1', title: 'Pay with QRPh', payload: 'ORIN_COMMERCE:QRPH:order_123' } }] }],
});
assert.equal(postback[0].body, 'Pay with QRPh');
assert.equal(postback[0].actionPayload, 'ORIN_COMMERCE:QRPH:order_123');

const instagram = await normalizeMetaPayload({
  object: 'instagram',
  entry: [{
    id: 'instagram_400',
    messaging: [{ sender: { id: 'customer_500' }, timestamp: 1_720_000_002_000, message: { mid: 'message_600', attachments: [{ type: 'image' }] } }],
  }],
});
assert.equal(instagram[0].channel, 'Instagram');
assert.equal(instagram[0].routeId, 'meta_instagram_instagram_400');
assert.equal(instagram[0].body, 'Shared photo');
assert.equal(instagram[0].providerAccountId, 'instagram_400');
assert.equal(instagram[0].providerUserId, 'customer_500');

const lead = await normalizeMetaPayload({
  object: 'page',
  entry: [{
    id: 'page_100',
    changes: [{ field: 'leadgen', value: { leadgen_id: 'lead_700', page_id: 'page_100', created_time: 1_720_000_003 } }],
  }],
});
assert.equal(lead.length, 1);
assert.equal(lead[0].type, 'lead.captured');
assert.equal(lead[0].channel, 'Facebook Lead');

const ignored = await normalizeMetaPayload({
  object: 'page',
  entry: [{
    id: 'page_100',
    messaging: [
      { sender: { id: 'page_100' }, message: { mid: 'echo_800', text: 'Our reply', is_echo: true } },
      { sender: { id: 'customer_200' }, timestamp: 1_720_000_004_000 },
    ],
  }],
});
assert.equal(ignored.length, 0, 'Echoes and delivery receipts must not create customer messages');

await assert.rejects(() => normalizeMetaPayload({ object: 'unknown', entry: [] }), /INVALID_META_PAYLOAD/);

process.stdout.write('Meta normalization verification passed: Messenger, Instagram, lead, replay, and ignore cases.\n');
