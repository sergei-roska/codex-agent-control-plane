'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shouldRequeue } = require('../src/queue-worker');
const { describeSync } = require('../src/sync-job');

test('requeue below the limit only', () => {
  assert.strictEqual(shouldRequeue({ attempts: 3 }), true);
  assert.strictEqual(shouldRequeue({ attempts: 4 }), false);
});

test('sync description mentions the limit', () => {
  assert.match(describeSync('nightly'), /4 retries/);
});
