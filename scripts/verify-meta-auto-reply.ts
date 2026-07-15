import assert from 'node:assert/strict';
import { shouldProcessMetaAutoReply } from '../api/webhooks/meta';

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

process.stdout.write('Meta automatic-reply verification passed: eligibility, burst collapse, human takeover, channel, and subscription guards.\n');
