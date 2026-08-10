const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: {}, module: { exports: {} } };
vm.runInNewContext(fs.readFileSync('public/scroll-world.js', 'utf8'), context);
const { idleScrollDelta, storyFrameDue, storyPlaybackRate, shouldKeepSegment } = context.module.exports;

assert.equal(idleScrollDelta(800, 1000, 8), 100);
assert.equal(idleScrollDelta(800, 100000, 8), 400);
assert.equal(idleScrollDelta(800, -1000, 8), 0);
assert.equal(storyFrameDue(0, 1000), true);
assert.equal(storyFrameDue(1000, 1020), false);
assert.equal(storyFrameDue(1000, 1042), true);
assert.equal(storyPlaybackRate(10, 1.4, 6.5).toFixed(3), '1.099');
assert.equal(storyPlaybackRate(10, 100, 6.5), 0.5);
assert.equal(storyPlaybackRate(10, 0.1, 0.1), 2);
assert.equal(shouldKeepSegment(2, 2, false, false), true);
assert.equal(shouldKeepSegment(3, 2, false, false), true);
assert.equal(shouldKeepSegment(1, 2, true, false), true);
assert.equal(shouldKeepSegment(1, 2, true, true), false);
assert.equal(shouldKeepSegment(4, 2, false, false), false);

const engine = fs.readFileSync('public/scroll-world.js', 'utf8');
assert.doesNotMatch(engine, /fetch\(url\).*?\.blob\(/s, 'desktop must not buffer whole videos into renderer memory');
assert.match(engine, /setNativeAutoplay\(true\)/, 'autoplay must switch to native video playback');
assert.match(engine, /if \(needsFrame\) scrubFrame = requestAnimationFrame\(raf\)/, 'scrub loop must stop when settled');
console.log('Idle autoplay timing verified.');
