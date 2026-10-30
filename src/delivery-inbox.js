'use strict';

const { createHash } = require('node:crypto');

const MAX_MESSAGE_BYTES = 16384;
const MAX_PENDING = 256;
const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);
const copy = (value) => JSON.parse(JSON.stringify(value));
const error = (code) => Object.assign(new Error(code), { code });

function validId(value, field) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value)) throw error(`invalid_${field}`);
}

class DeliveryInbox {
  constructor(db, { projectId, sessionId, objectiveId, now = () => Date.now(), maxPending = MAX_PENDING, authenticateOwner } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('A better-sqlite3 database is required');
    for (const [field, value] of Object.entries({ projectId, sessionId, objectiveId })) validId(value, field);
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > MAX_PENDING) throw new TypeError('maxPending must be between 1 and 256');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (authenticateOwner !== undefined && typeof authenticateOwner !== 'function') throw new TypeError('authenticateOwner must be a function');
    this.db = db;
    this.projectId = projectId;
    this.sessionId = sessionId;
    this.objectiveId = objectiveId;
    this.now = now;
    this.maxPending = maxPending;
    this.authenticateOwner = authenticateOwner || (() => false);
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_inbox_state (
        project_id TEXT NOT NULL, session_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0,
        trigger_json TEXT NOT NULL DEFAULT '[]', wakeup INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(project_id, session_id, objective_id)
      );
      CREATE TABLE IF NOT EXISTS delivery_inbox_messages (
        project_id TEXT NOT NULL, session_id TEXT NOT NULL, objective_id TEXT NOT NULL,
        message_id TEXT NOT NULL, message_json TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL, received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        result_json TEXT, PRIMARY KEY(project_id, session_id, objective_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS delivery_inbox_pending_idx
        ON delivery_inbox_messages(project_id, session_id, objective_id, state, received_at);
    `);
    db.prepare(`INSERT OR IGNORE INTO delivery_inbox_state(project_id,session_id,objective_id)
      VALUES(?,?,?)`).run(projectId, sessionId, objectiveId);
  }

  receive({ messageId, kind, payload, source } = {}) {
    validId(messageId, 'message_id');
    if (!['steering', 'owner_correction'].includes(kind)) throw error('invalid_message_kind');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw error('invalid_message_payload');
    const authenticatedOwner = kind === 'owner_correction' ? this.authenticateOwner({ projectId: this.projectId, sessionId: this.sessionId, objectiveId: this.objectiveId, messageId, source }) : false;
    if (kind === 'owner_correction' && authenticatedOwner !== true) throw error('owner_authentication_required');
    const message = { messageId, kind, payload: copy(payload), authenticatedOwner: kind === 'owner_correction' };
    const serialized = json(message);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MESSAGE_BYTES) throw error('message_too_large');
    const digest = createHash('sha256').update(serialized).digest('hex');
    const tx = this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT message_json,digest,state FROM delivery_inbox_messages
        WHERE project_id=? AND session_id=? AND objective_id=? AND message_id=?`)
        .get(this.projectId, this.sessionId, this.objectiveId, messageId);
      if (prior) {
        if (prior.digest !== digest) throw error('message_id_conflict');
        return { ...parse(prior.message_json), state: prior.state, duplicate: true, acknowledged: true };
      }
      const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM delivery_inbox_messages
        WHERE project_id=? AND session_id=? AND objective_id=? AND state='received'`)
        .get(this.projectId, this.sessionId, this.objectiveId).n;
      if (pending >= this.maxPending) throw error('inbox_full');
      const now = this.now();
      this.db.prepare(`INSERT INTO delivery_inbox_messages
        (project_id,session_id,objective_id,message_id,message_json,digest,state,received_at,updated_at)
        VALUES(?,?,?,?,?,?,'received',?,?)`).run(this.projectId, this.sessionId, this.objectiveId, messageId, serialized, digest, now, now);
      const state = this.#state();
      const reasons = [...new Set([...parse(state.trigger_json), `message:${kind}`])].slice(-16);
      this.db.prepare(`UPDATE delivery_inbox_state SET version=version+1,cursor=cursor+1,
        trigger_json=?,wakeup=1 WHERE project_id=? AND session_id=? AND objective_id=?`)
        .run(json(reasons), this.projectId, this.sessionId, this.objectiveId);
      return { ...message, state: 'received', duplicate: false, acknowledged: true, receivedAt: now };
    });
    return tx.immediate();
  }

  pending({ limit = MAX_PENDING } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING) throw new TypeError('Invalid inbox limit');
    return this.db.prepare(`SELECT message_json,state,received_at,updated_at,result_json FROM delivery_inbox_messages
      WHERE project_id=? AND session_id=? AND objective_id=? AND state='received'
      ORDER BY received_at,message_id LIMIT ?`).all(this.projectId, this.sessionId, this.objectiveId, limit)
      .map((row) => ({ ...parse(row.message_json), state: row.state, receivedAt: row.received_at, updatedAt: row.updated_at, result: row.result_json ? parse(row.result_json) : null }));
  }

  messages({ limit = MAX_PENDING } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING) throw new TypeError('Invalid inbox limit');
    return this.db.prepare(`SELECT message_json,state,received_at,updated_at,result_json FROM delivery_inbox_messages
      WHERE project_id=? AND session_id=? AND objective_id=? ORDER BY received_at DESC,message_id LIMIT ?`)
      .all(this.projectId, this.sessionId, this.objectiveId, limit)
      .map((row) => ({ ...parse(row.message_json), state: row.state, receivedAt: row.received_at, updatedAt: row.updated_at, result: row.result_json ? parse(row.result_json) : null }));
  }

  get(messageId) {
    validId(messageId, 'message_id');
    const row = this.db.prepare(`SELECT message_json,state,received_at,updated_at,result_json FROM delivery_inbox_messages
      WHERE project_id=? AND session_id=? AND objective_id=? AND message_id=?`)
      .get(this.projectId, this.sessionId, this.objectiveId, messageId);
    return row ? { ...parse(row.message_json), state: row.state, receivedAt: row.received_at, updatedAt: row.updated_at, result: row.result_json ? parse(row.result_json) : null } : null;
  }

  isAuthenticatedOwnerMessage(messageId) {
    const message = this.get(messageId);
    return message?.kind === 'owner_correction' && message.authenticatedOwner === true;
  }

  hasBlockingOwnerCorrection() {
    return this.db.prepare(`SELECT 1 AS found FROM delivery_inbox_messages
      WHERE project_id=? AND session_id=? AND objective_id=? AND state IN ('received','blocked')
        AND json_extract(message_json,'$.kind')='owner_correction'
        AND json_extract(message_json,'$.authenticatedOwner')=1 LIMIT 1`)
      .get(this.projectId, this.sessionId, this.objectiveId) !== undefined;
  }

  markApplied(messageId, expectedState = 'received', result) { return this.#finish(messageId, expectedState, 'applied', result); }
  markBlocked(messageId, expectedState = 'received', result) { return this.#finish(messageId, expectedState, 'blocked', result); }

  signal(reason) {
    if (typeof reason !== 'string' || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(reason)) throw error('invalid_trigger_reason');
    const tx = this.db.transaction(() => {
      const state = this.#state();
      const reasons = [...new Set([...parse(state.trigger_json), reason])].slice(-16);
      this.db.prepare(`UPDATE delivery_inbox_state SET version=version+1,cursor=cursor+1,trigger_json=?,wakeup=1
        WHERE project_id=? AND session_id=? AND objective_id=?`)
        .run(json(reasons), this.projectId, this.sessionId, this.objectiveId);
      return this.projection();
    });
    return tx.immediate();
  }

  consumeTriggers(expectedVersion) {
    const tx = this.db.transaction(() => {
      const state = this.#state();
      if (state.version !== expectedVersion) throw error('inbox_version_stale');
      const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM delivery_inbox_messages
        WHERE project_id=? AND session_id=? AND objective_id=? AND state='received'`)
        .get(this.projectId, this.sessionId, this.objectiveId).n;
      this.db.prepare(`UPDATE delivery_inbox_state SET version=version+1,trigger_json=?,wakeup=?
        WHERE project_id=? AND session_id=? AND objective_id=?`)
        .run(json(pending ? ['message:steering'] : []), pending ? 1 : 0, this.projectId, this.sessionId, this.objectiveId);
      return this.projection();
    });
    return tx.immediate();
  }

  completeTurn(expectedVersion, messageIds = []) {
    if (!Array.isArray(messageIds) || messageIds.length > MAX_PENDING || messageIds.some((id) => typeof id !== 'string')) throw error('invalid_turn_messages');
    const tx = this.db.transaction(() => {
      const state = this.#state();
      if (state.version !== expectedVersion) throw error('inbox_version_stale');
      const now = this.now();
      const mark = this.db.prepare(`UPDATE delivery_inbox_messages SET state='applied',updated_at=?,result_json=?
        WHERE project_id=? AND session_id=? AND objective_id=? AND message_id=? AND state='received'
          AND json_extract(message_json,'$.kind')='steering'`);
      for (const messageId of messageIds) mark.run(now, json({ turnApplied: true }), this.projectId, this.sessionId, this.objectiveId, messageId);
      const pending = this.db.prepare(`SELECT COUNT(*) AS n FROM delivery_inbox_messages
        WHERE project_id=? AND session_id=? AND objective_id=? AND state='received'`)
        .get(this.projectId, this.sessionId, this.objectiveId).n;
      const reasons = pending ? ['message:pending'] : [];
      this.db.prepare(`UPDATE delivery_inbox_state SET version=version+1,trigger_json=?,wakeup=?
        WHERE project_id=? AND session_id=? AND objective_id=?`)
        .run(json(reasons), pending ? 1 : 0, this.projectId, this.sessionId, this.objectiveId);
      return { ...this.projection(), appliedMessageIds: messageIds.filter((messageId) => this.get(messageId)?.state === 'applied') };
    });
    return tx.immediate();
  }

  #finish(messageId, expectedState, nextState, result) {
    validId(messageId, 'message_id');
    if (!['received', 'applied', 'blocked'].includes(expectedState)) throw error('invalid_expected_state');
    const encoded = result === undefined ? null : json(copy(result));
    if (encoded && Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES) throw error('result_too_large');
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT state FROM delivery_inbox_messages WHERE project_id=? AND session_id=? AND objective_id=? AND message_id=?`)
        .get(this.projectId, this.sessionId, this.objectiveId, messageId);
      if (!row) throw error('message_missing');
      if (row.state === nextState) return this.get(messageId);
      if (row.state !== expectedState) throw error('message_state_stale');
      const now = this.now();
      this.db.prepare(`UPDATE delivery_inbox_messages SET state=?,updated_at=?,result_json=? WHERE project_id=? AND session_id=? AND objective_id=? AND message_id=? AND state=?`)
        .run(nextState, now, encoded, this.projectId, this.sessionId, this.objectiveId, messageId, expectedState);
      const remaining = this.db.prepare(`SELECT COUNT(*) AS n FROM delivery_inbox_messages WHERE project_id=? AND session_id=? AND objective_id=? AND state='received'`)
        .get(this.projectId, this.sessionId, this.objectiveId).n;
      const state = this.#state();
      const reasons = parse(state.trigger_json).filter((reason) => !reason.startsWith('message:'));
      if (remaining) reasons.push('message:pending');
      this.db.prepare(`UPDATE delivery_inbox_state SET version=version+1,trigger_json=?,wakeup=?
        WHERE project_id=? AND session_id=? AND objective_id=?`)
        .run(json(reasons), remaining ? 1 : 0, this.projectId, this.sessionId, this.objectiveId);
      return this.get(messageId);
    });
    return tx.immediate();
  }

  projection() {
    const state = this.#state();
    return { projectId: this.projectId, sessionId: this.sessionId, objectiveId: this.objectiveId,
      version: state.version, cursor: state.cursor, triggerReasons: parse(state.trigger_json), wakeup: state.wakeup === 1,
      received: this.db.prepare(`SELECT COUNT(*) AS n FROM delivery_inbox_messages WHERE project_id=? AND session_id=? AND objective_id=? AND state='received'`).get(this.projectId, this.sessionId, this.objectiveId).n,
      applied: this.db.prepare(`SELECT COUNT(*) AS n FROM delivery_inbox_messages WHERE project_id=? AND session_id=? AND objective_id=? AND state='applied'`).get(this.projectId, this.sessionId, this.objectiveId).n,
      blocked: this.db.prepare(`SELECT COUNT(*) AS n FROM delivery_inbox_messages WHERE project_id=? AND session_id=? AND objective_id=? AND state='blocked'`).get(this.projectId, this.sessionId, this.objectiveId).n };
  }

  #state() { return this.db.prepare(`SELECT * FROM delivery_inbox_state WHERE project_id=? AND session_id=? AND objective_id=?`)
    .get(this.projectId, this.sessionId, this.objectiveId); }
}

module.exports = { DeliveryInbox, MAX_MESSAGE_BYTES, MAX_PENDING };
