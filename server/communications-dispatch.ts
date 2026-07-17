import { commitWrites, decryptJson, documentName, encryptJson, fieldString, getDocument, googleAccessToken, integerValue, doubleValue, stableId, stringValue, timestampValue, verifyFirebaseAccount, type ServerRequest } from './server-data.js';

type Request = ServerRequest & { method?: string; body?: unknown };
type Body = Record<string, unknown>;
type Credential = Record<string, string>;
type ElevenLabsVoice = { voice_id?: string; name?: string; category?: string };
type ElevenLabsModel = { model_id?: string; name?: string; can_do_text_to_speech?: boolean };
const providers = new Set(['twilio', 'semaphore', 'infobip', 'elevenlabs']);
const clean = (value: unknown, maximum = 500) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const e164 = (value: unknown) => { const result = clean(value, 20); if (!/^\+[1-9]\d{7,14}$/.test(result)) throw new Error('INVALID_PHONE_NUMBER'); return result; };

function bodyOf(req: Request) {
  const value = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  return value as Body;
}

async function requireEditor(projectId: string, accessToken: string, workspaceId: string, uid: string) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(workspaceId)) throw new Error('INVALID_REQUEST');
  const [workspace, member] = await Promise.all([getDocument(projectId, accessToken, `workspaces/${workspaceId}`), getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`)]);
  if (!workspace || !['owner', 'admin', 'editor'].includes(fieldString(member, 'role'))) throw new Error('FORBIDDEN');
  return fieldString(workspace, 'ownerId') || uid;
}

export function validateCommunicationsCredential(provider: string, raw: unknown) {
  if (!providers.has(provider) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_CONNECTION');
  const value = raw as Body;
  if (provider === 'twilio') {
    const accountSid = clean(value.accountSid); const authToken = clean(value.authToken); const fromNumber = e164(value.fromNumber);
    if (!/^AC[a-fA-F0-9]{32}$/.test(accountSid) || authToken.length < 20) throw new Error('INVALID_CONNECTION');
    return { accountSid, authToken, fromNumber };
  }
  if (provider === 'semaphore') { const apiKey = clean(value.apiKey); const senderName = clean(value.senderName, 11); if (apiKey.length < 10 || !senderName) throw new Error('INVALID_CONNECTION'); return { apiKey, senderName }; }
  if (provider === 'infobip') { const baseUrl = clean(value.baseUrl, 300).replace(/\/$/, ''); const apiKey = clean(value.apiKey); const sender = clean(value.sender, 20); let url: URL; try { url = new URL(baseUrl); } catch { throw new Error('INVALID_CONNECTION'); } if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || apiKey.length < 10 || !sender) throw new Error('INVALID_CONNECTION'); return { baseUrl: url.origin, apiKey, sender }; }
  const apiKey = clean(value.apiKey); const voiceId = clean(value.voiceId, 100);
  if (apiKey.length < 20) throw new Error('INVALID_CONNECTION');
  return { apiKey, ...(voiceId ? { voiceId } : {}) };
}

async function credentialFor(projectId: string, accessToken: string, workspaceId: string, provider: string) {
  const vault = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/comms_${provider}`);
  if (!vault) throw new Error('PROVIDER_NOT_CONNECTED');
  return decryptJson<Credential>(fieldString(vault, 'ciphertext'), fieldString(vault, 'iv'), process.env.CONNECTOR_ENCRYPTION_KEY || '');
}

export function selectElevenLabsVoice(voices: ElevenLabsVoice[], preferredVoiceId = '') {
  const available = voices.filter((voice) => voice.voice_id && voice.name);
  const voice = available.find((candidate) => candidate.voice_id === preferredVoiceId) || available[0];
  if (!voice?.voice_id) throw new Error('PROVIDER_VOICE_SETUP_REQUIRED');
  return { voiceId: voice.voice_id, voiceName: voice.name || 'ElevenLabs voice' };
}

export function selectElevenLabsModel(models: ElevenLabsModel[]) {
  const available = models.filter((model) => model.model_id && model.can_do_text_to_speech !== false);
  const model = available.find((candidate) => candidate.model_id === 'eleven_flash_v2_5')
    || available.find((candidate) => candidate.model_id === 'eleven_multilingual_v2')
    || available[0];
  if (!model?.model_id) throw new Error('PROVIDER_VOICE_SETUP_REQUIRED');
  return { modelId: model.model_id, modelName: model.name || model.model_id };
}

async function testCommunicationsCredential(provider: string, credential: Credential) {
  let responses: Response[] = [];
  if (provider === 'twilio') {
    responses = [await fetch(`https://api.twilio.com/2010-04-01/Accounts/${credential.accountSid}/Balance.json`, {
      headers: { Authorization: `Basic ${btoa(`${credential.accountSid}:${credential.authToken}`)}` },
      signal: AbortSignal.timeout(10_000),
    })];
  } else if (provider === 'semaphore') {
    const query = new URLSearchParams({ apikey: credential.apiKey });
    responses = await Promise.all([
      fetch(`https://api.semaphore.co/api/v4/account?${query}`, { signal: AbortSignal.timeout(10_000) }),
      fetch(`https://api.semaphore.co/api/v4/account/sendernames?${query}`, { signal: AbortSignal.timeout(10_000) }),
    ]);
  } else if (provider === 'infobip') {
    responses = [await fetch(`${credential.baseUrl}/account/1/balance`, {
      headers: { Authorization: `App ${credential.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })];
  } else if (provider === 'elevenlabs') {
    const headers = { 'xi-api-key': credential.apiKey, Accept: 'application/json' };
    responses = await Promise.all([
      fetch('https://api.elevenlabs.io/v2/voices?page_size=100', { headers, signal: AbortSignal.timeout(10_000) }),
      fetch('https://api.elevenlabs.io/v1/models', { headers, signal: AbortSignal.timeout(10_000) }),
    ]);
  }
  if (!responses.length || responses.some((response) => !response.ok)) throw new Error('PROVIDER_REJECTED_CREDENTIALS');
  if (provider === 'semaphore') {
    const senders = await responses[1].json().catch(() => []) as Array<{ name?: string; status?: string }>;
    const sender = senders.find((item) => item.name?.toLowerCase() === credential.senderName.toLowerCase());
    if (!sender || !['active', 'approved'].includes(String(sender.status || '').toLowerCase())) throw new Error('PROVIDER_SENDER_NOT_APPROVED');
  }
  if (provider === 'elevenlabs') {
    const [voicePayload, models] = await Promise.all([
      responses[0].json().catch(() => ({})) as Promise<{ voices?: ElevenLabsVoice[] }>,
      responses[1].json().catch(() => []) as Promise<ElevenLabsModel[]>,
    ]);
    return {
      ...credential,
      ...selectElevenLabsVoice(voicePayload.voices || [], credential.voiceId),
      ...selectElevenLabsModel(Array.isArray(models) ? models : []),
    };
  }
  return credential;
}

async function sendSms(provider: string, credential: Credential, to: string, message: string) {
  let response: Response;
  if (provider === 'twilio') response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${credential.accountSid}/Messages.json`, { method: 'POST', headers: { Authorization: `Basic ${btoa(`${credential.accountSid}:${credential.authToken}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: to, From: credential.fromNumber, Body: message }), signal: AbortSignal.timeout(15_000) });
  else if (provider === 'semaphore') response = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ apikey: credential.apiKey, number: to, message, sendername: credential.senderName }), signal: AbortSignal.timeout(15_000) });
  else if (provider === 'infobip') response = await fetch(`${credential.baseUrl}/sms/2/text/advanced`, { method: 'POST', headers: { Authorization: `App ${credential.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ destinations: [{ to }], from: credential.sender, text: message }] }), signal: AbortSignal.timeout(15_000) });
  else throw new Error('INVALID_SMS_PROVIDER');
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
  const messages = Array.isArray(payload.messages) ? payload.messages as Array<Record<string, unknown>> : [];
  const first = Array.isArray(payload) ? (payload as Array<Record<string, unknown>>)[0] : messages[0];
  return String(payload.sid || first?.messageId || first?.message_id || crypto.randomUUID());
}

export async function synthesizeElevenLabsVoice(credential: Credential, text: string) {
  const speech = clean(text, 5_000);
  if (!credential.apiKey || !credential.voiceId || !credential.modelId || !speech) throw new Error('PROVIDER_VOICE_SETUP_REQUIRED');
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(credential.voiceId)}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': credential.apiKey, Accept: 'audio/mpeg', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: speech, model_id: credential.modelId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`PROVIDER_DELIVERY_FAILED:${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 24_000_000) throw new Error('PROVIDER_AUDIO_INVALID');
  return {
    bytes,
    contentType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
    characterCost: Number(response.headers.get('character-cost') || speech.length),
    requestId: response.headers.get('request-id') || '',
  };
}

export async function synthesizeWorkspaceVoice(projectId: string, accessToken: string, workspaceId: string, text: string) {
  return synthesizeElevenLabsVoice(await credentialFor(projectId, accessToken, workspaceId, 'elevenlabs'), text);
}

export async function handleCommunications(req: Request, action: string) {
  if (req.method !== 'POST') throw new Error('METHOD_NOT_ALLOWED');
  const body = bodyOf(req); const account = await verifyFirebaseAccount(req); const { projectId, accessToken } = await googleAccessToken();
  const workspaceId = clean(body.workspaceId, 200); const ownerId = await requireEditor(projectId, accessToken, workspaceId, account.localId); const now = new Date().toISOString();
  if (action === 'disconnect') {
    const provider = clean(body.provider, 30);
    if (!providers.has(provider)) throw new Error('INVALID_CONNECTION');
    await commitWrites(projectId, accessToken, [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/comms_${provider}`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/comms_${provider}`) },
    ]);
    return { ok: true, provider, disconnected: true };
  }
  if (action === 'connect') {
    const provider = clean(body.provider, 30); const submitted = validateCommunicationsCredential(provider, body.credential); const credential = await testCommunicationsCredential(provider, submitted); const encrypted = await encryptJson(credential, process.env.CONNECTOR_ENCRYPTION_KEY || '');
    const unitCost = typeof body.estimatedUnitCostUsd === 'number' && body.estimatedUnitCostUsd >= 0 && body.estimatedUnitCostUsd <= 100 ? body.estimatedUnitCostUsd : 0;
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/connectorVault/comms_${provider}`), fields: { provider: stringValue(provider), ownerId: stringValue(ownerId), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), updatedAt: timestampValue(now) } } }, { update: { name: documentName(projectId, `workspaces/${workspaceId}/connections/comms_${provider}`), fields: { provider: stringValue(provider), category: stringValue(provider === 'elevenlabs' ? 'voice' : 'sms'), displayName: stringValue(provider === 'elevenlabs' ? 'ElevenLabs Voice' : provider.charAt(0).toUpperCase() + provider.slice(1)), status: stringValue('connected'), health: stringValue('healthy'), credentialState: stringValue('stored_server_side'), connectionMode: stringValue('byok'), estimatedUnitCostUsd: doubleValue(unitCost), connectedBy: stringValue(account.localId), connectionTestedAt: timestampValue(now), ...(provider === 'elevenlabs' ? { externalVoiceName: stringValue(credential.voiceName), externalModelName: stringValue(credential.modelName) } : {}), updatedAt: timestampValue(now) } } }]);
    return { ok: true, provider, ...(provider === 'elevenlabs' ? { voiceName: credential.voiceName, modelName: credential.modelName } : {}) };
  }
  if (action === 'send_sms') {
    const provider = clean(body.provider, 30); const to = e164(body.to); const message = clean(body.message, 1600);
    if (body.consentConfirmed !== true) throw new Error('CONSENT_REQUIRED');
    if (!['twilio', 'semaphore', 'infobip'].includes(provider) || !message) throw new Error('INVALID_MESSAGE');
    const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/comms_${provider}`); if (!connection) throw new Error('PROVIDER_NOT_CONNECTED');
    const externalId = await sendSms(provider, await credentialFor(projectId, accessToken, workspaceId, provider), to, message);
    const deliveryId = await stableId('communication-delivery', workspaceId, provider, externalId); const unitCost = Number(connection.fields?.estimatedUnitCostUsd?.doubleValue || 0);
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/communicationDeliveries/${deliveryId}`), fields: { provider: stringValue(provider), type: stringValue('sms'), destinationMasked: stringValue(`${to.slice(0, 4)}••••${to.slice(-3)}`), status: stringValue('accepted'), externalId: stringValue(externalId), units: integerValue(1), estimatedCostUsd: doubleValue(unitCost), providerBilledCostUsd: doubleValue(0), costState: stringValue('estimated'), consentConfirmed: stringValue('user_attested'), consentConfirmedAt: timestampValue(now), createdBy: stringValue(account.localId), createdAt: timestampValue(now), updatedAt: timestampValue(now) } } }]);
    return { ok: true, deliveryId, externalId };
  }
  throw new Error('INVALID_REQUEST');
}
