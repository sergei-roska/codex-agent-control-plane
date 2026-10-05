'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { WriterAdmission } = require('../src/writer-admission');

const IDENTITY = { pid: 4242, pgid: 4242, startTime: '100' };
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeQuiescence({ gone = false, killable = false } = {}) {
  const q = {
    gone,
    kills: 0,
    isProcessGroupGone: () => q.gone,
    killOrphanProcessGroup: () => { q.kills += 1; if (killable) q.gone = true; return true; },
  };
  return q;
}

let counter = 0;
function fakeSnapshot() {
  // Every call sees a new state, so a delta between two snapshots is known and non-empty.
  counter += 1;
  return { kind: 'git', head: 'h', entries: [{ path: `f${counter}`, status: ' M', sha256: String(counter) }], fingerprint: String(counter) };
}

function make(options = {}) {
  const db = options.db || new Database(':memory:');
  const quiescence = options.quiescence || fakeQuiescence();
  const admission = new WriterAdmission({
    db, workspace: options.workspace || os.tmpdir(), snapshot: fakeSnapshot, quiescence, settleMs: 0,
  });
  return { db, quiescence, admission };
}

const req = (n, extra = {}) => ({ role: 'orch-w', taskId: `t${n}`, contextId: `c${n}`, ...extra });

test('a second writer waits FIFO until the holder releases', async () => {
  const { admission } = make();
  const first = await admission.acquire(req(1));
  const order = [];
  const second = admission.acquire(req(2)).then((r) => { order.push('second'); return r; });
  const third = admission.acquire(req(3)).then((r) => { order.push('third'); return r; });
  await tick();
  assert.deepEqual(order, []);
  assert.equal(admission.holder().executionId, first.executionId);
  const released = admission.release(first.executionId);
  assert.equal(released.state, 'released');
  assert.equal(released.delta.known, true);
  await second;
  await tick();
  assert.deepEqual(order, ['second']);
  admission.release('orch-w:t2');
  await third;
  assert.deepEqual(order, ['second', 'third']);
});

test('abort while waiting rejects with AbortError, leaves no row and does not block others', async () => {
  const { admission, db } = make();
  const first = await admission.acquire(req(1));
  const controller = new AbortController();
  const waiting = admission.acquire(req(2, { signal: controller.signal }));
  const behind = admission.acquire(req(3));
  await tick();
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError' && error.effects === 'none');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM writer_executions WHERE task_id = ?').get('t2').n, 0);
  admission.release(first.executionId);
  await behind;
  assert.equal(admission.holder().taskId, 't3');
});

test('unknown outcome keeps the workspace held; admission_blocked until quiescence is proven', async () => {
  const { admission, quiescence } = make();
  const a = await admission.acquire(req(1));
  admission.recordTurnStart(a.executionId, { processIdentity: IDENTITY, threadId: 'thr' });
  admission.markUnresolved(a.executionId, 'outcome_unknown');
  assert.deepEqual(await admission.reconcile(a.executionId), { state: 'unresolved', reason: 'quiescence_unproven', survivors: [] });
  assert.equal(quiescence.kills, 1);

  await assert.rejects(admission.acquire(req(2)), (error) => (
    error.code === 'admission_blocked' && error.effects === 'none'
    && error.holder.executionId === a.executionId && error.holder.reason === 'outcome_unknown'));

  quiescence.gone = true;
  const b = await admission.acquire(req(3));
  assert.equal(b.executionId, 'orch-w:t3');
  const reconciled = admission.get(a.executionId);
  assert.equal(reconciled.state, 'reconciled');
  assert.equal(reconciled.delta.known, true);
  assert.ok(reconciled.snapshotAfter);
});

test('reconcile kills an orphan group and accepts it once it is gone; no recorded turn is quiescent', async () => {
  const { admission, quiescence } = make({ quiescence: fakeQuiescence({ killable: true }) });
  const a = await admission.acquire(req(1));
  admission.recordTurnStart(a.executionId, { processIdentity: IDENTITY, threadId: 'thr' });
  admission.markUnresolved(a.executionId, 'timeout');
  const result = await admission.reconcile(a.executionId);
  assert.equal(result.state, 'reconciled');
  assert.equal(quiescence.kills, 1);

  const b = await admission.acquire(req(2));
  admission.markUnresolved(b.executionId, 'never_started');
  assert.equal((await admission.reconcile(b.executionId)).state, 'reconciled');
  assert.equal(quiescence.kills, 1);
});

test('a restart reconciles leftover active rows and the holder survives while unproven', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-'));
  const file = path.join(dir, 'state.sqlite');
  try {
    let db = new Database(file);
    const first = make({ db, workspace: dir });
    const a = await first.admission.acquire(req(1));
    first.admission.recordTurnStart(a.executionId, { processIdentity: IDENTITY, threadId: 'thr' });
    db.close();

    db = new Database(file);
    const alive = make({ db, workspace: dir, quiescence: fakeQuiescence({ gone: false }) });
    assert.deepEqual(await alive.admission.reconcileStale(), { reconciled: [], unresolved: [a.executionId] });
    assert.equal(alive.admission.holder().state, 'unresolved');
    assert.equal(alive.admission.holder().reason, 'server_restart');
    db.close();

    db = new Database(file);
    const gone = make({ db, workspace: dir, quiescence: fakeQuiescence({ gone: true }) });
    assert.equal(gone.admission.holder().state, 'unresolved');
    assert.deepEqual(await gone.admission.reconcileStale(), { reconciled: [a.executionId], unresolved: [] });
    assert.equal(gone.admission.holder(), null);
    assert.equal(gone.admission.get(a.executionId).state, 'reconciled');
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fenced context is refused with code fenced, and fence returns the existing execution', async () => {
  const { admission } = make();
  assert.deepEqual(admission.fence('c-never', 'gave up'), { execution: null, inserted: true });
  assert.equal(admission.fence('c-never', 'again').inserted, false);
  await assert.rejects(admission.acquire(req(9, { contextId: 'c-never' })), (error) => error.code === 'fenced' && error.effects === 'none');
  assert.equal(admission.holder(), null);

  const a = await admission.acquire(req(1));
  const fenced = admission.fence('c1', 'late fence');
  assert.equal(fenced.execution.executionId, a.executionId);
  assert.equal(fenced.execution.state, 'active');
  assert.equal(admission.fence('c1', 'again').execution.executionId, a.executionId);
  assert.equal(admission.findByContextId('c1').taskId, 't1');
});

test('storage allows at most one holder per workspace', async () => {
  const { admission, db } = make();
  await admission.acquire(req(1));
  assert.throws(() => db.prepare(`
    INSERT INTO writer_executions (execution_id, workspace, role, task_id, context_id, state, created_at, updated_at)
    VALUES ('x', ?, 'r', 't', 'c', 'active', 'now', 'now')`).run(admission.workspace), /UNIQUE/);
});

test('a turn start with a null process identity keeps quiescence unproven', async () => {
  const { admission } = make({ quiescence: fakeQuiescence({ gone: true }) });
  const a = await admission.acquire(req(1));
  admission.recordTurnStart(a.executionId, { processIdentity: null, threadId: null });
  admission.markUnresolved(a.executionId, 'server_restart');
  assert.deepEqual(await admission.reconcile(a.executionId), { state: 'unresolved', reason: 'quiescence_unproven', survivors: [] });
});

test('unresolved reconcile lists surviving group members', async () => {
  const quiescence = fakeQuiescence();
  quiescence.listGroupMembers = (pgid) => (pgid === IDENTITY.pgid ? [{ pid: 4300, ppid: 1, comm: 'sleep', startTime: '9' }] : []);
  const { admission } = make({ quiescence });
  const a = await admission.acquire(req(1));
  admission.recordTurnStart(a.executionId, { processIdentity: IDENTITY, threadId: 'thr' });
  admission.markUnresolved(a.executionId, 'outcome_unknown');
  assert.deepEqual(await admission.reconcile(a.executionId), {
    state: 'unresolved', reason: 'quiescence_unproven', survivors: [{ pid: 4300, comm: 'sleep' }],
  });
});

test('findAnyByContextId sees rows stored under another workspace; findByContextId does not', async () => {
  const db = new Database(':memory:');
  const other = make({ db, workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'other-ws-')) }).admission;
  const mine = make({ db, workspace: os.tmpdir() }).admission;
  const held = await other.acquire(req(1));
  assert.equal(mine.findByContextId('c1'), null);
  assert.equal(mine.findAnyByContextId('c1').executionId, held.executionId);
  assert.equal(mine.findAnyByContextId('missing'), null);
});
