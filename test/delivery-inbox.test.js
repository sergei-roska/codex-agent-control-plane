'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { DeliveryInbox } = require('../src/delivery-inbox');

function fixture(options = {}) {
  const db = new Database(':memory:');
  return { db, inbox: new DeliveryInbox(db, { projectId: 'p', sessionId: 's', objectiveId: 'o', ...options }) };
}

test('receipt is durable, idempotent and distinct from application', (t) => {
  const { db, inbox } = fixture();
  t.after(() => db.close());
  const ack = inbox.receive({ messageId: 'm1', kind: 'steering', payload: { text: 'Prioritize the bug fix' } });
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.state, 'received');
  assert.equal(ack.duplicate, false);
  assert.equal(inbox.projection().received, 1);
  assert.equal(inbox.projection().version, 1);
  assert.equal(inbox.receive({ messageId: 'm1', kind: 'steering', payload: { text: 'Prioritize the bug fix' } }).duplicate, true);
  assert.throws(() => inbox.receive({ messageId: 'm1', kind: 'steering', payload: { text: 'Different message' } }), { code: 'message_id_conflict' });
  assert.equal(inbox.pending()[0].messageId, 'm1');
  inbox.markApplied('m1', 'received', { applied: true });
  assert.equal(inbox.get('m1').state, 'applied');
  assert.deepEqual([inbox.projection().received, inbox.projection().applied, inbox.projection().blocked], [0, 1, 0]);
  assert.throws(() => inbox.markBlocked('m1'), { code: 'message_state_stale' });
});

test('owner corrections require injected authentication and inbox bounds are durable', (t) => {
  const { db, inbox } = fixture({ maxPending: 1 });
  t.after(() => db.close());
  assert.throws(() => inbox.receive({ messageId: 'bad', kind: 'owner_correction', payload: {} }), { code: 'owner_authentication_required' });
  inbox.receive({ messageId: 'm1', kind: 'steering', payload: {} });
  assert.throws(() => inbox.receive({ messageId: 'm2', kind: 'steering', payload: {} }), { code: 'inbox_full' });
});

test('owner correction authentication is checked by the trusted adapter, not a caller flag', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const inbox = new DeliveryInbox(db, { projectId: 'p', sessionId: 's', objectiveId: 'o', authenticateOwner: ({ source }) => source === 'owner-channel' });
  assert.throws(() => inbox.receive({ messageId: 'm1', kind: 'owner_correction', payload: {}, authenticatedOwner: true }), { code: 'owner_authentication_required' });
  assert.equal(inbox.receive({ messageId: 'm1', kind: 'owner_correction', payload: {}, source: 'owner-channel' }).authenticatedOwner, true);
});
