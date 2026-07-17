import { strict as assert } from 'node:assert';
import { selectElevenLabsModel, selectElevenLabsVoice, validateCommunicationsCredential } from '../server/communications-dispatch.js';

assert.deepEqual(validateCommunicationsCredential('infobip', { baseUrl: 'https://example.api.infobip.com/', apiKey: 'app-key-long-enough', sender: 'ORIN' }), { baseUrl: 'https://example.api.infobip.com', apiKey: 'app-key-long-enough', sender: 'ORIN' });
assert.deepEqual(validateCommunicationsCredential('semaphore', { apiKey: 'semaphore-key', senderName: 'ORINAI' }), { apiKey: 'semaphore-key', senderName: 'ORINAI' });
assert.throws(() => validateCommunicationsCredential('twilio', { accountSid: 'bad', authToken: 'bad', fromNumber: '09171234567' }), /INVALID_PHONE_NUMBER|INVALID_CONNECTION/);
assert.throws(() => validateCommunicationsCredential('infobip', { baseUrl: 'http://unsafe.test', apiKey: 'long-enough-key', sender: 'ORIN' }), /INVALID_CONNECTION/);
assert.deepEqual(validateCommunicationsCredential('elevenlabs', { apiKey: 'elevenlabs-key-long-enough' }), { apiKey: 'elevenlabs-key-long-enough' });
assert.deepEqual(selectElevenLabsVoice([{ voice_id: 'v1', name: 'Default' }, { voice_id: 'v2', name: 'Preferred' }], 'v2'), { voiceId: 'v2', voiceName: 'Preferred' });
assert.deepEqual(selectElevenLabsModel([{ model_id: 'eleven_multilingual_v2', name: 'Multilingual' }, { model_id: 'eleven_flash_v2_5', name: 'Flash' }]), { modelId: 'eleven_flash_v2_5', modelName: 'Flash' });
console.log('Communications provider validation passed.');
