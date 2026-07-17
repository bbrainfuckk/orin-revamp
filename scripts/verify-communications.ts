import { strict as assert } from 'node:assert';
import { validateCommunicationsCredential } from '../server/communications-dispatch.js';

assert.deepEqual(validateCommunicationsCredential('infobip', { baseUrl: 'https://example.api.infobip.com/', apiKey: 'app-key-long-enough', sender: 'ORIN' }), { baseUrl: 'https://example.api.infobip.com', apiKey: 'app-key-long-enough', sender: 'ORIN' });
assert.deepEqual(validateCommunicationsCredential('semaphore', { apiKey: 'semaphore-key', senderName: 'ORINAI' }), { apiKey: 'semaphore-key', senderName: 'ORINAI' });
assert.throws(() => validateCommunicationsCredential('twilio', { accountSid: 'bad', authToken: 'bad', fromNumber: '09171234567' }), /INVALID_PHONE_NUMBER|INVALID_CONNECTION/);
assert.throws(() => validateCommunicationsCredential('infobip', { baseUrl: 'http://unsafe.test', apiKey: 'long-enough-key', sender: 'ORIN' }), /INVALID_CONNECTION/);
console.log('Communications provider validation passed.');
