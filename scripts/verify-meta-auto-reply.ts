import assert from 'node:assert/strict';
import { buildMessengerAudioMessage, enforceVoiceDeliveryReply, requestsVoiceReply, shouldProcessMetaAutoReply, voiceDeliveryInstruction } from '../api/webhooks/meta';

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
assert.equal(requestsVoiceReply('Can you send the price list?'), false, 'A normal request must remain text');
assert.match(voiceDeliveryInstruction(true), /Never claim that you cannot send, attach, or provide a voice message/);
assert.equal(voiceDeliveryInstruction(false), '');
assert.equal(enforceVoiceDeliveryReply("I'm sorry, I can't send a voice message.", true), 'Yes—I can send voice messages here. How can I help you today?');
assert.equal(enforceVoiceDeliveryReply("I can't send audio. Your ten phone stands can be quoted after dimensions are confirmed.", true), 'Your ten phone stands can be quoted after dimensions are confirmed.');
assert.equal(enforceVoiceDeliveryReply("I can't confirm stock.", true), "I can't confirm stock.");
assert.deepEqual(buildMessengerAudioMessage('customer_1', 'attachment_1'), { recipient: { id: 'customer_1' }, messaging_type: 'RESPONSE', message: { attachment: { type: 'audio', payload: { attachment_id: 'attachment_1' } } } });

process.stdout.write('Meta automatic-reply verification passed: eligibility, burst collapse, voice intent, audio payload, human takeover, channel, and subscription guards.\n');
