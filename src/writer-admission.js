'use strict';

const fs = require('node:fs');
const { takeSnapshot, diffSnapshots } = require('./workspace-snapshot');

const HOLDING = "('active','unresolved')";
const SETTLE_POLL_MS = 50;

function admissionError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, effects: 'none', ...extra });
}

function abortError() {
  return Object.assign(new Error('Writer admission wait aborted'), { name: 'AbortError', code: 'ABORT_ERR', effects: 'none' });
}

function parse(json) {
  return json == null ? null : JSON.parse(json);
}

function toRecord(row) {
  if (!row) return null;
  return {
    executionId: row.execution_id,
    workspace: row.workspace,
    role: row.role,
    taskId: row.task_id,
    contextId: row.context_id,
    state: row.state,
    turnStart: parse(row.turn_start_json),
    snapshotBefore: parse(row.snapshot_before_json),
    snapshotAfter: parse(row.snapshot_after_json),
    delta: parse(row.delta_json),
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Durable workspace-wide writer admission: at most one writable Codex execution
 * may hold a workspace, enforced by a partial unique index. A holder whose outcome
 * is unknown stays `unresolved` until its process group is proven gone.
 */
class WriterAdmission {
  constructor({
    db, workspace, snapshot = takeSnapshot, quiescence, clock = () => new Date(), settleMs = 2000,
  }) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('db (better-sqlite3) is required');
    this.db = db;
    this.workspace = fs.realpathSync(workspace);
    this.snapshot = snapshot;
    this.quiescenceOverride = quiescence;
    this.clock = clock;
    this.settleMs = settleMs;
    this.queue = []; // FIFO tickets of in-process acquirers
    this.reconciling = new Map();
    db.exec(`
      CREATE TABLE IF NOT EXISTS writer_executions (
        execution_id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        role TEXT NOT NULL,
        task_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active','unresolved','released','reconciled')),
        turn_start_json TEXT,
        snapshot_before_json TEXT,
        snapshot_after_json TEXT,
        delta_json TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS writer_executions_holder_idx
        ON writer_executions (workspace) WHERE state IN ('active','unresolved');
      CREATE INDEX IF NOT EXISTS writer_executions_context_idx ON writer_executions (context_id);
      CREATE TABLE IF NOT EXISTS writer_fences (
        context_id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  get quiescence() {
    return this.quiescenceOverride || require('./process-quiescence');
  }

  now() {
    const value = this.clock();
    return value instanceof Date ? value.toISOString() : String(value);
  }

  get(executionId) {
    return toRecord(this.db.prepare('SELECT * FROM writer_executions WHERE execution_id = ?').get(executionId));
  }

  holder() {
    return toRecord(this.db.prepare(
      `SELECT * FROM writer_executions WHERE workspace = ? AND state IN ${HOLDING}`,
    ).get(this.workspace));
  }

  findByContextId(contextId) {
    return toRecord(this.db.prepare(
      'SELECT * FROM writer_executions WHERE workspace = ? AND context_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(this.workspace, contextId));
  }

  // Workspace-independent lookup: only for the never_executed proof, which must see rows stored under any workspace path.
  findAnyByContextId(contextId) {
    return toRecord(this.db.prepare(
      'SELECT * FROM writer_executions WHERE context_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(contextId));
  }

  // `inserted` is true only when this call created the fence.
  fence(contextId, reason) {
    return this.db.transaction(() => {
      const info = this.db.prepare('INSERT OR IGNORE INTO writer_fences (context_id, workspace, reason, created_at) VALUES (?, ?, ?, ?)')
        .run(contextId, this.workspace, reason ?? null, this.now());
      return { execution: this.findByContextId(contextId), inserted: info.changes > 0 };
    })();
  }

  // One transaction: refuse fenced contexts, then admit if nobody holds the workspace.
  // Without a snapshot it only reports whether admission is possible.
  tryAdmit({ executionId, role, taskId, contextId }, snapshotBefore) {
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM writer_fences WHERE context_id = ? AND workspace = ?').get(contextId, this.workspace)) {
        throw admissionError('fenced', `Context "${contextId}" is fenced; its writer will not run.`);
      }
      const holder = this.holder();
      if (holder) return { holder };
      if (!snapshotBefore) return { needSnapshot: true };
      const at = this.now();
      this.db.prepare(`DELETE FROM writer_executions WHERE execution_id = ? AND state NOT IN ${HOLDING}`).run(executionId);
      this.db.prepare(`
        INSERT INTO writer_executions
          (execution_id, workspace, role, task_id, context_id, state, snapshot_before_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(executionId, this.workspace, role, taskId, contextId, JSON.stringify(snapshotBefore), at, at);
      return { admitted: true };
    })();
  }

  wakeHead() {
    this.queue[0]?.wake();
  }

  async acquire({ role, taskId, contextId, signal }) {
    const executionId = `${role}:${taskId}`;
    const ticket = { wake: () => {} };
    this.queue.push(ticket);
    let reconciledHolder = null;
    try {
      for (;;) {
        if (signal?.aborted) throw abortError();
        if (this.queue[0] === ticket) {
          const details = { executionId, role, taskId, contextId };
          let outcome = this.tryAdmit(details, null);
          let snapshotBefore = null;
          if (outcome.needSnapshot) {
            snapshotBefore = this.snapshot(this.workspace);
            outcome = this.tryAdmit(details, snapshotBefore);
          }
          if (outcome.admitted) {
            this.queue.shift();
            return { executionId, snapshotBefore };
          }
          const { holder } = outcome;
          if (holder.state === 'unresolved') {
            if (reconciledHolder === holder.executionId) {
              throw admissionError('admission_blocked', `Workspace writer ${holder.executionId} has an unresolved outcome.`, {
                holder: { executionId: holder.executionId, role: holder.role, taskId: holder.taskId, reason: holder.reason },
              });
            }
            reconciledHolder = holder.executionId;
            await this.reconcile(holder.executionId);
            continue;
          }
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(abortError());
          ticket.wake = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        });
      }
    } catch (error) {
      const index = this.queue.indexOf(ticket);
      if (index >= 0) this.queue.splice(index, 1);
      this.wakeHead();
      throw error;
    }
  }

  recordTurnStart(executionId, { processIdentity = null, threadId = null } = {}) {
    this.db.prepare('UPDATE writer_executions SET turn_start_json = ?, updated_at = ? WHERE execution_id = ?')
      .run(JSON.stringify({ processIdentity, threadId }), this.now(), executionId);
  }

  finish(executionId, state) {
    const row = this.get(executionId);
    if (!row) throw new Error(`Unknown writer execution "${executionId}"`);
    const snapshotAfter = this.snapshot(this.workspace);
    const delta = diffSnapshots(row.snapshotBefore, snapshotAfter, this.workspace);
    this.db.prepare(`
      UPDATE writer_executions SET state = ?, snapshot_after_json = ?, delta_json = ?, updated_at = ?
      WHERE execution_id = ?
    `).run(state, JSON.stringify(snapshotAfter), JSON.stringify(delta), this.now(), executionId);
    this.wakeHead();
    return { state, delta };
  }

  /** Outcome known: the turn ended with a confirmed terminal, or never started. */
  release(executionId) {
    return this.finish(executionId, 'released');
  }

  markUnresolved(executionId, reason) {
    this.db.prepare(`UPDATE writer_executions SET state = 'unresolved', reason = ?, updated_at = ? WHERE execution_id = ? AND state IN ${HOLDING}`)
      .run(reason ?? null, this.now(), executionId);
    this.wakeHead(); // a waiter should see the unresolved holder
  }

  async waitGone(identity) {
    const { isProcessGroupGone } = this.quiescence;
    const deadline = Date.now() + this.settleMs;
    for (;;) {
      if (isProcessGroupGone(identity)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }

  async isQuiescent(record) {
    if (!record.turnStart) return true; // no turn started, so nothing could run
    const identity = record.turnStart.processIdentity;
    if (!identity) return false;
    const { isProcessGroupGone, killOrphanProcessGroup } = this.quiescence;
    if (isProcessGroupGone(identity)) return true;
    killOrphanProcessGroup(identity);
    return this.waitGone(identity);
  }

  /** Members still in the recorded process group, so an operator can act on them. */
  survivorsOf(record) {
    const pgid = record.turnStart?.processIdentity?.pgid;
    const { listGroupMembers } = this.quiescence;
    if (!Number.isInteger(pgid) || typeof listGroupMembers !== 'function') return [];
    try {
      return listGroupMembers(pgid).map(({ pid, comm }) => ({ pid, comm }));
    } catch (_) {
      return [];
    }
  }

  /** Release an unresolved holder only once its process group is proven gone. */
  reconcile(executionId) {
    if (!this.reconciling.has(executionId)) {
      const pending = this.reconcileOnce(executionId).finally(() => this.reconciling.delete(executionId));
      this.reconciling.set(executionId, pending);
    }
    return this.reconciling.get(executionId);
  }

  async reconcileOnce(executionId) {
    const record = this.get(executionId);
    if (!record) throw new Error(`Unknown writer execution "${executionId}"`);
    if (record.state !== 'unresolved') return { state: record.state, delta: record.delta };
    if (!(await this.isQuiescent(record))) {
      return { state: 'unresolved', reason: 'quiescence_unproven', survivors: this.survivorsOf(record) };
    }
    return this.finish(executionId, 'reconciled');
  }

  /** Startup: every `active` row belongs to a dead previous process. */
  async reconcileStale() {
    const rows = this.db.prepare(`SELECT execution_id, state FROM writer_executions WHERE workspace = ? AND state IN ${HOLDING}`)
      .all(this.workspace);
    const summary = { reconciled: [], unresolved: [] };
    for (const row of rows) {
      if (row.state === 'active') this.markUnresolved(row.execution_id, 'server_restart');
      const result = await this.reconcile(row.execution_id);
      (result.state === 'reconciled' ? summary.reconciled : summary.unresolved).push(row.execution_id);
    }
    return summary;
  }
}

module.exports = { WriterAdmission, admissionError };
