'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openStateDatabase } = require('../src/durable-store');
const { SessionThreads } = require('../src/session-threads');

async function open() {
  const state = await openStateDatabase({ filePath: ':memory:' });
  return { state, store: new SessionThreads({ db: state.db }) };
}

test('requires a database and returns null for an unknown or invalid context', async () => {
  assert.throws(() => new SessionThreads({}), /requires a better-sqlite3 db/);
  const { state, store } = await open();
  assert.equal(store.get('nope'), null);
  assert.equal(store.get(''), null);
  assert.equal(store.get(undefined), null);
  assert.throws(() => store.upsert({ threadId: 't' }), /contextId is required/);
  await state.close();
});

test('upsert creates and then updates one row per context', async () => {
  const { state, store } = await open();
  const first = store.upsert({ contextId: 'c1', threadId: 't1', codexHome: '/a', lastInputTokens: 1200, runId: 'r1' });
  assert.equal(first.threadId, 't1');
  assert.equal(first.codexHome, '/a');
  assert.equal(first.lastInputTokens, 1200);
  assert.equal(first.rollovers, 0);
  assert.deepEqual(first.runIds, ['r1']);
  assert.ok(first.createdAt && first.updatedAt);
  const second = store.upsert({ contextId: 'c1', threadId: 't1', codexHome: '/a', lastInputTokens: 3400, runId: 'r1' });
  assert.equal(second.lastInputTokens, 3400);
  assert.deepEqual(second.runIds, ['r1']);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM session_threads').get().n, 1);
  store.upsert({ contextId: 'c2', threadId: 'x' });
  assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM session_threads').get().n, 2);
  await state.close();
});

test('rolledOver counts rollovers and a new run id is appended once', async () => {
  const { state, store } = await open();
  store.upsert({ contextId: 'c1', threadId: 't1', runId: 'r1' });
  const rolled = store.upsert({ contextId: 'c1', threadId: 't2', codexHome: '/b', lastInputTokens: 10, runId: 'r2', rolledOver: true });
  assert.equal(rolled.threadId, 't2');
  assert.equal(rolled.rollovers, 1);
  assert.deepEqual(rolled.runIds, ['r1', 'r2']);
  const again = store.upsert({ contextId: 'c1', threadId: 't2', runId: 'r2' });
  assert.equal(again.rollovers, 1);
  assert.deepEqual(again.runIds, ['r1', 'r2']);
  await state.close();
});

test('unknown token counts are stored as null and the run list is capped', async () => {
  const { state, store } = await open();
  const row = store.upsert({ contextId: 'c1', threadId: 't1', lastInputTokens: undefined });
  assert.equal(row.lastInputTokens, null);
  assert.equal(row.codexHome, null);
  for (let i = 0; i < 60; i += 1) store.upsert({ contextId: 'c1', threadId: 't1', runId: `r${i}` });
  const capped = store.get('c1');
  assert.equal(capped.runIds.length, 50);
  assert.equal(capped.runIds.at(-1), 'r59');
  await state.close();
});

test('rows survive reopening the store on the same database', async () => {
  const { state, store } = await open();
  store.upsert({ contextId: 'c1', threadId: 't1', lastInputTokens: 5, runId: 'r1' });
  const reopened = new SessionThreads({ db: state.db });
  assert.equal(reopened.get('c1').threadId, 't1');
  await state.close();
});
