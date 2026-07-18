import assert from 'node:assert/strict';
import { buildMessengerAudioMessage, buildMessengerDemoResponse, buildMessengerHandoffPrompt, buildMessengerQuickReplies, buildMessengerSenderAction, enforceVoiceDeliveryReply, parseMessengerCommand, parseMessengerDemoAction, parseMessengerHandoffAction, requestsVoiceReply, selectMetaAssignedAgent, shouldProcessMetaAutoReply, voiceCommandSpeech, voiceDeliveryInstruction } from '../api/webhooks/meta';

const eligible = {
  routeActive: true,
  eventAt: 1_720_000_001_000,
  latestInboundAt: 1_720_000_001_000,
  autoReplyEnabled: true,
  assignedAgentId: 'agent_12345678',
  approvedChannels: ['Messenger'],
  subscribedAccountIds: ['page_100'],
  channel: 'Messenger',
  providerAccountId: 'page_100',
  teamResponded: false,
  teamTakeoverActive: false,
};

assert.equal(shouldProcessMetaAutoReply(eligible), true, 'Newest verified message should be eligible');
assert.equal(shouldProcessMetaAutoReply({ ...eligible, latestInboundAt: eligible.eventAt + 500 }), false, 'A newer inbound message must collapse the older reply');
assert.equal(shouldProcessMetaAutoReply({ ...eligible, teamResponded: true }), false, 'The AI must not answer after a team member');
assert.equal(shouldProcessMetaAutoReply({ ...eligible, teamTakeoverActive: true }), false, 'An active team takeover must keep the AI paused');
assert.equal(shouldProcessMetaAutoReply({ ...eligible, autoReplyEnabled: false }), false, 'Disabled automatic replies must stay off');
assert.equal(shouldProcessMetaAutoReply({ ...eligible, assignedAgentId: '' }), false, 'An assigned AI is required');
assert.equal(shouldProcessMetaAutoReply({ ...eligible, approvedChannels: ['Instagram'] }), false, 'The AI must be approved for the inbound channel');
assert.equal(shouldProcessMetaAutoReply({ ...eligible, subscribedAccountIds: ['page_200'] }), false, 'The provider account must have an accepted subscription');
assert.equal(requestsVoiceReply('Can you send me a voice msg?'), true, 'A direct voice-message request should be recognized');
assert.equal(requestsVoiceReply('Can you speak Taglish in a voice message?'), true, 'A Taglish voice request should be recognized');
assert.equal(requestsVoiceReply('Pakisend po as Taglish voice'), true, 'A Filipino voice request should be recognized');
assert.equal(requestsVoiceReply('do a voice msg'), true, 'A colloquial voice request should be recognized');
assert.equal(requestsVoiceReply('can u do me a voice note'), true, 'A conversational voice request should be recognized');
assert.equal(requestsVoiceReply('/voice Hello from ORIN AI'), true, 'The voice slash command should be recognized');
assert.equal(requestsVoiceReply('Can you send the price list?'), false, 'A normal request must remain text');
assert.equal(requestsVoiceReply('Do you support voice messages?'), false, 'A capability question must not silently force audio');
assert.deepEqual(parseMessengerCommand('/demo'), { name: 'demo', argument: '' });
assert.deepEqual(parseMessengerCommand('/menu'), { name: 'demo', argument: '' });
assert.deepEqual(parseMessengerCommand('/commands'), { name: 'help', argument: '' });
assert.deepEqual(parseMessengerCommand('/voice  Kumusta, Marvin!  '), { name: 'voice', argument: 'Kumusta, Marvin!' });
assert.equal(parseMessengerCommand('demo'), null);
assert.equal(voiceCommandSpeech('/voice Kumusta, Marvin!'), 'Kumusta, Marvin!');
assert.match(voiceCommandSpeech('/voice'), /this is ORIN AI/i);
assert.match(voiceDeliveryInstruction(true), /Never claim that you cannot send, attach, or provide a voice message/);
assert.equal(voiceDeliveryInstruction(false), '');
assert.equal(enforceVoiceDeliveryReply("I'm sorry, I can't send a voice message.", true), 'Yes—I can send voice messages here. How can I help you today?');
assert.equal(enforceVoiceDeliveryReply("I can't send audio. Your ten phone stands can be quoted after dimensions are confirmed.", true), 'Your ten phone stands can be quoted after dimensions are confirmed.');
assert.equal(enforceVoiceDeliveryReply("I can't confirm stock.", true), "I can't confirm stock.");
assert.deepEqual(buildMessengerAudioMessage('customer_1', 'attachment_1'), { recipient: { id: 'customer_1' }, messaging_type: 'RESPONSE', message: { attachment: { type: 'audio', payload: { attachment_id: 'attachment_1' } } } });
assert.deepEqual(buildMessengerSenderAction('customer_1', 'typing_on'), { recipient: { id: 'customer_1' }, sender_action: 'typing_on' });
assert.equal(parseMessengerHandoffAction('ORIN_HANDOFF:REQUEST'), 'request');
assert.equal(parseMessengerHandoffAction('ORIN_HANDOFF:DETAILS'), 'details');
assert.equal(parseMessengerHandoffAction('ORIN_COMMERCE:CATALOG'), null);
const handoff = buildMessengerHandoffPrompt('customer_1', 'I will bring in the team.');
assert.equal(handoff.message.attachment.payload.template_type, 'button');
assert.equal(handoff.message.attachment.payload.buttons.length, 2);
assert.deepEqual(handoff.message.attachment.payload.buttons.map((button) => 'payload' in button ? button.payload : ''), ['ORIN_HANDOFF:REQUEST', 'ORIN_HANDOFF:DETAILS']);
assert.deepEqual(parseMessengerDemoAction('ORIN_DEMO:AIRBNB:START'), { journey: 'AIRBNB', step: 'START' });
assert.equal(parseMessengerDemoAction('ORIN_DEMO:AIRBNB:start'), null);
assert.equal(parseMessengerDemoAction('ORIN_COMMERCE:CATALOG'), null);
const quickReplies = buildMessengerQuickReplies('customer_1', 'Choose a demo', [
  { title: 'Online shop', payload: 'ORIN_DEMO:ECOMMERCE:START' },
  { title: 'Airbnb host', payload: 'ORIN_DEMO:AIRBNB:START' },
]);
assert.equal(quickReplies.message.quick_replies.length, 2);
assert.equal(quickReplies.message.quick_replies[0].content_type, 'text');
const welcomeDemo = buildMessengerDemoResponse('customer_1', null);
assert.equal(welcomeDemo.body.message.quick_replies.length, 5);
assert.match(welcomeDemo.transcript, /choose a live customer journey/i);
const ecommerceDemo = buildMessengerDemoResponse('customer_1', { journey: 'ECOMMERCE', step: 'START' });
assert.equal(ecommerceDemo.body.message.quick_replies[0].payload, 'ORIN_WHITEN:CATEGORIES:0');
assert.match(ecommerceDemo.transcript, /Whiten Beauty and Wellness/i);
const pickleballDemo = buildMessengerDemoResponse('customer_1', { journey: 'PICKLEBALL', step: 'START' });
assert.deepEqual(pickleballDemo.body.message.quick_replies.slice(0, 3).map((reply) => reply.title), ['Book a court', 'Join a game', 'View rates']);
const hospitalDemo = buildMessengerDemoResponse('customer_1', { journey: 'HOSPITAL', step: 'GENERAL' });
assert.deepEqual(hospitalDemo.body.message.quick_replies.slice(0, 3).map((reply) => reply.title), ['Today', 'Tomorrow', 'Choose a date']);
assert.equal(selectMetaAssignedAgent({ page_100: 'agent_showcase_123' }, 'page_100', 'agent_default_123'), 'agent_showcase_123');
assert.equal(selectMetaAssignedAgent({ page_100: 'bad id' }, 'page_100', 'agent_default_123'), 'agent_default_123');
assert.equal(selectMetaAssignedAgent({ page_100: 'agent_showcase_123' }, 'page_200', 'agent_default_123'), 'agent_default_123');

process.stdout.write('Meta automatic-reply verification passed: eligibility, burst collapse, voice intent, audio payload, interactive demo journeys, customer handoff actions, human takeover, channel, and subscription guards.\n');
