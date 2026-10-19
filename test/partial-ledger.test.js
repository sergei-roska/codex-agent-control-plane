'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeLedger, unreviewedIds, finalizeLedger, formatLedger } = require('../src/partial-ledger');

const ledger = () => [
  { id: 'cp-1', status: 'accepted', reason: 'Landed', evidence: ['run:r1:a0'] },
  { id: 'cp-2', status: 'blocked', reason: 'No loopback sockets', evidence: [] },
  { id: 'cp-3', status: 'not_started', reason: 'Depends on cp-2', evidence: [] },
];

test('normalizeLedger trims entries, treats null and empty as no ledger, and reports the first problem', () => {
  assert.deepEqual(normalizeLedger(null), { ledger: null });
  assert.deepEqual(normalizeLedger([]), { ledger: null });
  assert.deepEqual(normalizeLedger([{ id: ' a ', status: 'blocked', reason: ' why ', evidence: [' e ', ''] }]),
    { ledger: [{ id: 'a', status: 'blocked', reason: 'why', evidence: ['e'] }] });
  assert.match(normalizeLedger([{ id: 'a', status: 'accepted', reason: '', evidence: ['x'] }]).error, /at least one blocked or not_started/);
});

test('unreviewedIds lists the checkpoints that are not accepted', () => {
  assert.deepEqual([...unreviewedIds(ledger())].sort(), ['cp-2', 'cp-3']);
  assert.equal(unreviewedIds(null).size, 0);
});

test('finalizeLedger leaves accepted entries only when acceptance did not fail', () => {
  for (const disposition of ['accepted', 'unverified', 'not_required']) {
    assert.deepEqual(finalizeLedger(ledger(), { acceptance: { disposition } }), ledger());
  }
  for (const disposition of ['rejected', 'unverifiable']) {
    const result = finalizeLedger(ledger(), { acceptance: { disposition } });
    assert.equal(result.find((entry) => entry.id === 'cp-1').status, 'blocked');
    assert.match(result.find((entry) => entry.id === 'cp-1').reason, new RegExp(`acceptance ${disposition}`));
    assert.equal(result.filter((entry) => entry.status === 'accepted').length, 0);
  }
});

test('finalizeLedger marks owner-blocked checkpoints blocked, adding the ones the lead left out', () => {
  const blocked = [
    { checkpointId: 'cp-1', reason: 'Owner deferred: needs a device farm', decisionId: 'run:h1' },
    { checkpointId: 'cp-9', reason: 'Owner deferred: outside the run', decisionId: 'run:h1' },
  ];
  const result = finalizeLedger(ledger(), { blocked });
  assert.deepEqual(result.find((entry) => entry.id === 'cp-1'), { id: 'cp-1', status: 'blocked', reason: 'Owner deferred: needs a device farm', evidence: ['run:r1:a0'] });
  assert.deepEqual(result.find((entry) => entry.id === 'cp-9'), { id: 'cp-9', status: 'blocked', reason: 'Owner deferred: outside the run', evidence: ['run:h1'] });
  assert.equal(result.length, 4);
});

test('formatLedger renders counts and one line per checkpoint', () => {
  const text = formatLedger(ledger());
  assert.match(text, /^Partial result: 1 accepted, 1 blocked, 1 not started \(goal not achieved\)\n/);
  assert.match(text, /- cp-1: accepted - Landed \[evidence: run:r1:a0\]/);
  assert.match(text, /- cp-2: blocked - No loopback sockets\n/);
  assert.equal(formatLedger([]), '');
});
