'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DeliveryEvents } = require('../src/delivery-events');
const { BacklogStore } = require('../src/backlog-store');

const projectId = 'project-events';
const objective = { projectId, objectiveId: 'objective-events', sessionId: 'session-events', engineVersion: 'delivery-v1', goalRevision: 1, requirementDigest: `sha256:${'a'.repeat(64)}`, checksDigest: `sha256:${'b'.repeat(64)}`, authorityRevision: 1, controlRevision: 1, disposition: 'executing' };

test('dedupe rejects payload conflicts and consumer cursors persist across reopen', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-events-'));
  const file = path.join(directory, 'events.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let db = new Database(file);
  let id = 0;
  let events = new DeliveryEvents(db, { now: () => 10, idFactory: (prefix) => `${prefix}-${++id}` });
  assert.throws(() => events.appendInTransaction(projectId, { eventType: 'task.changed', objectRevision: 1, payload: { state: 'queued' }, dedupeKey: 'detached' }), { code: 'event_transaction_required' });
  const first = events.append(projectId, { eventType: 'task.changed', objectRevision: 1, payload: { state: 'queued' }, dedupeKey: 'task:alpha:queued' });
  assert.equal(first.sequence, 1);
  assert.equal(events.append(projectId, { eventType: 'task.changed', objectRevision: 1, payload: { state: 'queued' }, dedupeKey: 'task:alpha:queued' }).eventId, first.eventId);
  assert.throws(() => events.append(projectId, { eventType: 'task.changed', objectRevision: 1, payload: { state: 'running' }, dedupeKey: 'task:alpha:queued' }), { code: 'event_dedupe_conflict' });
  const second = events.append(projectId, { eventType: 'task.changed', objectRevision: 2, payload: { state: 'running' }, dedupeKey: 'task:alpha:running' });
  assert.equal(second.sequence, 2);
  events.advanceCursor(projectId, 'consumer-a', 1);
  assert.throws(() => events.advanceCursor(projectId, 'consumer-a', 0), { code: 'cursor_backwards' });
  assert.throws(() => events.advanceCursor(projectId, 'consumer-a', 3), { code: 'cursor_future' });
  db.close();
  db = new Database(file); events = new DeliveryEvents(db);
  assert.equal(events.cursor(projectId, 'consumer-a'), 1);
  assert.deepEqual(events.replay(projectId, { consumerId: 'consumer-a' }).map((event) => event.sequence), [2]);
  db.close();
});
test('event insertion failure rolls back objective and event state in one transaction', () => {
  const db = new Database(':memory:');
  try {
    const store = new BacklogStore(db, { beforeEventInsert(event) { if (event.eventType === 'objective.created') throw new Error('injected event failure'); } });
    assert.throws(() => store.createObjective(objective), /injected event failure/);
    assert.equal(store.getObjective(projectId, objective.objectiveId), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_events').get().n, 0);
  } finally { db.close(); }
});
