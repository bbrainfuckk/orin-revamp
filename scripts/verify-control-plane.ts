import assert from 'node:assert/strict';
import { controlPlaneManifest, verifyControlPlaneContract } from '../server/control-plane.js';

assert.equal(verifyControlPlaneContract(), true);
assert.ok(controlPlaneManifest.resources.some((resource) => resource.name === 'agents' && resource.mutable?.includes('upsert')));
assert.ok(controlPlaneManifest.resources.some((resource) => resource.name === 'messages' && resource.parent === 'conversation'));
assert.ok(controlPlaneManifest.externalActions.some((action) => action.name === 'publishing.publish'));
console.log(`ORIN control-plane self-test passed (${controlPlaneManifest.resources.length} resources).`);
