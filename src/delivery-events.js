'use strict';

const crypto = require('node:crypto');
const { validateEvent } = require('./delivery-contracts');

function json(value) { return JSON.stringify(value); }
function parse(value) { return JSON.parse(value); }
function defaultId(prefix) { return `${prefix}-${crypto.randomUUID()}`; }

class DeliveryEvents {
  constructor(db, { now = () => Date.now(), idFactory = defaultId, beforeInsert = null } = {}) {
    if (!db || typeof db.exec !== 'function') throw new TypeError('A better-sqlite3 database is required');
    this.db = db;
    this.now = now;
    this.idFactory = idFactory;
    this.beforeInsert = beforeInsert;
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_events (
        project_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
        event_json TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        PRIMARY KEY(project_id, sequence), UNIQUE(project_id, event_id), UNIQUE(project_id, dedupe_key)
      );
      CREATE TABLE IF NOT EXISTS delivery_event_cursors (
        project_id TEXT NOT NULL, consumer_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY(project_id, consumer_id)
      );
    `);
  }

  append(projectId, event) {
    const run = this.db.transaction(() => this.appendInTransaction(projectId, event));
    return run.immediate();
  }

  appendInTransaction(projectId, event) {
    if (!this.db.inTransaction) { const error = new Error('appendInTransaction requires an active SQLite transaction'); error.code = 'event_transaction_required'; throw error; }
    const existing = this.db.prepare('SELECT event_json FROM delivery_events WHERE project_id = ? AND dedupe_key = ?').get(projectId, event.dedupeKey);
    if (existing) {
      const prior = parse(existing.event_json);
      const retry = validateEvent({ ...event, schemaVersion: 'delivery/v1', projectId, sequence: prior.sequence, eventId: prior.eventId, createdAt: event.createdAt ?? prior.createdAt });
      if (prior.eventType !== retry.eventType || prior.payload === undefined || json(prior.payload) !== json(retry.payload) || (prior.taskId ?? null) !== (retry.taskId ?? null) || (prior.attemptId ?? null) !== (retry.attemptId ?? null) || (prior.candidateId ?? null) !== (retry.candidateId ?? null) || (prior.evidenceRef ?? null) !== (retry.evidenceRef ?? null) || prior.objectRevision !== retry.objectRevision) {
        const error = new Error('Event dedupe key payload conflict'); error.code = 'event_dedupe_conflict'; throw error;
      }
      return prior;
    }
    const nextSequence = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM delivery_events WHERE project_id = ?').get(projectId).n;
    if (event.sequence !== undefined && event.sequence !== nextSequence) { const error = new Error('Event sequence must be the next project sequence'); error.code = 'event_sequence_invalid'; throw error; }
    const input = { ...event, schemaVersion: 'delivery/v1', projectId, sequence: nextSequence };
    if (!input.eventId) input.eventId = this.idFactory('event', JSON.stringify([projectId, nextSequence]));
    if (!Object.hasOwn(input, 'createdAt')) input.createdAt = this.now();
    const valid = validateEvent(input);
    if (this.beforeInsert) this.beforeInsert(valid);
    this.db.prepare('INSERT INTO delivery_events(project_id, sequence, event_id, event_json, dedupe_key) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, valid.sequence, valid.eventId, json(valid), valid.dedupeKey);
    return valid;
  }

  advanceCursor(projectId, consumerId, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Cursor sequence must be a non-negative integer');
    const tx = this.db.transaction(() => {
      const current = this.db.prepare('SELECT sequence FROM delivery_event_cursors WHERE project_id = ? AND consumer_id = ?').get(projectId, consumerId);
      if (current && sequence < current.sequence) { const error = new Error('Event cursor cannot move backwards'); error.code = 'cursor_backwards'; throw error; }
      const max = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM delivery_events WHERE project_id = ?').get(projectId).n;
      if (sequence > max) { const error = new Error('Event cursor cannot skip a future event'); error.code = 'cursor_future'; throw error; }
      this.db.prepare(`INSERT INTO delivery_event_cursors(project_id, consumer_id, sequence) VALUES (?, ?, ?)
        ON CONFLICT(project_id, consumer_id) DO UPDATE SET sequence = excluded.sequence`).run(projectId, consumerId, sequence);
      return sequence;
    });
    return tx.immediate();
  }

  cursor(projectId, consumerId) {
    return this.db.prepare('SELECT sequence FROM delivery_event_cursors WHERE project_id = ? AND consumer_id = ?').get(projectId, consumerId)?.sequence ?? 0;
  }

  replay(projectId, { after = 0, limit = 100, consumerId } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid replay page');
    const cursor = consumerId === undefined ? after : Math.max(after, this.cursor(projectId, consumerId));
    return this.db.prepare('SELECT event_json FROM delivery_events WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(projectId, cursor, limit).map((row) => parse(row.event_json));
  }
}

module.exports = { DeliveryEvents };
