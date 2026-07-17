const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: {}, module: { exports: {} } };
vm.runInNewContext(fs.readFileSync('public/scroll-world.js', 'utf8'), context);
const { idleScrollDelta } = context.module.exports;

assert.equal(idleScrollDelta(800, 1000, 8), 100);
assert.equal(idleScrollDelta(800, 100000, 8), 400);
assert.equal(idleScrollDelta(800, -1000, 8), 0);
console.log('Idle autoplay timing verified.');
