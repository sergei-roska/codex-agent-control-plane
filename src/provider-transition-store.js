'use strict';

const FIELDS = Object.freeze([
  'projectId', 'transitionId', 'runId', 'objectiveId', 'sessionId', 'waitId',
  'sourceAccountHash', 'targetAccountHash', 'ownerGeneration', 'controlRevision', 'phase',
]);
const PHASES = Object.freeze(['intent', 'profile_switched', 'thread_prepared']);
const NEXT_PHASE = Object.freeze({ intent: 'profile_switched', profile_switched: 'thread_prepared' });

class ProviderTransitionStoreError extends Error {
  constructor(code, message = code) { super(message); this.name = 'ProviderTransitionStoreError'; this.code = code; }
}

function fail(code, message) { throw new ProviderTransitionStoreError(code, message); }
function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value); }
function validHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function validCounter(value) { return Number.isSafeInteger(value) && value >= 0; }

function validateTransition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('transition_invalid');
  const keys = Object.keys(input);
  if (keys.length !== FIELDS.length || FIELDS.some((field) => !Object.hasOwn(input, field))
    || keys.some((field) => !FIELDS.includes(field))) fail('transition_invalid');
  for (const field of ['projectId', 'transitionId', 'runId', 'objectiveId', 'sessionId', 'waitId']) {
    if (!validId(input[field])) fail('transition_identity_invalid', `${field} is invalid`);
  }
  if (!validHash(input.sourceAccountHash) || !validHash(input.targetAccountHash)
    || input.sourceAccountHash === input.targetAccountHash) fail('transition_account_hash_invalid');
  if (!validCounter(input.ownerGeneration) || !validCounter(input.controlRevision)) fail('transition_pin_invalid');
  if (!PHASES.includes(input.phase)) fail('transition_phase_invalid');
  return Object.fromEntries(FIELDS.map((field) => [field, input[field]]));
}

function parseRow(row) {
  if (!row) return null;
  let value;
  try { value = JSON.parse(row.record_json); } catch (_) { fail('transition_record_corrupt'); }
  return validateTransition(value);
}

function sameTransition(left, right) {
  return FIELDS.every((field) => left[field] === right[field]);
}

function validatePins(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('transition_pins_invalid');
  const expectedKeys = ['transitionId', 'phase', 'ownerGeneration', 'controlRevision'];
  if (Object.keys(input).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(input, key))) fail('transition_pins_invalid');
  if (!validId(input.transitionId) || !PHASES.includes(input.phase)
    || !validCounter(input.ownerGeneration) || !validCounter(input.controlRevision)) fail('transition_pins_invalid');
  return input;
}

/**
 * Durable single-transition-per-project journal.
 * create(record) returns the stored transition and is idempotent only for an exact match.
 * get(projectId) returns the active record or null.
 * advance(projectId, expectedRecord, nextPhase) returns the advanced record; the exact
 * current record is required so immutable identity fields cannot be changed or omitted.
 * clear(projectId, expectedPins) removes only the exact current transition and returns true.
 * Stale or invalid operations throw ProviderTransitionStoreError with a stable code.
 */
class ProviderTransitionStore {
  constructor(db) {
    if (!db || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new TypeError('A better-sqlite3 database is required');
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_transitions (
        project_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL
      );
    `);
  }

  create(input) {
    const record = validateTransition(input);
    if (record.phase !== 'intent') fail('transition_phase_invalid', 'New transitions must start at intent');
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT record_json FROM provider_transitions WHERE project_id = ?').get(record.projectId);
      if (existing) {
        const prior = parseRow(existing);
        if (!sameTransition(prior, record)) fail('transition_exists');
        return prior;
      }
      this.db.prepare('INSERT INTO provider_transitions(project_id, record_json) VALUES (?, ?)').run(record.projectId, JSON.stringify(record));
      return record;
    });
    return transaction.immediate();
  }

  get(projectId) {
    if (!validId(projectId)) fail('transition_identity_invalid', 'projectId is invalid');
    return parseRow(this.db.prepare('SELECT record_json FROM provider_transitions WHERE project_id = ?').get(projectId));
  }

  advance(projectId, expectedRecord, nextPhase) {
    if (!validId(projectId)) fail('transition_identity_invalid', 'projectId is invalid');
    const expected = validateTransition(expectedRecord);
    if (expected.projectId !== projectId) fail('transition_stale');
    if (NEXT_PHASE[expected.phase] !== nextPhase) fail('transition_phase_invalid', 'Phase advancement must be sequential');
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT record_json FROM provider_transitions WHERE project_id = ?').get(projectId);
      const current = parseRow(row);
      if (!current || !sameTransition(current, expected)) fail('transition_stale');
      const updated = { ...current, phase: nextPhase };
      const result = this.db.prepare(`UPDATE provider_transitions SET record_json = ?
        WHERE project_id = ? AND record_json = ?`).run(JSON.stringify(updated), projectId, row.record_json);
      if (result.changes !== 1) fail('transition_stale');
      return updated;
    });
    return transaction.immediate();
  }

  clear(projectId, expectedPins) {
    if (!validId(projectId)) fail('transition_identity_invalid', 'projectId is invalid');
    const pins = validatePins(expectedPins);
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT record_json FROM provider_transitions WHERE project_id = ?').get(projectId);
      const current = parseRow(row);
      if (!current || current.transitionId !== pins.transitionId || current.phase !== pins.phase
        || current.ownerGeneration !== pins.ownerGeneration || current.controlRevision !== pins.controlRevision) fail('transition_stale');
      const result = this.db.prepare(`DELETE FROM provider_transitions
        WHERE project_id = ? AND record_json = ?`).run(projectId, row.record_json);
      if (result.changes !== 1) fail('transition_stale');
      return true;
    });
    return transaction.immediate();
  }
}

function createProviderTransitionStore(db) { return new ProviderTransitionStore(db); }

module.exports = { ProviderTransitionStore, ProviderTransitionStoreError, createProviderTransitionStore };
