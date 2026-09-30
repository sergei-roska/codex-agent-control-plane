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
const ACTIVE_RUN_STATUSES = Object.freeze(['queued', 'running', 'paused', 'interrupted']);
const CARD_ID_PREFIX = 'lr_';
const ANSWER_MAX = 4000;
const LEAD_ANSWER_MAX = 8000;
const INTAKE_READINESS = Object.freeze(['ready', 'needs_input', 'unsupported']);
const CONTENT_FIELDS = ['title', 'description', 'criteria', 'references', 'artifactIds', 'priority', 'requestedSpecialty'];

const STATUS_BY_CODE = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  stale_version: 409,
  conflict: 409,
  invalid_state: 409,
  stale_decision: 409,
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

function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function runFromRow(row) {
  return {
    runId: row.run_id,
    ticketId: row.ticket_id,
    revisionId: row.revision_id,
    projectId: row.project_id,
    status: row.status,
    phase: row.phase,
    waitReason: row.wait_reason,
    waitDetail: parseJson(row.wait_detail_json, null),
    planRevisionId: row.plan_revision_id,
    leadTaskId: row.lead_task_id,
    leadContextId: row.lead_context_id,
    branchName: row.branch_name,
    baseCommit: row.base_commit,
    candidateId: row.candidate_id,
    settings: parseJson(row.settings_snapshot_json, {}),
    intakeTurns: row.intake_turns,
    commandId: row.command_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

// Pinned run summary (D-M3-7).
function runSummary(run) {
  return {
    runId: run.runId,
    ticketId: run.ticketId,
    revisionId: run.revisionId,
    status: run.status,
    phase: run.phase,
    waitReason: run.waitReason || null,
    waitDetail: run.waitDetail || null,
    planRevisionId: run.planRevisionId || null,
    branchName: run.branchName || null,
    baseCommit: run.baseCommit || null,
    candidateId: run.candidateId || null,
    createdAt: run.createdAt,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    updatedAt: run.updatedAt,
  };
}

function intakeRecordFromRow(row) {
  return {
    intakeId: row.intake_id,
    runId: row.run_id,
    turn: row.turn,
    output: parseJson(row.output_json, null),
    valid: row.valid === 1,
    errors: parseJson(row.errors_json, []),
    createdAt: row.created_at,
  };
}

function intakeView(record) {
  const output = record.output && typeof record.output === 'object' ? record.output : {};
  const str = (value) => (typeof value === 'string' ? value : null);
  return {
    turn: record.turn,
    valid: record.valid,
    errors: record.errors,
    readiness: INTAKE_READINESS.includes(output.readiness) ? output.readiness : null,
    classification: str(output.classification),
    requirements: output.requirements && typeof output.requirements === 'object' ? output.requirements : null,
    questions: Array.isArray(output.questions)
      ? output.questions.map((q) => ({ id: q.id, question: q.question, why: q.why })) : [],
    unsupportedReason: str(output.unsupportedReason),
    createdAt: record.createdAt,
  };
}

function planFromRow(row) {
  return {
    planRevisionId: row.plan_revision_id,
    runId: row.run_id,
    parentPlanRevisionId: row.parent_plan_revision_id,
    classification: row.classification,
    stages: parseJson(row.stages_json, []),
    checkIds: parseJson(row.check_ids_json, []),
    checks: parseJson(row.checks_json, []),
    requirements: parseJson(row.requirements_json, null),
    validatorVersion: row.validator_version,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function planView(plan) {
  return {
    planRevisionId: plan.planRevisionId,
    classification: plan.classification,
    stages: plan.stages,
    checks: plan.checks,
    requirements: plan.requirements,
    validatorVersion: plan.validatorVersion,
    createdAt: plan.createdAt,
  };
}

function decisionFromRow(row) {
  return {
    decisionId: row.decision_id,
    kind: row.kind,
    ticketId: row.ticket_id,
    runId: row.run_id,
    revisionId: row.revision_id,
    planRevisionId: row.plan_revision_id,
    state: row.state,
    request: parseJson(row.request_json, {}),
    answer: parseJson(row.answer_json, null),
    actor: row.actor,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

function decisionView(decision) {
  let request = decision.request;
  if (decision.kind === 'lead_decision') {
    request = {
      question: request.question ?? null,
      reason: request.reason ?? null,
      options: Array.isArray(request.options) ? request.options : [],
      recommendation: request.recommendation ?? null,
    };
  }
  return {
    decisionId: decision.decisionId,
    kind: decision.kind,
    state: decision.state,
    request,
    answer: decision.answer,
    createdAt: decision.createdAt,
    answeredAt: decision.answeredAt || null,
  };
}

function candidateFromRow(row) {
  return {
    candidateId: row.candidate_id,
    runId: row.run_id,
    planRevisionId: row.plan_revision_id,
    baseCommit: row.base_commit,
    head: row.head,
    branch: row.branch,
    headMoved: row.head_moved === 1,
    manifest: parseJson(row.manifest_json, []),
    diffArtifactId: row.diff_artifact_id,
    truncated: row.truncated === 1,
    acceptance: parseJson(row.acceptance_json, null),
    integrityHash: row.integrity_hash,
    createdAt: row.created_at,
  };
}

function candidateView(candidate) {
  const acceptance = candidate.acceptance;
  return {
    candidateId: candidate.candidateId,
    baseCommit: candidate.baseCommit,
    head: candidate.head,
    branch: candidate.branch,
    headMoved: candidate.headMoved,
    manifest: candidate.manifest.map((entry) => ({
      path: entry.path, status: entry.status, sha256: entry.sha256 ?? null, size: entry.size ?? null,
    })),
    truncated: candidate.truncated,
    diffArtifactId: candidate.diffArtifactId || null,
    acceptance: acceptance && typeof acceptance === 'object'
      ? {
        disposition: acceptance.disposition,
        reasons: Array.isArray(acceptance.reasons) ? acceptance.reasons : [],
        checks: Array.isArray(acceptance.checks) ? acceptance.checks : [],
      }
      : null,
    integrityHash: candidate.integrityHash,
    createdAt: candidate.createdAt,
  };
}

function validateAnswerCommand(decision, body) {
  const errors = [];
  if (decision.kind === 'intake_clarification') {
    for (const key of ['answer', 'choice']) {
      if (body[key] !== undefined) errors.push({ field: key, message: 'not accepted for an intake clarification' });
    }
    const questions = Array.isArray(decision.request.questions) ? decision.request.questions : [];
    if (!Array.isArray(body.answers)) {
      errors.push({ field: 'answers', message: 'must be an array of { questionId, answer }' });
    } else {
      const seen = new Set();
      body.answers.forEach((entry, index) => {
        const at = `answers[${index}]`;
        if (!isPlainObject(entry)) { errors.push({ field: at, message: 'must be an object' }); return; }
        for (const key of Object.keys(entry)) {
          if (key !== 'questionId' && key !== 'answer') errors.push({ field: `${at}.${key}`, message: 'unknown field' });
        }
        if (typeof entry.questionId !== 'string' || !questions.some((q) => q.id === entry.questionId)) {
          errors.push({ field: `${at}.questionId`, message: 'must name a pending question' });
        } else if (seen.has(entry.questionId)) {
          errors.push({ field: `${at}.questionId`, message: 'is answered twice' });
        } else {
          seen.add(entry.questionId);
        }
        if (checkString(errors, `${at}.answer`, entry.answer)) {
          if (entry.answer.trim().length < 1 || entry.answer.length > ANSWER_MAX) {
            errors.push({ field: `${at}.answer`, message: `must be 1..${ANSWER_MAX} characters` });
          }
        }
      });
      for (const question of questions) {
        if (!seen.has(question.id)) errors.push({ field: 'answers', message: `question "${question.id}" is not answered` });
      }
    }
    if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
    return { answers: body.answers.map((entry) => ({ questionId: entry.questionId, answer: entry.answer.trim() })) };
  }
  if (body.answers !== undefined) errors.push({ field: 'answers', message: 'not accepted for a lead decision' });
  if (checkString(errors, 'answer', body.answer)) {
    if (body.answer.trim().length < 1 || body.answer.length > LEAD_ANSWER_MAX) {
      errors.push({ field: 'answer', message: `must be 1..${LEAD_ANSWER_MAX} characters` });
    }
  }
  const options = Array.isArray(decision.request.options) ? decision.request.options : [];
  if (body.choice !== undefined && (typeof body.choice !== 'string' || !options.some((o) => o.id === body.choice))) {
    errors.push({ field: 'choice', message: 'must match one of the decision option ids' });
  }
  if (body.choice === undefined && options.length > 0) {
    errors.push({ field: 'choice', message: 'is required when the decision has options' });
  }
  if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
  return { answer: body.answer.trim(), ...(body.choice !== undefined ? { choice: body.choice } : {}) };
}

class ProductStore {
  constructor({ db, projectId, now, randomId, events } = {}) {
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
    this.events = events || null;
    this.stmts = {};
  }

  // Diagnostic only; the journal never throws and never drives state.
  emit(type, { ticketId, runId, payload } = {}) {
    if (!this.events) return;
    try { this.events.record(type, { ticketId, runId, payload }); } catch (_) { /* diagnostic only */ }
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

  // Operator attachments only; run outputs such as candidate diffs are read through their owning record.
  listTicketArtifacts(ticketId) {
    return this.stmt("SELECT * FROM artifacts WHERE ticket_id = ? AND kind = 'attachment' ORDER BY created_at ASC, artifact_id ASC")
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
      if (ticket.status === 'backlog') {
        this.requireVersion(ticket, body.expectedVersion);
        this.stmt("UPDATE tickets SET status = 'cancelled', version = version + 1, updated_at = ? WHERE ticket_id = ?")
          .run(at, ticket.ticketId);
        return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId };
      }
      if (ticket.status !== 'waiting_human' && ticket.status !== 'blocked') {
        if (ticket.status === 'pending' || ticket.status === 'in_progress') {
          throw new ProductError('invalid_state', 'Stopping active work arrives in M7');
        }
        throw new ProductError('invalid_state', `ticket is ${ticket.status}; cancel is available for backlog, waiting_human and blocked tickets`);
      }
      const run = this.latestRunOf(ticket.ticketId);
      if (run && run.status === 'running') {
        throw new ProductError('invalid_state', 'Stopping active work arrives in M7');
      }
      this.requireVersion(ticket, body.expectedVersion);
      if (run) {
        this.stmt("UPDATE decisions SET state = 'stale' WHERE ticket_id = ? AND state = 'pending'").run(ticket.ticketId);
        if (run.status !== 'failed') {
          this.stmt(
            "UPDATE runs SET status = 'cancelled', phase = 'settled', wait_reason = NULL, wait_detail_json = NULL, "
            + 'finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE run_id = ?',
          ).run(at, at, run.runId);
        }
      }
      this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(ticket.ticketId);
      this.stmt("UPDATE tickets SET status = 'cancelled', version = version + 1, updated_at = ? WHERE ticket_id = ?")
        .run(at, ticket.ticketId);
      return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId };
    });
  }

  // ------------------------------------------------------------ runs (M3)

  tx(fn) {
    return this.db.transaction(fn).immediate();
  }

  getRun(runId) {
    const row = this.stmt('SELECT * FROM runs WHERE run_id = ?').get(String(runId));
    return row ? runFromRow(row) : null;
  }

  latestRunOf(ticketId) {
    const row = this.stmt('SELECT * FROM runs WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(String(ticketId));
    return row ? runFromRow(row) : null;
  }

  getActiveRun(ticketId) {
    const row = this.stmt(
      "SELECT * FROM runs WHERE ticket_id = ? AND status IN ('queued','running','paused','interrupted') ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(String(ticketId));
    return row ? runFromRow(row) : null;
  }

  // Run summaries of a ticket, newest first.
  listRuns(ticketId) {
    return this.stmt('SELECT * FROM runs WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(String(ticketId)).map((row) => runSummary(runFromRow(row)));
  }

  // Non-terminal runs, oldest first (the controller's work list).
  listActiveRuns() {
    return this.stmt("SELECT * FROM runs WHERE status IN ('queued','running','paused','interrupted') ORDER BY created_at ASC, rowid ASC")
      .all().map(runFromRow);
  }

  getLease(projectId = this.projectId) {
    const row = this.stmt('SELECT * FROM repository_leases WHERE project_id = ?').get(String(projectId));
    return row ? { projectId: row.project_id, runId: row.run_id, ticketId: row.ticket_id, acquiredAt: row.acquired_at } : null;
  }

  getPlanRevision(planRevisionId) {
    const row = this.stmt('SELECT * FROM plan_revisions WHERE plan_revision_id = ?').get(String(planRevisionId));
    return row ? planFromRow(row) : null;
  }

  listIntakeRecords(runId) {
    return this.stmt('SELECT * FROM intake_results WHERE run_id = ? ORDER BY turn ASC').all(String(runId)).map(intakeRecordFromRow);
  }

  getDecision(decisionId) {
    const row = this.stmt('SELECT * FROM decisions WHERE decision_id = ?').get(String(decisionId));
    return row ? decisionFromRow(row) : null;
  }

  listDecisions(runId) {
    return this.stmt('SELECT * FROM decisions WHERE run_id = ? ORDER BY created_at ASC, rowid ASC').all(String(runId)).map(decisionFromRow);
  }

  // The lead's own decision id is stored inside the lead pause payload.
  findLeadDecision(runId, leadDecisionId) {
    const row = this.stmt(
      "SELECT * FROM decisions WHERE run_id = ? AND kind = 'lead_decision' AND json_extract(request_json, '$.decisionId') = ?",
    ).get(String(runId), String(leadDecisionId));
    return row ? decisionFromRow(row) : null;
  }

  getCandidate(candidateId) {
    const row = this.stmt('SELECT * FROM candidates WHERE candidate_id = ?').get(String(candidateId));
    return row ? candidateFromRow(row) : null;
  }

  isTicketBranch(branchName, ticketId) {
    const row = this.stmt('SELECT ticket_id FROM ticket_branches WHERE branch_name = ?').get(String(branchName));
    return Boolean(row) && row.ticket_id === String(ticketId);
  }

  // Pinned run read shapes (D-M3-7). `stages` overrides the stored/derived stage list (live journal view).
  getRunView(runId, { stages } = {}) {
    const run = this.getRun(runId);
    if (!run) return null;
    const plan = run.planRevisionId ? this.getPlanRevision(run.planRevisionId) : null;
    const candidate = run.candidateId ? this.getCandidate(run.candidateId) : null;
    return {
      run: runSummary(run),
      intake: this.listIntakeRecords(run.runId).map(intakeView),
      plan: plan ? planView(plan) : null,
      decisions: this.listDecisions(run.runId).map(decisionView),
      stages: Array.isArray(stages) ? stages : this.stageView(plan, candidate),
      leadTaskCardId: run.leadTaskId
        ? CARD_ID_PREFIX + Buffer.from(`orchestrator\u0000\u0000${run.leadTaskId}`, 'utf8').toString('base64url')
        : null,
      candidate: candidate ? candidateView(candidate) : null,
      settings: run.settings,
    };
  }

  // Stage list from the plan plus the stage results captured with the candidate.
  stageView(plan, candidate) {
    if (!plan) return [];
    const recorded = new Map(((candidate && candidate.acceptance && candidate.acceptance.stages) || []).map((entry) => [entry.stageId, entry]));
    const succeeded = new Set([...recorded.values()].filter((entry) => entry.status === 'succeeded').map((entry) => entry.stageId));
    return plan.stages.map((stage) => {
      const entry = recorded.get(stage.stageId);
      let status = entry && ['succeeded', 'failed'].includes(entry.status) ? entry.status : 'pending';
      if (status === 'pending' && stage.dependencies.every((dep) => succeeded.has(dep))) status = 'eligible';
      return {
        stageId: stage.stageId,
        roleId: stage.roleId,
        required: stage.required,
        status,
        attempts: ((entry && entry.attemptIds) || []).map((attemptId) => this.attemptView(attemptId)),
      };
    });
  }

  attemptView(attemptId) {
    let row = null;
    try {
      row = this.db.prepare('SELECT attempt_id, role, state, result_json FROM dispatch_journal WHERE attempt_id = ?').get(String(attemptId));
    } catch (_) { row = null; }
    const result = row ? parseJson(row.result_json, null) : null;
    const outcome = result && typeof result === 'object'
      ? (['outcome', 'status', 'state'].map((key) => result[key]).find((value) => typeof value === 'string') || null)
      : null;
    return { attemptId, role: row ? row.role : null, journalState: row ? row.state : null, outcome };
  }

  // ---------------------------------------------------- run commands (M3)

  // `settingsSnapshot` is captured by the caller (delivery controller) and pinned on the run.
  submitTicket(ticketId, command, settingsSnapshot) {
    if (!isPlainObject(settingsSnapshot)) throw new TypeError('submitTicket requires a settings snapshot object');
    const result = this.runCommand('submit', String(ticketId), command, ['commandId', 'expectedVersion'], (body, at) => {
      const ticket = this.requireTicket(ticketId);
      if (ticket.status !== 'backlog' && ticket.status !== 'blocked') {
        throw new ProductError('invalid_state', `ticket is ${ticket.status}; only backlog or blocked tickets can be submitted`);
      }
      this.requireVersion(ticket, body.expectedVersion);
      if (this.getActiveRun(ticket.ticketId)) throw new ProductError('invalid_state', 'ticket already has an active run');
      if (ticket.status === 'blocked' && !this.latestRunOf(ticket.ticketId)) {
        throw new ProductError('invalid_state', 'a blocked ticket can be submitted again only after a settled run');
      }
      const runId = this.randomId('run_');
      this.stmt(
        'INSERT INTO runs (run_id, ticket_id, revision_id, project_id, status, phase, settings_snapshot_json, '
        + 'intake_turns, command_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
      ).run(runId, ticket.ticketId, ticket.currentRevisionId, this.projectId, 'queued', 'queued',
        JSON.stringify(settingsSnapshot), body.commandId, at, at);
      this.setTicketStatus(ticket.ticketId, 'pending', at);
      return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId, extra: { run: runSummary(this.getRun(runId)) } };
    });
    if (!result.replayed) this.emit('run_queued', { ticketId: result.ticket.ticketId, runId: result.run.runId, payload: { status: 'queued' } });
    return result;
  }

  // Answers a pending decision. Intake: { answers: [{ questionId, answer }] }; lead: { answer, choice? }.
  answerDecision(ticketId, decisionId, command) {
    const result = this.runCommand('answer', `${String(ticketId)}:${String(decisionId)}`, command,
      ['commandId', 'expectedVersion', 'answers', 'answer', 'choice'], (body, at) => {
        const ticket = this.requireTicket(ticketId);
        const decision = this.getDecision(decisionId);
        if (!decision || decision.ticketId !== ticket.ticketId) throw new ProductError('not_found', 'decision not found');
        this.requireVersion(ticket, body.expectedVersion);
        const run = this.getRun(decision.runId);
        if (decision.state !== 'pending' || !run || !ACTIVE_RUN_STATUSES.includes(run.status) || ticket.status !== 'waiting_human') {
          throw new ProductError('stale_decision', 'the decision is no longer pending');
        }
        const answer = validateAnswerCommand(decision, body);
        this.stmt("UPDATE decisions SET state = 'answered', answer_json = ?, actor = 'operator', answered_at = ? WHERE decision_id = ?")
          .run(JSON.stringify(answer), at, decision.decisionId);
        const patch = { status: 'running', wait_reason: null, wait_detail_json: null };
        if (decision.kind === 'intake_clarification') patch.phase = 'intake';
        this.patchRun(run.runId, patch, at);
        this.setTicketStatus(ticket.ticketId, 'in_progress', at);
        return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId, extra: { decision: decisionView(this.getDecision(decision.decisionId)) } };
      });
    if (!result.replayed) {
      this.emit('decision_answered', { ticketId: result.ticket.ticketId, runId: result.decision ? this.getDecision(decisionId)?.runId : undefined, payload: { kind: result.decision?.kind } });
    }
    return result;
  }

  // ------------------------------------------ controller writes (one transaction each)

  setTicketStatus(ticketId, status, at) {
    const info = this.stmt('UPDATE tickets SET status = ?, version = version + 1, updated_at = ? WHERE ticket_id = ? AND status <> ?')
      .run(status, at, ticketId, status);
    return info.changes > 0;
  }

  // Column whitelist keeps dynamic SQL limited to known run columns.
  patchRun(runId, fields, at) {
    const allowed = new Set(['status', 'phase', 'wait_reason', 'wait_detail_json', 'plan_revision_id', 'lead_task_id',
      'lead_context_id', 'branch_name', 'base_commit', 'candidate_id', 'intake_turns', 'started_at', 'finished_at']);
    const keys = Object.keys(fields).filter((key) => allowed.has(key));
    const sets = keys.map((key) => `${key} = ?`).concat('updated_at = ?');
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...keys.map((key) => fields[key]), at, runId);
  }

  insertIntakeResult(run, { turn, output, valid, errors }, at) {
    this.stmt(
      'INSERT INTO intake_results (intake_id, run_id, turn, output_json, valid, errors_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(this.randomId('itk_'), run.runId, turn, JSON.stringify(output === undefined ? null : output), valid ? 1 : 0,
      JSON.stringify(errors || []), at);
  }

  // Queued -> running/intake when the repository lease is free or already this ticket's.
  acquireLease(runId) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.status !== 'queued') return { acquired: false, holder: null };
      const at = this.now();
      const lease = this.getLease(run.projectId);
      let blocker = null;
      if (lease && lease.ticketId !== run.ticketId) {
        blocker = { ticketId: lease.ticketId, runId: lease.runId };
      } else if (!lease) {
        const older = this.stmt(
          "SELECT run_id FROM runs WHERE project_id = ? AND status = 'queued' AND run_id <> ? "
          + 'AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM runs WHERE run_id = ?))) LIMIT 1',
        ).get(run.projectId, run.runId, run.createdAt, run.createdAt, run.runId);
        if (older) blocker = { ticketId: null, runId: older.run_id };
      }
      if (blocker) {
        const detail = {
          code: 'repository_busy',
          message: blocker.ticketId ? `Repository in use by ${blocker.ticketId}` : 'Waiting for earlier queued work',
        };
        const json = JSON.stringify(detail);
        if (run.waitReason !== 'dependency' || JSON.stringify(run.waitDetail) !== json) {
          this.patchRun(run.runId, { wait_reason: 'dependency', wait_detail_json: json }, at);
        }
        return { acquired: false, holder: blocker };
      }
      this.stmt('INSERT OR REPLACE INTO repository_leases (project_id, run_id, ticket_id, acquired_at) VALUES (?, ?, ?, ?)')
        .run(run.projectId, run.runId, run.ticketId, at);
      this.patchRun(run.runId, {
        status: 'running', phase: 'intake', wait_reason: null, wait_detail_json: null, started_at: run.startedAt || at,
      }, at);
      this.setTicketStatus(run.ticketId, 'in_progress', at);
      return { acquired: true, holder: null };
    });
  }

  // Intake turn is ready: save the immutable plan revision and move to the branch phase.
  saveIntakePlan(runId, { turn, output, classification, plan, checks, requirements, validatorVersion, reason = 'intake' }) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'intake' || run.status !== 'running') return null;
      const at = this.now();
      this.insertIntakeResult(run, { turn, output, valid: true, errors: [] }, at);
      const planRevisionId = this.randomId('plan_');
      this.stmt(
        'INSERT INTO plan_revisions (plan_revision_id, run_id, parent_plan_revision_id, classification, stages_json, '
        + 'check_ids_json, checks_json, requirements_json, validator_version, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(planRevisionId, run.runId, run.planRevisionId, classification, JSON.stringify(plan.stages),
        JSON.stringify(plan.checkIds), JSON.stringify(checks), JSON.stringify(requirements), validatorVersion, reason, at);
      this.patchRun(run.runId, { plan_revision_id: planRevisionId, intake_turns: turn, phase: 'branch' }, at);
      return this.getPlanRevision(planRevisionId);
    });
  }

  // Intake needs operator input: persist the questions and wait for the answer.
  requestIntakeAnswer(runId, { turn, output }) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'intake' || run.status !== 'running') return null;
      const at = this.now();
      this.insertIntakeResult(run, { turn, output, valid: true, errors: [] }, at);
      const decisionId = this.randomId('dec_');
      this.stmt(
        'INSERT INTO decisions (decision_id, kind, ticket_id, run_id, revision_id, plan_revision_id, state, request_json, created_at) '
        + "VALUES (?, 'intake_clarification', ?, ?, ?, NULL, 'pending', ?, ?)",
      ).run(decisionId, run.ticketId, run.runId, run.revisionId,
        JSON.stringify({ questions: output.questions.map((q) => ({ id: q.id, question: q.question, why: q.why })) }), at);
      this.patchRun(run.runId, {
        status: 'paused',
        phase: 'awaiting_answer',
        intake_turns: turn,
        wait_reason: 'human_decision',
        wait_detail_json: JSON.stringify({ code: 'intake_clarification', message: 'Intake needs answers before planning' }),
      }, at);
      this.setTicketStatus(run.ticketId, 'waiting_human', at);
      return this.getDecision(decisionId);
    });
  }

  // Ends a run without a candidate (or with a rejected one handled by completeRun). The lease stays held
  // unless releaseLease is set (the run had no repository effect).
  settleRun(runId, { status, ticketStatus, waitReason, waitDetail, intake, releaseLease }) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) return null;
      const at = this.now();
      if (intake) {
        this.insertIntakeResult(run, intake, at);
        this.patchRun(run.runId, { intake_turns: intake.turn }, at);
      }
      this.stmt("UPDATE decisions SET state = 'stale' WHERE run_id = ? AND state = 'pending'").run(run.runId);
      this.patchRun(run.runId, {
        status,
        phase: 'settled',
        wait_reason: waitReason || null,
        wait_detail_json: waitDetail ? JSON.stringify(waitDetail) : null,
        finished_at: at,
      }, at);
      if (releaseLease) this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(run.ticketId);
      this.setTicketStatus(run.ticketId, ticketStatus, at);
      return this.getRun(run.runId);
    });
  }

  // Intent record first: a crash between this and the branch creation keeps the branch ours.
  reserveBranch(branchName, ticketId) {
    const at = this.now();
    this.stmt('INSERT OR IGNORE INTO ticket_branches (branch_name, ticket_id, project_id, created_at) VALUES (?, ?, ?, ?)')
      .run(branchName, ticketId, this.projectId, at);
    return this.isTicketBranch(branchName, ticketId);
  }

  // Branch phase done; branchName is null for read-only plans.
  recordBranch(runId, { branchName, baseCommit }) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'branch' || run.status !== 'running') return null;
      this.patchRun(run.runId, { branch_name: branchName || null, base_commit: baseCommit, phase: 'engineering' }, this.now());
      return this.getRun(run.runId);
    });
  }

  recordLeadTask(runId, taskId, contextId) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'engineering' || run.leadTaskId) return null;
      this.patchRun(run.runId, { lead_task_id: taskId, lead_context_id: contextId || null }, this.now());
      return this.getRun(run.runId);
    });
  }

  // Mirrors the lead task state on the run and ticket. No-op (no version bump) when nothing changed.
  setExecutionState(runId, { status, ticketStatus, waitReason = null, waitDetail = null }) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'engineering' || !ACTIVE_RUN_STATUSES.includes(run.status)) return null;
      const at = this.now();
      const detailJson = waitDetail ? JSON.stringify(waitDetail) : null;
      if (run.status !== status || run.waitReason !== waitReason || (run.waitDetail ? JSON.stringify(run.waitDetail) : null) !== detailJson) {
        this.patchRun(run.runId, { status, wait_reason: waitReason, wait_detail_json: detailJson }, at);
      }
      this.setTicketStatus(run.ticketId, ticketStatus, at);
      return this.getRun(run.runId);
    });
  }

  // The lead paused for a human decision; `pause` is the lead pause payload (carries its own decisionId).
  requestLeadDecision(runId, pause) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'engineering' || !ACTIVE_RUN_STATUSES.includes(run.status)) return null;
      const existing = this.findLeadDecision(run.runId, pause.decisionId);
      if (existing) return existing;
      const at = this.now();
      const decisionId = this.randomId('dec_');
      this.stmt(
        'INSERT INTO decisions (decision_id, kind, ticket_id, run_id, revision_id, plan_revision_id, state, request_json, created_at) '
        + "VALUES (?, 'lead_decision', ?, ?, ?, ?, 'pending', ?, ?)",
      ).run(decisionId, run.ticketId, run.runId, run.revisionId, run.planRevisionId, JSON.stringify(pause), at);
      this.patchRun(run.runId, {
        status: 'paused',
        wait_reason: 'human_decision',
        wait_detail_json: JSON.stringify({ code: 'lead_decision', message: String(pause.question || 'The lead needs a decision').slice(0, 500) }),
      }, at);
      this.setTicketStatus(run.ticketId, 'waiting_human', at);
      return this.getDecision(decisionId);
    });
  }

  markDecisionStale(decisionId) {
    return this.stmt("UPDATE decisions SET state = 'stale' WHERE decision_id = ? AND state = 'pending'").run(String(decisionId)).changes > 0;
  }

  moveToCandidate(runId) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'engineering' || !ACTIVE_RUN_STATUSES.includes(run.status)) return null;
      this.patchRun(run.runId, { phase: 'candidate', status: 'running', wait_reason: null, wait_detail_json: null }, this.now());
      this.setTicketStatus(run.ticketId, 'in_progress', this.now());
      return this.getRun(run.runId);
    });
  }

  // Candidate captured. outcome 'review' -> waiting_human/human_review; 'blocked' -> blocked/execution_error.
  completeRun(runId, { candidate, diffArtifact, outcome, waitDetail }) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'candidate' || !ACTIVE_RUN_STATUSES.includes(run.status)) return null;
      const at = this.now();
      let diffArtifactId = null;
      if (diffArtifact) {
        diffArtifactId = diffArtifact.artifactId;
        this.stmt(
          'INSERT INTO artifacts (artifact_id, ticket_id, state, kind, media_type, display_name, size, sha256, storage_ref, '
          + "extraction, extracted_chars, extraction_truncated, origin, created_at) VALUES (?, ?, 'attached', 'candidate_diff', "
          + "'text/x-diff', ?, ?, ?, ?, 'reference_only', NULL, 0, 'system', ?)",
        ).run(diffArtifact.artifactId, run.ticketId, diffArtifact.displayName, diffArtifact.size, diffArtifact.sha256,
          diffArtifact.storageRef, at);
      }
      const candidateId = this.randomId('cand_');
      this.stmt(
        'INSERT INTO candidates (candidate_id, run_id, plan_revision_id, base_commit, head, branch, head_moved, manifest_json, '
        + 'diff_artifact_id, truncated, acceptance_json, integrity_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(candidateId, run.runId, run.planRevisionId, candidate.baseCommit, candidate.head || '', candidate.branch || '',
        candidate.headMoved ? 1 : 0, JSON.stringify(candidate.manifest), diffArtifactId, candidate.truncated ? 1 : 0,
        candidate.acceptance ? JSON.stringify(candidate.acceptance) : null, candidate.integrityHash, at);
      const review = outcome === 'review';
      this.patchRun(run.runId, {
        status: 'completed',
        phase: 'settled',
        candidate_id: candidateId,
        wait_reason: review ? 'human_review' : 'execution_error',
        wait_detail_json: JSON.stringify(review ? { code: 'human_review', message: 'The candidate is ready for review' } : waitDetail),
        finished_at: at,
      }, at);
      this.setTicketStatus(run.ticketId, review ? 'waiting_human' : 'blocked', at);
      return this.getCandidate(candidateId);
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
        ...(ids.extra || {}),
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

module.exports = {
  ProductStore, ProductError, LIMITS, SPECIALTIES, PRIORITIES, REFERENCE_KINDS, ACTIVE_RUN_STATUSES, canonicalJson, runSummary,
};
