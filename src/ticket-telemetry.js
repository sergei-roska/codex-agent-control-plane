'use strict';

// Ticket activity telemetry. Pure functions and the activity builder used by the dashboard API.
// No SSE, no model reasoning, no new command executor.

const { summarize, hypotheticalCost } = require('./usage-report');
const { redactDiagnosticMessage } = require('./event-journal');
const { UsageLedger } = require('./usage-ledger');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Cached input share: ratio of sums over entries where BOTH cachedInputTokens AND inputTokens are finite.
// share = sum(cachedInputTokens) / sum(inputTokens) over paired entries.
// Entries that lack either value are unpaired and do not contribute to the ratio.
// If no paired entries or denominator is zero: share null (unavailable).
// Observed zero numerator with positive denominator: share 0, status available (or partial).
function cachedInputShare(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let sumCached = 0;
  let sumInput = 0;
  let pairedRows = 0;
  let unpairedRows = 0;
  const totalRows = list.length;

  for (const entry of list) {
    const tokens = entry && entry.tokens && typeof entry.tokens === 'object' ? entry.tokens : null;
    const cached = tokens ? tokens.cachedInputTokens : undefined;
    const input = tokens ? tokens.inputTokens : undefined;
    if (isNum(cached) && isNum(input)) {
      sumCached += cached;
      sumInput += input;
      pairedRows += 1;
    } else {
      unpairedRows += 1;
    }
  }

  const meaning = 'token reuse, not cache-hit rate and not money saved';

  if (pairedRows === 0 || sumInput === 0) {
    return { status: 'unavailable', share: null, meaning, pairedRows, unpairedRows, totalRows };
  }

  const share = sumCached / sumInput;
  const partial = unpairedRows > 0;
  const out = {
    status: partial ? 'partial' : 'available',
    share,
    meaning,
    pairedRows,
    unpairedRows,
    totalRows,
  };
  if (partial) {
    out.coverageNote = 'Computed from ' + pairedRows + ' of ' + totalRows + ' rows; does not represent the full run.';
  }
  return out;
}

// Monetary cost: reads measuredCost field on each entry only.
// Unknown amount stays null; 0 is a real zero and is returned as-is.
// The existing usage report does not set measuredCost (subscription), so this returns unavailable by default.
function monetaryCost(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let total = 0;
  let rows = 0;
  for (const entry of list) {
    if (isNum(entry.measuredCost)) { total += entry.measuredCost; rows += 1; }
  }
  if (rows === 0) return { status: 'unavailable', amount: null };
  return { status: 'available', amount: total, currency: 'USD', rows };
}

function parseResult(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function attemptOutcome(result) {
  if (!result || typeof result !== 'object') return null;
  for (const key of ['outcome', 'status', 'state']) {
    if (typeof result[key] === 'string') return result[key];
  }
  return null;
}

function redactJournalEntry(event) {
  if (!event || typeof event !== 'object') return event;
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.message !== 'string') {
    return event;
  }
  let message;
  try {
    message = redactDiagnosticMessage(payload.message);
  } catch (_) {
    message = '[REDACTED]';
  }
  if (message === payload.message) return event;
  return Object.assign({}, event, { payload: Object.assign({}, payload, { message }) });
}

function redactReview(review) {
  if (!review) return null;
  const out = Object.assign({}, review);
  if (typeof out.findings === 'string') out.findings = redactDiagnosticMessage(out.findings);
  return out;
}

function redactAcceptance(acceptance) {
  if (!acceptance || typeof acceptance !== 'object') return null;
  const out = Object.assign({}, acceptance);
  if (Array.isArray(out.reasons)) {
    out.reasons = out.reasons.map((r) => {
      if (typeof r === 'string') return redactDiagnosticMessage(r);
      if (r && typeof r === 'object') {
        const rc = Object.assign({}, r);
        if (typeof rc.message === 'string') rc.message = redactDiagnosticMessage(rc.message);
        if (typeof rc.detail === 'string') rc.detail = redactDiagnosticMessage(rc.detail);
        if (typeof rc.text === 'string') rc.text = redactDiagnosticMessage(rc.text);
        return rc;
      }
      return r;
    });
  }
  if (Array.isArray(out.checks)) {
    out.checks = out.checks.map((ch) => {
      if (!ch || typeof ch !== 'object') return ch;
      const c = Object.assign({}, ch);
      if (typeof c.outputTail === 'string') c.outputTail = redactDiagnosticMessage(c.outputTail);
      return c;
    });
  }
  return out;
}

function hasTable(db, name) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch (_) { return false; }
}

function queryDispatchJournal(db, leadTaskId) {
  try {
    if (!hasTable(db, 'dispatch_journal')) return [];
    return db.prepare(
      'SELECT attempt_id, role, state, result_json, created_at, updated_at FROM dispatch_journal WHERE run_id = ? ORDER BY created_at, rowid',
    ).all(String(leadTaskId));
  } catch (_) {
    return null; // null signals a query failure
  }
}

// Collect and deduplicate usage rows for a list of full runs. Tags each row with productRunId.
function collectUsageRows(db, fullRuns) {
  const ledger = new UsageLedger({ db, readonly: true });
  const seen = new Set();
  const all = [];

  for (const run of fullRuns) {
    // Intake rows are recorded with the product run id directly.
    let intakeRows = [];
    try { intakeRows = ledger.listByRecordedRun(run.runId); } catch (_) {}

    // Lead + worker rows are keyed by the lead task id.
    let leadWorkerRows = [];
    if (run.leadTaskId) {
      try { leadWorkerRows = ledger.listByRun(run.leadTaskId); } catch (_) {}
    }

    for (const row of [...intakeRows, ...leadWorkerRows]) {
      if (seen.has(row.entryId)) continue;
      seen.add(row.entryId);
      all.push(Object.assign({}, row, { productRunId: run.runId }));
    }
  }
  return all;
}

// Route view of a run: the Intake route decision (latest ready intake of the run or its rework parents) plus the lead
// result route metadata kept with the candidate acceptance. Null for runs without a decision (policy off, pre-feature).
function routeViewOf(productStore, run) {
  try {
    let decision = null;
    const seen = new Set();
    for (let cur = run; cur && !decision && !seen.has(cur.runId); cur = cur.parentRunId ? productStore.getRun(cur.parentRunId) : null) {
      seen.add(cur.runId);
      const records = productStore.listIntakeRecords(cur.runId).filter((r) => r.valid && r.output && r.output.readiness === 'ready');
      const plan = records.length ? records[records.length - 1].output.plan : null;
      if (plan && plan.routeDecision && typeof plan.routeDecision === 'object') decision = plan.routeDecision;
    }
    if (!decision) return null;
    const candidate = run.candidateId ? productStore.getCandidate(run.candidateId) : null;
    const lead = candidate && candidate.acceptance && candidate.acceptance.route && typeof candidate.acceptance.route === 'object'
      ? candidate.acceptance.route : null;
    return {
      mode: decision.mode,
      requested: decision.requested,
      verdict: decision.verdict,
      effective: decision.effective,
      reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
      promoted: Boolean(lead && lead.promoted),
      promotionReasons: lead && Array.isArray(lead.reasons) ? lead.reasons : [],
      promotedAt: lead && lead.at ? lead.at : null,
      scriptedDecisions: lead && isNum(lead.scriptedDecisions) ? lead.scriptedDecisions : 0,
    };
  } catch (_) {
    return null;
  }
}

function unavailableActivity(error) {
  const reason = error && error.message
    ? redactDiagnosticMessage(String(error.message))
    : 'Activity unavailable';
  return {
    available: false,
    reason,
    hiddenReasoning: false,
    note: 'Operational records only. Hidden model reasoning is not available.',
    runLog: { status: 'unavailable', reason, entries: [] },
    turns: { status: 'unavailable', reason, entries: [] },
    attempts: { status: 'unavailable', reason, entries: [] },
    tokens: { status: 'unavailable', measured: null, monetaryCost: null, hypotheticalApiCost: null, cacheShare: null },
    executions: [],
  };
}

function buildTicketActivity({ productStore, events, ticketId, priceTable, after = 0, limit = 100 } = {}) {
  const cursor = Number.isSafeInteger(after) && after > 0 ? after : 0;
  const pageLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 499) : 100;
  const result = {
    available: true,
    reason: null,
    hiddenReasoning: false,
    note: 'Operational records only. Hidden model reasoning is not available.',
    runLog: { status: 'empty', reason: null, entries: [] },
    turns: { status: 'empty', reason: null, entries: [] },
    attempts: { status: 'empty', reason: null, entries: [] },
    tokens: { status: 'unavailable', measured: null, monetaryCost: null, hypotheticalApiCost: null, cacheShare: null },
    executions: [],
  };

  // Resolve full runs (with leadTaskId, reworkReviewId, parentRunId, candidateId, revisionId).
  let fullRuns;
  try {
    const summaries = productStore.listRuns(ticketId);
    fullRuns = summaries.map((s) => productStore.getRun(s.runId)).filter(Boolean);
  } catch (error) {
    return unavailableActivity(error);
  }

  // Run log: ticket events + per-run lead task events, deduped by sequence.
  // Fetch one extra row from each stream so the merged page can report whether
  // another cursor page exists without returning an unbounded event array.
  try {
    const ticketEvents = typeof events.listByTicket === 'function'
      ? events.listByTicket(ticketId, { after: cursor, limit: pageLimit + 1 }) : [];
    const seen = new Set(ticketEvents.map((e) => e.sequence));
    const runEvents = [];
    for (const run of fullRuns) {
      if (!run.leadTaskId) continue;
      const evs = typeof events.listByRun === 'function'
        ? events.listByRun(run.leadTaskId, { after: cursor, limit: pageLimit + 1 }) : [];
      for (const ev of evs) {
        if (seen.has(ev.sequence)) continue;
        seen.add(ev.sequence);
        runEvents.push(ev);
      }
    }
    const candidates = [...ticketEvents, ...runEvents].sort((a, b) => a.sequence - b.sequence);
    const hasMore = candidates.length > pageLimit;
    const page = candidates.slice(0, pageLimit);
    const allEntries = page.map(redactJournalEntry);
    result.runLog = {
      status: hasMore ? 'partial' : (allEntries.length ? 'available' : 'empty'),
      reason: null,
      entries: allEntries,
      hasMore,
      nextAfter: allEntries.length ? allEntries[allEntries.length - 1].sequence : cursor,
      limit: pageLimit,
    };
  } catch (error) {
    result.runLog = {
      status: 'unavailable',
      reason: redactDiagnosticMessage(error && error.message ? String(error.message) : 'Events unavailable'),
      entries: [],
    };
  }

  // Usage rows and derived sections.
  let usageRows;
  try {
    usageRows = collectUsageRows(productStore.db, fullRuns);
  } catch (error) {
    result.tokens = {
      status: 'unavailable',
      reason: redactDiagnosticMessage(error && error.message ? String(error.message) : 'Usage unavailable'),
      measured: null, monetaryCost: null, hypotheticalApiCost: null, cacheShare: null,
    };
    usageRows = null;
  }

  if (usageRows !== null) {
    // Turns: operational metadata only, no reasoning or prompt text.
    const turnEntries = usageRows.map((row) => ({
      entryId: row.entryId,
      kind: row.kind,
      role: row.role,
      productRunId: row.productRunId,
      attemptId: row.attemptId || null,
      startedAt: row.startedAt || null,
      turns: row.turns !== undefined ? row.turns : null,
      outcome: row.outcome || null,
      model: row.model || null,
      elapsedMs: row.elapsedMs !== undefined ? row.elapsedMs : null,
      tokenSource: row.tokenSource || null,
      hasTokens: Boolean(row.tokens && typeof row.tokens === 'object'),
    }));
    result.turns = { status: turnEntries.length ? 'available' : 'empty', reason: null, entries: turnEntries };

    // Tokens: measured, monetary, hypothetical, cacheShare.
    const measured = summarize(usageRows);
    const mcost = monetaryCost(usageRows);
    const cacheShareTotals = cachedInputShare(usageRows);

    const byRole = {};
    for (const role of [...new Set(usageRows.map((r) => r.role))].sort()) {
      byRole[role] = cachedInputShare(usageRows.filter((r) => r.role === role));
    }

    const byRun = {};
    for (const run of fullRuns) {
      byRun[run.runId] = cachedInputShare(usageRows.filter((r) => r.productRunId === run.runId));
    }

    result.tokens = {
      status: usageRows.length ? 'available' : 'unavailable',
      measured: Object.assign({ basis: 'subscription', cost: null }, measured),
      monetaryCost: mcost,
      hypotheticalApiCost: priceTable ? hypotheticalCost(usageRows, priceTable) : null,
      cacheShare: { ticket: cacheShareTotals, byRole, byRun },
    };
  }

  // Attempts from dispatch_journal for each run's lead task.
  const attemptEntries = [];
  let attemptsStatus = 'empty';
  let attemptsReason = null;

  for (const run of fullRuns) {
    if (!run.leadTaskId) continue;
    const rows = queryDispatchJournal(productStore.db, run.leadTaskId);
    if (rows === null) {
      attemptsStatus = 'unavailable';
      attemptsReason = 'Dispatch journal query failed';
      break;
    }
    for (const row of rows) {
      const parsed = parseResult(row.result_json);
      attemptEntries.push({
        attemptId: row.attempt_id,
        role: row.role,
        journalState: row.state,
        outcome: attemptOutcome(parsed),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        productRunId: run.runId,
      });
    }
  }

  if (attemptsStatus !== 'unavailable') {
    attemptsStatus = attemptEntries.length ? 'available' : 'empty';
  }
  result.attempts = { status: attemptsStatus, reason: attemptsReason, entries: attemptEntries };

  // Executions: review, acceptance, rework bindings per run.
  for (const run of fullRuns) {
    let review = null;
    let acceptance = null;
    let rework = null;

    try { review = redactReview(productStore.getReviewForRun(run.runId)); } catch (_) {}

    try {
      const candidate = run.candidateId ? productStore.getCandidate(run.candidateId) : null;
      acceptance = candidate && candidate.acceptance ? redactAcceptance(candidate.acceptance) : null;
    } catch (_) {}

    try {
      let reworkReview = null;
      if (run.reworkReviewId) {
        try { reworkReview = redactReview(productStore.getReview(run.reworkReviewId)); } catch (_) {}
      }
      const childRunIds = fullRuns.filter((r) => r.parentRunId === run.runId).map((r) => r.runId);
      rework = {
        reviewId: run.reworkReviewId || null,
        parentRunId: run.parentRunId || null,
        review: reworkReview,
        childRunIds,
      };
    } catch (_) {
      rework = { reviewId: run.reworkReviewId || null, parentRunId: run.parentRunId || null, review: null, childRunIds: [] };
    }

    result.executions.push({
      runId: run.runId,
      revisionId: run.revisionId || null,
      candidateId: run.candidateId || null,
      runKind: run.runKind || 'initial',
      parentRunId: run.parentRunId || null,
      review,
      acceptance,
      rework,
      route: routeViewOf(productStore, run),
    });
  }

  return result;
}

module.exports = { routeViewOf, cachedInputShare, monetaryCost, buildTicketActivity, unavailableActivity };
