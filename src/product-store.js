'use strict';

const crypto = require('node:crypto');

const SPECIALTIES = Object.freeze([
  'project-manager', 'architect', 'developer', 'qa', 'reviewer',
  'security', 'performance', 'devops', 'tech-writer',
]);
const PRIORITIES = Object.freeze(['low', 'normal', 'high']);
const REFERENCE_KINDS = Object.freeze(['jiraIssues', 'jiraParents', 'confluence', 'figma', 'links']);

const LIMITS = Object.freeze({
  titleMax: 200,
  descriptionMax: 32000,
  criteriaItems: 100,
  criteriaJoinedMax: 16000,
  referencesPerKind: 20,
  referenceMax: 2000,
  artifactIds: 10,
  artifactBytes: 25 * 1024 * 1024,
});

const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const CONTENT_FIELDS = ['title', 'description', 'criteria', 'references', 'artifactIds', 'priority', 'requestedSpecialty'];

const STATUS_BY_CODE = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  stale_version: 409,
  conflict: 409,
  invalid_state: 409,
});

class ProductError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProductError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 500;
    if (details !== undefined) this.details = details;
  }
}

function invalid(field, message) {
  return new ProductError('invalid_request', message, [{ field, message }]);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function defaultRandomId(prefix) {
  return `${prefix}${crypto.randomBytes(16).toString('base64url')}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function checkString(errors, field, value) {
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string' });
    return false;
  }
  if (CONTROL_RE.test(value)) {
    errors.push({ field, message: 'must not contain control characters' });
    return false;
  }
  return true;
}

// Validates revision content; returns normalized content or throws invalid_request.
function validateContent(body) {
  const errors = [];
  const out = {};

  if (checkString(errors, 'title', body.title)) {
    const title = body.title.trim();
    if (title.length < 1 || title.length > LIMITS.titleMax) {
      errors.push({ field: 'title', message: `must be 1..${LIMITS.titleMax} characters` });
    }
    out.title = title;
  }

  out.description = '';
  if (body.description !== undefined) {
    if (checkString(errors, 'description', body.description)) {
      if (body.description.length > LIMITS.descriptionMax) {
        errors.push({ field: 'description', message: `must be at most ${LIMITS.descriptionMax} characters` });
      }
      out.description = body.description;
    }
  }

  out.criteria = [];
  if (body.criteria !== undefined) {
    if (!Array.isArray(body.criteria)) {
      errors.push({ field: 'criteria', message: 'must be an array of strings' });
    } else {
      let ok = true;
      if (body.criteria.length > LIMITS.criteriaItems) {
        errors.push({ field: 'criteria', message: `must have at most ${LIMITS.criteriaItems} items` });
        ok = false;
      }
      body.criteria.forEach((item, index) => {
        if (!checkString(errors, `criteria[${index}]`, item)) { ok = false; return; }
        if (item.trim().length === 0) {
          errors.push({ field: `criteria[${index}]`, message: 'must not be empty' });
          ok = false;
        }
      });
      if (ok && body.criteria.join('\n').length > LIMITS.criteriaJoinedMax) {
        errors.push({ field: 'criteria', message: `joined length must be at most ${LIMITS.criteriaJoinedMax} characters` });
        ok = false;
      }
      if (ok) out.criteria = body.criteria.slice();
    }
  }

  out.references = {};
  for (const kind of REFERENCE_KINDS) out.references[kind] = [];
  if (body.references !== undefined) {
    if (!isPlainObject(body.references)) {
      errors.push({ field: 'references', message: 'must be an object of arrays' });
    } else {
      for (const key of Object.keys(body.references)) {
        if (!REFERENCE_KINDS.includes(key)) errors.push({ field: `references.${key}`, message: 'unknown field' });
      }
      for (const kind of REFERENCE_KINDS) {
        const list = body.references[kind];
        if (list === undefined) continue;
        const field = `references.${kind}`;
        if (!Array.isArray(list)) {
          errors.push({ field, message: 'must be an array of strings' });
          continue;
        }
        if (list.length > LIMITS.referencesPerKind) {
          errors.push({ field, message: `must have at most ${LIMITS.referencesPerKind} items` });
          continue;
        }
        let ok = true;
        list.forEach((item, index) => {
          if (!checkString(errors, `${field}[${index}]`, item)) { ok = false; return; }
          if (item.length < 1 || item.length > LIMITS.referenceMax) {
            errors.push({ field: `${field}[${index}]`, message: `must be 1..${LIMITS.referenceMax} characters` });
            ok = false;
          }
        });
        if (ok) out.references[kind] = list.map((value) => ({ value, availability: 'not_retrieved' }));
      }
    }
  }

  out.artifactIds = [];
  if (body.artifactIds !== undefined) {
    if (!Array.isArray(body.artifactIds)) {
      errors.push({ field: 'artifactIds', message: 'must be an array of strings' });
    } else if (body.artifactIds.length > LIMITS.artifactIds) {
      errors.push({ field: 'artifactIds', message: `must have at most ${LIMITS.artifactIds} items` });
    } else if (body.artifactIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      errors.push({ field: 'artifactIds', message: 'must contain non-empty strings' });
    } else if (new Set(body.artifactIds).size !== body.artifactIds.length) {
      errors.push({ field: 'artifactIds', message: 'must not contain duplicates' });
    } else {
      out.artifactIds = body.artifactIds.slice();
    }
  }

  out.priority = 'normal';
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) {
      errors.push({ field: 'priority', message: `must be one of ${PRIORITIES.join(', ')}` });
    } else {
      out.priority = body.priority;
    }
  }

  out.requestedSpecialty = null;
  if (body.requestedSpecialty !== undefined && body.requestedSpecialty !== null) {
    if (!SPECIALTIES.includes(body.requestedSpecialty)) {
      errors.push({ field: 'requestedSpecialty', message: `must be null or one of ${SPECIALTIES.join(', ')}` });
    } else {
      out.requestedSpecialty = body.requestedSpecialty;
    }
  }

  if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
  return out;
}

// Shape checks shared by every command: object body, commandId, known fields.
function validateEnvelope(body, allowed) {
  if (!isPlainObject(body)) throw invalid('body', 'must be an object');
  const errors = [];
  if (typeof body.commandId !== 'string' || !COMMAND_ID_RE.test(body.commandId)) {
    errors.push({ field: 'commandId', message: 'must be 8..100 characters of [A-Za-z0-9_-]' });
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push({ field: key, message: 'unknown field' });
  }
  if (allowed.includes('expectedVersion')) {
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
      errors.push({ field: 'expectedVersion', message: 'must be a positive integer' });
    }
  }
  if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
}

function ticketFromRow(row) {
  return {
    ticketId: row.ticket_id,
    projectId: row.project_id,
    source: row.source,
    title: row.title,
    priority: row.priority,
    status: row.status,
    currentRevisionId: row.current_revision_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    trackingMode: 'internal',
  };
}

function revisionFromRow(row) {
  return {
    revisionId: row.revision_id,
    ticketId: row.ticket_id,
    parentRevisionId: row.parent_revision_id,
    ordinal: row.ordinal,
    title: row.title,
    description: row.description,
    criteria: JSON.parse(row.criteria_json),
    references: JSON.parse(row.references_json),
    artifactIds: JSON.parse(row.artifact_ids_json),
    priority: row.priority,
    trackingMode: row.tracking_mode,
    requestedSpecialty: row.requested_specialty,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

function artifactFromRow(row) {
  return {
    artifactId: row.artifact_id,
    ticketId: row.ticket_id,
    state: row.state,
    kind: row.kind,
    displayName: row.display_name,
    mediaType: row.media_type,
    size: row.size,
    sha256: row.sha256,
    storageRef: row.storage_ref,
    extraction: row.extraction,
    extractedChars: row.extracted_chars,
    extractionTruncated: Boolean(row.extraction_truncated),
    origin: row.origin,
    createdAt: row.created_at,
  };
}

class ProductStore {
  constructor({ db, projectId, now, randomId } = {}) {
    if (!db) throw new Error('ProductStore requires db');
    if (!projectId) throw new Error('ProductStore requires projectId');
    this.db = db;
    this.projectId = projectId;
    this.now = () => {
      const value = typeof now === 'function' ? now() : now;
      const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
      return date.toISOString();
    };
    this.randomId = randomId || defaultRandomId;
    this.stmts = {};
  }

  stmt(sql) {
    if (!this.stmts[sql]) this.stmts[sql] = this.db.prepare(sql);
    return this.stmts[sql];
  }

  // ------------------------------------------------------------ reads

  getTicket(ticketId) {
    const row = this.stmt('SELECT * FROM tickets WHERE ticket_id = ?').get(String(ticketId));
    return row ? ticketFromRow(row) : null;
  }

  getRevision(ticketId, revisionId) {
    const row = this.stmt('SELECT * FROM requirement_revisions WHERE ticket_id = ? AND revision_id = ?')
      .get(String(ticketId), String(revisionId));
    return row ? revisionFromRow(row) : null;
  }

  listRevisions(ticketId) {
    return this.stmt('SELECT * FROM requirement_revisions WHERE ticket_id = ? ORDER BY ordinal ASC')
      .all(String(ticketId)).map(revisionFromRow);
  }

  listTickets() {
    const rows = this.stmt(
      'SELECT t.*, r.requested_specialty AS r_specialty, r.ordinal AS r_ordinal, '
      + 'json_array_length(r.artifact_ids_json) AS r_attachments '
      + 'FROM tickets t JOIN requirement_revisions r ON r.revision_id = t.current_revision_id '
      + 'ORDER BY t.updated_at DESC, t.ticket_id DESC',
    ).all();
    return rows.map((row) => ({
      ...ticketFromRow(row),
      requestedSpecialty: row.r_specialty,
      revisionOrdinal: row.r_ordinal,
      attachmentCount: row.r_attachments,
    }));
  }

  getArtifact(artifactId) {
    const row = this.stmt('SELECT * FROM artifacts WHERE artifact_id = ?').get(String(artifactId));
    return row ? artifactFromRow(row) : null;
  }

  listTicketArtifacts(ticketId) {
    return this.stmt('SELECT * FROM artifacts WHERE ticket_id = ? ORDER BY created_at ASC, artifact_id ASC')
      .all(String(ticketId)).map(artifactFromRow);
  }

  // -------------------------------------------------------- artifacts

  recordStagedArtifact(meta) {
    const errors = [];
    if (!meta || typeof meta.artifactId !== 'string' || !meta.artifactId) errors.push({ field: 'artifactId', message: 'required' });
    for (const field of ['displayName', 'mediaType', 'sha256', 'storageRef', 'extraction']) {
      if (!meta || typeof meta[field] !== 'string' || !meta[field]) errors.push({ field, message: 'required' });
    }
    if (!meta || !Number.isInteger(meta.size) || meta.size < 0) errors.push({ field: 'size', message: 'must be a non-negative integer' });
    if (errors.length > 0) throw new ProductError('invalid_request', 'invalid artifact metadata', errors);
    const chars = Number.isInteger(meta.extractedChars) ? meta.extractedChars : null;
    this.stmt(
      'INSERT INTO artifacts (artifact_id, ticket_id, state, kind, media_type, display_name, size, sha256, '
      + 'storage_ref, extraction, extracted_chars, extraction_truncated, origin, created_at) '
      + "VALUES (?, NULL, 'staged', 'attachment', ?, ?, ?, ?, ?, ?, ?, ?, 'operator_upload', ?)",
    ).run(
      meta.artifactId, meta.mediaType, meta.displayName, meta.size, meta.sha256,
      meta.storageRef, meta.extraction, chars, meta.extractionTruncated ? 1 : 0, this.now(),
    );
    return this.getArtifact(meta.artifactId);
  }

  listStaleStagedArtifacts(olderThanIso) {
    return this.stmt("SELECT * FROM artifacts WHERE state = 'staged' AND created_at < ? ORDER BY created_at ASC, artifact_id ASC")
      .all(String(olderThanIso)).map(artifactFromRow);
  }

  stagedUsage() {
    const row = this.stmt("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM artifacts WHERE state = 'staged'").get();
    return { count: row.n, bytes: row.bytes };
  }

  deleteStagedArtifact(artifactId) {
    return this.stmt("DELETE FROM artifacts WHERE artifact_id = ? AND state = 'staged'")
      .run(String(artifactId)).changes > 0;
  }

  // --------------------------------------------------------- commands

  createTicket(command) {
    return this.runCommand('create', null, command, ['commandId', ...CONTENT_FIELDS], (body, at) => {
      const content = validateContent(body);
      const ticketId = this.randomId('tkt_');
      const revisionId = this.randomId('rev_');
      this.stmt(
        'INSERT INTO tickets (ticket_id, project_id, source, title, priority, status, current_revision_id, '
        + 'version, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      ).run(ticketId, this.projectId, 'direct', content.title, content.priority, 'backlog', revisionId, at, at, 'operator');
      this.insertRevision(revisionId, ticketId, null, 1, content, body.commandId, at);
      this.attachArtifacts(ticketId, content.artifactIds, false);
      return { ticketId, revisionId };
    });
  }

  reviseTicket(ticketId, command) {
    return this.runCommand('revise', String(ticketId), command,
      ['commandId', 'expectedVersion', ...CONTENT_FIELDS], (body, at) => {
        const content = validateContent(body);
        const ticket = this.requireTicket(ticketId);
        this.requireBacklog(ticket);
        this.requireVersion(ticket, body.expectedVersion);
        const parent = this.stmt('SELECT revision_id, ordinal FROM requirement_revisions WHERE revision_id = ?')
          .get(ticket.currentRevisionId);
        const revisionId = this.randomId('rev_');
        this.insertRevision(revisionId, ticket.ticketId, parent.revision_id, parent.ordinal + 1, content, body.commandId, at);
        this.attachArtifacts(ticket.ticketId, content.artifactIds, true);
        this.stmt('UPDATE tickets SET title = ?, priority = ?, current_revision_id = ?, version = version + 1, updated_at = ? WHERE ticket_id = ?')
          .run(content.title, content.priority, revisionId, at, ticket.ticketId);
        return { ticketId: ticket.ticketId, revisionId };
      });
  }

  cancelTicket(ticketId, command) {
    return this.runCommand('cancel', String(ticketId), command, ['commandId', 'expectedVersion'], (body, at) => {
      const ticket = this.requireTicket(ticketId);
      this.requireBacklog(ticket);
      this.requireVersion(ticket, body.expectedVersion);
      this.stmt("UPDATE tickets SET status = 'cancelled', version = version + 1, updated_at = ? WHERE ticket_id = ?")
        .run(at, ticket.ticketId);
      return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId };
    });
  }

  // Runs one command in a single immediate transaction with the idempotency ledger.
  runCommand(kind, targetTicketId, body, allowedFields, apply) {
    validateEnvelope(body, allowedFields);
    const { commandId, ...rest } = body;
    const payloadHash = sha256(canonicalJson({ kind, ticketId: targetTicketId, body: rest }));
    const run = this.db.transaction(() => {
      const prior = this.stmt('SELECT payload_sha256, result_json FROM product_commands WHERE command_id = ?').get(commandId);
      if (prior) {
        if (prior.payload_sha256 !== payloadHash) {
          throw new ProductError('conflict', 'commandId was already used with a different payload');
        }
        return { ...JSON.parse(prior.result_json), replayed: true };
      }
      const at = this.now();
      const ids = apply(body, at);
      const result = {
        ticket: this.getTicket(ids.ticketId),
        revision: this.getRevision(ids.ticketId, ids.revisionId),
      };
      this.stmt('INSERT INTO product_commands (command_id, kind, payload_sha256, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(commandId, kind, payloadHash, JSON.stringify(result), at);
      return { ...result, replayed: false };
    });
    return run.immediate();
  }

  requireTicket(ticketId) {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new ProductError('not_found', 'ticket not found');
    return ticket;
  }

  requireBacklog(ticket) {
    if (ticket.status !== 'backlog') {
      throw new ProductError('invalid_state', `ticket is ${ticket.status}; only backlog tickets accept this command`);
    }
  }

  requireVersion(ticket, expected) {
    if (ticket.version !== expected) {
      throw new ProductError('stale_version', 'ticket version is stale', { currentVersion: ticket.version });
    }
  }

  insertRevision(revisionId, ticketId, parentRevisionId, ordinal, content, commandId, at) {
    this.stmt(
      'INSERT INTO requirement_revisions (revision_id, ticket_id, parent_revision_id, ordinal, title, description, '
      + 'criteria_json, references_json, artifact_ids_json, priority, tracking_mode, requested_specialty, actor, '
      + 'command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      revisionId, ticketId, parentRevisionId, ordinal, content.title, content.description,
      JSON.stringify(content.criteria), JSON.stringify(content.references), JSON.stringify(content.artifactIds),
      content.priority, 'internal', content.requestedSpecialty, 'operator', commandId, at,
    );
  }

  // Validates ownership/limits and attaches staged artifacts; throws inside the transaction.
  attachArtifacts(ticketId, artifactIds, allowOwn) {
    let total = 0;
    const toAttach = [];
    artifactIds.forEach((id, index) => {
      const field = `artifactIds[${index}]`;
      const row = this.stmt('SELECT artifact_id, ticket_id, state, size FROM artifacts WHERE artifact_id = ?').get(id);
      if (!row) throw invalid(field, 'artifact not found');
      if (row.state === 'staged') toAttach.push(id);
      else if (!(allowOwn && row.state === 'attached' && row.ticket_id === ticketId)) {
        throw invalid(field, row.state === 'attached' && row.ticket_id !== ticketId
          ? 'artifact is attached to another ticket'
          : 'artifact is not available for attachment');
      }
      total += row.size;
    });
    if (total > LIMITS.artifactBytes) {
      throw invalid('artifactIds', `combined size must be at most ${LIMITS.artifactBytes} bytes`);
    }
    const attach = this.stmt("UPDATE artifacts SET state = 'attached', ticket_id = ? WHERE artifact_id = ? AND state = 'staged'");
    for (const id of toAttach) attach.run(ticketId, id);
  }
}

module.exports = { ProductStore, ProductError, LIMITS, SPECIALTIES, PRIORITIES, REFERENCE_KINDS, canonicalJson };
