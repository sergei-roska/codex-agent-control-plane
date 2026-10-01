'use strict';

const crypto = require('node:crypto');

const MAX_BUNDLE_BYTES = 24 * 1024 * 1024;
const MAX_DOCUMENTS = 20;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_LINKS = 1000;
const MAX_JSON_NODES = 100000;
const MAX_JSON_DEPTH = 24;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

// Shared verbatim by the standalone store and the product schema migration so
// both entry points create the same identity and snapshot tables.
const SOURCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS m6_source_identities (
  identity_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  origin_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  latest_snapshot_id TEXT,
  latest_available_snapshot_id TEXT,
  ticket_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, source_kind, origin_id, external_id)
);
CREATE TABLE IF NOT EXISTS m6_source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES m6_source_identities(identity_id),
  ordinal INTEGER NOT NULL,
  parent_snapshot_id TEXT REFERENCES m6_source_snapshots(snapshot_id),
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  root_available INTEGER NOT NULL CHECK(root_available IN (0, 1)),
  bundle_json TEXT NOT NULL,
  UNIQUE(identity_id, ordinal)
);
CREATE INDEX IF NOT EXISTS m6_source_snapshots_identity_idx
  ON m6_source_snapshots(identity_id, recorded_at, snapshot_id);
`;

class SourceImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceImportError';
    this.code = code;
  }
}

function invalid(message) {
  throw new SourceImportError('invalid_bundle', message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Bound traversal before serialization so hostile depth/size cannot exhaust the
// process while we validate an imported bundle.
function boundedClone(input) {
  let nodes = 0;
  let estimatedBytes = 0;
  const seen = new Set();
  function clone(value, depth) {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) invalid('bundle exceeds structural limits');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid('bundle contains a non-finite number');
      estimatedBytes += 16;
      return value;
    }
    if (typeof value === 'string') {
      estimatedBytes += Buffer.byteLength(value, 'utf8');
      if (estimatedBytes > MAX_BUNDLE_BYTES) invalid('bundle exceeds size limit');
      return value;
    }
    if (typeof value !== 'object') invalid('bundle must contain JSON values only');
    if (seen.has(value)) invalid('bundle must not contain cycles or shared references');
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      if (value.length > MAX_DOCUMENTS * (MAX_LINKS + 1)) invalid('bundle array exceeds limit');
      result = value.map((item) => clone(item, depth + 1));
    } else {
      if (!isPlainObject(value)) invalid('bundle must contain plain JSON objects');
      const keys = Object.keys(value);
      if (keys.length > 100) invalid('bundle object has too many fields');
      result = Object.create(null);
      for (const key of keys) {
        estimatedBytes += Buffer.byteLength(key, 'utf8');
        if (estimatedBytes > MAX_BUNDLE_BYTES) invalid('bundle exceeds size limit');
        Object.defineProperty(result, key, {
          value: clone(value[key], depth + 1), enumerable: true, writable: true, configurable: true,
        });
      }
    }
    seen.delete(value);
    if (estimatedBytes > MAX_BUNDLE_BYTES) invalid('bundle exceeds size limit');
    return result;
  }
  const cloned = clone(input, 0);
  if (Buffer.byteLength(JSON.stringify(cloned), 'utf8') > MAX_BUNDLE_BYTES) invalid('bundle exceeds size limit');
  return cloned;
}

function requireString(value, field, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max || CONTROL_RE.test(value)) {
    invalid(`${field} is invalid`);
  }
  return value;
}

function validateReference(ref, field) {
  if (!isPlainObject(ref)) invalid(`${field} must be an object`);
  if (!['jira', 'confluence'].includes(ref.sourceKind)) invalid(`${field}.sourceKind is invalid`);
  requireString(ref.originId, `${field}.originId`, 256);
  requireString(ref.externalId, `${field}.externalId`, 512);
  return { sourceKind: ref.sourceKind, originId: ref.originId, externalId: ref.externalId };
}

function validateBundle(input) {
  const bundle = boundedClone(input);
  if (!isPlainObject(bundle) || bundle.schemaVersion !== 1) invalid('bundle schemaVersion must be 1');
  const rootRef = validateReference(bundle.root, 'root');
  if (bundle.root.displayKey !== undefined) requireString(bundle.root.displayKey, 'root.displayKey', 256, { allowEmpty: true });
  if (bundle.root.availability !== undefined && !['available', 'missing', 'unauthorized', 'unavailable'].includes(bundle.root.availability)) {
    invalid('root.availability is invalid');
  }
  const root = { ...bundle.root, ...rootRef };
  requireString(bundle.fetchedAt, 'fetchedAt', 100);
  if (!Number.isFinite(Date.parse(bundle.fetchedAt))) invalid('fetchedAt must be a timestamp');
  if (!Array.isArray(bundle.documents) || bundle.documents.length > MAX_DOCUMENTS) invalid('documents exceeds limit');
  const documents = bundle.documents.map((doc, index) => {
    const field = `documents[${index}]`;
    if (!isPlainObject(doc)) invalid(`${field} must be an object`);
    const reference = validateReference(doc, field);
    if (!['available', 'missing', 'unauthorized', 'unavailable'].includes(doc.availability)) invalid(`${field}.availability is invalid`);
    if (doc.url !== null) requireString(doc.url, `${field}.url`, 2048);
    if (doc.availability === 'available') {
      if (typeof doc.url !== 'string') invalid(`${field}.url is required for available content`);
      try {
        const url = new URL(doc.url);
        if (url.protocol !== 'https:' || url.username || url.password) invalid(`${field}.url must be a credential-free HTTPS URL`);
      } catch (error) {
        if (error instanceof SourceImportError) throw error;
        invalid(`${field}.url must be a credential-free HTTPS URL`);
      }
    }
    requireString(doc.title, `${field}.title`, 1000, { allowEmpty: true });
    if (typeof doc.text !== 'string' || Buffer.byteLength(doc.text, 'utf8') > MAX_DOCUMENT_BYTES) {
      invalid(`${field}.text exceeds the source text limit`);
    }
    if (!Array.isArray(doc.links) || doc.links.length > MAX_LINKS) invalid(`${field}.links exceeds limit`);
    const links = doc.links.map((link, i) => validateReference(link, `${field}.links[${i}]`));
    if (doc.displayKey !== undefined) requireString(doc.displayKey, `${field}.displayKey`, 256, { allowEmpty: true });
    if (doc.sourceRevision !== undefined) requireString(doc.sourceRevision, `${field}.sourceRevision`, 512, { allowEmpty: true });
    if (doc.truncation !== undefined && doc.truncation !== null && typeof doc.truncation !== 'boolean' && !isPlainObject(doc.truncation)) {
      invalid(`${field}.truncation is invalid`);
    }
    return { ...doc, ...reference, links };
  });
  if (!Array.isArray(bundle.warnings) || bundle.warnings.length > 100) invalid('warnings exceeds limit');
  for (let i = 0; i < bundle.warnings.length; i += 1) {
    const warning = bundle.warnings[i];
    if (typeof warning === 'string') requireString(warning, `warnings[${i}]`, 2000, { allowEmpty: true });
    else if (!isPlainObject(warning)) invalid(`warnings[${i}] is invalid`);
  }
  return { ...bundle, root, documents };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableContent(value) {
  if (Array.isArray(value)) return value.map(stableContent);
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      if (key !== 'fetchedAt') out[key] = stableContent(value[key]);
    }
    return out;
  }
  return value;
}

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

class SourceImportStore {
  constructor({ db, now = () => new Date(), randomId } = {}) {
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
      throw new TypeError('SourceImportStore requires a caller-owned better-sqlite3 database');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.db = db;
    this.now = now;
    this.randomId = randomId || ((prefix) => `${prefix}${crypto.randomBytes(16).toString('base64url')}`);
    db.exec(SOURCE_SCHEMA_SQL);
  }

  recordSnapshot({ projectId, bundle } = {}) {
    requireString(projectId, 'projectId', 256);
    const normalized = validateBundle(bundle);
    const { root } = normalized;
    const rootDocument = normalized.documents.find((doc) => doc.sourceKind === root.sourceKind && doc.originId === root.originId && doc.externalId === root.externalId);
    if (!rootDocument) invalid('documents must include the exact root source identity');
    const rootAvailable = rootDocument.availability === 'available';
    const canonical = canonicalJson(stableContent(normalized));
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    const bundleJson = JSON.stringify(normalized);
    const recordedAt = requireString(new Date(this.now()).toISOString(), 'recordedAt', 100);
    const transact = this.db.transaction(() => {
      let identity = this.db.prepare(`SELECT * FROM m6_source_identities
        WHERE project_id = ? AND source_kind = ? AND origin_id = ? AND external_id = ?`)
        .get(projectId, root.sourceKind, root.originId, root.externalId);
      if (!identity) {
        const identityId = this.randomId('src_');
        this.db.prepare(`INSERT INTO m6_source_identities
          (identity_id, project_id, source_kind, origin_id, external_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(identityId, projectId, root.sourceKind, root.originId, root.externalId, recordedAt);
        identity = this.db.prepare('SELECT * FROM m6_source_identities WHERE identity_id = ?').get(identityId);
      }
      const prior = identity.latest_snapshot_id
        ? this.db.prepare(`SELECT snapshot_id FROM m6_source_snapshots
          WHERE snapshot_id = ? AND content_hash = ?`).get(identity.latest_snapshot_id, hash)
        : null;
      if (prior) return { identityId: identity.identity_id, snapshotId: prior.snapshot_id, changed: false, replayed: true };

      const parentSnapshotId = identity.latest_snapshot_id || null;
      const ordinal = this.db.prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS next
        FROM m6_source_snapshots WHERE identity_id = ?`).get(identity.identity_id).next;
      const snapshotId = this.randomId('ss_');
      this.db.prepare(`INSERT INTO m6_source_snapshots
        (snapshot_id, identity_id, ordinal, parent_snapshot_id, content_hash, fetched_at, recorded_at, root_available, bundle_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(snapshotId, identity.identity_id, ordinal, parentSnapshotId, hash, normalized.fetchedAt, recordedAt, rootAvailable ? 1 : 0, bundleJson);
      this.db.prepare(`UPDATE m6_source_identities SET latest_snapshot_id = ?,
        latest_available_snapshot_id = CASE WHEN ? = 1 THEN ? ELSE latest_available_snapshot_id END
        WHERE identity_id = ?`)
        .run(snapshotId, rootAvailable ? 1 : 0, snapshotId, identity.identity_id);
      return { identityId: identity.identity_id, snapshotId, changed: true, replayed: false };
    });
    return transact();
  }

  getIdentity({ projectId, originId, externalId, sourceKind = 'jira' } = {}) {
    requireString(projectId, 'projectId', 256);
    requireString(originId, 'originId', 256);
    requireString(externalId, 'externalId', 512);
    if (!['jira', 'confluence'].includes(sourceKind)) invalid('sourceKind is invalid');
    const row = this.db.prepare(`SELECT * FROM m6_source_identities
      WHERE project_id = ? AND source_kind = ? AND origin_id = ? AND external_id = ?`)
      .get(projectId, sourceKind, originId, externalId);
    return row ? {
      identityId: row.identity_id, projectId: row.project_id, sourceKind: row.source_kind,
      originId: row.origin_id, externalId: row.external_id,
      latestSnapshotId: row.latest_snapshot_id,
      latestAvailableSnapshotId: row.latest_available_snapshot_id,
      ticketId: row.ticket_id, createdAt: row.created_at,
    } : null;
  }

  getSnapshot(snapshotId) {
    requireString(snapshotId, 'snapshotId', 256);
    const row = this.db.prepare('SELECT * FROM m6_source_snapshots WHERE snapshot_id = ?').get(snapshotId);
    return row ? this.#snapshot(row) : null;
  }

  listSnapshots(identityId) {
    requireString(identityId, 'identityId', 256);
    return this.db.prepare(`SELECT * FROM m6_source_snapshots
      WHERE identity_id = ? ORDER BY ordinal`).all(identityId).map((row) => this.#snapshot(row));
  }

  bindTicket({ identityId, ticketId } = {}) {
    requireString(identityId, 'identityId', 256);
    requireString(ticketId, 'ticketId', 256);
    const transact = this.db.transaction(() => {
      const row = this.db.prepare('SELECT ticket_id FROM m6_source_identities WHERE identity_id = ?').get(identityId);
      if (!row) throw new SourceImportError('not_found', 'source identity was not found');
      if (row.ticket_id && row.ticket_id !== ticketId) throw new SourceImportError('ticket_binding_conflict', 'source identity is already bound to another ticket');
      if (!row.ticket_id) this.db.prepare('UPDATE m6_source_identities SET ticket_id = ? WHERE identity_id = ?').run(ticketId, identityId);
      return { identityId, ticketId, replayed: Boolean(row.ticket_id) };
    });
    return transact();
  }

  #snapshot(row) {
    return {
      snapshotId: row.snapshot_id,
      identityId: row.identity_id,
      ordinal: row.ordinal,
      parentSnapshotId: row.parent_snapshot_id,
      contentHash: row.content_hash,
      fetchedAt: row.fetched_at,
      recordedAt: row.recorded_at,
      rootAvailable: Boolean(row.root_available),
      bundle: copyJson(JSON.parse(row.bundle_json)),
    };
  }
}

module.exports = { SourceImportStore, SourceImportError, SOURCE_SCHEMA_SQL };
