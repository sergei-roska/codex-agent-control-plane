'use strict';

// Read-only projection of stored A2A tasks into dashboard board cards (M1-02).
// SELECT-only prepared statements on the shared handle; no DDL, writes, migrations or model calls.

const { buildReport } = require('./usage-report');

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

module.exports = { createProjection, encodeCardId, canReturnToBacklog };
