import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { normalizeWhatsAppPayload, parseWhatsAppCredential, validSignature } from '../api/webhooks/meta';
import { buildWhatsAppOutboundRequest, parseWhatsAppCredential as parseOutboundCredential } from '../api/widget/message';

const secret = 'whatsapp-test-secret-with-enough-entropy';
const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba_123',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '+63 917 555 0101', phone_number_id: '100200300400' },
        contacts: [{ profile: { name: 'Maria Santos' }, wa_id: '639171234567' }],
        messages: [{
          from: '639171234567',
          id: 'wamid.HBgMNjM5MTcxMjM0NTY3FQIAERgSODc2NTQzMjEw',
          timestamp: '1784102400',
          type: 'text',
          text: { body: 'Do you have this in stock?' },
        }],
      },
    }],
  }],
};

const raw = new TextEncoder().encode(JSON.stringify(payload));
const signature = createHmac('sha256', secret).update(raw).digest('hex');
assert.equal(await validSignature(raw, `sha256=${signature}`, secret), true);
assert.equal(await validSignature(raw, `sha256=${'0'.repeat(64)}`, secret), false);

const normalized = await normalizeWhatsAppPayload(payload);
assert.equal(normalized.length, 1);
assert.equal(normalized[0].provider, 'whatsapp');
assert.equal(normalized[0].channel, 'WhatsApp');
assert.equal(normalized[0].contactName, 'Maria Santos');
assert.equal(normalized[0].body, 'Do you have this in stock?');
assert.equal(normalized[0].providerAccountId, '100200300400');
assert.equal(normalized[0].providerUserId, '639171234567');
assert.match(normalized[0].routeId, /^whatsapp_phone_[A-Za-z0-9_-]{40}$/);
assert.equal(normalized[0].routeId.includes('100200300400'), false);

const statusesOnly = await normalizeWhatsAppPayload({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '100200300400' }, statuses: [{ id: 'wamid.delivery' }] } }] }],
});
assert.deepEqual(statusesOnly, []);

const credential = {
  provider: 'whatsapp',
  graphVersion: 'v24.0',
  accessToken: 'EAA-whatsapp-access-token-long-enough',
  expiresAt: '2027-01-01T00:00:00.000Z',
  accounts: [{ id: 'waba_123', phones: [{ id: '100200300400', verifiedName: 'ORIN Test Shop' }] }],
};
assert.deepEqual(parseWhatsAppCredential(credential), {
  graphVersion: 'v24.0',
  accessToken: credential.accessToken,
  expiresAt: credential.expiresAt,
  accounts: credential.accounts,
});
assert.deepEqual(parseOutboundCredential(credential), credential);
assert.equal(parseWhatsAppCredential({ ...credential, accessToken: 'short' }), null);

const outbound = buildWhatsAppOutboundRequest('v24.0', '100200300400', '639171234567', 'Yes, it is available.');
assert.equal(outbound.url, 'https://graph.facebook.com/v24.0/100200300400/messages');
assert.deepEqual(outbound.body, {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: '639171234567',
  type: 'text',
  text: { preview_url: false, body: 'Yes, it is available.' },
});
assert.throws(() => buildWhatsAppOutboundRequest('v24.0', '100200300400', '+63 917', 'Hello'), /WHATSAPP_ROUTE_NOT_FOUND/);

console.log('WhatsApp signature, normalization, credential, privacy, and outbound checks passed.');
