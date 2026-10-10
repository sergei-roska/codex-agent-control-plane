'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { createActivityStore } = require('../src/activity-store');

function fixture(options = {}) {
  const db = new Database(':memory:');
  let nowMs = Date.parse('2026-10-10T10:00:00.000Z');
  const timers = [];
  const store = createActivityStore(db, {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    ...options,
  });
  const row = (key = 'task-1') => db.prepare('SELECT * FROM live_activity WHERE key = ?').get(key);
  return {
    db, store, timers, row,
    advance: (ms) => { nowMs += ms; },
    fire: () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); },
  };
}

const started = (item) => ({ method: 'item/started', params: { item } });
const completed = (item) => ({ method: 'item/completed', params: { item } });

test('begin writes a starting row immediately', () => {
  const { store, row } = fixture();
  store.begin({ key: 'task-1', runId: 'run-1', role: 'qa' });
  assert.deepEqual({ ...row() }, {
    key: 'task-1', run_id: 'run-1', role: 'qa', started_at: '2026-10-10T10:00:00.000Z',
    updated_at: '2026-10-10T10:00:00.000Z', ended_at: null, phase: 'starting', summary: '', commands: 0, file_changes: 0,
  });
});

test('maps notifications to phase, summary and counters', () => {
  const { store, row, advance, fire } = fixture();
  const t = store.begin({ key: 'task-1', role: 'qa' });
  const step = (event) => { advance(3000); t.observe(event); fire(); return row(); };

  assert.equal(step({ method: 'turn/started', params: {} }).phase, 'thinking');
  let r = step(started({ type: 'commandExecution', command: 'npm  test\n--all' }));
  assert.equal(r.phase, 'command');
  assert.equal(r.summary, 'npm test --all');
  r = step(completed({ type: 'commandExecution', command: 'npm test', exitCode: 1, durationMs: 2500 }));
  assert.equal(r.phase, 'thinking');
  assert.equal(r.commands, 1);
  assert.equal(r.summary, 'npm test (exit 1, 2.5s)');
  r = step(started({ type: 'fileChange', changes: [{ path: 'a.js' }, { path: 'b.js' }] }));
  assert.equal(r.phase, 'editing');
  assert.equal(r.summary, 'a.js, b.js');
  r = step(completed({ type: 'fileChange', changes: [] }));
  assert.equal(r.file_changes, 1);
  assert.equal(r.phase, 'thinking');
  r = step(started({ type: 'mcpToolCall', server: 's', tool: 'search' }));
  assert.deepEqual([r.phase, r.summary], ['tool', 'search']);
  r = step(started({ type: 'dynamicToolCall', tool: 'lookup', arguments: {} }));
  assert.deepEqual([r.phase, r.summary], ['tool', 'lookup']);
  r = step(started({ type: 'reasoning', summary: [], content: [] }));
  assert.deepEqual([r.phase, r.summary], ['thinking', '']);
  r = step(started({ type: 'agentMessage', text: '' }));
  assert.equal(r.phase, 'reporting');
  r = step(started({ type: 'webSearch' }));
  assert.deepEqual([r.phase, r.summary], ['tool', 'webSearch']);
  assert.equal(r.updated_at, '2026-10-10T10:00:30.000Z');
});

test('code mode exec shows as a command with the cmd string', () => {
  const { store, row } = fixture();
  const t = store.begin({ key: 'task-1', role: 'qa' });
  const input = 'const r = await Promise.allSettled([\n  tools.exec_command({cmd:"cat src/a \\"x\\".js",workdir:"/w"}),\n]);';
  for (const item of [
    { type: 'customToolCall', name: 'exec', input },
    { type: 'dynamicToolCall', tool: 'exec', arguments: input },
    { type: 'somethingNew', tool: 'exec', arguments: { source: input } },
  ]) {
    t.observe(started(item));
    store._write(store.tracked.get('task-1'));
    assert.equal(row().phase, 'command');
    assert.equal(row().summary, 'cat src/a "x".js');
  }
});

test('array commands use the shell script or are joined', () => {
  const { store, row, advance, fire } = fixture();
  const t = store.begin({ key: 'task-1', role: 'qa' });
  advance(5000);
  t.observe(started({ type: 'commandExecution', command: ['/bin/bash', '-lc', 'pwd && ls'] }));
  fire();
  assert.equal(row().summary, 'pwd && ls');
  advance(5000);
  t.observe(started({ type: 'commandExecution', command: ['git', 'status', '-s'] }));
  fire();
  assert.equal(row().summary, 'git status -s');
});

test('unknown shapes degrade without throwing', () => {
  const { store, row } = fixture();
  const t = store.begin({ key: 'task-1', role: 'qa' });
  for (const event of [null, undefined, 5, {}, { method: 'item/started' }, { method: 'item/started', params: { item: {} } },
    { method: 'item/completed', params: { item: { type: 'commandExecution' } } }, { method: 'x', params: 7 }]) {
    assert.doesNotThrow(() => t.observe(event));
  }
  assert.equal(row().role, 'qa');
});

test('summary is one line and at most 200 chars', () => {
  const { store, row, advance, fire } = fixture();
  const t = store.begin({ key: 'task-1', role: 'qa' });
  advance(5000);
  t.observe(started({ type: 'commandExecution', command: `echo ${'x'.repeat(500)}` }));
  fire();
  assert.equal(row().summary.length, 200);
  assert.ok(row().summary.endsWith('...'));
});

test('writes are throttled and the trailing write lands', () => {
  const { store, row, timers, advance, fire, db } = fixture();
  const t = store.begin({ key: 'task-1', role: 'qa' });
  let writes = 0;
  const run = store.upsert.run.bind(store.upsert);
  store.upsert = { run: (args) => { writes += 1; return run(args); } };
  for (let i = 0; i < 50; i += 1) {
    advance(10);
    t.observe(started({ type: 'commandExecution', command: `cmd ${i}` }));
  }
  assert.equal(writes, 0, 'within 2 s of begin nothing is written');
  assert.equal(timers.filter((x) => !x.cleared).length, 1, 'one trailing timer');
  assert.ok(timers[0].ms > 0 && timers[0].ms <= 2000);
  advance(2000);
  fire();
  assert.equal(writes, 1);
  assert.equal(row().summary, 'cmd 49');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM live_activity').get().n, 1);
  // After the interval, the next event writes immediately.
  advance(2500);
  t.observe(started({ type: 'reasoning' }));
  assert.equal(writes, 2);
});

test('end writes done immediately and clears the timer', () => {
  const { store, row, timers, advance } = fixture();
  const t = store.begin({ key: 'task-1', role: 'qa' });
  advance(100);
  t.observe(started({ type: 'commandExecution', command: 'ls' }));
  assert.equal(timers.filter((x) => !x.cleared).length, 1);
  advance(100);
  t.end('completed');
  assert.equal(timers.filter((x) => !x.cleared).length, 0);
  assert.equal(row().phase, 'done');
  assert.equal(row().ended_at, '2026-10-10T10:00:00.200Z');
  t.observe(started({ type: 'reasoning' }));
  assert.equal(row().phase, 'done', 'events after end are ignored');
});

test('a reused key resets the turn', () => {
  const { store, row, advance } = fixture();
  const first = store.begin({ key: 'lead:r1', runId: 'r1', role: 'coordinator' });
  advance(5000);
  first.observe(completed({ type: 'commandExecution', command: 'ls', exitCode: 0 }));
  first.end('completed');
  assert.equal(row('lead:r1').commands, 1);
  advance(5000);
  const second = store.begin({ key: 'lead:r1', runId: 'r1', role: 'coordinator' });
  assert.deepEqual([row('lead:r1').phase, row('lead:r1').commands, row('lead:r1').ended_at, row('lead:r1').started_at],
    ['starting', 0, null, '2026-10-10T10:00:10.000Z']);
  first.end('late'); // superseded turn cannot touch the new row
  assert.equal(row('lead:r1').phase, 'starting');
  second.end('completed');
  assert.equal(row('lead:r1').phase, 'done');
});

test('a database error never propagates', () => {
  const { store, db, advance } = fixture();
  const t = store.begin({ key: 'task-1', role: 'qa' });
  db.exec('DROP TABLE live_activity');
  advance(5000);
  assert.doesNotThrow(() => t.observe(started({ type: 'commandExecution', command: 'ls' })));
  assert.doesNotThrow(() => t.end('failed'));
  assert.doesNotThrow(() => store.begin({ key: 'task-2', role: 'qa' }));
  assert.doesNotThrow(() => store.begin({}).observe({}));
});
