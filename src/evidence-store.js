'use strict';

// Bounded, run-owned evidence store in the state database (contract evidence-ref/v1, see
// docs/evidence-artifact-contract.md). An evidence id never maps to a filesystem path.

const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { DEFAULT_STATE_DB, stateDbPath } = require('./durable-store');

const CONTRACT = 'evidence-ref/v1';
const MiB = 1024 * 1024;
const MAX_STORED_BYTES = 8 * MiB;
const MAX_RUN_BYTES = 64 * MiB;
const MAX_READ_BYTES = 1 * MiB;
const MAX_SUMMARY_CHARS = 2000;
const HEAD_BYTES = 2 * MiB;
const TAIL_BYTES = 6 * MiB;
const DEFAULT_RETENTION_DAYS = 30;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const KINDS = new Set(['worker_result_text', 'check_stdout', 'check_stderr']);
const MEDIA_TYPES = new Set(['text/plain; charset=utf-8', 'application/json']);
const ID_PATTERN = /^ev_[0-9a-f]{32}$/;

class EvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

function createEvidenceTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_id TEXT,
      task_id TEXT,
      check_id TEXT,
      kind TEXT NOT NULL,
      media_type TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('stored', 'expired', 'not_stored')),
      payload BLOB,
      stored_bytes INTEGER NOT NULL,
      original_bytes INTEGER NOT NULL,
      omitted_offset INTEGER,
      omitted_bytes INTEGER,
      sha256 TEXT,
      original_sha256 TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evidence_run_idx ON evidence (run_id);
    CREATE INDEX IF NOT EXISTS evidence_expires_idx ON evidence (expires_at);
  `);
}

const sha256Hex = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const defaultRandomId = () => `ev_${crypto.randomBytes(16).toString('hex')}`;
const invalid = (message) => new EvidenceError('evidence_invalid_input', message);

// Env value must be a plain integer 1..365; anything else falls back to the default.
function parseRetentionDays(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 365) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (n >= 1 && n <= 365) return n;
  }
  return DEFAULT_RETENTION_DAYS;
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new EvidenceError('evidence_invalid_id', 'Evidence id must match ev_ followed by 32 lowercase hex chars');
  }
}

function optionalString(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value === '') throw invalid(`${name} must be a non-empty string or null`);
  return value;
}

function nonNegInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${name} must be a non-negative integer`);
  return value;
}

function markerFor(omittedBytes) {
  return Buffer.from(`\n[evidence: ${omittedBytes} bytes omitted]\n`, 'utf8');
}

// Returns { payload, omitted, originalBytes, originalSha256 } for any accepted content shape.
function normalizeContent(content) {
  if (typeof content === 'string') content = Buffer.from(content, 'utf8');
  if (Buffer.isBuffer(content)) {
    return splitFull(content, sha256Hex(content));
  }
  if (content && typeof content === 'object' && Buffer.isBuffer(content.head) && Buffer.isBuffer(content.tail)) {
    const originalBytes = nonNegInt(content.originalBytes, 'content.originalBytes');
    if (typeof content.originalSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(content.originalSha256)) {
      throw invalid('content.originalSha256 must be 64 lowercase hex chars');
    }
    const { head, tail } = content;
    if (head.length + tail.length > originalBytes) throw invalid('content head and tail exceed originalBytes');
    if (head.length + tail.length === originalBytes) {
      return splitFull(Buffer.concat([head, tail]), content.originalSha256);
    }
    if (head.length + tail.length > MAX_STORED_BYTES) throw invalid('content capture exceeds the stored byte bound');
    const omittedBytes = originalBytes - head.length - tail.length;
    return {
      payload: Buffer.concat([head, markerFor(omittedBytes), tail]),
      omitted: { offset: head.length, bytes: omittedBytes },
      originalBytes,
      originalSha256: content.originalSha256,
    };
  }
  throw invalid('content must be a Buffer, a string, or a { head, tail, originalBytes, originalSha256 } capture');
}

function splitFull(full, originalSha256) {
  if (full.length <= MAX_STORED_BYTES) {
    return { payload: full, omitted: null, originalBytes: full.length, originalSha256 };
  }
  const omittedBytes = full.length - HEAD_BYTES - TAIL_BYTES;
  return {
    payload: Buffer.concat([full.subarray(0, HEAD_BYTES), markerFor(omittedBytes), full.subarray(full.length - TAIL_BYTES)]),
    omitted: { offset: HEAD_BYTES, bytes: omittedBytes },
    originalBytes: full.length,
    originalSha256,
  };
}

function refFromRow(row) {
  let error = null;
  if (row.state === 'not_stored') error = 'evidence_quota_exceeded';
  else if (row.state === 'expired') error = 'evidence_expired';
  const stored = row.state === 'stored';
  return {
    contract: CONTRACT,
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    taskId: row.task_id,
    checkId: row.check_id,
    kind: row.kind,
    mediaType: row.media_type,
    stored,
    originalBytes: row.original_bytes,
    storedBytes: stored ? row.stored_bytes : 0,
    truncated: row.omitted_bytes != null,
    omitted: row.omitted_bytes != null ? { offset: row.omitted_offset, bytes: row.omitted_bytes } : null,
    sha256: stored ? row.sha256 : null,
    originalSha256: row.original_sha256,
    summary: row.summary,
    source: JSON.parse(row.source_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    error,
  };
}

function createEvidenceStore(db, { now = Date.now, retentionDays, randomId = defaultRandomId, readonly = false } = {}) {
  const retention = retentionDays !== undefined
    ? parseRetentionDays(retentionDays)
    : parseRetentionDays(process.env.CODEX_A2A_EVIDENCE_RETENTION_DAYS);
  if (!readonly) createEvidenceTable(db);
  let lastSweepAt = now();

  const hasTable = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'evidence'").get());

  function sweepExpired(at = now()) {
    lastSweepAt = at;
    return db.prepare(`
      UPDATE evidence SET state = 'expired', payload = NULL
      WHERE state IN ('stored', 'not_stored') AND expires_at <= ?
    `).run(at).changes;
  }
  if (!readonly) sweepExpired();

  function lookup(id, runId) {
    checkId(id);
    const row = hasTable() ? db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) : undefined;
    if (!row) throw new EvidenceError('evidence_not_found', 'Evidence not found');
    if (row.run_id !== runId) throw new EvidenceError('evidence_forbidden', 'Evidence belongs to a different run');
    // A past-due row is expired even before the hourly sweep has tombstoned it.
    if (row.state !== 'expired' && row.expires_at <= now()) return { ...row, state: 'expired', payload: null };
    return row;
  }

  function put(input) {
    if (!input || typeof input !== 'object') throw invalid('put input must be an object');
    if (typeof input.runId !== 'string' || input.runId === '') throw invalid('runId must be a non-empty string');
    if (!KINDS.has(input.kind)) throw invalid('kind is not a known evidence kind');
    if (!MEDIA_TYPES.has(input.mediaType)) throw invalid('mediaType is not allowed');
    if (typeof input.summary !== 'string' || input.summary.length > MAX_SUMMARY_CHARS) {
      throw invalid(`summary must be a string of at most ${MAX_SUMMARY_CHARS} chars`);
    }
    if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) {
      throw invalid('source must be an object');
    }
    const attemptId = optionalString(input.attemptId, 'attemptId');
    const taskId = optionalString(input.taskId, 'taskId');
    const checkIdValue = optionalString(input.checkId, 'checkId');
    const normalized = normalizeContent(input.content);
    const id = randomId();
    try { checkId(id); } catch (_) { throw invalid('randomId produced an invalid evidence id'); }
    const at = now();
    if (at - lastSweepAt >= SWEEP_INTERVAL_MS) sweepExpired(at);
    const sourceJson = JSON.stringify(input.source);

    const tx = db.transaction(() => {
      // Idempotent: a replay of the same producer output returns the existing row and writes nothing.
      const existing = db.prepare(`
        SELECT * FROM evidence
        WHERE run_id = ? AND attempt_id IS ? AND task_id IS ? AND check_id IS ? AND kind = ?
          AND original_sha256 = ? AND state IN ('stored', 'not_stored')
        ORDER BY created_at ASC, id ASC LIMIT 1
      `).get(input.runId, attemptId, taskId, checkIdValue, input.kind, normalized.originalSha256);
      if (existing) return existing;
      const used = db.prepare("SELECT COALESCE(SUM(stored_bytes), 0) AS n FROM evidence WHERE run_id = ? AND state = 'stored'")
        .get(input.runId).n;
      const overQuota = used + normalized.payload.length > MAX_RUN_BYTES;
      const omitted = overQuota ? { offset: 0, bytes: normalized.originalBytes } : normalized.omitted;
      db.prepare(`
        INSERT INTO evidence (id, run_id, attempt_id, task_id, check_id, kind, media_type, state, payload,
          stored_bytes, original_bytes, omitted_offset, omitted_bytes, sha256, original_sha256, summary,
          source_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.runId, attemptId, taskId, checkIdValue, input.kind, input.mediaType,
        overQuota ? 'not_stored' : 'stored',
        overQuota ? null : normalized.payload,
        overQuota ? 0 : normalized.payload.length,
        normalized.originalBytes,
        omitted ? omitted.offset : null,
        omitted ? omitted.bytes : null,
        overQuota ? null : sha256Hex(normalized.payload),
        normalized.originalSha256,
        input.summary,
        sourceJson,
        at,
        at + retention * DAY_MS
      );
      return db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
    });
    return refFromRow(tx());
  }

  function getRef(id, { runId } = {}) {
    const row = lookup(id, runId);
    if (row.state === 'expired') throw new EvidenceError('evidence_expired', 'Evidence has expired');
    return refFromRow(row);
  }

  function read(id, { runId, offset = 0, length = MAX_READ_BYTES } = {}) {
    const row = lookup(id, runId);
    if (row.state === 'expired') throw new EvidenceError('evidence_expired', 'Evidence has expired');
    if (row.state === 'not_stored') throw new EvidenceError('evidence_not_stored', 'Evidence payload was not stored');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new EvidenceError('evidence_read_too_large', 'Offset and length must be non-negative integers');
    }
    if (length > MAX_READ_BYTES) {
      throw new EvidenceError('evidence_read_too_large', `A read is limited to ${MAX_READ_BYTES} bytes`);
    }
    const payload = row.payload;
    if (!Buffer.isBuffer(payload) || payload.length !== row.stored_bytes || sha256Hex(payload) !== row.sha256) {
      throw new EvidenceError('evidence_corrupt', 'Stored evidence failed its checksum');
    }
    const bytes = Buffer.from(payload.subarray(offset, offset + length));
    return { ref: refFromRow(row), bytes, offset, eof: offset + length >= payload.length };
  }

  function listByRun(runId) {
    if (!hasTable()) return [];
    return db.prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at ASC, id ASC').all(runId).map(refFromRow);
  }

  function deleteRun(runId) {
    return db.prepare('DELETE FROM evidence WHERE run_id = ?').run(runId).changes;
  }

  return { put, getRef, read, listByRun, deleteRun, sweepExpired, retentionDays: retention };
}

function parseCliArgs(argv) {
  const out = {};
  const flags = { '--run': 'runId', '--id': 'id', '--offset': 'offset', '--length': 'length', '--state': 'state' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]];
    if (!key || i + 1 >= argv.length) throw new Error(`Unknown or incomplete argument "${argv[i]}"`);
    out[key] = argv[i + 1];
    i += 1;
  }
  if (!out.runId) throw new Error('Provide --run <runId>');
  if (!out.id && (out.offset !== undefined || out.length !== undefined)) throw new Error('--offset and --length need --id');
  return out;
}

// Returns the process exit code: 0 ok, 1 evidence or database error, 2 usage error.
function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return 2;
  }
  let db;
  try {
    const file = stateDbPath(args.state || env.CODEX_A2A_STATE_DB || DEFAULT_STATE_DB);
    db = new Database(file, { readonly: true, fileMustExist: true });
    const store = createEvidenceStore(db, { readonly: true });
    if (!args.id) {
      for (const ref of store.listByRun(args.runId)) stdout.write(`${JSON.stringify(ref)}\n`);
      return 0;
    }
    const options = { runId: args.runId };
    if (args.offset !== undefined) options.offset = Number(args.offset);
    if (args.length !== undefined) options.length = Number(args.length);
    stdout.write(store.read(args.id, options).bytes);
    return 0;
  } catch (error) {
    stderr.write(`${error.code || 'evidence_error'}: ${error.message}\n`);
    return 1;
  } finally {
    if (db) db.close();
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  CONTRACT,
  EvidenceError,
  MAX_STORED_BYTES,
  MAX_RUN_BYTES,
  MAX_READ_BYTES,
  MAX_SUMMARY_CHARS,
  HEAD_BYTES,
  TAIL_BYTES,
  createEvidenceStore,
  parseRetentionDays,
  parseCliArgs,
  main,
};
