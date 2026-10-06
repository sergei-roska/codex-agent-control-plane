'use strict';

const crypto = require('node:crypto');
const { SourceImportStore, SourceImportError } = require('./integrations/source-import-store');
const { bundleToIntakeInput } = require('./integrations/source-bundle');

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
const CONTROL_RANK = Object.freeze({ pause: 1, stop: 2, return_to_backlog: 3, cancel: 4 });
const OPEN_TICKET_STATUSES = Object.freeze(['pending', 'in_progress', 'paused', 'waiting_human', 'blocked']);
const REVIEW_VERDICTS = Object.freeze(['accept', 'corrections']);
const RUN_CONTROL_FIELDS = Object.freeze(['commandId', 'expectedVersion', 'runId']);
const REVIEW_FIELDS = Object.freeze(['commandId', 'expectedVersion', 'runId', 'candidateId', 'integrityHash', 'verdict', 'findings']);
const COMMIT_FIELDS = Object.freeze(['commandId', 'expectedVersion', 'candidateId', 'integrityHash', 'message']);
const PUSH_FIELDS = Object.freeze(['commandId', 'expectedVersion', 'deliveryId', 'commitSha', 'remote']);
const COMMAND_FIELDS = Object.freeze({
  pause: RUN_CONTROL_FIELDS,
  resume: RUN_CONTROL_FIELDS,
  stop: RUN_CONTROL_FIELDS,
  cancel: Object.freeze(['commandId', 'expectedVersion']),
  return_to_backlog: Object.freeze(['commandId', 'expectedVersion']),
  review: REVIEW_FIELDS,
  commit: COMMIT_FIELDS,
  push: PUSH_FIELDS,
  release_repository: Object.freeze(['commandId', 'expectedVersion']),
});
const FINDINGS_MAX = 8000;
const COMMIT_MESSAGE_MAX = 2000;
const MAX_REWORKS = 3;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const CONTENT_FIELDS = ['title', 'description', 'criteria', 'references', 'artifactIds', 'priority', 'requestedSpecialty'];

const STATUS_BY_CODE = Object.freeze({
  invalid_request: 400,
  not_found: 404,
  stale_version: 409,
  conflict: 409,
  invalid_state: 409,
  stale_decision: 409,
  settings_invalid: 409,
  catalog_unavailable: 503,
  command_conflict: 409,
  candidate_changed: 409,
  rework_exhausted: 409,
  git_failed: 502,
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
    controlRequest: row.control_request || null,
    controlCommandId: row.control_command_id || null,
    controlRequestedAt: row.control_requested_at || null,
    runKind: row.run_kind || 'initial',
    parentRunId: row.parent_run_id || null,
    reworkReviewId: row.rework_review_id || null,
  };
}

// Pinned run summary (D-M3-7).
function runSummary(run) {
  const waitDetail = run.waitDetail ? { ...run.waitDetail } : null;
  if (waitDetail && waitDetail.code === 'preflight_failed'
      && Array.isArray(waitDetail.problems)
      && waitDetail.problems.some((problem) => problem && problem.code === 'dirty_worktree')) {
    const base = typeof waitDetail.message === 'string' ? waitDetail.message : 'Repository preflight failed';
    waitDetail.message = `${base}. Inspect the checkout with git status --short and git diff; preserve wanted changes before cleaning it. No files were removed.`;
  }
  return {
    runId: run.runId,
    ticketId: run.ticketId,
    revisionId: run.revisionId,
    status: run.status,
    phase: run.phase,
    waitReason: run.waitReason || null,
    waitDetail,
    planRevisionId: run.planRevisionId || null,
    branchName: run.branchName || null,
    baseCommit: run.baseCommit || null,
    candidateId: run.candidateId || null,
    createdAt: run.createdAt,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    updatedAt: run.updatedAt,
    controlRequest: run.controlRequest || null,
    runKind: run.runKind || 'initial',
    parentRunId: run.parentRunId || null,
  };
}

function reviewFromRow(row) {
  return {
    reviewId: row.review_id,
    ticketId: row.ticket_id,
    runId: row.run_id,
    revisionId: row.revision_id,
    planRevisionId: row.plan_revision_id,
    candidateId: row.candidate_id,
    integrityHash: row.integrity_hash,
    verdict: row.verdict,
    findings: row.findings,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

function deliveryFromRow(row) {
  return {
    deliveryId: row.delivery_id,
    ticketId: row.ticket_id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    reviewId: row.review_id,
    kind: row.kind,
    state: row.state,
    parentDeliveryId: row.parent_delivery_id,
    branch: row.branch,
    baseHead: row.base_head,
    commitSha: row.commit_sha,
    remote: row.remote,
    remoteRef: row.remote_ref,
    message: row.message,
    error: parseJson(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    ...(row.preset_id ? {
      presetId: row.preset_id, presetVersion: row.preset_version, rolePack: row.role_pack, rolePackVersion: row.role_pack_version,
    } : {}),
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
    ...(plan.presetId ? {
      presetId: plan.presetId, presetVersion: plan.presetVersion, rolePack: plan.rolePack, rolePackVersion: plan.rolePackVersion,
    } : {}),
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
        warnings: Array.isArray(acceptance.warnings) ? acceptance.warnings : [],
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
    this.sourceImports = new SourceImportStore({ db, now: () => this.now(), randomId: this.randomId });
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

  // ------------------------------------------------------ source reads (M6)

  getTicketSource(ticketId) {
    const ticket = this.getTicket(String(ticketId));
    if (!ticket || ticket.projectId !== this.projectId) return null;
    const identity = this.stmt('SELECT * FROM m6_source_identities WHERE ticket_id = ? AND project_id = ?')
      .get(ticket.ticketId, this.projectId);
    if (!identity) return null;
    const applied = this.stmt(`SELECT l.snapshot_id FROM ticket_source_revision_links l
      JOIN requirement_revisions r ON r.revision_id = l.revision_id
      WHERE l.ticket_id = ? ORDER BY r.ordinal DESC LIMIT 1`).get(ticket.ticketId);
    const latest = identity.latest_snapshot_id ? this.sourceSnapshotMeta(identity.latest_snapshot_id) : null;
    const latestAvailable = identity.latest_available_snapshot_id
      ? this.sourceSnapshotMeta(identity.latest_available_snapshot_id) : null;
    const appliedSnapshotId = applied?.snapshot_id || null;
    // Pending is an available snapshot whose content differs from the applied content;
    // unavailable observations stay in history only.
    const appliedMeta = appliedSnapshotId ? this.sourceSnapshotMeta(appliedSnapshotId) : null;
    const pendingSnapshotId = latestAvailable && latestAvailable.snapshotId !== appliedSnapshotId
      && latestAvailable.contentHash !== appliedMeta?.contentHash
      ? latestAvailable.snapshotId : null;
    return {
      identityId: identity.identity_id,
      sourceKind: identity.source_kind,
      originId: identity.origin_id,
      externalId: identity.external_id,
      ticketId: identity.ticket_id,
      latestSnapshotId: identity.latest_snapshot_id,
      latestAvailableSnapshotId: identity.latest_available_snapshot_id,
      appliedSnapshotId,
      pendingSnapshotId,
      pending: Boolean(pendingSnapshotId),
      rootAvailable: latest ? latest.rootAvailable : false,
      latestAvailableRootAvailable: latestAvailable ? latestAvailable.rootAvailable : false,
      displayKey: latest?.displayKey || latestAvailable?.displayKey || null,
      sourceRevision: latest?.rootSourceRevision || latestAvailable?.rootSourceRevision || null,
      fetchedAt: latest?.fetchedAt || null,
    };
  }

  getRevisionSource(ticketId, revisionId) {
    const revision = this.getRevision(String(ticketId), String(revisionId));
    if (!revision) return null;
    const row = this.stmt(`SELECT l.*, s.content_hash, s.fetched_at, s.recorded_at, s.root_available,
      json_extract(s.bundle_json, '$.root.sourceKind') AS root_source_kind,
      json_extract(s.bundle_json, '$.root.originId') AS root_origin_id,
      json_extract(s.bundle_json, '$.root.externalId') AS root_external_id,
      json_extract(s.bundle_json, '$.root.displayKey') AS root_display_key
      FROM ticket_source_revision_links l JOIN m6_source_snapshots s ON s.snapshot_id = l.snapshot_id
      JOIN m6_source_identities i ON i.identity_id = l.identity_id
      WHERE l.ticket_id = ? AND l.revision_id = ? AND i.project_id = ? AND i.ticket_id = ?`)
      .get(String(ticketId), String(revisionId), this.projectId, String(ticketId));
    if (!row) return null;
    const documents = this.stmt(`SELECT json_extract(j.value, '$.sourceKind') AS source_kind,
      json_extract(j.value, '$.originId') AS origin_id,
      json_extract(j.value, '$.externalId') AS external_id,
      json_extract(j.value, '$.displayKey') AS display_key,
      json_extract(j.value, '$.availability') AS availability,
      json_extract(j.value, '$.title') AS title,
      json_extract(j.value, '$.url') AS url,
      json_extract(j.value, '$.sourceRevision') AS source_revision
      FROM m6_source_snapshots s, json_each(s.bundle_json, '$.documents') j
      WHERE s.snapshot_id = ? ORDER BY CAST(j.key AS INTEGER) LIMIT 20`).all(row.snapshot_id);
    return {
      revisionId: row.revision_id,
      ticketId: row.ticket_id,
      identityId: row.identity_id,
      snapshotId: row.snapshot_id,
      artifactId: row.artifact_id,
      rootAvailable: Boolean(row.root_available),
      fetchedAt: row.fetched_at,
      recordedAt: row.recorded_at,
      contentHash: row.content_hash,
      root: { sourceKind: row.root_source_kind, originId: row.root_origin_id,
        externalId: row.root_external_id, displayKey: row.root_display_key || null },
      documents: documents.map((doc) => ({ sourceKind: doc.source_kind, originId: doc.origin_id,
        externalId: doc.external_id, displayKey: doc.display_key || null, availability: doc.availability,
        title: doc.title, url: doc.url, sourceRevision: doc.source_revision || null })),
    };
  }

  getTicketSourceHistory(ticketId, { beforeOrdinal, limit = 50 } = {}) {
    const source = this.getTicketSource(ticketId);
    if (!source) return null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('source history limit must be 1..100');
    if (beforeOrdinal !== undefined && (!Number.isInteger(beforeOrdinal) || beforeOrdinal < 1)) {
      throw invalid('source history beforeOrdinal must be a positive integer');
    }
    const rows = this.stmt(`SELECT snapshot_id, identity_id, ordinal, parent_snapshot_id, content_hash,
      fetched_at, recorded_at, root_available,
      json_extract(bundle_json, '$.root.displayKey') AS display_key,
      json_array_length(bundle_json, '$.documents') AS document_count
      FROM m6_source_snapshots
      WHERE identity_id = ? AND (? IS NULL OR ordinal < ?)
      ORDER BY ordinal DESC LIMIT ?`).all(source.identityId,
      beforeOrdinal === undefined ? null : beforeOrdinal, beforeOrdinal === undefined ? null : beforeOrdinal, limit + 1);
    const hasMore = rows.length > limit;
    const snapshots = rows.slice(0, limit).map((row) => this.sourceSnapshotSummary(row));
    return {
      snapshots,
      nextBeforeOrdinal: hasMore && snapshots.length ? snapshots[snapshots.length - 1].ordinal : null,
    };
  }

  getTicketSourceSnapshot(ticketId, snapshotId) {
    const source = this.getTicketSource(ticketId);
    if (!source) return null;
    const belongs = this.stmt(`SELECT 1 FROM m6_source_snapshots s JOIN m6_source_identities i ON i.identity_id = s.identity_id
      WHERE s.snapshot_id = ? AND i.identity_id = ? AND i.project_id = ? AND i.ticket_id = ?`)
      .get(String(snapshotId), source.identityId, this.projectId, String(ticketId));
    if (!belongs) return null;
    const snapshot = this.sourceImports.getSnapshot(String(snapshotId));
    if (!snapshot) return null;
    return snapshot;
  }

  sourceSnapshotMeta(snapshotId) {
    const row = this.stmt(`SELECT snapshot_id, identity_id, ordinal, parent_snapshot_id, content_hash,
      fetched_at, recorded_at, root_available,
      json_extract(bundle_json, '$.root.displayKey') AS display_key,
      json_array_length(bundle_json, '$.documents') AS document_count,
      (SELECT json_extract(j.value, '$.sourceRevision') FROM json_each(m6_source_snapshots.bundle_json, '$.documents') j
        WHERE json_extract(j.value, '$.sourceKind') = json_extract(m6_source_snapshots.bundle_json, '$.root.sourceKind')
          AND json_extract(j.value, '$.originId') = json_extract(m6_source_snapshots.bundle_json, '$.root.originId')
          AND json_extract(j.value, '$.externalId') = json_extract(m6_source_snapshots.bundle_json, '$.root.externalId') LIMIT 1) AS root_source_revision
      FROM m6_source_snapshots WHERE snapshot_id = ?`).get(String(snapshotId));
    return row ? {
      snapshotId: row.snapshot_id, identityId: row.identity_id, ordinal: row.ordinal,
      parentSnapshotId: row.parent_snapshot_id, contentHash: row.content_hash, fetchedAt: row.fetched_at,
      recordedAt: row.recorded_at, rootAvailable: Boolean(row.root_available), displayKey: row.display_key || null,
      documentCount: row.document_count, rootSourceRevision: row.root_source_revision || null,
    } : null;
  }

  sourceSnapshotSummary(snapshot) {
    const row = snapshot;
    return {
      snapshotId: row.snapshot_id,
      identityId: row.identity_id,
      ordinal: row.ordinal,
      parentSnapshotId: row.parent_snapshot_id,
      contentHash: row.content_hash,
      fetchedAt: row.fetched_at,
      recordedAt: row.recorded_at,
      rootAvailable: Boolean(row.root_available),
      documentCount: row.document_count,
      displayKey: row.display_key || null,
    };
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

  getSourceCommandResult({ commandId, kind, request } = {}) {
    const normalized = this.validateSourceCommand(commandId, kind, request);
    const fingerprint = sha256(canonicalJson({ projectId: this.projectId, request: normalized }));
    const row = this.stmt('SELECT kind, payload_sha256, result_json FROM product_commands WHERE command_id = ?')
      .get(commandId);
    if (!row) return null;
    if (row.kind !== kind || row.payload_sha256 !== fingerprint) {
      throw new ProductError('command_conflict', 'commandId was already used with a different source command');
    }
    return { ...JSON.parse(row.result_json), replayed: true };
  }

  importSourceBundle({ commandId, request, bundle, artifact } = {}) {
    this.validateSourceCommand(commandId, 'source_import', request);
    const replay = this.getSourceCommandResult({ commandId, kind: 'source_import', request });
    if (replay) return replay;
    this.validateJiraRoot(bundle, request);
    const root = bundle.root;
    const fingerprint = sha256(canonicalJson({ projectId: this.projectId, request }));
    return this.db.transaction(() => {
      const prior = this.stmt('SELECT kind, payload_sha256, result_json FROM product_commands WHERE command_id = ?')
        .get(commandId);
      if (prior) return this.resolveSourceCommandRow(prior, 'source_import', fingerprint);

      // Identity lookup is repeated under the same immediate transaction to
      // serialize concurrent imports from separate SQLite connections.
      const identity = this.sourceImports.getIdentity({ projectId: this.projectId, sourceKind: 'jira',
        originId: request.originId, externalId: root.externalId });
      if (identity?.ticketId) {
        const result = {
          ticket: this.getTicket(identity.ticketId),
          revision: this.getTicket(identity.ticketId) && this.getRevision(identity.ticketId, this.getTicket(identity.ticketId).currentRevisionId),
          source: this.getTicketSource(identity.ticketId),
          duplicate: true, applied: false, changed: false, artifactAttached: false,
        };
        this.recordSourceCommand(commandId, 'source_import', fingerprint, result);
        return { ...result, replayed: false };
      }

      const recorded = this.sourceImports.recordSnapshot({ projectId: this.projectId, bundle });
      const snapshot = this.sourceImports.getSnapshot(recorded.snapshotId);
      if (!snapshot.rootAvailable) throw new ProductError('invalid_request', 'Jira source root must be available to create a ticket');
      const input = bundleToIntakeInput(snapshot.bundle);
      const ticketId = this.randomId('tkt_');
      const revisionId = this.randomId('rev_');
      const at = this.now();
      if (!isPlainObject(artifact) || typeof artifact.artifactId !== 'string') throw invalid('persisted source evidence artifact is required');
      input.revision.artifactIds = [artifact.artifactId];
      const content = validateContent(input.revision);
      this.stmt(
        'INSERT INTO tickets (ticket_id, project_id, source, title, priority, status, current_revision_id, '
        + 'version, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      ).run(ticketId, this.projectId, 'jira', content.title, content.priority, 'backlog', revisionId, at, at, 'operator');
      const artifactId = this.insertSourceArtifact(artifact, ticketId, at);
      this.insertRevision(revisionId, ticketId, null, 1, content, commandId, at);
      this.sourceImports.bindTicket({ identityId: recorded.identityId, ticketId });
      this.linkSourceRevision(revisionId, ticketId, recorded.identityId, recorded.snapshotId, artifactId, at);
      const result = {
        ticket: this.getTicket(ticketId), revision: this.getRevision(ticketId, revisionId),
        source: this.getTicketSource(ticketId), duplicate: false, applied: true,
        changed: true, artifactAttached: true,
      };
      this.recordSourceCommand(commandId, 'source_import', fingerprint, result);
      return { ...result, replayed: false };
    }).immediate();
  }

  refreshSourceBundle(ticketId, { commandId, request, bundle, artifact, expectedVersion } = {}) {
    const canonicalRequest = request || { ticketId: String(ticketId), expectedVersion };
    this.validateSourceCommand(commandId, 'source_refresh', canonicalRequest);
    const replay = this.getSourceCommandResult({ commandId, kind: 'source_refresh', request: canonicalRequest });
    if (replay) return replay;
    if (canonicalRequest.ticketId !== String(ticketId)) throw invalid('source refresh ticket does not match request');
    const fingerprint = sha256(canonicalJson({ projectId: this.projectId, request: canonicalRequest }));
    return this.db.transaction(() => {
      const prior = this.stmt('SELECT kind, payload_sha256, result_json FROM product_commands WHERE command_id = ?')
        .get(commandId);
      if (prior) return this.resolveSourceCommandRow(prior, 'source_refresh', fingerprint);
      const ticket = this.requireTicket(ticketId);
      if (ticket.projectId !== this.projectId) throw new ProductError('not_found', 'ticket not found');
      this.requireVersion(ticket, canonicalRequest.expectedVersion);
      const identityRow = this.stmt(`SELECT * FROM m6_source_identities
        WHERE ticket_id = ? AND project_id = ? AND source_kind = 'jira'`).get(ticket.ticketId, this.projectId);
      if (!identityRow) throw new ProductError('not_found', 'ticket has no linked Jira source');
      this.validateJiraRoot(bundle, { originId: identityRow.origin_id }, identityRow.external_id);
      const recorded = this.sourceImports.recordSnapshot({ projectId: this.projectId, bundle });
      const snapshot = this.sourceImports.getSnapshot(recorded.snapshotId);
      const appliedRow = this.stmt(`SELECT l.snapshot_id FROM ticket_source_revision_links l
        JOIN requirement_revisions r ON r.revision_id = l.revision_id
        WHERE l.ticket_id = ? ORDER BY r.ordinal DESC LIMIT 1`).get(ticket.ticketId);
      // Compare content, not snapshot identity: A -> unavailable -> A records a new snapshot with A's content.
      const appliedHash = appliedRow
        ? this.stmt('SELECT content_hash FROM m6_source_snapshots WHERE snapshot_id = ?').get(appliedRow.snapshot_id)?.content_hash
        : null;
      const alreadyApplied = appliedRow?.snapshot_id === snapshot.snapshotId || appliedHash === snapshot.contentHash;
      const changed = snapshot.rootAvailable ? !alreadyApplied : recorded.changed;
      let applied = false;
      let artifactAttached = false;
      let revision = this.getRevision(ticket.ticketId, ticket.currentRevisionId);
      const at = this.now();
      if (snapshot.rootAvailable && !alreadyApplied && ticket.status === 'backlog') {
        const input = bundleToIntakeInput(snapshot.bundle);
        const revisionId = this.randomId('rev_');
        const artifactId = this.insertSourceArtifact(artifact, ticket.ticketId, at);
        input.revision.artifactIds = [artifactId];
        const content = validateContent(input.revision);
        const parent = this.stmt('SELECT revision_id, ordinal FROM requirement_revisions WHERE revision_id = ?')
          .get(ticket.currentRevisionId);
        this.insertRevision(revisionId, ticket.ticketId, parent.revision_id, parent.ordinal + 1, content, commandId, at);
        this.linkSourceRevision(revisionId, ticket.ticketId, identityRow.identity_id, snapshot.snapshotId, artifactId, at);
        this.stmt('UPDATE tickets SET title = ?, priority = ?, current_revision_id = ?, version = version + 1, updated_at = ? WHERE ticket_id = ?')
          .run(content.title, content.priority, revisionId, at, ticket.ticketId);
        revision = this.getRevision(ticket.ticketId, revisionId);
        applied = true;
        artifactAttached = true;
      }
      const result = {
        ticket: this.getTicket(ticket.ticketId), revision,
        source: this.getTicketSource(ticket.ticketId), duplicate: false, applied,
        changed, artifactAttached,
      };
      this.recordSourceCommand(commandId, 'source_refresh', fingerprint, result);
      return { ...result, replayed: false };
    }).immediate();
  }

  validateSourceCommand(commandId, kind, request) {
    if (typeof commandId !== 'string' || !COMMAND_ID_RE.test(commandId)) throw invalid('commandId is invalid');
    if (!['source_import', 'source_refresh'].includes(kind)) throw invalid('source command kind is invalid');
    if (!isPlainObject(request)) throw invalid('source request must be an object');
    const fields = kind === 'source_import' ? ['originId', 'issueIdOrKey'] : ['ticketId', 'expectedVersion'];
    if (Object.keys(request).some((key) => !fields.includes(key)) || fields.some((key) => !(key in request))) {
      throw invalid('source request fields are invalid');
    }
    if (kind === 'source_import') {
      for (const field of fields) {
        if (typeof request[field] !== 'string' || request[field].length < 1 || request[field].length > 256 || CONTROL_RE.test(request[field])) {
          throw invalid(`source request ${field} is invalid`);
        }
      }
    } else if (typeof request.ticketId !== 'string' || request.ticketId.length < 1 || request.ticketId.length > 256
      || CONTROL_RE.test(request.ticketId) || !Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
      throw invalid('source refresh request is invalid');
    }
    return kind === 'source_import'
      ? { originId: request.originId, issueIdOrKey: request.issueIdOrKey }
      : { ticketId: request.ticketId, expectedVersion: request.expectedVersion };
  }

  validateJiraRoot(bundle, request, expectedExternalId) {
    if (!bundle || !bundle.root || bundle.root.sourceKind !== 'jira'
      || bundle.root.originId !== request.originId || !/^\d+$/.test(String(bundle.root.externalId || ''))
      || (expectedExternalId && bundle.root.externalId !== expectedExternalId)) {
      throw new ProductError('invalid_request', 'source bundle must contain the requested immutable Jira issue identity');
    }
    const alias = bundle.root.displayKey || bundle.root.externalId;
    if (!expectedExternalId && request.issueIdOrKey !== alias && request.issueIdOrKey !== bundle.root.externalId) {
      throw new ProductError('invalid_request', 'source bundle Jira key does not match the requested issue');
    }
  }

  resolveSourceCommandRow(row, kind, fingerprint) {
    if (row.kind !== kind || row.payload_sha256 !== fingerprint) {
      throw new ProductError('command_conflict', 'commandId was already used with a different source command');
    }
    return { ...JSON.parse(row.result_json), replayed: true };
  }

  recordSourceCommand(commandId, kind, fingerprint, result) {
    this.stmt('INSERT INTO product_commands (command_id, kind, payload_sha256, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(commandId, kind, fingerprint, JSON.stringify(result), this.now());
  }

  insertSourceArtifact(meta, ticketId, at) {
    if (!isPlainObject(meta)) throw invalid('persisted source evidence artifact is required');
    const required = ['artifactId', 'displayName', 'mediaType', 'sha256', 'storageRef', 'extraction'];
    for (const field of required) {
      if (typeof meta[field] !== 'string' || meta[field].length < 1 || meta[field].length > 2048 || CONTROL_RE.test(meta[field])) {
        throw invalid(`source artifact ${field} is invalid`);
      }
    }
    if (!Number.isInteger(meta.size) || meta.size < 0 || meta.size > LIMITS.artifactBytes) throw invalid('source artifact size is invalid');
    if (!/^[a-f0-9]{64}$/i.test(meta.sha256)) throw invalid('source artifact digest is invalid');
    const existing = this.stmt('SELECT artifact_id FROM artifacts WHERE artifact_id = ?').get(meta.artifactId);
    if (existing) throw invalid('source artifact is already registered');
    this.stmt(`INSERT INTO artifacts (artifact_id, ticket_id, state, kind, media_type, display_name, size, sha256,
      storage_ref, extraction, extracted_chars, extraction_truncated, origin, created_at)
      VALUES (?, ?, 'attached', 'attachment', ?, ?, ?, ?, ?, ?, ?, ?, 'jira_import', ?)`)
      .run(meta.artifactId, ticketId, meta.mediaType, meta.displayName, meta.size, meta.sha256, meta.storageRef,
        meta.extraction, Number.isInteger(meta.extractedChars) ? meta.extractedChars : null,
        meta.extractionTruncated ? 1 : 0, at);
    return meta.artifactId;
  }

  linkSourceRevision(revisionId, ticketId, identityId, snapshotId, artifactId, at) {
    this.stmt(`INSERT INTO ticket_source_revision_links
      (revision_id, ticket_id, identity_id, snapshot_id, artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(revisionId, ticketId, identityId, snapshotId, artifactId, at);
  }

  reviseTicket(ticketId, command) {
    const result = this.runCommand('revise', String(ticketId), command,
      ['commandId', 'expectedVersion', ...CONTENT_FIELDS], (body, at) => {
        const content = validateContent(body);
        const ticket = this.requireTicket(ticketId);
        const staged = ticket.status !== 'backlog';
        if (staged && !OPEN_TICKET_STATUSES.includes(ticket.status)) {
          throw new ProductError('invalid_state', `ticket is ${ticket.status}; only open tickets accept this command`);
        }
        this.requireVersion(ticket, body.expectedVersion);
        // Open non-backlog tickets keep their current revision; the edit is staged (D-M7-1).
        const parent = staged
          ? this.stmt('SELECT revision_id, ordinal FROM requirement_revisions WHERE ticket_id = ? ORDER BY ordinal DESC LIMIT 1').get(ticket.ticketId)
          : this.stmt('SELECT revision_id, ordinal FROM requirement_revisions WHERE revision_id = ?').get(ticket.currentRevisionId);
        const revisionId = this.randomId('rev_');
        this.insertRevision(revisionId, ticket.ticketId, parent.revision_id, parent.ordinal + 1, content, body.commandId, at);
        this.attachArtifacts(ticket.ticketId, content.artifactIds, true);
        if (staged) {
          this.stmt('UPDATE tickets SET staged_revision_id = ?, version = version + 1, updated_at = ? WHERE ticket_id = ?')
            .run(revisionId, at, ticket.ticketId);
          return { ticketId: ticket.ticketId, revisionId, extra: { staged: true } };
        }
        this.stmt('UPDATE tickets SET title = ?, priority = ?, current_revision_id = ?, version = version + 1, updated_at = ? WHERE ticket_id = ?')
          .run(content.title, content.priority, revisionId, at, ticket.ticketId);
        return { ticketId: ticket.ticketId, revisionId };
      });
    return result;
  }

  // The staged (not yet applied) revision of an open ticket, or null.
  getStagedRevision(ticketId) {
    const row = this.stmt('SELECT staged_revision_id FROM tickets WHERE ticket_id = ?').get(String(ticketId));
    return row && row.staged_revision_id ? this.getRevision(String(ticketId), row.staged_revision_id) : null;
  }

  promoteStagedRevision(ticketId, at) {
    const row = this.stmt('SELECT staged_revision_id FROM tickets WHERE ticket_id = ?').get(ticketId);
    if (!row || !row.staged_revision_id) return false;
    const revision = this.stmt('SELECT title, priority FROM requirement_revisions WHERE revision_id = ?').get(row.staged_revision_id);
    if (!revision) return false;
    this.stmt('UPDATE tickets SET current_revision_id = ?, title = ?, priority = ?, staged_revision_id = NULL, updated_at = ? WHERE ticket_id = ?')
      .run(row.staged_revision_id, revision.title, revision.priority, at, ticketId);
    return true;
  }

  // ---------------------------------------------- operator controls (M7)

  bumpTicket(ticketId, at) {
    this.stmt('UPDATE tickets SET version = version + 1, updated_at = ? WHERE ticket_id = ?').run(at, ticketId);
  }

  requireRun(ticket, runId) {
    if (typeof runId !== 'string' || !runId) throw invalid('runId', 'must be a run id');
    const run = this.getRun(runId);
    if (!run || run.ticketId !== ticket.ticketId) throw new ProductError('not_found', 'run not found');
    return run;
  }

  // True when any run of the ticket prepared a branch or started a lead task (files may have changed).
  hasRepositoryEffect(ticketId) {
    return Boolean(this.stmt('SELECT 1 FROM runs WHERE ticket_id = ? AND (branch_name IS NOT NULL OR lead_task_id IS NOT NULL) LIMIT 1').get(String(ticketId)));
  }

  // A settled lead task must not lose repository ownership while any workspace writer
  // still has an active or unknown outcome. Specialist writer task IDs differ from the
  // parent lead task ID, and dispatch journal coverage can be incomplete during submit.
  holdingWorkspaceWriter() {
    const table = this.stmt("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'writer_executions'").get();
    if (!table) return null;
    return this.stmt(`
      SELECT execution_id, state FROM writer_executions
      WHERE state IN ('active', 'unresolved')
      LIMIT 1
    `).get() || null;
  }

  // Return to Backlog hands the repository back when no writer is active or unknown and the
  // ticket has no commit delivery in progress or done. A dirty checkout is still refused by the
  // next Submit's branch preflight, so releasing never lets a second ticket write over it.
  canReleaseOnReturn(ticketId) {
    if (this.holdingWorkspaceWriter()) return false;
    return !this.stmt("SELECT 1 FROM deliveries WHERE ticket_id = ? AND kind = 'commit' AND state IN ('succeeded','intended')").get(String(ticketId));
  }

  requireWriterQuiescent(ticketId) {
    const holder = this.holdingWorkspaceWriter();
    if (holder) {
      throw new ProductError('invalid_state', `writer ${holder.execution_id} is ${holder.state}; repository ownership is retained until it is quiescent`);
    }
  }

  // Terminal effect of a stop-like control request on a run (no transaction of its own).
  settleStopLike(run, control, at) {
    const cancelled = control === 'cancel';
    if (cancelled) this.requireWriterQuiescent(run.ticketId);
    this.stmt("UPDATE decisions SET state = 'stale' WHERE run_id = ? AND state = 'pending'").run(run.runId);
    this.patchRun(run.runId, {
      status: cancelled ? 'cancelled' : 'stopped',
      phase: 'settled',
      wait_reason: cancelled ? null : 'run_stopped',
      wait_detail_json: cancelled ? null : JSON.stringify({
        code: 'run_stopped',
        message: control === 'return_to_backlog' ? 'Returned to Backlog by the operator' : 'Stopped by the operator',
      }),
      control_request: null,
      finished_at: at,
    }, at);
    if (cancelled || !this.hasRepositoryEffect(run.ticketId) || (control === 'return_to_backlog' && this.canReleaseOnReturn(run.ticketId))) {
      this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(run.ticketId);
    }
    if (control === 'return_to_backlog') {
      this.promoteStagedRevision(run.ticketId, at);
      this.setTicketStatus(run.ticketId, 'backlog', at);
    } else {
      this.setTicketStatus(run.ticketId, cancelled ? 'cancelled' : 'blocked', at);
    }
  }

  settlePauseRun(run, at) {
    this.patchRun(run.runId, {
      status: 'paused',
      wait_reason: 'operator_pause',
      wait_detail_json: JSON.stringify({ code: 'operator_pause', message: 'Paused by the operator' }),
      control_request: null,
    }, at);
    this.setTicketStatus(run.ticketId, 'paused', at);
  }

  // A run ended on its own while a control request was pending: the request is never dropped silently.
  // Returns the ticket status and lease decision the settle must use, and records the superseded request.
  applyNaturalControl(run, { ticketStatus, releaseLease }, at, { moot = [] } = {}) {
    const control = run.controlRequest;
    const out = { ticketStatus, releaseLease };
    if (!control) return out;
    let outcome = 'moot';
    if (control === 'cancel') {
      this.requireWriterQuiescent(run.ticketId);
      outcome = 'settled';
      out.ticketStatus = 'cancelled';
      out.releaseLease = true;
    } else if (control === 'return_to_backlog') {
      outcome = 'settled';
      this.promoteStagedRevision(run.ticketId, at);
      out.ticketStatus = 'backlog';
      out.releaseLease = !this.hasRepositoryEffect(run.ticketId);
    } else if (control === 'stop' && !moot.includes('stop')) {
      outcome = 'settled';
    }
    this.emit('control_requested', { ticketId: run.ticketId, runId: run.runId, payload: { control, outcome } });
    return out;
  }

  // Settles the pending control request of a run (controller use). Returns the run, or null when nothing was pending.
  // `expected` is the control the caller evaluated: a request that changed since is left for the next tick.
  settleControlRequest(runId, expected) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || !ACTIVE_RUN_STATUSES.includes(run.status) || !run.controlRequest) return null;
      if (expected !== undefined && run.controlRequest !== expected) return null;
      const at = this.now();
      if (run.controlRequest === 'pause') {
        // A run waiting for a human answer stays answerable: the pause is moot.
        if (run.phase === 'awaiting_answer' || run.waitReason === 'human_decision') {
          this.patchRun(run.runId, { control_request: null }, at);
          this.emit('control_requested', { ticketId: run.ticketId, runId: run.runId, payload: { control: 'pause', outcome: 'moot' } });
        } else this.settlePauseRun(run, at);
      } else this.settleStopLike(run, run.controlRequest, at);
      return this.getRun(run.runId);
    });
  }

  // Stores a stop-like control request, or settles at once for runs that have not started executing.
  requestOrSettle(run, control, body, at) {
    if (run.controlRequest && CONTROL_RANK[run.controlRequest] >= CONTROL_RANK[control]) {
      throw new ProductError('invalid_state', `a ${run.controlRequest} request is already pending`);
    }
    if (run.phase === 'queued' || run.phase === 'awaiting_answer') {
      this.settleStopLike(run, control, at);
      return 'settled';
    }
    this.patchRun(run.runId, { control_request: control, control_command_id: body.commandId, control_requested_at: at }, at);
    this.bumpTicket(run.ticketId, at);
    return 'requested';
  }

  controlResult(ticketId, runId, outcome) {
    return { ticketId, revisionId: this.getTicket(ticketId).currentRevisionId, extra: { run: runId ? runSummary(this.getRun(runId)) : null, outcome } };
  }

  emitControl(result, control) {
    if (result.replayed) return;
    const ticketId = result.ticket.ticketId;
    const runId = result.run ? result.run.runId : undefined;
    if (result.outcome === 'requested') this.emit('control_requested', { ticketId, runId, payload: { control } });
    else if (result.outcome === 'settled') {
      if (control === 'pause') this.emit('run_paused', { ticketId, runId, payload: { waitReason: 'operator_pause' } });
      else if (control === 'return_to_backlog') this.emit('ticket_returned_to_backlog', { ticketId, runId, payload: {} });
      else if (runId && ['stopped', 'cancelled'].includes(result.run?.status)) {
        this.emit('run_stopped', { ticketId, runId, payload: { control } });
      }
    }
  }

  requestPause(ticketId, command) {
    const result = this.runCommand('pause', String(ticketId), command, RUN_CONTROL_FIELDS, (body, at) => {
      const ticket = this.requireTicket(ticketId);
      const run = this.requireRun(ticket, body.runId);
      this.requireVersion(ticket, body.expectedVersion);
      if (run.status !== 'queued' && run.status !== 'running') {
        throw new ProductError('invalid_state', `run is ${run.status}; pause is available for queued or running runs`);
      }
      if (!['queued', 'intake', 'branch', 'engineering'].includes(run.phase)) {
        throw new ProductError('invalid_state', `run is in phase ${run.phase}; pause is not available now`);
      }
      if (run.controlRequest) throw new ProductError('invalid_state', `a ${run.controlRequest} request is already pending`);
      this.patchRun(run.runId, { control_request: 'pause', control_command_id: body.commandId, control_requested_at: at }, at);
      let outcome = 'requested';
      if (run.phase === 'queued') {
        this.settlePauseRun(this.getRun(run.runId), at);
        outcome = 'settled';
      } else {
        this.bumpTicket(ticket.ticketId, at);
      }
      return this.controlResult(ticket.ticketId, run.runId, outcome);
    });
    this.emitControl(result, 'pause');
    return result;
  }

  // Store side of Resume. `resumeLead` tells the controller to send the A2A resume message (engineering with a lead task).
  resume(ticketId, command) {
    const result = this.runCommand('resume', String(ticketId), command, RUN_CONTROL_FIELDS, (body, at) => {
      const ticket = this.requireTicket(ticketId);
      const run = this.requireRun(ticket, body.runId);
      this.requireVersion(ticket, body.expectedVersion);
      if (run.phase === 'awaiting_answer' || run.waitReason === 'human_decision') {
        throw new ProductError('invalid_state', 'the run is waiting for a human decision; answer it instead of resuming');
      }
      const operatorPaused = run.status === 'paused' && run.waitReason === 'operator_pause';
      if (!operatorPaused && run.status !== 'interrupted') {
        throw new ProductError('invalid_state', `run is ${run.status}; resume is available for paused or interrupted runs`);
      }
      if (run.controlRequest && run.controlRequest !== 'pause') {
        throw new ProductError('invalid_state', `a ${run.controlRequest} request is pending`);
      }
      const queued = run.phase === 'queued';
      this.patchRun(run.runId, {
        status: queued ? 'queued' : 'running', wait_reason: null, wait_detail_json: null, control_request: null,
      }, at);
      this.setTicketStatus(ticket.ticketId, queued ? 'pending' : 'in_progress', at);
      const out = this.controlResult(ticket.ticketId, run.runId, 'resumed');
      out.extra.resumeLead = run.phase === 'engineering' && run.leadTaskId
        ? { taskId: run.leadTaskId, contextId: run.leadContextId || null } : null;
      return out;
    });
    if (!result.replayed) this.emit('run_resumed', { ticketId: result.ticket.ticketId, runId: result.run.runId, payload: { phase: result.run.phase } });
    return result;
  }

  requestStop(ticketId, command) {
    const result = this.runCommand('stop', String(ticketId), command, RUN_CONTROL_FIELDS, (body, at) => {
      const ticket = this.requireTicket(ticketId);
      const run = this.requireRun(ticket, body.runId);
      this.requireVersion(ticket, body.expectedVersion);
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
        throw new ProductError('invalid_state', `run is ${run.status}; stop is available for runs that have not finished`);
      }
      const outcome = this.requestOrSettle(run, 'stop', body, at);
      return this.controlResult(ticket.ticketId, run.runId, outcome);
    });
    this.emitControl(result, 'stop');
    return result;
  }

  cancelTicket(ticketId, command) {
    const result = this.runCommand('cancel', String(ticketId), command, ['commandId', 'expectedVersion'], (body, at) => {
      const ticket = this.requireTicket(ticketId);
      if (ticket.status === 'done' || ticket.status === 'cancelled') {
        throw new ProductError('invalid_state', `ticket is ${ticket.status}; cancel is available for open tickets`);
      }
      this.requireVersion(ticket, body.expectedVersion);
      if (ticket.status === 'backlog') {
        this.requireWriterQuiescent(ticket.ticketId);
        // A ticket returned to backlog after repository effects still holds the lease.
        this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(ticket.ticketId);
        this.stmt("UPDATE tickets SET status = 'cancelled', version = version + 1, updated_at = ? WHERE ticket_id = ?")
          .run(at, ticket.ticketId);
        return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId, extra: { run: null, outcome: 'settled' } };
      }
      const active = this.getActiveRun(ticket.ticketId);
      if (active) {
        const outcome = this.requestOrSettle(active, 'cancel', body, at);
        return this.controlResult(ticket.ticketId, active.runId, outcome);
      }
      this.requireWriterQuiescent(ticket.ticketId);
      // Settled work (a candidate under review, a blocked run): a completed run stays completed.
      this.stmt("UPDATE decisions SET state = 'stale' WHERE ticket_id = ? AND state = 'pending'").run(ticket.ticketId);
      this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(ticket.ticketId);
      this.setTicketStatus(ticket.ticketId, 'cancelled', at);
      const latest = this.latestRunOf(ticket.ticketId);
      return this.controlResult(ticket.ticketId, latest ? latest.runId : null, 'settled');
    });
    this.emitControl(result, 'cancel');
    return result;
  }

  returnToBacklog(ticketId, command) {
    const result = this.runCommand('return_to_backlog', String(ticketId), command, ['commandId', 'expectedVersion'], (body, at) => {
      const ticket = this.requireTicket(ticketId);
      if (!OPEN_TICKET_STATUSES.includes(ticket.status)) {
        throw new ProductError('invalid_state', `ticket is ${ticket.status}; return to backlog is available for started tickets`);
      }
      this.requireVersion(ticket, body.expectedVersion);
      const active = this.getActiveRun(ticket.ticketId);
      if (active) {
        const outcome = this.requestOrSettle(active, 'return_to_backlog', body, at);
        return this.controlResult(ticket.ticketId, active.runId, outcome);
      }
      this.stmt("UPDATE decisions SET state = 'stale' WHERE ticket_id = ? AND state = 'pending'").run(ticket.ticketId);
      this.promoteStagedRevision(ticket.ticketId, at);
      this.setTicketStatus(ticket.ticketId, 'backlog', at);
      if (this.canReleaseOnReturn(ticket.ticketId)) this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(ticket.ticketId);
      const latest = this.latestRunOf(ticket.ticketId);
      return this.controlResult(ticket.ticketId, latest ? latest.runId : null, 'settled');
    });
    this.emitControl(result, 'return_to_backlog');
    return result;
  }

  // Control a lead task should honour at its next safe boundary (lead graph hook): null | 'pause' | 'stop'.
  controlForLeadTask(leadTaskId) {
    const row = this.stmt("SELECT control_request FROM runs WHERE lead_task_id = ? AND status IN ('queued','running','paused','interrupted')")
      .get(String(leadTaskId));
    if (!row || !row.control_request) return null;
    return row.control_request === 'pause' ? 'pause' : 'stop';
  }

  // Stored outcome of an already-applied command (null when new); validates the envelope like runCommand.
  lookupCommand(kind, ticketId, command) {
    const allowed = COMMAND_FIELDS[kind];
    if (!allowed) throw new TypeError(`unknown command kind ${kind}`);
    validateEnvelope(command, allowed);
    const { commandId, ...rest } = command;
    const payloadHash = sha256(canonicalJson({ kind, ticketId: String(ticketId), body: rest }));
    const prior = this.stmt('SELECT payload_sha256, result_json FROM product_commands WHERE command_id = ?').get(commandId);
    if (!prior) return null;
    if (prior.payload_sha256 !== payloadHash) throw new ProductError('conflict', 'commandId was already used with a different payload');
    return { ...JSON.parse(prior.result_json), replayed: true };
  }

  // The ticket's most recently reserved branch, or null.
  getTicketBranch(ticketId) {
    const row = this.stmt('SELECT branch_name FROM ticket_branches WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(String(ticketId));
    return row ? row.branch_name : null;
  }

  // ------------------------------------------------------- reviews (M7)

  getReview(reviewId) {
    const row = this.stmt('SELECT * FROM reviews WHERE review_id = ?').get(String(reviewId));
    return row ? reviewFromRow(row) : null;
  }

  getReviewForRun(runId) {
    const row = this.stmt('SELECT * FROM reviews WHERE run_id = ?').get(String(runId));
    return row ? reviewFromRow(row) : null;
  }

  listReviews() {
    return this.stmt('SELECT * FROM reviews ORDER BY created_at DESC, rowid DESC').all().map(reviewFromRow);
  }

  listControlRequests() {
    return this.stmt(
      "SELECT * FROM runs WHERE control_request IS NOT NULL AND control_request != '' ORDER BY control_requested_at ASC, rowid ASC",
    ).all().map(runFromRow);
  }

  getLatestReview(ticketId) {
    const row = this.stmt('SELECT * FROM reviews WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(String(ticketId));
    return row ? reviewFromRow(row) : null;
  }

  getAcceptedReview(ticketId) {
    const row = this.stmt("SELECT * FROM reviews WHERE ticket_id = ? AND verdict = 'accepted' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(String(ticketId));
    return row ? reviewFromRow(row) : null;
  }

  // Validates a review command against durable state without writing; returns { ticket, run, candidate }.
  checkReview(ticketId, command) {
    validateEnvelope(command, REVIEW_FIELDS);
    const errors = [];
    if (!REVIEW_VERDICTS.includes(command.verdict)) errors.push({ field: 'verdict', message: `must be one of ${REVIEW_VERDICTS.join(', ')}` });
    for (const field of ['runId', 'candidateId', 'integrityHash']) {
      if (typeof command[field] !== 'string' || !command[field]) errors.push({ field, message: 'must be a non-empty string' });
    }
    if (command.verdict === 'corrections') {
      if (checkString(errors, 'findings', command.findings)
        && (command.findings.trim().length < 1 || command.findings.length > FINDINGS_MAX)) {
        errors.push({ field: 'findings', message: `must be 1..${FINDINGS_MAX} characters` });
      }
    } else if (command.findings !== undefined) {
      errors.push({ field: 'findings', message: 'is accepted only with corrections' });
    }
    if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
    const ticket = this.requireTicket(ticketId);
    this.requireVersion(ticket, command.expectedVersion);
    const run = this.requireRun(ticket, command.runId);
    const latest = this.latestRunOf(ticket.ticketId);
    if (ticket.status !== 'waiting_human' || !latest || latest.runId !== run.runId
      || run.status !== 'completed' || run.waitReason !== 'human_review') {
      throw new ProductError('invalid_state', 'the ticket has no candidate waiting for review');
    }
    const candidate = run.candidateId ? this.getCandidate(run.candidateId) : null;
    if (!candidate) throw new ProductError('invalid_state', 'the run has no candidate');
    if (candidate.candidateId !== command.candidateId || candidate.integrityHash !== command.integrityHash) {
      throw new ProductError('candidate_changed', 'The candidate shown is not the one under review');
    }
    if (this.getReviewForRun(run.runId)) throw new ProductError('invalid_state', 'this run was already reviewed');
    return { ticket, run, candidate };
  }

  // Accept (ticket done) or request corrections (new rework run on the same revision, lease transferred).
  recordReview(ticketId, command) {
    const result = this.runCommand('review', String(ticketId), command, REVIEW_FIELDS, (body, at) => {
      const { ticket, run, candidate } = this.checkReview(ticketId, body);
      const accepted = body.verdict === 'accept';
      if (!accepted) {
        const used = this.stmt("SELECT COUNT(*) AS c FROM runs WHERE ticket_id = ? AND revision_id = ? AND run_kind = 'rework'")
          .get(ticket.ticketId, run.revisionId).c;
        if (used >= MAX_REWORKS) {
          throw new ProductError('rework_exhausted', `at most ${MAX_REWORKS} rework runs are allowed for one revision`);
        }
      }
      const reviewId = this.randomId('rvw_');
      this.stmt(
        'INSERT INTO reviews (review_id, ticket_id, run_id, revision_id, plan_revision_id, candidate_id, integrity_hash, verdict, '
        + "findings, actor, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'operator', ?, ?)",
      ).run(reviewId, ticket.ticketId, run.runId, run.revisionId, run.planRevisionId, candidate.candidateId,
        candidate.integrityHash, accepted ? 'accepted' : 'corrections', accepted ? null : body.findings.trim(), body.commandId, at);
      if (accepted) {
        if (candidate.manifest.length === 0) this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(ticket.ticketId);
        this.setTicketStatus(ticket.ticketId, 'done', at);
        return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId, extra: { review: this.getReview(reviewId), run: runSummary(run) } };
      }
      const rework = this.insertReworkRun(ticket, run, reviewId, body.commandId, at);
      this.patchRun(run.runId, {
        wait_reason: null,
        wait_detail_json: JSON.stringify({ code: 'corrections_requested', message: `Corrections requested; superseded by rework run ${rework.runId}` }),
      }, at);
      this.setTicketStatus(ticket.ticketId, 'in_progress', at);
      return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId, extra: { review: this.getReview(reviewId), run: runSummary(rework) } };
    });
    if (!result.replayed) {
      const ticketId2 = result.ticket.ticketId;
      this.emit('review_recorded', { ticketId: ticketId2, runId: result.review.runId, payload: { verdict: result.review.verdict } });
      if (result.review.verdict === 'corrections') {
        this.emit('rework_started', { ticketId: ticketId2, runId: result.run.runId, payload: { parentRunId: result.review.runId, reviewId: result.review.reviewId } });
      }
    }
    return result;
  }

  insertReworkRun(ticket, parent, reviewId, commandId, at) {
    const lease = this.getLease(parent.projectId);
    if (lease && lease.ticketId !== ticket.ticketId) throw new ProductError('invalid_state', 'the repository is in use by another ticket');
    const runId = this.randomId('run_');
    const planId = this.randomId('plan_');
    const plan = this.stmt('SELECT * FROM plan_revisions WHERE plan_revision_id = ?').get(parent.planRevisionId);
    if (!plan) throw new ProductError('invalid_state', 'the reviewed run has no saved plan');
    this.stmt(
      'INSERT INTO plan_revisions (plan_revision_id, run_id, parent_plan_revision_id, classification, stages_json, '
      + 'check_ids_json, checks_json, requirements_json, validator_version, reason, created_at, '
      + 'preset_id, preset_version, role_pack, role_pack_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(planId, runId, plan.plan_revision_id, plan.classification, plan.stages_json, plan.check_ids_json, plan.checks_json,
      plan.requirements_json, plan.validator_version, `rework: ${reviewId}`, at,
      plan.preset_id, plan.preset_version, plan.role_pack, plan.role_pack_version);
    this.stmt(
      'INSERT INTO runs (run_id, ticket_id, revision_id, project_id, status, phase, plan_revision_id, branch_name, '
      + "settings_snapshot_json, intake_turns, command_id, created_at, started_at, updated_at, run_kind, parent_run_id, rework_review_id) "
      + "VALUES (?, ?, ?, ?, 'running', 'branch', ?, ?, ?, ?, ?, ?, ?, ?, 'rework', ?, ?)",
    ).run(runId, ticket.ticketId, parent.revisionId, parent.projectId, planId, parent.branchName,
      JSON.stringify(parent.settings), parent.intakeTurns, commandId, at, at, at, parent.runId, reviewId);
    this.stmt('INSERT OR REPLACE INTO repository_leases (project_id, run_id, ticket_id, acquired_at) VALUES (?, ?, ?, ?)')
      .run(parent.projectId, runId, ticket.ticketId, lease ? lease.acquiredAt : at);
    return this.getRun(runId);
  }

  // ---------------------------------------------------- deliveries (M7)

  getDelivery(deliveryId) {
    const row = this.stmt('SELECT * FROM deliveries WHERE delivery_id = ?').get(String(deliveryId));
    return row ? deliveryFromRow(row) : null;
  }

  listDeliveries(ticketId) {
    return this.stmt('SELECT * FROM deliveries WHERE ticket_id = ? ORDER BY created_at ASC, rowid ASC').all(String(ticketId)).map(deliveryFromRow);
  }

  listIntendedDeliveries() {
    return this.stmt("SELECT * FROM deliveries WHERE state = 'intended' ORDER BY created_at ASC, rowid ASC").all().map(deliveryFromRow);
  }

  requireDone(ticket) {
    if (ticket.status !== 'done') throw new ProductError('invalid_state', `ticket is ${ticket.status}; only accepted (done) tickets can be delivered`);
  }

  // Persists a commit delivery as `intended` before Git runs (D-M7-7).
  beginCommit(ticketId, command) {
    return this.runCommand('commit', String(ticketId), command, COMMIT_FIELDS, (body, at) => {
      const ticket = this.requireTicket(ticketId);
      this.requireDone(ticket);
      this.requireVersion(ticket, body.expectedVersion);
      const errors = [];
      if (typeof body.message !== 'string' || body.message.trim().length < 1 || body.message.length > COMMIT_MESSAGE_MAX
        || body.message.includes('\u0000')) {
        errors.push({ field: 'message', message: `must be 1..${COMMIT_MESSAGE_MAX} characters without NUL` });
      }
      for (const field of ['candidateId', 'integrityHash']) {
        if (typeof body[field] !== 'string' || !body[field]) errors.push({ field, message: 'must be a non-empty string' });
      }
      if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
      const review = this.getAcceptedReview(ticket.ticketId);
      if (!review) throw new ProductError('invalid_state', 'the ticket has no accepted review');
      if (review.candidateId !== body.candidateId || review.integrityHash !== body.integrityHash) {
        throw new ProductError('candidate_changed', 'The candidate does not match the accepted review');
      }
      const candidate = this.getCandidate(review.candidateId);
      if (!candidate || candidate.manifest.length === 0) throw new ProductError('invalid_state', 'the accepted candidate has no changes to commit');
      if (!this.isTicketBranch(candidate.branch, ticket.ticketId)) {
        throw new ProductError('invalid_state', 'the accepted candidate is not on a ticket-owned branch');
      }
      const existing = this.stmt("SELECT 1 FROM deliveries WHERE candidate_id = ? AND kind = 'commit' AND state IN ('succeeded','intended')")
        .get(candidate.candidateId);
      if (existing) throw new ProductError('invalid_state', 'this candidate already has a commit in progress or committed');
      const lease = this.getLease();
      if (!lease || lease.ticketId !== ticket.ticketId) throw new ProductError('invalid_state', 'the ticket does not hold the repository');
      const deliveryId = this.randomId('dlv_');
      this.stmt(
        'INSERT INTO deliveries (delivery_id, ticket_id, run_id, candidate_id, review_id, kind, state, branch, base_head, message, '
        + "command_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'commit', 'intended', ?, ?, ?, ?, ?, ?)",
      ).run(deliveryId, ticket.ticketId, review.runId, candidate.candidateId, review.reviewId, candidate.branch, candidate.head,
        body.message.trim(), body.commandId, at, at);
      this.bumpTicket(ticket.ticketId, at);
      return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId, extra: { delivery: this.getDelivery(deliveryId) } };
    });
  }

  // Persists a push delivery as `intended` for a succeeded commit delivery.
  beginPush(ticketId, command) {
    return this.runCommand('push', String(ticketId), command, PUSH_FIELDS, (body, at) => {
      const ticket = this.requireTicket(ticketId);
      this.requireDone(ticket);
      this.requireVersion(ticket, body.expectedVersion);
      const errors = [];
      for (const field of ['deliveryId', 'commitSha']) {
        if (typeof body[field] !== 'string' || !body[field]) errors.push({ field, message: 'must be a non-empty string' });
      }
      if (typeof body.remote !== 'string' || !REMOTE_RE.test(body.remote)) errors.push({ field: 'remote', message: 'must be a remote name' });
      if (errors.length > 0) throw new ProductError('invalid_request', 'invalid request', errors);
      const commit = this.getDelivery(body.deliveryId);
      if (!commit || commit.ticketId !== ticket.ticketId || commit.kind !== 'commit') throw new ProductError('not_found', 'commit delivery not found');
      if (commit.state !== 'succeeded' || commit.commitSha !== body.commitSha) {
        throw new ProductError('conflict', 'the push does not match a succeeded commit delivery');
      }
      const open = this.stmt("SELECT 1 FROM deliveries WHERE parent_delivery_id = ? AND kind = 'push' AND state = 'intended'").get(commit.deliveryId);
      if (open) throw new ProductError('invalid_state', 'a push for this commit is already in progress');
      const pushed = this.stmt("SELECT 1 FROM deliveries WHERE parent_delivery_id = ? AND kind = 'push' AND state = 'succeeded' AND remote = ?")
        .get(commit.deliveryId, body.remote);
      if (pushed) throw new ProductError('invalid_state', `this commit was already pushed to ${body.remote}`);
      const deliveryId = this.randomId('dlv_');
      this.stmt(
        'INSERT INTO deliveries (delivery_id, ticket_id, run_id, candidate_id, review_id, kind, state, parent_delivery_id, branch, base_head, '
        + 'commit_sha, remote, remote_ref, command_id, created_at, updated_at) '
        + "VALUES (?, ?, ?, ?, ?, 'push', 'intended', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(deliveryId, ticket.ticketId, commit.runId, commit.candidateId, commit.reviewId, commit.deliveryId, commit.branch,
        commit.baseHead, commit.commitSha, body.remote, `refs/heads/${commit.branch}`, body.commandId, at, at);
      this.bumpTicket(ticket.ticketId, at);
      return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId, extra: { delivery: this.getDelivery(deliveryId) } };
    });
  }

  // Records the outcome of an intended delivery; a succeeded commit releases the repository lease.
  finishDelivery(deliveryId, { state, commitSha, error } = {}) {
    if (!['succeeded', 'failed', 'unknown'].includes(state)) throw new TypeError('finishDelivery requires a final state');
    return this.tx(() => {
      const row = this.getDelivery(deliveryId);
      if (!row || row.state !== 'intended') return null;
      const at = this.now();
      this.stmt('UPDATE deliveries SET state = ?, commit_sha = COALESCE(?, commit_sha), error_json = ?, updated_at = ? WHERE delivery_id = ?')
        .run(state, commitSha || null, error ? JSON.stringify(error) : null, at, row.deliveryId);
      if (row.kind === 'commit' && state === 'succeeded') {
        this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(row.ticketId);
      }
      this.bumpTicket(row.ticketId, at);
      return this.getDelivery(row.deliveryId);
    });
  }

  releaseRepository(ticketId, command) {
    const result = this.runCommand('release_repository', String(ticketId), command, ['commandId', 'expectedVersion'], (body, at) => {
      const ticket = this.requireTicket(ticketId);
      if (!['done', 'backlog'].includes(ticket.status)) {
        throw new ProductError('invalid_state', `ticket is ${ticket.status}; repository release is available for done tickets or backlog drafts`);
      }
      this.requireVersion(ticket, body.expectedVersion);
      const committed = this.stmt("SELECT 1 FROM deliveries WHERE ticket_id = ? AND kind = 'commit' AND state IN ('succeeded','intended')")
        .get(ticket.ticketId);
      if (committed) throw new ProductError('invalid_state', 'the candidate is committed or being committed; nothing to release');
      const lease = this.getLease();
      if (!lease || lease.ticketId !== ticket.ticketId) throw new ProductError('invalid_state', 'the ticket does not hold the repository');
      this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(ticket.ticketId);
      this.bumpTicket(ticket.ticketId, at);
      return { ticketId: ticket.ticketId, revisionId: ticket.currentRevisionId };
    });
    if (!result.replayed) this.emit('repository_released', { ticketId: result.ticket.ticketId, payload: {} });
    return result;
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
    const succeeded = new Set([...recorded.values()].filter((entry) => ['succeeded', 'skipped'].includes(entry.status)).map((entry) => entry.stageId));
    return plan.stages.map((stage) => {
      const entry = recorded.get(stage.stageId);
      let status = entry && ['succeeded', 'failed', 'skipped'].includes(entry.status) ? entry.status : 'pending';
      if (status === 'pending' && stage.dependencies.every((dep) => succeeded.has(dep))) status = 'eligible';
      return {
        stageId: stage.stageId,
        roleId: stage.roleId,
        required: entry && typeof entry.required === 'boolean' ? entry.required : stage.required,
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
      const prior = this.latestRunOf(ticket.ticketId);
      if (ticket.status === 'blocked' && !prior) {
        throw new ProductError('invalid_state', 'a blocked ticket can be submitted again only after a settled run');
      }
      // A staged revision applies when the ticket is submitted again (D-M7-1).
      this.promoteStagedRevision(ticket.ticketId, at);
      const revisionId = this.requireTicket(ticket.ticketId).currentRevisionId;
      const runId = this.randomId('run_');
      this.stmt(
        'INSERT INTO runs (run_id, ticket_id, revision_id, project_id, status, phase, settings_snapshot_json, '
        + 'intake_turns, command_id, created_at, updated_at, run_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)',
      ).run(runId, ticket.ticketId, revisionId, this.projectId, 'queued', 'queued',
        JSON.stringify(settingsSnapshot), body.commandId, at, at, prior ? 'resubmit' : 'initial');
      this.setTicketStatus(ticket.ticketId, 'pending', at);
      return { ticketId: ticket.ticketId, revisionId, extra: { run: runSummary(this.getRun(runId)) } };
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
      'lead_context_id', 'branch_name', 'base_commit', 'candidate_id', 'intake_turns', 'started_at', 'finished_at',
      'control_request', 'control_command_id', 'control_requested_at']);
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
          message: blocker.ticketId
            ? 'The repository is in use by another ticket. Wait for it to settle or open that ticket and release the repository when available.'
            : 'Waiting for earlier queued work',
          ...(blocker.ticketId ? { holderTicketId: blocker.ticketId } : {}),
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
  saveIntakePlan(runId, { turn, output, classification, plan, checks, requirements, validatorVersion, planMeta = null, reason = 'intake' }) {
    return this.tx(() => {
      const run = this.getRun(runId);
      if (!run || run.phase !== 'intake' || run.status !== 'running') return null;
      const at = this.now();
      this.insertIntakeResult(run, { turn, output, valid: true, errors: [] }, at);
      const planRevisionId = this.randomId('plan_');
      this.stmt(
        'INSERT INTO plan_revisions (plan_revision_id, run_id, parent_plan_revision_id, classification, stages_json, '
        + 'check_ids_json, checks_json, requirements_json, validator_version, reason, created_at, '
        + 'preset_id, preset_version, role_pack, role_pack_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(planRevisionId, run.runId, run.planRevisionId, classification, JSON.stringify(plan.stages),
        JSON.stringify(plan.checkIds), JSON.stringify(checks),
        JSON.stringify(requirements), validatorVersion, reason, at,
        planMeta ? planMeta.presetId : null, planMeta ? planMeta.presetVersion : null,
        planMeta ? planMeta.rolePack : null, planMeta ? planMeta.rolePackVersion : null);
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
      if (run.controlRequest === 'pause') {
        this.patchRun(run.runId, { control_request: null }, at);
        this.emit('control_requested', { ticketId: run.ticketId, runId: run.runId, payload: { control: 'pause', outcome: 'moot' } });
      }
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
      if (run.leadTaskId) this.requireWriterQuiescent(run.ticketId);
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
        control_request: null,
        finished_at: at,
      }, at);
      const applied = this.applyNaturalControl(run, { ticketStatus, releaseLease: Boolean(releaseLease) && !this.hasRepositoryEffect(run.ticketId) }, at);
      if (applied.releaseLease) this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(run.ticketId);
      this.setTicketStatus(run.ticketId, applied.ticketStatus, at);
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
      if (run.controlRequest === 'pause') {
        this.patchRun(run.runId, { control_request: null }, at);
        this.emit('control_requested', { ticketId: run.ticketId, runId: run.runId, payload: { control: 'pause', outcome: 'moot' } });
      }
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
        control_request: null,
        finished_at: at,
      }, at);
      // stop and pause are moot once a candidate exists; cancel and return to backlog still apply to the ticket.
      const applied = this.applyNaturalControl(run, { ticketStatus: review ? 'waiting_human' : 'blocked', releaseLease: false }, at, { moot: ['stop'] });
      if (run.controlRequest === 'cancel' || run.controlRequest === 'return_to_backlog') {
        this.stmt("UPDATE decisions SET state = 'stale' WHERE run_id = ? AND state = 'pending'").run(run.runId);
      }
      if (applied.releaseLease) this.stmt('DELETE FROM repository_leases WHERE ticket_id = ?').run(run.ticketId);
      this.setTicketStatus(run.ticketId, applied.ticketStatus, at);
      return this.getCandidate(candidateId);
    });
  }

  // Runs one command in a single immediate transaction with the idempotency ledger.
  // Stored outcome of an already-applied submit command (null when new), so callers can skip revalidation on replay.
  replayedSubmit(ticketId, command) {
    const allowed = ['commandId', 'expectedVersion'];
    validateEnvelope(command, allowed);
    const { commandId, ...rest } = command;
    const payloadHash = sha256(canonicalJson({ kind: 'submit', ticketId: String(ticketId), body: rest }));
    const prior = this.stmt('SELECT payload_sha256, result_json FROM product_commands WHERE command_id = ?').get(commandId);
    if (!prior) return null;
    if (prior.payload_sha256 !== payloadHash) throw new ProductError('conflict', 'commandId was already used with a different payload');
    return { ...JSON.parse(prior.result_json), replayed: true };
  }

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
  validateEnvelope, sha256, defaultRandomId, MAX_REWORKS,
};
