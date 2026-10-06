'use strict';

// Read-only projection of stored A2A tasks into dashboard board cards (M1-02).
// SELECT-only prepared statements on the shared handle; no DDL, writes, migrations or model calls.

const fs = require('node:fs');
const path = require('node:path');
const { buildReport } = require('./usage-report');
const { cachedInputShare } = require('./ticket-telemetry');
const { redactDiagnosticMessage } = require('./event-journal');

const LEAD_NAMESPACE = 'orchestrator';
const LEAD_ROLE = 'orch-lead';
const COLUMNS = ['backlog', 'pending', 'in_progress', 'needs_attention', 'closed'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_Q_CHARS = 200;
const MAX_TITLE_CHARS = 200;
const MAX_STATUS_MESSAGE_CHARS = 4000;
const MAX_RESULT_CHARS = 20000;
const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_USER_MESSAGES = 100;
const MAX_PAUSE_STRING_CHARS = 2000;
const NO_GOAL_TITLE = '(no goal text)';
const CARD_ID_PREFIX = 'lr_';
const TICKET_ID_PREFIX = 'tkt_';
const TICKET_API_PATH = '/api/dashboard/v1/tickets/';
// Legacy lr_ cards are read-only: operator commands apply to tickets only.
const UNAVAILABLE_ACTIONS = ['pause', 'resume', 'stop', 'cancel', 'edit', 'return_to_backlog', 'review', 'commit', 'push']
  .map((action) => ({ action, reason: 'Legacy runs are read-only in the dashboard; operator commands apply to tickets' }));
const RETURNABLE_TICKET_STATUSES = ['pending', 'in_progress', 'paused', 'waiting_human', 'blocked'];
// A pending return_to_backlog or cancel request on the active run outranks another return (store CONTROL_RANK).
const BLOCKING_CONTROLS = ['return_to_backlog', 'cancel'];

// Whether Return to Backlog is offered (shared with the ticket API's availableActions).
function canReturnToBacklog(ticket, activeRun) {
  if (!RETURNABLE_TICKET_STATUSES.includes(ticket.status)) return false;
  return !(activeRun && BLOCKING_CONTROLS.includes(activeRun.controlRequest));
}

const WAIT_REASONS = {
  human_decision: 'human_decision',
  waiting_for_budget: 'budget',
  waiting_for_auth: 'auth_required',
  restart: 'restart',
  writer_unresolved: 'writer_unresolved',
  error: 'execution_error',
};

// Raw stored state -> [boardColumn, executionStatus, displayStatus].
const STATE_TABLE = {
  TASK_STATE_SUBMITTED: ['pending', 'queued', 'Queued'],
  TASK_STATE_WORKING: ['in_progress', 'working', 'Working'],
  TASK_STATE_INPUT_REQUIRED: ['needs_attention', 'waiting', 'Waiting for input'],
  TASK_STATE_COMPLETED: ['closed', 'completed', 'Completed'],
  TASK_STATE_FAILED: ['needs_attention', 'failed', 'Failed'],
  TASK_STATE_REJECTED: ['needs_attention', 'rejected', 'Rejected'],
  TASK_STATE_CANCELED: ['closed', 'canceled', 'Canceled'],
};
const UNKNOWN_STATE = ['needs_attention', 'unknown', 'Unknown state'];

// Contract ticket status -> [boardColumn, displayStatus] (D-M3-7). Unknown statuses need attention.
const TICKET_STATE_TABLE = {
  backlog: ['backlog', 'Draft'],
  pending: ['pending', 'Pending'],
  in_progress: ['in_progress', 'In progress'],
  paused: ['needs_attention', 'Paused'],
  waiting_human: ['needs_attention', 'Waiting for you'],
  blocked: ['needs_attention', 'Blocked'],
  done: ['closed', 'Done'],
  cancelled: ['closed', 'Cancelled'],
};

function requestError(message, code = 'invalid_request', details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function invalid(message) {
  return requestError(message, 'invalid_request');
}

function truncate(text, max) {
  const value = String(text);
  return value.length > max ? value.slice(0, max) : value;
}

// ------------------------------------------------------------ card ids

function encodeCardId({ namespace, tenant, taskId }) {
  return CARD_ID_PREFIX + Buffer.from(`${namespace}\u0000${tenant}\u0000${taskId}`, 'utf8').toString('base64url');
}

function decodeRaw(cardId) {
  if (typeof cardId === 'string' && cardId.startsWith(TICKET_ID_PREFIX)) {
    throw requestError('Card not found', 'not_found', { ticketUrl: `${TICKET_API_PATH}${encodeURIComponent(cardId)}` });
  }
  if (typeof cardId !== 'string' || !cardId.startsWith(CARD_ID_PREFIX) || cardId.length > 2048) throw invalid('Invalid cardId');
  const body = cardId.slice(CARD_ID_PREFIX.length);
  if (!body || !/^[A-Za-z0-9_-]+$/.test(body)) throw invalid('Invalid cardId');
  const parts = Buffer.from(body, 'base64url').toString('utf8').split('\u0000');
  if (parts.length !== 3 || !parts[0] || !parts[2]) throw invalid('Invalid cardId');
  const [namespace, tenant, taskId] = parts;
  return { namespace, tenant, taskId };
}

// ------------------------------------------------------ message helpers

function isUserMessage(message) {
  return message?.role === 'ROLE_USER' || message?.role === 1;
}

function messageText(message) {
  const parts = message?.parts;
  if (!Array.isArray(parts)) return '';
  const values = [];
  for (const part of parts) {
    if (typeof part?.text === 'string') values.push(part.text);
    else if (part?.content?.$case === 'text' && typeof part.content.value === 'string') values.push(part.content.value);
  }
  return values.join('\n').trim();
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function goalTitle(history) {
  for (const message of Array.isArray(history) ? history : []) {
    if (!isUserMessage(message)) continue;
    const text = messageText(message).replace(/\s+/g, ' ').trim();
    if (text) return truncate(text, MAX_TITLE_CHARS);
  }
  return NO_GOAL_TITLE;
}

function resultArtifact(artifacts, taskId) {
  return (Array.isArray(artifacts) ? artifacts : []).find((artifact) => artifact?.artifactId === `${taskId}-result`) || null;
}

function acceptanceOf(artifact) {
  const acceptance = artifact?.metadata?.acceptance;
  if (!acceptance || typeof acceptance.disposition !== 'string') return null;
  const reasons = Array.isArray(acceptance.reasons) ? acceptance.reasons.filter((r) => typeof r === 'string').map((r) => truncate(r, 500)).slice(0, 50) : [];
  return { disposition: acceptance.disposition, reasons };
}

function sanitizePause(pause) {
  if (!pause || typeof pause !== 'object') return null;
  const out = {};
  const str = (value) => truncate(value, MAX_PAUSE_STRING_CHARS);
  for (const key of ['kind', 'decisionId', 'question', 'reason', 'recommendation', 'source', 'message', 'resetsAt', 'errorName']) {
    if (typeof pause[key] === 'string') out[key] = str(pause[key]);
  }
  if (Array.isArray(pause.options)) {
    out.options = pause.options.slice(0, 20).filter((o) => o && typeof o === 'object')
      .map((o) => ({ id: typeof o.id === 'string' ? str(o.id) : null, description: typeof o.description === 'string' ? str(o.description) : null }));
  }
  if (Array.isArray(pause.attempts)) {
    out.attempts = pause.attempts.slice(0, 50).filter((a) => a && typeof a === 'object')
      .map((a) => ({
        attemptId: typeof a.attemptId === 'string' ? str(a.attemptId) : null,
        role: typeof a.role === 'string' ? str(a.role) : null,
        reason: typeof a.reason === 'string' ? str(a.reason) : null,
      }));
  }
  return out;
}

// ----------------------------------------------------------- projection

function classify(rawState, pauseKind) {
  const [boardColumn, executionStatus, displayStatus] = STATE_TABLE[rawState] || UNKNOWN_STATE;
  let waitReason = null;
  if (rawState === 'TASK_STATE_INPUT_REQUIRED') waitReason = WAIT_REASONS[pauseKind] || 'unknown';
  return { boardColumn, executionStatus, displayStatus, waitReason };
}

function isoFromMs(ms) {
  const value = Number(ms);
  const date = new Date(Number.isFinite(value) ? value : 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function monitorNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function monitorUnavailable() {
  return {
    available: false,
    reason: 'Event journal is unavailable',
    events: [],
    filters: {
      category: { available: false, values: [] },
      severity: { available: false, values: [] },
      role: { available: false, values: [] },
    },
  };
}

function projectMonitor(read) {
  if (!read || read.ok !== true || !Array.isArray(read.events)) return monitorUnavailable();
  const events = [];
  for (const event of read.events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? event.payload
      : {};
    const level = typeof event.level === 'string' ? event.level.trim() : '';
    events.push({
      sequence: Number.isInteger(event.sequence) ? event.sequence : null,
      timestamp: monitorNonEmptyString(event.occurredAt),
      category: monitorNonEmptyString(event.type),
      role: monitorNonEmptyString(event.role),
      ticketId: monitorNonEmptyString(event.ticketId),
      level: level.length > 0 ? level : null,
      message: monitorNonEmptyString(typeof payload.message === 'string' ? redactDiagnosticMessage(payload.message) : null),
    });
  }
  const categories = [...new Set(events.map((event) => event.category).filter(Boolean))].sort();
  const severities = [...new Set(events.map((event) => event.level).filter(Boolean))].sort();
  const roles = [...new Set(events.map((event) => event.role).filter(Boolean))].sort();
  return {
    available: true,
    events,
    filters: {
      category: { available: categories.length > 0, values: categories },
      severity: { available: severities.length > 0, values: severities },
      role: { available: roles.length > 0, values: roles },
    },
  };
}

const DOC_MAX_CHARS = 24000;
const DOC_SOURCES = new Set(['role', 'preset', 'project']);

function decisionsUnavailable(reason) {
  const text = typeof reason === 'string' && reason.trim()
    ? redactDiagnosticMessage(reason.trim())
    : 'Decisions are unavailable';
  return { available: false, reason: text, pending: [], responses: [] };
}

function computeDecisionBinding({
  revisionId, currentRevisionId, candidatePresent, candidateId, integrityHash, liveIntegrityHash,
}) {
  const rev = typeof revisionId === 'string' ? revisionId : '';
  const current = typeof currentRevisionId === 'string' ? currentRevisionId : '';
  if (rev && current && rev !== current) return 'stale';
  if (rev === current && candidatePresent === true
    && typeof candidateId === 'string' && candidateId
    && typeof integrityHash === 'string' && integrityHash
    && typeof liveIntegrityHash === 'string' && liveIntegrityHash
    && integrityHash === liveIntegrityHash) {
    return 'current';
  }
  return 'unavailable';
}

function publicReviewVerdict(verdict) {
  if (verdict === 'accepted') return 'accepted';
  if (verdict === 'corrections') return 'corrections';
  return null;
}

function redactTitle(title) {
  return typeof title === 'string' && title.trim()
    ? redactDiagnosticMessage(title.trim())
    : 'unavailable';
}

function mapPendingReview(store, ticket, run, candidate) {
  const candidatePresent = Boolean(candidate && candidate.candidateId === run.candidateId);
  const liveIntegrityHash = candidatePresent ? candidate.integrityHash : '';
  const integrityHash = candidatePresent ? liveIntegrityHash : '';
  const binding = computeDecisionBinding({
    revisionId: run.revisionId,
    currentRevisionId: ticket.currentRevisionId,
    candidatePresent,
    candidateId: run.candidateId,
    integrityHash,
    liveIntegrityHash,
  });
  const expectedVersion = Number.isInteger(ticket.version) ? ticket.version : null;
  const fieldsReady = Boolean(ticket.ticketId && run.runId && run.candidateId && integrityHash);
  const actionable = binding === 'current' && expectedVersion !== null && fieldsReady;
  return {
    id: `review:${run.runId}`,
    kind: 'review',
    command: null,
    ticketId: ticket.ticketId,
    ticketTitle: redactTitle(ticket.title),
    runId: run.runId,
    revisionId: run.revisionId || null,
    planRevisionId: run.planRevisionId || null,
    candidateId: run.candidateId || null,
    integrityHash: integrityHash || null,
    binding,
    authorized: false,
    actionable,
    expectedVersion,
    requestedAt: run.finishedAt || run.updatedAt || null,
  };
}

function mapOperatorCommand(store, run) {
  const ticket = store.getTicket(run.ticketId);
  const candidate = run.candidateId ? store.getCandidate(run.candidateId) : null;
  const candidatePresent = Boolean(candidate && candidate.candidateId === run.candidateId);
  const liveIntegrityHash = candidatePresent ? candidate.integrityHash : '';
  const integrityHash = candidatePresent ? liveIntegrityHash : '';
  const currentRevisionId = ticket ? ticket.currentRevisionId : '';
  const binding = computeDecisionBinding({
    revisionId: run.revisionId,
    currentRevisionId,
    candidatePresent,
    candidateId: run.candidateId,
    integrityHash,
    liveIntegrityHash,
  });
  return {
    id: `command:${run.runId}:${run.controlRequest}`,
    kind: 'operator_command',
    command: run.controlRequest,
    ticketId: run.ticketId,
    ticketTitle: redactTitle(ticket ? ticket.title : null),
    runId: run.runId,
    revisionId: run.revisionId || null,
    planRevisionId: run.planRevisionId || null,
    candidateId: run.candidateId || null,
    integrityHash: integrityHash || null,
    binding,
    authorized: false,
    actionable: false,
    expectedVersion: ticket && Number.isInteger(ticket.version) ? ticket.version : null,
    requestedAt: run.controlRequestedAt || run.updatedAt || null,
  };
}

function mapReviewResponse(store, review) {
  const ticket = store.getTicket(review.ticketId);
  const currentRevisionId = ticket ? ticket.currentRevisionId : '';
  const candidate = review.candidateId ? store.getCandidate(review.candidateId) : null;
  const candidatePresent = Boolean(candidate && candidate.candidateId === review.candidateId);
  const liveIntegrityHash = candidatePresent ? candidate.integrityHash : '';
  const integrityHash = typeof review.integrityHash === 'string' ? review.integrityHash : '';
  const binding = computeDecisionBinding({
    revisionId: review.revisionId,
    currentRevisionId,
    candidatePresent,
    candidateId: review.candidateId,
    integrityHash,
    liveIntegrityHash,
  });
  const verdict = publicReviewVerdict(review.verdict);
  const authorized = binding === 'current' && verdict === 'accepted';
  const findings = typeof review.findings === 'string' && review.findings.trim()
    ? redactDiagnosticMessage(review.findings)
    : null;
  return {
    id: review.reviewId,
    ticketId: review.ticketId,
    ticketTitle: redactTitle(ticket ? ticket.title : null),
    runId: review.runId,
    revisionId: review.revisionId || null,
    planRevisionId: review.planRevisionId || null,
    candidateId: review.candidateId || null,
    integrityHash: integrityHash || null,
    verdict,
    findings,
    createdAt: review.createdAt || null,
    binding,
    authorized,
  };
}

const DECISION_REQUEST_MAX = 4000;
const ANSWERABLE_DECISION_KINDS = new Set(['intake_clarification', 'lead_decision']);
const ACTIVE_DECISION_RUN_STATUSES = new Set(['queued', 'running', 'paused', 'interrupted']);

function decisionText(value) {
  return typeof value === 'string' ? truncate(redactDiagnosticMessage(value), DECISION_REQUEST_MAX) : null;
}

function sanitizeDecisionRequest(kind, request) {
  const source = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  if (kind === 'intake_clarification') {
    return { questions: (Array.isArray(source.questions) ? source.questions : []).slice(0, 50).map((question) => ({
      id: question && typeof question.id === 'string' ? truncate(question.id, 200) : null,
      question: decisionText(question && question.question),
      why: decisionText(question && question.why),
    })) };
  }
  if (kind === 'lead_decision') {
    return {
      question: decisionText(source.question),
      reason: decisionText(source.reason),
      recommendation: decisionText(source.recommendation),
      options: (Array.isArray(source.options) ? source.options : []).slice(0, 50).map((option) => ({
        id: option && typeof option.id === 'string' ? truncate(option.id, 200) : null,
        description: decisionText(option && option.description),
      })),
    };
  }
  return {};
}

function sanitizeDecisionAnswer(kind, answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  if (kind === 'intake_clarification') {
    return { answers: (Array.isArray(answer.answers) ? answer.answers : []).slice(0, 50).map((entry) => ({
      questionId: entry && typeof entry.questionId === 'string' ? truncate(entry.questionId, 200) : null,
      answer: decisionText(entry && entry.answer),
    })) };
  }
  if (kind === 'lead_decision') {
    return {
      answer: decisionText(answer.answer),
      choice: typeof answer.choice === 'string' ? truncate(answer.choice, 200) : null,
    };
  }
  return null;
}

function mapRunDecision(store, ticket, run, decision) {
  const runBound = decision.runId === run.runId
    && decision.revisionId === run.revisionId
    && decision.planRevisionId === (run.planRevisionId || null);
  const revisionCurrent = typeof decision.revisionId === 'string' && decision.revisionId.length > 0
    && decision.revisionId === ticket.currentRevisionId;
  const binding = revisionCurrent && runBound ? 'current'
    : (decision.revisionId && ticket.currentRevisionId && decision.revisionId !== ticket.currentRevisionId ? 'stale' : 'unavailable');
  const current = binding === 'current';
  const state = decision.state === 'pending' && !current ? 'stale' : decision.state;
  const expectedVersion = Number.isInteger(ticket.version) ? ticket.version : null;
  const actionable = state === 'pending' && current && ticket.status === 'waiting_human'
    && ACTIVE_DECISION_RUN_STATUSES.has(run.status) && expectedVersion !== null
    && ANSWERABLE_DECISION_KINDS.has(decision.kind);
  const answer = sanitizeDecisionAnswer(decision.kind, decision.answer);
  return {
    id: `decision:${decision.decisionId}`,
    decisionId: decision.decisionId,
    kind: decision.kind,
    state,
    ticketId: ticket.ticketId,
    ticketTitle: redactTitle(ticket.title),
    runId: run.runId,
    revisionId: decision.revisionId || null,
    planRevisionId: decision.planRevisionId || null,
    binding,
    authorized: false,
    actionable,
    expectedVersion,
    request: sanitizeDecisionRequest(decision.kind, decision.request),
    answer,
    createdAt: decision.createdAt || null,
    answeredAt: decision.answeredAt || null,
  };
}

function projectDecisions(read) {
  if (!read || read.ok !== true) return decisionsUnavailable(read && read.reason);
  return {
    available: true,
    pending: Array.isArray(read.pending) ? read.pending : [],
    responses: Array.isArray(read.responses) ? read.responses : [],
  };
}

function collectDecisions(productStore) {
  const required = ['listTickets', 'listReviews', 'listControlRequests', 'latestRunOf', 'getReviewForRun', 'getCandidate', 'listRuns', 'listDecisions', 'getRun'];
  if (!productStore || required.some((method) => typeof productStore[method] !== 'function')) {
    return { ok: false, reason: 'Product store is unavailable' };
  }
  try {
    const pending = [];
    const decisionResponses = [];
    for (const ticket of productStore.listTickets()) {
      for (const runSummary of productStore.listRuns(ticket.ticketId)) {
        const run = productStore.getRun(runSummary.runId);
        if (!run) continue;
        for (const decision of productStore.listDecisions(run.runId)) {
          if (!ANSWERABLE_DECISION_KINDS.has(decision.kind)) continue;
          const projected = mapRunDecision(productStore, ticket, run, decision);
          if (projected.state === 'pending' || projected.state === 'stale') pending.push(projected);
          else if (projected.state === 'answered') decisionResponses.push(projected);
        }
      }
      if (ticket.status !== 'waiting_human') continue;
      const latest = productStore.latestRunOf(ticket.ticketId);
      if (!latest || latest.status !== 'completed' || latest.waitReason !== 'human_review' || !latest.candidateId) continue;
      if (productStore.getReviewForRun(latest.runId)) continue;
      const candidate = productStore.getCandidate(latest.candidateId);
      pending.push(mapPendingReview(productStore, ticket, latest, candidate));
    }
    for (const run of productStore.listControlRequests()) {
      pending.push(mapOperatorCommand(productStore, run));
    }
    const responses = productStore.listReviews().map((review) => mapReviewResponse(productStore, review)).concat(decisionResponses);
    return { ok: true, pending, responses };
  } catch (error) {
    return { ok: false, reason: redactDiagnosticMessage(error && error.message ? error.message : 'Decisions are unavailable') };
  }
}

function relativeSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return '';
  const normalized = sourcePath.replace(/\\/g, '/');
  if (path.isAbsolute(normalized)) return path.basename(normalized);
  return normalized.replace(/^\.\/+/, '');
}

function readDocFileContent(io, filePath, format) {
  let raw;
  try {
    raw = io.readFileSync(filePath);
  } catch (error) {
    return { status: 'unavailable', content: null, truncated: false, reason: redactDiagnosticMessage(error.message) };
  }
  if (Buffer.isBuffer(raw) && raw.includes(0)) {
    return { status: 'unavailable', content: null, truncated: false, reason: 'Unsupported binary content (NUL bytes)' };
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (text.includes('\u0000')) {
    return { status: 'unavailable', content: null, truncated: false, reason: 'Unsupported binary content (NUL bytes)' };
  }
  let content = redactDiagnosticMessage(text);
  let truncated = false;
  if (content.length > DOC_MAX_CHARS) {
    content = content.slice(0, DOC_MAX_CHARS);
    truncated = true;
  }
  const status = truncated ? 'truncated' : 'available';
  const reason = truncated ? 'Content truncated' : null;
  return { status, content, truncated, reason, format };
}

function pushDocEntry(documents, entry) {
  if (!entry || !entry.id || !DOC_SOURCES.has(entry.source)) return;
  documents.push({
    id: entry.id,
    title: entry.title,
    source: entry.source,
    sourcePath: relativeSourcePath(entry.sourcePath),
    status: entry.status,
    format: entry.format,
    content: entry.content,
    truncated: Boolean(entry.truncated),
    reason: entry.reason || null,
  });
}

function readDocsCatalog({ packDir, projectConfig, projectConfigPath, io = fs } = {}) {
  const documents = [];
  try {
    const root = path.resolve(packDir || '');
    let manifest = null;
    try {
      manifest = JSON.parse(io.readFileSync(path.join(root, 'pack.json'), 'utf8'));
    } catch (_) {
      manifest = null;
    }
    const presetIds = manifest && Array.isArray(manifest.presets) ? manifest.presets : [];
    const unavailablePresetIds = manifest && Array.isArray(manifest.unavailablePresets) ? manifest.unavailablePresets : [];

    try {
      const team = readDocFileContent(io, path.join(root, 'TEAM.md'), 'markdown');
      pushDocEntry(documents, {
        id: 'role:team',
        title: 'TEAM.md',
        source: 'role',
        sourcePath: 'TEAM.md',
        format: 'markdown',
        ...team,
      });
    } catch (error) {
      pushDocEntry(documents, {
        id: 'role:team',
        title: 'TEAM.md',
        source: 'role',
        sourcePath: 'TEAM.md',
        status: 'unavailable',
        format: 'markdown',
        content: null,
        truncated: false,
        reason: redactDiagnosticMessage(error.message),
      });
    }

    const agentsDir = path.join(root, 'agents');
    try {
      const names = io.readdirSync(agentsDir).filter((name) => name.endsWith('.toml')).sort();
      for (const name of names) {
        const filePath = path.join(agentsDir, name);
        const base = path.basename(name, '.toml');
        try {
          const stat = io.statSync(filePath);
          if (!stat.isFile()) {
            pushDocEntry(documents, {
              id: `role:${base}`,
              title: name,
              source: 'role',
              sourcePath: `agents/${name}`,
              status: 'unavailable',
              format: 'toml',
              content: null,
              truncated: false,
              reason: 'Not a readable file',
            });
            continue;
          }
          const doc = readDocFileContent(io, filePath, 'toml');
          pushDocEntry(documents, {
            id: `role:${base}`,
            title: name,
            source: 'role',
            sourcePath: `agents/${name}`,
            format: 'toml',
            ...doc,
          });
        } catch (error) {
          pushDocEntry(documents, {
            id: `role:${base}`,
            title: name,
            source: 'role',
            sourcePath: `agents/${name}`,
            status: 'unavailable',
            format: 'toml',
            content: null,
            truncated: false,
            reason: redactDiagnosticMessage(error.message),
          });
        }
      }
    } catch (error) {
      pushDocEntry(documents, {
        id: 'role:agents',
        title: 'agents',
        source: 'role',
        sourcePath: 'agents',
        status: 'unavailable',
        format: 'toml',
        content: null,
        truncated: false,
        reason: redactDiagnosticMessage(error.message),
      });
    }

    for (const presetId of presetIds) {
      const sourcePath = `presets/${presetId}.json`;
      const filePath = path.join(root, sourcePath);
      try {
        const stat = io.statSync(filePath);
        if (!stat.isFile()) throw new Error('Preset file is not available');
        const doc = readDocFileContent(io, filePath, 'json');
        pushDocEntry(documents, {
          id: `preset:${presetId}`,
          title: `${presetId}.json`,
          source: 'preset',
          sourcePath,
          format: 'json',
          ...doc,
        });
      } catch (error) {
        pushDocEntry(documents, {
          id: `preset:${presetId}`,
          title: `${presetId}.json`,
          source: 'preset',
          sourcePath,
          status: 'unavailable',
          format: 'json',
          content: null,
          truncated: false,
          reason: redactDiagnosticMessage(error.message),
        });
      }
    }

    for (const presetId of unavailablePresetIds) {
      pushDocEntry(documents, {
        id: `preset:${presetId}`,
        title: `${presetId}.json`,
        source: 'preset',
        sourcePath: `presets/${presetId}.json`,
        status: 'unavailable',
        format: 'json',
        content: null,
        truncated: false,
        reason: 'Preset file is not available',
      });
    }

    if (projectConfig && typeof projectConfig === 'object') {
      if (projectConfig.source === 'file' && projectConfigPath) {
        try {
          const doc = readDocFileContent(io, projectConfigPath, 'json');
          pushDocEntry(documents, {
            id: 'project:config',
            title: path.basename(projectConfigPath),
            source: 'project',
            sourcePath: relativeSourcePath(projectConfigPath),
            format: 'json',
            ...doc,
          });
        } catch (error) {
          pushDocEntry(documents, {
            id: 'project:config',
            title: path.basename(String(projectConfigPath)),
            source: 'project',
            sourcePath: relativeSourcePath(String(projectConfigPath)),
            status: 'unavailable',
            format: 'json',
            content: null,
            truncated: false,
            reason: redactDiagnosticMessage(error.message),
          });
        }
      } else {
        const publicFields = {
          source: projectConfig.source,
          revision: projectConfig.revision,
          baseRef: projectConfig.baseRef,
          branchPrefixes: projectConfig.branchPrefixes,
          rolePack: projectConfig.rolePack,
          delivery: projectConfig.delivery,
          checks: projectConfig.checks,
        };
        let content = redactDiagnosticMessage(JSON.stringify(publicFields, null, 2));
        let truncated = false;
        let status = 'available';
        let reason = null;
        if (content.length > DOC_MAX_CHARS) {
          content = content.slice(0, DOC_MAX_CHARS);
          truncated = true;
          status = 'truncated';
          reason = 'Content truncated';
        }
        pushDocEntry(documents, {
          id: 'project:config',
          title: 'Project config',
          source: 'project',
          sourcePath: 'defaults',
          status,
          format: 'json',
          content,
          truncated,
          reason,
        });
      }
    } else {
      pushDocEntry(documents, {
        id: 'project:config',
        title: 'Project config',
        source: 'project',
        sourcePath: 'defaults',
        status: 'unavailable',
        format: 'json',
        content: null,
        truncated: false,
        reason: 'Project config is not available',
      });
    }

    return { ok: true, documents };
  } catch (error) {
    return { ok: false, reason: redactDiagnosticMessage(error && error.message ? error.message : 'Docs are unavailable'), documents: [] };
  }
}

function projectDocs(read) {
  if (!read || read.ok !== true) {
    return {
      available: false,
      reason: redactDiagnosticMessage(read && read.reason ? read.reason : 'Docs are unavailable'),
      documents: [],
    };
  }
  const documents = [];
  for (const doc of read.documents || []) {
    if (!doc || typeof doc.id !== 'string' || !doc.id || !DOC_SOURCES.has(doc.source)) continue;
    const content = doc.content == null ? null : redactDiagnosticMessage(String(doc.content));
    documents.push({
      id: doc.id,
      title: typeof doc.title === 'string' ? redactDiagnosticMessage(doc.title) : 'unavailable',
      source: doc.source,
      sourcePath: relativeSourcePath(doc.sourcePath),
      status: doc.status,
      format: doc.format,
      content,
      truncated: Boolean(doc.truncated),
      reason: doc.reason ? redactDiagnosticMessage(String(doc.reason)) : null,
    });
  }
  return { available: true, documents };
}


function createProjection({ db, roleIds = [], projectId = null, productStore = null } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('createProjection requires a better-sqlite3 db');
  const specialistRoles = [...new Set(roleIds)].filter((id) => typeof id === 'string' && id && id !== LEAD_ROLE);
  const knownRoles = [LEAD_ROLE, ...specialistRoles];
  const knownNamespaces = new Set([LEAD_NAMESPACE, ...specialistRoles]);

  function prepareRead(sql) {
    const stmt = db.prepare(sql);
    if (stmt.reader !== true) throw new Error('dashboard projection may only prepare read statements');
    return stmt;
  }

  const hasTable = (name) => Boolean(prepareRead("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

  const selectLight = prepareRead(`SELECT tenant, owner, id, context_id, status_state, status_last_updated,
    length(history) AS history_len, length(metadata) AS metadata_len, length(artifacts) AS artifacts_len FROM tasks`);
  const selectHeavy = prepareRead('SELECT status, history, metadata, artifacts FROM tasks WHERE tenant = ? AND owner = ? AND id = ?');
  const selectLightOne = prepareRead(`SELECT tenant, owner, id, context_id, status_state, status_last_updated,
    length(history) AS history_len, length(metadata) AS metadata_len, length(artifacts) AS artifacts_len
    FROM tasks WHERE tenant = ? AND owner = ? AND id = ?`);
  const selectTaskByOwnerId = prepareRead('SELECT tenant, id, context_id, status_state FROM tasks WHERE owner = ? AND id = ? ORDER BY tenant');
  const selectTaskByOwnerContext = prepareRead('SELECT tenant, id, context_id, status_state FROM tasks WHERE owner = ? AND context_id = ? ORDER BY tenant, id');

  let journalStatements = null;
  function journal() {
    if (!journalStatements) {
      if (!hasTable('dispatch_journal')) return null;
      journalStatements = {
        all: prepareRead('SELECT attempt_id, run_id, role, task_id, context_id FROM dispatch_journal'),
        run: prepareRead('SELECT * FROM dispatch_journal WHERE run_id = ? ORDER BY created_at, rowid'),
      };
    }
    return journalStatements;
  }

  // In-process summary cache keyed by the light tuple; heavy JSON is parsed only when it changes.
  const cache = new Map();
  const cacheStats = { hits: 0, misses: 0 };

  function summaryFor(row) {
    const key = `${row.owner}\u0000${row.tenant}\u0000${row.id}`;
    const tuple = [row.status_state, row.status_last_updated, row.history_len, row.metadata_len, row.artifacts_len].join('|');
    const cached = cache.get(key);
    if (cached && cached.tuple === tuple) {
      cacheStats.hits += 1;
      cached.seen = true;
      return cached.summary;
    }
    cacheStats.misses += 1;
    const heavy = selectHeavy.get(row.tenant, row.owner, row.id);
    const history = parseJson(heavy?.history, []);
    const metadata = parseJson(heavy?.metadata, {});
    const artifacts = parseJson(heavy?.artifacts, []);
    const pauseKind = typeof metadata?.pause?.kind === 'string' ? metadata.pause.kind : null;
    const summary = {
      title: goalTitle(history),
      acceptance: acceptanceOf(resultArtifact(artifacts, row.id)),
      pauseKind,
    };
    cache.set(key, { tuple, summary, seen: true });
    return summary;
  }

  function readJournal() {
    const stmts = journal();
    const linkedTaskIds = new Set();
    const linkedContextIds = new Set();
    const byRun = new Map();
    if (!stmts) return { linkedTaskIds, linkedContextIds, byRun };
    for (const row of stmts.all.all()) {
      if (row.task_id) linkedTaskIds.add(row.task_id);
      if (row.context_id) linkedContextIds.add(row.context_id);
      let entry = byRun.get(row.run_id);
      if (!entry) { entry = { count: 0, roles: new Set() }; byRun.set(row.run_id, entry); }
      entry.count += 1;
      if (row.role) entry.roles.add(row.role);
    }
    return { linkedTaskIds, linkedContextIds, byRun };
  }

  // A specialist task is a journal child by task id, or by context id when the submission was lost (task_id NULL).
  const isChild = (row, info) => info.linkedTaskIds.has(row.id)
    || Boolean(row.context_id && info.linkedContextIds.has(row.context_id));

  function buildCard(row, summary, journalInfo) {
    const isLead = row.owner === LEAD_NAMESPACE;
    const rawState = row.status_state ?? null;
    const cls = classify(rawState, summary.pauseKind);
    const participating = [];
    let attemptCount = 0;
    if (isLead) {
      participating.push(LEAD_ROLE);
      const run = journalInfo.byRun.get(row.id);
      if (run) {
        attemptCount = run.count;
        for (const role of [...run.roles].sort()) if (!participating.includes(role)) participating.push(role);
      }
    } else {
      participating.push(row.owner);
    }
    return {
      cardId: encodeCardId({ namespace: row.owner, tenant: row.tenant, taskId: row.id }),
      cardKind: isLead ? 'legacy_run' : 'standalone_execution',
      runtimeTaskRef: { namespace: row.owner, tenant: row.tenant, taskId: row.id, contextId: row.context_id },
      projectId,
      ticketId: null,
      title: summary.title,
      boardColumn: cls.boardColumn,
      executionStatus: cls.executionStatus,
      displayStatus: cls.displayStatus,
      rawState,
      acceptance: summary.acceptance,
      humanReview: 'unknown',
      waitReason: cls.waitReason,
      primaryRole: isLead ? LEAD_ROLE : row.owner,
      participatingRoles: participating,
      attemptCount,
      createdAt: null,
      updatedAt: isoFromMs(row.status_last_updated),
      _updatedMs: Number(row.status_last_updated) || 0,
    };
  }

  // Run-derived card fields: active (else latest) run for phase/waitReason, latest valid intake, latest candidate.
  function ticketRunFields(ticket) {
    const ticketId = ticket.ticketId;
    const out = {
      phase: null, classification: null, disposition: null, waitReason: null, waitMessage: null, controlRequest: null, returnable: false, runStatus: null,
    };
    if (!productStore || typeof productStore.latestRunOf !== 'function') return out;
    try {
      const active = productStore.getActiveRun(ticketId);
      const latest = active || productStore.latestRunOf(ticketId);
      if (active) out.phase = active.phase;
      out.controlRequest = active && active.controlRequest ? active.controlRequest : null;
      out.returnable = canReturnToBacklog(ticket, active);
      // A closed or idle ticket must not show the wait reason of its last run.
      if (latest && (active || ['waiting_human', 'blocked', 'paused'].includes(ticket.status))) out.waitReason = latest.waitReason || null;
      if (latest) out.runStatus = latest.status;
      if (active && active.waitDetail && typeof active.waitDetail.message === 'string' && active.waitDetail.message) out.waitMessage = active.waitDetail.message;
      const runs = productStore.listRuns(ticketId);
      for (const summary of runs) {
        if (out.classification === null) {
          const records = productStore.listIntakeRecords(summary.runId).filter((record) => record.valid && record.output && typeof record.output.classification === 'string');
          if (records.length) out.classification = records[records.length - 1].output.classification;
        }
        if (out.disposition === null && summary.candidateId) {
          const candidate = productStore.getCandidate(summary.candidateId);
          if (candidate && candidate.acceptance && typeof candidate.acceptance.disposition === 'string') out.disposition = candidate.acceptance.disposition;
        }
        if (out.classification !== null && out.disposition !== null) break;
      }
    } catch (_) { /* run tables are absent before migration 2; fall back to bare fields */ }
    return out;
  }

  function buildTicketCard(ticket) {
    const [boardColumn, tableStatus] = TICKET_STATE_TABLE[ticket.status] || ['needs_attention', String(ticket.status)];
    const runFields = ticketRunFields(ticket);
    // A stopped run is shown as such, not as a generic block.
    const displayStatus = ticket.status === 'blocked' && runFields.runStatus === 'stopped' ? 'Stopped' : tableStatus;
    const dragActions = [];
    if (ticket.status === 'backlog') dragActions.push('submit');
    if (runFields.returnable) dragActions.push('return_to_backlog');
    return {
      cardId: ticket.ticketId,
      cardKind: 'ticket',
      runtimeTaskRef: null,
      projectId: ticket.projectId || projectId,
      ticketId: ticket.ticketId,
      title: ticket.title,
      boardColumn,
      executionStatus: null,
      displayStatus,
      rawState: null,
      acceptance: null,
      humanReview: 'unknown',
      waitReason: runFields.waitReason,
      waitMessage: runFields.waitMessage,
      ticketStatus: ticket.status,
      phase: runFields.phase,
      controlRequest: runFields.controlRequest,
      dragActions,
      classification: runFields.classification,
      disposition: runFields.disposition,
      primaryRole: null,
      participatingRoles: [],
      requestedSpecialty: ticket.requestedSpecialty ?? null,
      priority: ticket.priority,
      revisionOrdinal: ticket.revisionOrdinal,
      attachmentCount: ticket.attachmentCount,
      attemptCount: 0,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      _updatedMs: Date.parse(ticket.updatedAt) || 0,
    };
  }

  function publicCard(card) {
    const { _updatedMs, ...rest } = card;
    return rest;
  }

  // Lead tasks owned by a product run are shown inside the ticket, not as separate cards.
  function linkedLeadTaskIds() {
    if (!productStore) return new Set();
    try {
      return new Set(db.prepare('SELECT lead_task_id FROM runs WHERE lead_task_id IS NOT NULL').all().map((row) => row.lead_task_id));
    } catch (_) {
      return new Set();
    }
  }

  function allCards() {
    const info = readJournal();
    const { byRun } = info;
    for (const entry of cache.values()) entry.seen = false;
    const cards = [];
    const linked = linkedLeadTaskIds();
    for (const row of selectLight.all()) {
      if (!knownNamespaces.has(row.owner)) continue;
      if (row.owner === LEAD_NAMESPACE && linked.has(row.id)) continue;
      if (row.owner !== LEAD_NAMESPACE && isChild(row, info)) continue;
      cards.push(buildCard(row, summaryFor(row), { byRun }));
    }
    for (const [key, entry] of cache) if (!entry.seen) cache.delete(key);
    if (productStore) for (const ticket of productStore.listTickets()) cards.push(buildTicketCard(ticket));
    cards.sort((a, b) => (b._updatedMs - a._updatedMs) || (a.cardId < b.cardId ? 1 : a.cardId > b.cardId ? -1 : 0));
    return cards;
  }

  function parseLimit(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
    const text = String(value);
    if (!/^\d+$/.test(text)) throw invalid('limit must be a positive integer');
    const n = Number(text);
    if (n < 1 || n > MAX_LIMIT) throw invalid(`limit must be between 1 and ${MAX_LIMIT}`);
    return n;
  }

  function encodeCursor(card) {
    return Buffer.from(JSON.stringify({ u: card._updatedMs, c: card.cardId }), 'utf8').toString('base64url');
  }

  function decodeCursor(cursor) {
    if (typeof cursor !== 'string' || !cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid('Invalid cursor');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch (_) { throw invalid('Invalid cursor'); }
    if (!parsed || !Number.isFinite(parsed.u) || typeof parsed.c !== 'string' || !parsed.c) throw invalid('Invalid cursor');
    return { u: parsed.u, c: parsed.c };
  }

  function listCards({ column, role, q, limit, cursor } = {}) {
    const has = (v) => v !== undefined && v !== null && v !== '';
    if (has(column) && !COLUMNS.includes(column)) throw invalid(`column must be one of ${COLUMNS.join(', ')}`);
    if (has(role) && !knownRoles.includes(role)) throw invalid('Unknown role');
    if (has(q) && (typeof q !== 'string' || q.length > MAX_Q_CHARS)) throw invalid(`q must be a string of at most ${MAX_Q_CHARS} characters`);
    const pageSize = parseLimit(limit);
    const after = has(cursor) ? decodeCursor(cursor) : null;

    const snapshotAt = new Date().toISOString();
    const cards = allCards();
    const roleCounts = Object.fromEntries(knownRoles.map((id) => [id, 0]));
    for (const card of cards) {
      for (const id of card.participatingRoles) roleCounts[id] = (roleCounts[id] || 0) + 1;
    }
    const needle = has(q) ? q.toLowerCase() : null;
    const scoped = cards.filter((card) => (!has(role) || card.participatingRoles.includes(role))
      && (!needle || card.title.toLowerCase().includes(needle)
        || (card.runtimeTaskRef ? card.runtimeTaskRef.taskId : card.ticketId).toLowerCase().includes(needle)));
    const counts = Object.fromEntries(COLUMNS.map((name) => [name, 0]));
    for (const card of scoped) counts[card.boardColumn] += 1;

    let page = scoped.filter((card) => !has(column) || card.boardColumn === column);
    if (after) {
      page = page.filter((card) => card._updatedMs < after.u || (card._updatedMs === after.u && card.cardId < after.c));
    }
    const slice = page.slice(0, pageSize);
    const nextCursor = page.length > pageSize ? encodeCursor(slice[slice.length - 1]) : null;
    return { cards: slice.map(publicCard), counts, roleCounts, nextCursor, snapshotAt };
  }

  function locate(cardId) {
    const ref = decodeRaw(cardId);
    if (!knownNamespaces.has(ref.namespace)) throw invalid('Invalid cardId');
    const row = selectLightOne.get(ref.tenant, ref.namespace, ref.taskId);
    if (!row) throw requestError('Card not found', 'not_found');
    const info = readJournal();
    if (row.owner !== LEAD_NAMESPACE && isChild(row, info)) throw requestError('Card not found', 'not_found');
    return { ref, row, info };
  }

  function getCard(cardId) {
    const { row, info } = locate(cardId);
    const card = publicCard(buildCard(row, summaryFor(row), info));
    const heavy = selectHeavy.get(row.tenant, row.owner, row.id);
    const status = parseJson(heavy?.status, null);
    const history = parseJson(heavy?.history, []);
    const metadata = parseJson(heavy?.metadata, {});
    const artifacts = parseJson(heavy?.artifacts, []);
    const statusText = messageText(status?.message);
    const resultText = messageText(resultArtifact(artifacts, row.id));
    const userMessages = (Array.isArray(history) ? history : []).filter(isUserMessage)
      .map((message) => ({ text: truncate(messageText(message), MAX_USER_MESSAGE_CHARS), at: null }))
      .filter((entry) => entry.text)
      .slice(0, MAX_USER_MESSAGES);
    return {
      card,
      statusMessage: statusText ? truncate(statusText, MAX_STATUS_MESSAGE_CHARS) : null,
      pause: sanitizePause(metadata?.pause),
      resultText: resultText ? truncate(resultText, MAX_RESULT_CHARS) : null,
      userMessages,
      availableActions: [],
      unavailableActions: UNAVAILABLE_ACTIONS.map((entry) => ({ ...entry })),
    };
  }

  function getAttempts(cardId) {
    const { row } = locate(cardId);
    if (row.owner !== LEAD_NAMESPACE) return { attempts: [] };
    const stmts = journal();
    if (!stmts) return { attempts: [] };
    const attempts = stmts.run.all(row.id).map((entry) => {
      let runtimeTaskRef = null;
      let taskState = null;
      if (knownNamespaces.has(entry.role)) {
        let found = entry.task_id ? selectTaskByOwnerId.all(entry.role, entry.task_id) : [];
        if (!found.length && entry.context_id) found = selectTaskByOwnerContext.all(entry.role, entry.context_id);
        const match = found.find((task) => task.tenant === row.tenant) || found[0];
        if (match) {
          runtimeTaskRef = { namespace: entry.role, tenant: match.tenant, taskId: match.id, contextId: entry.context_id };
          taskState = match.status_state ?? null;
        }
      }
      const result = parseJson(entry.result_json, null);
      return {
        attemptId: entry.attempt_id,
        assignmentId: entry.assignment_id,
        role: entry.role,
        sandbox: entry.sandbox,
        journalState: entry.state,
        runtimeTaskRef,
        taskState,
        outcome: typeof result?.status === 'string' ? result.status : null,
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
      };
    });
    return { attempts };
  }

  function getUsage(cardId) {
    const { row } = locate(cardId);
    const report = row.owner === LEAD_NAMESPACE
      ? buildReport(db, { runId: row.id })
      : buildReport(db, { taskId: row.id });
    const totals = report.totals;
    let status = 'complete';
    if (totals.rows === 0) status = 'unavailable';
    else if (totals.tokensPartial || totals.turnsPartial || totals.elapsedMsPartial || totals.retriesPartial) status = 'partial';
    const coverage = {
      status,
      rows: totals.rows,
      tokensKnownRows: totals.tokensKnownRows,
      tokensUnknownRows: totals.tokensUnknownRows,
    };
    if (row.owner === LEAD_NAMESPACE) {
      // Complete only when every dispatch attempt has a worker usage row and the lead itself recorded a turn.
      const stmts = journal();
      const attempts = stmts ? stmts.run.all(row.id) : [];
      const hasLedger = hasTable('usage_ledger');
      const workerRows = hasLedger ? prepareRead(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE kind = 'worker_turn' AND ((task_id IS NOT NULL AND task_id = ?) OR (context_id IS NOT NULL AND context_id = ?))") : null;
      const leadRows = hasLedger
        ? prepareRead("SELECT COUNT(*) AS n FROM usage_ledger WHERE kind = 'lead_turn' AND run_id = ?").get(row.id).n : 0;
      coverage.attemptsWithoutUsage = attempts.filter((entry) => !workerRows
        || workerRows.get(entry.task_id ?? null, entry.context_id ?? null).n === 0).length;
      if (status === 'complete' && (coverage.attemptsWithoutUsage > 0 || leadRows === 0)) coverage.status = 'partial';
    }
    report.coverage = coverage;
    // Attach cacheShare using the same rule as ticket-telemetry (ratio of sums over paired rows).
    report.totals.cacheShare = cachedInputShare(report.attempts);
    const roleIds = Object.keys(report.byRole);
    for (const roleId of roleIds) {
      const roleAttempts = report.attempts.filter((a) => a.role === roleId);
      report.byRole[roleId].cacheShare = cachedInputShare(roleAttempts);
    }
    return report;
  }

  return {
    listCards,
    getCard,
    getAttempts,
    getUsage,
    encodeCardId,
    decodeCardId(cardId) {
      const ref = decodeRaw(cardId);
      if (!knownNamespaces.has(ref.namespace)) throw invalid('Invalid cardId');
      return ref;
    },
    cacheStats: () => ({ ...cacheStats, size: cache.size }),
  };
}

module.exports = {
  createProjection,
  encodeCardId,
  canReturnToBacklog,
  projectMonitor,
  projectDecisions,
  collectDecisions,
  projectDocs,
  readDocsCatalog,
  DOC_MAX_CHARS,
};
