'use strict';

const { sessionLeadTaskIds } = require('./launcher-sessions');
const { UsageLedger } = require('./usage-ledger');
const { summarize } = require('./usage-report');
const { parseWorkerReport } = require('./contracts');
const { INTAKE_ROLE_NAME } = require('./intake-jira');

const LEGACY_LEAD_ROLE = 'orch-lead';
const LEAD_ROLE_NAME = 'coordinator';
const TOKEN_KEYS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
function sumKnown(values) {
  const known = values.filter(isNum);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function safeTokens(tokens) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const safe = Object.fromEntries(TOKEN_KEYS.map((key) => [key, isNum(tokens[key]) ? tokens[key] : null]));
  return TOKEN_KEYS.some((key) => isNum(safe[key])) ? safe : null;
}

function totalTokenContribution(tokens) {
  if (isNum(tokens?.totalTokens)) return tokens.totalTokens;
  if (isNum(tokens?.inputTokens) && isNum(tokens?.outputTokens)) return tokens.inputTokens + tokens.outputTokens;
  return null;
}

function sessionSummary(rows) {
  const summary = summarize(rows);
  const knownRows = rows.filter((row) => isNum(totalTokenContribution(row.tokens))).length;
  summary.tokensKnownRows = knownRows;
  summary.tokensUnknownRows = rows.length - knownRows;
  summary.tokensPartial = knownRows < rows.length;
  if (summary.tokens) summary.tokens.totalTokens = sumKnown(rows.map((row) => totalTokenContribution(row.tokens)));
  return summary;
}

function roundOf(assignmentId) {
  const match = /:r(\d+):/.exec(String(assignmentId || ''));
  return match ? Number(match[1]) : null;
}

function safeReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hasStatus = typeof value.status === 'string';
  const hasAccepted = typeof value.accepted === 'boolean';
  const hasValid = typeof value.valid === 'boolean';
  const hasVerdict = typeof value.verdict === 'string';
  const hasReason = typeof value.reason === 'string';
  if (!hasStatus && !hasAccepted && !hasValid && !hasVerdict && !hasReason) return null;
  return {
    status: hasStatus ? value.status.slice(0, 64) : null,
    accepted: hasAccepted ? value.accepted : null,
    valid: hasValid ? value.valid : null,
    verdict: hasVerdict ? value.verdict.slice(0, 64) : null,
    reason: hasReason ? value.reason.slice(0, 300) : null,
  };
}

function terminalResult(resultJson) {
  try {
    const status = JSON.parse(resultJson || 'null')?.status;
    return ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_CANCELLED', 'TASK_STATE_REJECTED'].includes(status);
  } catch (_) {
    return false;
  }
}

function reviewFor(db, journalRow, taskId) {
  if (journalRow?.result_json) {
    try {
      const result = JSON.parse(journalRow.result_json);
      const review = safeReview(result?.reviewResult);
      if (review) return review;
    } catch (_) {}
  }
  if (!taskId || !hasTable(db, 'tasks')) return null;
  try {
    const row = db.prepare('SELECT artifacts FROM tasks WHERE id = ?').get(taskId);
    const artifacts = row?.artifacts ? JSON.parse(row.artifacts) : [];
    if (!Array.isArray(artifacts)) return null;
    for (let i = artifacts.length - 1; i >= 0; i -= 1) {
      const review = safeReview(artifacts[i]?.metadata?.review);
      if (review) return review;
    }
  } catch (_) {}
  return null;
}

function structuredReport(journalRow) {
  if (!journalRow?.result_json) return null;
  try {
    const result = JSON.parse(journalRow.result_json);
    if (result?.report && typeof result.report === 'object' && !Array.isArray(result.report)) return result.report;
    const texts = [
      ...(Array.isArray(result?.artifacts) ? result.artifacts.map((artifact) => artifact?.text) : []),
      result?.text,
    ];
    for (const text of texts) {
      if (typeof text !== 'string') continue;
      const parsed = parseWorkerReport(text);
      if (parsed.report) return parsed.report;
    }
  } catch (_) {}
  return null;
}

function reportMetrics(journalRow) {
  const report = structuredReport(journalRow);
  if (!report) return { reportedVerdict: null, checks: null };
  const firstLine = typeof report.summary === 'string' ? report.summary.split(/\r?\n/, 1)[0] : '';
  const match = /^VERDICT: (pass|fail|inconclusive)\b/.exec(firstLine);
  if (!Array.isArray(report.checks)) return { reportedVerdict: match ? match[1] : null, checks: null };
  const checks = { passed: 0, failed: 0, notRun: 0, unknown: 0 };
  for (const check of report.checks) {
    if (check?.result === 'passed') checks.passed += 1;
    else if (check?.result === 'failed') checks.failed += 1;
    else if (check?.result === 'not_run') checks.notRun += 1;
    else checks.unknown += 1;
  }
  return { reportedVerdict: match ? match[1] : null, checks };
}

function sessionPerformance(db, contextId, options = {}) {
  const leadIds = sessionLeadTaskIds(db, contextId);
  if (leadIds.length === 0) return null;

  const entries = [];
  if (hasTable(db, 'usage_ledger')) {
    const ledger = new UsageLedger({ db, readonly: true });
    const seen = new Set();
    for (const runId of leadIds) {
      for (const row of ledger.listByRun(runId)) {
        if (seen.has(row.entryId)) continue;
        seen.add(row.entryId);
        if (row.kind === 'lead_turn' && row.role === LEGACY_LEAD_ROLE) row.role = LEAD_ROLE_NAME;
        entries.push({ ...row, tokens: safeTokens(row.tokens) });
      }
    }
  }

  const journalByAttempt = new Map();
  if (hasTable(db, 'dispatch_journal')) {
    const select = db.prepare(`SELECT attempt_id, run_id, assignment_id, state, result_json
      FROM dispatch_journal WHERE run_id IN (${leadIds.map(() => '?').join(',')})`);
    for (const row of select.all(...leadIds)) journalByAttempt.set(row.attempt_id, row);
  }

  const finalEntryByAttempt = new Map();
  const byAttempt = new Map();
  for (const row of entries) {
    if (!row.attemptId) continue;
    if (!byAttempt.has(row.attemptId)) byAttempt.set(row.attemptId, []);
    byAttempt.get(row.attemptId).push(row);
  }
  for (const [attemptId, rows] of byAttempt) {
    const journal = journalByAttempt.get(attemptId);
    if (journal?.state !== 'finished' || !terminalResult(journal.result_json)) continue;
    const ordered = rows.filter((row) => typeof row.recordedAt === 'string')
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.entryId.localeCompare(b.entryId));
    if (ordered.length === 1 || (ordered.length > 1 && ordered.at(-1).recordedAt > ordered.at(-2).recordedAt)) {
      finalEntryByAttempt.set(attemptId, ordered.at(-1).entryId);
    }
  }

  const byRole = {};
  for (const role of [...new Set(entries.map((row) => row.role))].sort()) {
    byRole[role] = sessionSummary(entries.filter((row) => row.role === role));
  }

  const attempts = entries.map((row) => {
    const journal = row.kind === 'worker_turn' ? journalByAttempt.get(row.attemptId) : null;
    // INTAKE-01: the intake turn is a lead_turn row of the same run; its own assignment key keeps it out of the lead group.
    const intakeTurn = row.kind === 'lead_turn' && row.role === INTAKE_ROLE_NAME && row.runId;
    const assignmentId = intakeTurn ? `${row.runId}:intake` : journal?.assignment_id ?? null;
    const hasFinalResult = row.attemptId != null && finalEntryByAttempt.get(row.attemptId) === row.entryId;
    const metrics = hasFinalResult ? reportMetrics(journal) : { reportedVerdict: null, checks: null };
    return {
      entryId: row.entryId,
      runId: row.runId ?? journal?.run_id ?? null,
      assignmentId,
      round: roundOf(assignmentId),
      kind: row.kind,
      role: row.role,
      taskId: row.taskId ?? null,
      model: row.model ?? null,
      effort: row.effort ?? null,
      startedAt: row.startedAt ?? null,
      elapsedMs: isNum(row.elapsedMs) ? row.elapsedMs : null,
      retries: isNum(row.retries) ? row.retries : null,
      queueWaitMs: isNum(row.queueWaitMs) ? row.queueWaitMs : null,
      startupMs: isNum(row.startupMs) ? row.startupMs : null,
      coldStart: typeof row.coldStart === 'boolean' ? row.coldStart : null,
      tokens: row.tokens || Object.fromEntries(TOKEN_KEYS.map((key) => [key, null])),
      outcome: row.outcome ?? null,
      permissionDenials: summarize([row]).permissionDenials.total,
      reportedVerdict: metrics.reportedVerdict,
      checks: metrics.checks,
      review: hasFinalResult ? reviewFor(db, journal, row.taskId) : null,
    };
  }).sort((a, b) => {
    const left = a.startedAt || '';
    const right = b.startedAt || '';
    return left.localeCompare(right) || a.entryId.localeCompare(b.entryId);
  });

  return {
    schema: 'session-performance/v1',
    generatedAt: typeof options.generatedAt === 'string' ? options.generatedAt : new Date().toISOString(),
    totals: sessionSummary(entries),
    byRole,
    retryAttempts: entries.filter((row) => isNum(row.retries) && row.retries > 0).length,
    attempts,
  };
}

module.exports = { sessionPerformance };
