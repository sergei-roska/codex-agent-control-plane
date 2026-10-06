'use strict';

// Diagnostic runtime event journal. It never drives lifecycle decisions: task store,
// checkpoints and dispatch_journal stay authoritative. record() never throws.

const crypto = require('node:crypto');

const EVENT_TYPES = Object.freeze([
  'server_started', 'task_reconciled_interrupted', 'writer_reconciled',
  'run_submitted', 'run_resumed', 'dispatch_submitting', 'dispatch_submitted',
  'dispatch_finished', 'run_paused', 'run_completed', 'run_failed',
  'run_canceled', 'run_error',
  'ticket_created', 'ticket_revised', 'ticket_cancelled', 'artifact_staged',
  'run_queued', 'lease_acquired', 'intake_completed', 'decision_requested', 'decision_answered',
  'plan_saved', 'branch_prepared', 'preflight_failed', 'engineering_started', 'candidate_captured',
  'run_settled', 'role_default_saved', 'role_default_reset',
  'role_rule_added', 'role_rule_edited', 'role_rule_removed',
  'control_requested', 'run_stopped', 'ticket_returned_to_backlog', 'review_recorded', 'rework_started',
  'delivery_commit_intended', 'delivery_commit_succeeded', 'delivery_commit_failed', 'delivery_commit_unknown',
  'delivery_push_intended', 'delivery_push_succeeded', 'delivery_push_failed', 'delivery_push_unknown',
  'repository_released', 'atlassian_egress', 'route_decided', 'route_promoted',
]);

const MAX_STRING = 500;
const MAX_PAYLOAD_BYTES = 4096;
const MAX_LIST = 20;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

// Allow-listed payload fields. Anything else (goal, prompt, text, output, env...) is dropped.
const PAYLOAD_FIELDS = Object.freeze([
  'port', 'pid', 'reconciledSpecialists', 'reconciledLead', 'reconciled', 'unresolved',
  'executionId', 'count', 'assignmentId', 'sandbox', 'contextId', 'dispatchTaskId',
  'outcome', 'state', 'pauseKind', 'disposition', 'rounds', 'assignments',
  'errorName', 'message', 'resumed', 'restarted',
  'ordinal', 'version', 'artifactCount', 'size', 'extraction',
  'code', 'codes', 'turn', 'readiness', 'classification', 'stageCount', 'phase', 'status',
  'waitReason', 'kind', 'truncated', 'fileCount', 'created',
  'control', 'deliveryId', 'verdict', 'parentRunId', 'reviewId',
  'method', 'host', 'path', 'durationMs', 'retryErrors',
  'mode', 'requested', 'effective', 'reasons', 'reason', 'at', 'scriptedDecisions',
]);

function sanitizeValue(value, depth = 0) {
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value) && depth < 2) return value.slice(0, MAX_LIST).map((entry) => sanitizeValue(entry, depth + 1));
  return undefined;
}

const ASSIGNMENT_SECRET_KEYS = 'access_token|access_key|client_secret|api_key|apikey|password|passwd|pwd|refresh_token|github_token|gh_token|token|secret';

function redactDiagnosticMessage(text) {
  return String(text)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#]*@/g, '$1')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s#]*/g, '$1?<redacted>')
    .replace(new RegExp(`(^|[^A-Za-z0-9_])(["']?)(${ASSIGNMENT_SECRET_KEYS})\\2(\\s*[:=]\\s*)(["'])(.*?)\\5`, 'gim'), '$1$2$3$2$4$5[REDACTED]$5')
    .replace(new RegExp(`(^|[^A-Za-z0-9_])(["']?)(${ASSIGNMENT_SECRET_KEYS})\\2(\\s*[:=]\\s*)(?!["'])([^\\s,;&]+)`, 'gim'), '$1$2$3$2$4[REDACTED]')
    .replace(/((?:^|\s)(?:cookie|set-cookie|x-api-key)\s*:\s*)[^\r\n]*/gim, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/\bATATT[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}

function sanitizePayload(payload) {
  const out = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
  for (const key of PAYLOAD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    let value;
    if (key === 'message' && typeof payload[key] === 'string') {
      const redacted = redactDiagnosticMessage(payload[key]);
      value = redacted.length > MAX_STRING ? redacted.slice(0, MAX_STRING) : redacted;
    } else {
      value = sanitizeValue(payload[key]);
    }
    if (value !== undefined) out[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_PAYLOAD_BYTES) return { truncated: true };
  return out;
}

function idOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text;
}

function clampLimit(limit) {
  const n = Number.isInteger(limit) ? limit : DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function fromRow(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json); } catch (_) { payload = {}; }
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    occurredAt: row.occurred_at,
    type: row.type,
    runId: row.run_id,
    namespace: row.namespace,
    taskId: row.task_id,
    ticketId: row.ticket_id ?? null,
    attemptId: row.attempt_id,
    role: row.role,
    causationId: row.causation_id,
    payload,
  };
}

class EventJournal {
  constructor({ db, now = () => new Date().toISOString(), randomId = () => crypto.randomUUID() } = {}) {
    this.db = db;
    this.now = now;
    this.randomId = randomId;
    this.failures = 0;
    this.lastFailureAt = null;
    this.stmts = null;
  }

  fail() {
    this.failures += 1;
    try { this.lastFailureAt = this.now(); } catch (_) { this.lastFailureAt = new Date().toISOString(); }
  }

  ensureSchema() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT UNIQUE NOT NULL,
          occurred_at TEXT NOT NULL,
          type TEXT NOT NULL,
          run_id TEXT,
          namespace TEXT,
          task_id TEXT,
          attempt_id TEXT,
          role TEXT,
          causation_id TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runtime_events_run ON runtime_events (run_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_runtime_events_task ON runtime_events (task_id, sequence);
      `);
      const columns = this.db.prepare('PRAGMA table_info(runtime_events)').all();
      if (!columns.some((column) => column.name === 'ticket_id')) {
        this.db.exec('ALTER TABLE runtime_events ADD COLUMN ticket_id TEXT');
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_runtime_events_ticket ON runtime_events (ticket_id, sequence)');
      this.stmts = null;
      return true;
    } catch (_) {
      this.fail();
      return false;
    }
  }

  prepared() {
    if (!this.stmts) {
      this.stmts = {
        insert: this.db.prepare(`INSERT INTO runtime_events
          (event_id, occurred_at, type, run_id, namespace, task_id, attempt_id, role, causation_id, payload_json, ticket_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      };
    }
    return this.stmts;
  }

  /** Never throws. Returns the sequence number, or null when nothing was recorded. */
  record(type, { runId, namespace, taskId, ticketId, attemptId, role, causationId, payload } = {}) {
    try {
      if (!EVENT_TYPES.includes(type)) {
        this.fail();
        return null;
      }
      const info = this.prepared().insert.run(
        String(this.randomId()), String(this.now()), type,
        idOrNull(runId), idOrNull(namespace), idOrNull(taskId), idOrNull(attemptId), idOrNull(role), idOrNull(causationId),
        JSON.stringify(sanitizePayload(payload)), idOrNull(ticketId),
      );
      return Number(info.lastInsertRowid);
    } catch (_) {
      this.stmts = null;
      this.fail();
      return null;
    }
  }

  health() {
    return { status: this.failures > 0 ? 'degraded' : 'ok', failures: this.failures, lastFailureAt: this.lastFailureAt };
  }

  lastSequence() {
    try {
      const row = this.db.prepare('SELECT MAX(sequence) AS seq FROM runtime_events').get();
      return row?.seq ?? 0;
    } catch (_) {
      return 0;
    }
  }

  listByRun(runId, { after = 0, limit = DEFAULT_LIMIT } = {}) {
    try {
      return this.db.prepare('SELECT * FROM runtime_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
        .all(String(runId), Number(after) || 0, clampLimit(limit)).map(fromRow);
    } catch (_) {
      return [];
    }
  }

  listByTicket(ticketId, { after = 0, limit = DEFAULT_LIMIT } = {}) {
    try {
      return this.db.prepare('SELECT * FROM runtime_events WHERE ticket_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
        .all(String(ticketId), Number(after) || 0, clampLimit(limit)).map(fromRow);
    } catch (_) {
      return [];
    }
  }

  listByTask(namespace, taskId, { after = 0, limit = DEFAULT_LIMIT } = {}) {
    try {
      return this.db.prepare('SELECT * FROM runtime_events WHERE namespace = ? AND task_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
        .all(String(namespace), String(taskId), Number(after) || 0, clampLimit(limit)).map(fromRow);
    } catch (_) {
      return [];
    }
  }

  listRecent({ limit = DEFAULT_LIMIT } = {}) {
    try {
      const events = this.db.prepare(
        'SELECT * FROM (SELECT * FROM runtime_events ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC',
      ).all(clampLimit(limit)).map(fromRow);
      return { ok: true, events };
    } catch (_) {
      return { ok: false, events: [] };
    }
  }
}

function outcomeOf(result) {
  if (!result || typeof result !== 'object') return null;
  for (const key of ['status', 'state', 'outcome']) {
    if (typeof result[key] === 'string') return result[key];
  }
  return null;
}

/**
 * Wrap a DispatchJournal-shaped object: delegate first (return values and exceptions are
 * preserved), then record dispatch_* events. Event failures never reach the caller.
 */
function withDispatchEvents(journal, events) {
  const emit = (type, fields) => {
    try { events.record(type, fields); } catch (_) { /* record() never throws; belt and braces */ }
  };
  return {
    recordSubmitting(row) {
      const out = journal.recordSubmitting(row);
      emit('dispatch_submitting', {
        runId: row?.runId, attemptId: row?.attemptId, role: row?.role,
        payload: { assignmentId: row?.assignmentId, sandbox: row?.sandbox, contextId: row?.contextId },
      });
      return out;
    },
    recordSubmitted(attempt, taskId) {
      const out = journal.recordSubmitted(attempt, taskId);
      emit('dispatch_submitted', {
        runId: out?.runId, attemptId: attempt, role: out?.role,
        payload: { dispatchTaskId: taskId },
      });
      return out;
    },
    recordFinished(attempt, result) {
      const out = journal.recordFinished(attempt, result);
      emit('dispatch_finished', {
        runId: out?.runId, attemptId: attempt, role: out?.role,
        payload: { outcome: outcomeOf(result), dispatchTaskId: result?.taskId },
      });
      return out;
    },
    get(attempt) {
      return journal.get(attempt);
    },
    listByRun(runId) {
      return journal.listByRun(runId);
    },
  };
}

const NOOP_EVENTS = Object.freeze({ record() { return null; } });

module.exports = { EventJournal, withDispatchEvents, sanitizePayload, redactDiagnosticMessage, EVENT_TYPES, NOOP_EVENTS };
