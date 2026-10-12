'use strict';

const TABLE = 'staging_events';
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_TEXT = 4096;
const MAX_DEPTH = 8;
const MAX_ITEMS = 100;
const SECRET_KEY = /(?:password|passwd|secret|credential|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|(?:^|[_-])token(?:$|[_-]))/i;
const RAW_KEY = /^(?:raw|source|stdout|stderr|tool[_-]?output|source[_-]?code|.*environment.*|.*prompt.*)$/i;

function hasStagingTable(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE));
}

function createStagingTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      run_id TEXT,
      assignment_id TEXT,
      attempt_id TEXT,
      role TEXT,
      problem_id TEXT,
      decision_id TEXT,
      target TEXT,
      status TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS staging_events_run_idx ON ${TABLE} (run_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS staging_events_problem_idx ON ${TABLE} (problem_id, created_at, event_id);
    CREATE INDEX IF NOT EXISTS staging_events_type_idx ON ${TABLE} (type, created_at, event_id);
    CREATE TRIGGER IF NOT EXISTS staging_events_no_update
      BEFORE UPDATE ON ${TABLE} BEGIN SELECT RAISE(ABORT, 'staging_events is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS staging_events_no_delete
      BEFORE DELETE ON ${TABLE} BEGIN SELECT RAISE(ABORT, 'staging_events is append-only'); END;
  `);
}

function safeText(value, field, { required = false, max = 512 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.length > max || (required && value.trim() === '')) {
    throw new TypeError(`${field} must be a string of at most ${max} characters${required ? ' and cannot be empty' : ''}`);
  }
  return value;
}

function safeIdentity(value, field, max = 512) {
  const normalized = safeText(value, field, { max });
  if (!isSafeIdentity(normalized, max)) {
    throw new TypeError(`${field} cannot contain credential-like text`);
  }
  return normalized;
}

function isSafeIdentity(value, max = 512) {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.length <= max && redactString(value) === value;
}

function redactString(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g, '$1[REDACTED]@')
    .replace(/\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|auth|token|signature|sig)[A-Za-z0-9_.-]*)\s*([=:])\s*([^\s,;?&#]+)/gi, '$1$2[REDACTED]');
}

function isForbiddenPayloadKey(key) {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return RAW_KEY.test(key) || compact.startsWith('env') || compact.endsWith('env');
}

function normalizePayload(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new TypeError(`payload nesting exceeds ${MAX_DEPTH}`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('payload numbers must be finite');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_TEXT) throw new TypeError(`payload strings are limited to ${MAX_TEXT} characters`);
    return redactString(value);
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new TypeError(`payload arrays are limited to ${MAX_ITEMS} items`);
    return value.map((item) => normalizePayload(item, depth + 1));
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('payload must contain only plain structured JSON values');
  }
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length > MAX_ITEMS) throw new TypeError(`payload objects are limited to ${MAX_ITEMS} fields`);
  const out = Object.create(null);
  for (const [key, child] of entries) {
    if (key.length > 128) throw new TypeError('payload field names are limited to 128 characters');
    if (isForbiddenPayloadKey(key)) {
      throw new TypeError(`payload field "${key}" cannot contain raw source, tool output, environment, or prompt data`);
    }
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : normalizePayload(child, depth + 1);
  }
  return out;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('event must be an object');
  const type = safeText(input.type, 'type', { required: true, max: 64 });
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(type)) throw new TypeError('type must be a bounded safe token');
  const eventId = safeText(input.eventId, 'eventId', { required: true });
  const normalized = {
    eventId: safeIdentity(eventId, 'eventId'),
    type,
    runId: safeIdentity(input.runId, 'runId'),
    assignmentId: safeIdentity(input.assignmentId, 'assignmentId'),
    attemptId: safeIdentity(input.attemptId, 'attemptId'),
    role: redactedText(input.role, 'role', 128),
    problemId: safeIdentity(input.problemId, 'problemId'),
    decisionId: safeIdentity(input.decisionId, 'decisionId'),
    target: redactedText(input.target, 'target', 2048),
    status: redactedText(input.status, 'status', 128),
    payload: normalizePayload(input.payload === undefined ? {} : input.payload),
  };
  if (!normalized.payload || typeof normalized.payload !== 'object' || Array.isArray(normalized.payload)) {
    throw new TypeError('payload must be a JSON object');
  }
  const payloadJson = JSON.stringify(normalized.payload);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) throw new TypeError(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  return { ...normalized, payloadJson };
}

function redactedText(value, field, max) {
  const normalized = safeText(value, field, { max });
  return normalized === null ? null : redactString(normalized);
}

function normalizedContent(event) {
  const { payloadJson, createdAt, ...content } = event;
  return JSON.stringify({ ...content, payload: JSON.parse(payloadJson) });
}

function immutable(event) {
  return deepFreeze({ ...event, payload: event.payload });
}

function publicEvent(event, createdAt) {
  const { payloadJson, ...fields } = event;
  return immutable({ ...fields, payload: JSON.parse(payloadJson), createdAt });
}

function fromRow(row) {
  return immutable({
    eventId: row.event_id,
    type: row.type,
    runId: row.run_id,
    assignmentId: row.assignment_id,
    attemptId: row.attempt_id,
    role: row.role,
    problemId: row.problem_id,
    decisionId: row.decision_id,
    target: row.target,
    status: row.status,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  });
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new TypeError('limit must be an integer from 1 to 10000');
  return limit;
}

function filterSql(filters = {}) {
  const clauses = [];
  const params = [];
  for (const [field, column] of [['runId', 'run_id'], ['problemId', 'problem_id'], ['type', 'type']]) {
    if (filters[field] !== undefined) {
      const value = field === 'type'
        ? safeText(filters[field], field, { required: true, max: 64 })
        : safeIdentity(filters[field], field);
      if (field === 'type' && !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value)) {
        throw new TypeError('type must be a bounded safe token');
      }
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function unavailableError() {
  const error = new Error('Staging event log is unavailable: staging_events table is missing');
  error.code = 'STAGING_LOG_UNAVAILABLE';
  return error;
}

class StagingLog {
  constructor({ db, readonly = false } = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('StagingLog requires a better-sqlite3 db');
    this.db = db;
    this.readonly = readonly;
    if (!readonly) createStagingTable(db);
  }

  record(input) {
    if (this.readonly) throw new Error('StagingLog is read-only');
    const event = normalize(input);
    const content = normalizedContent(event);
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM ${TABLE} WHERE event_id = ?`).get(event.eventId);
      if (existing) {
        const stored = fromRow(existing);
        if (normalizedContent({ ...stored, payloadJson: JSON.stringify(stored.payload) }) !== content) {
          throw new Error(`eventId "${event.eventId}" already exists with different content`);
        }
        return stored;
      }
      const createdAt = new Date().toISOString();
      this.db.prepare(`INSERT INTO ${TABLE}
        (event_id, type, run_id, assignment_id, attempt_id, role, problem_id, decision_id, target, status, payload_json, created_at)
        VALUES (@event_id, @type, @run_id, @assignment_id, @attempt_id, @role, @problem_id, @decision_id, @target, @status, @payload_json, @created_at)`)
        .run({
          event_id: event.eventId, type: event.type, run_id: event.runId, assignment_id: event.assignmentId,
          attempt_id: event.attemptId, role: event.role, problem_id: event.problemId, decision_id: event.decisionId,
          target: event.target, status: event.status, payload_json: event.payloadJson, created_at: createdAt,
        });
      return publicEvent(event, createdAt);
    });
    return tx();
  }

  list({ runId, problemId, type, limit = 1000 } = {}) {
    validateLimit(limit);
    if (!hasStagingTable(this.db)) throw unavailableError();
    const { where, params } = filterSql({ runId, problemId, type });
    const rows = this.db.prepare(`SELECT * FROM ${TABLE} ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit).reverse();
    return Object.freeze(rows.map(fromRow));
  }

  count({ runId, problemId, type } = {}) {
    if (!hasStagingTable(this.db)) throw unavailableError();
    const { where, params } = filterSql({ runId, problemId, type });
    return this.db.prepare(`SELECT COUNT(*) AS count FROM ${TABLE} ${where}`).get(...params).count;
  }
}

class InMemoryStagingLog {
  constructor() { this.events = new Map(); }

  record(input) {
    const event = normalize(input);
    const content = normalizedContent(event);
    const existing = this.events.get(event.eventId);
    if (existing) {
      if (normalizedContent({ ...existing, payloadJson: JSON.stringify(existing.payload) }) !== content) {
        throw new Error(`eventId "${event.eventId}" already exists with different content`);
      }
      return existing;
    }
    const stored = publicEvent(event, new Date().toISOString());
    this.events.set(event.eventId, stored);
    return stored;
  }

  list({ runId, problemId, type, limit = 1000 } = {}) {
    validateLimit(limit);
    filterSql({ runId, problemId, type });
    return Object.freeze([...this.events.values()]
      .filter((event) => runId === undefined || event.runId === runId)
      .filter((event) => problemId === undefined || event.problemId === problemId)
      .filter((event) => type === undefined || event.type === type)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit));
  }
}

module.exports = { StagingLog, InMemoryStagingLog, hasStagingTable, isSafeIdentity, MAX_PAYLOAD_BYTES };
