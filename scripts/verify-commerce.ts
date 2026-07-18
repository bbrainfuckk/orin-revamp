import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  buildMessengerCatalog,
  buildPaymentChoice,
  checkoutAttributes,
  extractPaidCheckout,
  nativeGcashCommand,
  parseCommerceAction,
  validateCatalogInput,
  verifyPayMongoSignature,
  wantsCommerceCatalog,
  type CatalogItem,
  type CommerceOrder,
} from '../server/commerce';
import {
  buildWhitenCategoryCatalog,
  buildWhitenServiceCatalog,
  parseWhitenAction,
  WHITEN_CATEGORIES,
  whitenItemById,
} from '../server/whiten-demo';

const item: CatalogItem = {
  id: 'item_filament', name: 'PLA Filament', kind: 'material', description: '1 kg spool', priceCentavos: 89900, quoteOnly: false, stock: 12, variants: ['Black', 'White'], imageUrl: 'https://example.com/pla.jpg', active: true,
};
assert.deepEqual(parseCommerceAction('ORIN_COMMERCE:QTY:order_123:-1'), { type: 'quantity', orderId: 'order_123', delta: -1 });
assert.deepEqual(parseCommerceAction('ORIN_COMMERCE:GCASH:order_123'), { type: 'gcash', orderId: 'order_123' });
assert.equal(parseCommerceAction('ORIN_COMMERCE:QTY:../order:1'), null);
assert.equal(wantsCommerceCatalog('Can I see the material list?'), true);
assert.equal(wantsCommerceCatalog('Can I see my existing order?'), false);
assert.equal(validateCatalogInput({ ...item, priceCentavos: 89900 }).priceCentavos, 89900);
assert.throws(() => validateCatalogInput({ ...item, imageUrl: 'http://example.com/image.jpg' }), /INVALID_CATALOG_IMAGE/);
const catalog = buildMessengerCatalog('customer_1', [item]);
assert.equal(catalog.message.attachment.payload.template_type, 'generic');
assert.equal(catalog.message.attachment.payload.elements[0].image_url, item.imageUrl);
assert.equal(catalog.message.attachment.payload.elements[0].buttons[0].payload, 'ORIN_COMMERCE:SELECT:item_filament:0');
assert.equal(nativeGcashCommand('09171234567'), 'GCash 09171234567');
assert.equal(WHITEN_CATEGORIES.length, 16);
assert.ok(WHITEN_CATEGORIES.reduce((total, category) => total + category.items.length, 0) >= 120);
assert.deepEqual(parseWhitenAction('ORIN_WHITEN:CATEGORY:facial_services:1'), { type: 'category', categoryId: 'facial_services', page: 1 });
assert.deepEqual(parseWhitenAction('ORIN_WHITEN:CATEGORIES:1'), { type: 'categories', page: 1 });
assert.equal(parseWhitenAction('ORIN_WHITEN:CATEGORY:../bad:0'), null);
const whitenCategories = buildWhitenCategoryCatalog('customer_1', 0);
assert.equal(whitenCategories.message.attachment.payload.elements.length, 10);
assert.match(whitenCategories.message.attachment.payload.elements[0].image_url, /^https:/);
const whitenServices = buildWhitenServiceCatalog('customer_1', 'facial_services', 0);
assert.equal(whitenServices?.message.attachment.payload.elements[0].buttons[0].payload.startsWith('ORIN_COMMERCE:ADD:whiten_'), true);
const whitenServiceId = WHITEN_CATEGORIES.find((category) => category.id === 'facial_services')?.items[0].id || '';
assert.equal(whitenItemById(whitenServiceId)?.name, 'Hydra Glass-skin Facial');

const order: CommerceOrder = { id: 'order_123', reference: 'ORIN-ABC12345', itemId: item.id, itemName: item.name, itemKind: item.kind, variant: 'Black', quantity: 2, unitPriceCentavos: 89900, totalCentavos: 179800, quoteOnly: false, status: 'draft', contactId: 'contact_1', contactName: 'Customer', conversationId: 'conversation_1' };
const paymentChoice = buildPaymentChoice('customer_1', order, true);
assert.deepEqual(paymentChoice.message.attachment.payload.buttons.map((button) => button.title), ['GCash / QRPh', 'GCash transfer', 'Cancel']);
const checkout = checkoutAttributes(order);
assert.deepEqual(checkout.payment_method_types, ['qrph']);
assert.equal(checkout.line_items[0].quantity, 2);
assert.equal(checkout.reference_number, order.reference);

const current = Math.floor(Date.now() / 1000);
const raw = new TextEncoder().encode('{"data":{"type":"checkout_session.payment.paid","livemode":true,"data":{"id":"cs_123","attributes":{"reference_number":"ORIN-ABC12345"}}}}');
const secret = 'webhook_secret_for_tests';
const signature = createHmac('sha256', secret).update(`${current}.${new TextDecoder().decode(raw)}`).digest('hex');
assert.equal(await verifyPayMongoSignature(raw, `t=${current},te=,li=${signature}`, secret, true, current), true);
assert.equal(await verifyPayMongoSignature(raw, `t=${current},te=,li=${'0'.repeat(64)}`, secret, true, current), false);
assert.deepEqual(extractPaidCheckout(JSON.parse(new TextDecoder().decode(raw))), { sessionId: 'cs_123', eventId: '', liveMode: true, reference: 'ORIN-ABC12345' });
assert.deepEqual(extractPaidCheckout({ data: { id: 'evt_1', attributes: { type: 'checkout_session.payment.paid', livemode: false, data: { id: 'cs_old', attributes: { reference_number: 'ORIN-OLD' } } } } }), { sessionId: 'cs_old', eventId: 'evt_1', liveMode: false, reference: 'ORIN-OLD' });

process.stdout.write('Commerce verification passed: catalog validation, Messenger actions, native GCash command, QRPh checkout shape, and signed webhook parsing.\n');
