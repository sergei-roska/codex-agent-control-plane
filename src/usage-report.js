'use strict';

// Read-only usage report over the state database. Measured usage is subscription usage: cost is
// always null. A price table adds a separate, clearly hypothetical API cost estimate.

const fs = require('node:fs');
const Database = require('better-sqlite3');
const { UsageLedger } = require('./usage-ledger');
const { DEFAULT_STATE_DB, stateDbPath } = require('./durable-store');

const TOKEN_KEYS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

function sumKnown(values) {
  const known = values.filter(isNum);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

function countBy(values) {
  const out = {};
  for (const value of values) {
    const key = value == null ? 'unknown' : String(value);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// A permission event is a denial only when something was actually refused: a blocking hook, a
// declined or sandbox-denied tool item, a declined approval request, or a non-approved review.
function isDenial(event) {
  switch (event?.type) {
    case 'hook': return event.status === 'blocked';
    case 'tool': return event.denial === true || event.status === 'declined';
    case 'approval_request_declined': return true;
    case 'approval_review': return event.status !== 'approved';
    default: return false;
  }
}

function denialCounts(rows) {
  const byType = {};
  let total = 0;
  for (const row of rows) {
    for (const event of row.permissionEvents || []) {
      if (!isDenial(event)) continue;
      total += 1;
      const type = event?.type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    }
  }
  return { total, byType };
}

function summarize(rows) {
  const known = rows.filter((row) => row.tokens && typeof row.tokens === 'object');
  const unknownCount = rows.length - known.length;
  let tokens = null;
  if (known.length) {
    tokens = {};
    for (const key of TOKEN_KEYS) tokens[key] = sumKnown(known.map((row) => row.tokens[key]));
  }
  const counts = {};
  for (const key of ['turns', 'elapsedMs', 'retries']) {
    const knownRows = rows.filter((row) => isNum(row[key])).length;
    counts[key] = { knownRows, unknownRows: rows.length - knownRows, partial: rows.length - knownRows > 0 };
  }
  return {
    rows: rows.length,
    turns: sumKnown(rows.map((row) => row.turns)),
    elapsedMs: sumKnown(rows.map((row) => row.elapsedMs)),
    retries: sumKnown(rows.map((row) => row.retries)),
    turnsKnownRows: counts.turns.knownRows,
    turnsUnknownRows: counts.turns.unknownRows,
    turnsPartial: counts.turns.partial,
    elapsedMsKnownRows: counts.elapsedMs.knownRows,
    elapsedMsUnknownRows: counts.elapsedMs.unknownRows,
    elapsedMsPartial: counts.elapsedMs.partial,
    retriesKnownRows: counts.retries.knownRows,
    retriesUnknownRows: counts.retries.unknownRows,
    retriesPartial: counts.retries.partial,
    tokens,
    tokensKnownRows: known.length,
    tokensUnknownRows: unknownCount,
    tokensPartial: unknownCount > 0,
    models: [...new Set(rows.map((row) => row.model).filter((m) => m != null))].sort(),
    efforts: [...new Set(rows.map((row) => row.effort).filter((m) => m != null))].sort(),
    outcomes: countBy(rows.map((row) => row.outcome)),
    permissionDenials: denialCounts(rows),
  };
}

function attemptRow(row) {
  return {
    entryId: row.entryId,
    kind: row.kind,
    role: row.role,
    taskId: row.taskId,
    attemptId: row.attemptId,
    model: row.model,
    effort: row.effort,
    startedAt: row.startedAt,
    turns: row.turns,
    modelRequests: row.modelRequests,
    elapsedMs: row.elapsedMs,
    retries: row.retries,
    tokens: row.tokens,
    tokenSource: row.tokenSource,
    outcome: row.outcome,
    requested: row.requested ?? null,
    reported: row.reported ?? null,
    permissionDenials: denialCounts([row]).total,
  };
}

function hypotheticalCost(rows, priceTable) {
  const unpricedModels = new Set();
  let cost = 0;
  let pricedRows = 0;
  let skippedUnknownTokenRows = 0;
  for (const row of rows) {
    if (!row.tokens || typeof row.tokens !== 'object') { skippedUnknownTokenRows += 1; continue; }
    const price = row.model != null ? priceTable[row.model] : undefined;
    const { inputTokens: input, cachedInputTokens: cached, outputTokens: output } = row.tokens;
    if (!price || !isNum(price.inputPerMTok) || !isNum(price.outputPerMTok) || !isNum(input) || !isNum(output)) {
      unpricedModels.add(row.model == null ? 'unknown' : row.model);
      continue;
    }
    const cachedTokens = isNum(cached) ? cached : 0;
    const cachedRate = isNum(price.cachedInputPerMTok) ? price.cachedInputPerMTok : price.inputPerMTok;
    cost += ((Math.max(input - cachedTokens, 0) * price.inputPerMTok)
      + (cachedTokens * cachedRate)
      + (output * price.outputPerMTok)) / 1e6;
    pricedRows += 1;
  }
  return {
    label: 'hypothetical API pricing estimate; not measured spend and not subscription cost',
    currency: 'USD',
    // Reasoning tokens are assumed to be included in outputTokens and are not billed twice.
    estimatedCost: pricedRows ? cost : null,
    pricedRows,
    skippedUnknownTokenRows,
    unpricedModels: [...unpricedModels].sort(),
    partial: skippedUnknownTokenRows > 0 || unpricedModels.size > 0,
  };
}

function repeatedAssignments(db, runId) {
  const columns = db.prepare("PRAGMA table_info('dispatch_journal')").all();
  if (!columns.some((column) => column.name === 'objective_sha256')) return null;
  const rows = db.prepare(`
    SELECT objective_sha256 AS hash, COUNT(DISTINCT assignment_id) AS n
    FROM dispatch_journal WHERE run_id = ? AND objective_sha256 IS NOT NULL
    GROUP BY objective_sha256 HAVING n > 1
  `).all(runId);
  return rows.reduce((sum, row) => sum + row.n, 0);
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function breakdownRow(rows) {
  const t = summarize(rows);
  return {
    rows: t.rows,
    turns: t.turns,
    input: t.tokens ? t.tokens.inputTokens : null,
    cached: t.tokens ? t.tokens.cachedInputTokens : null,
    output: t.tokens ? t.tokens.outputTokens : null,
    elapsedMs: t.elapsedMs,
    tokensPartial: t.tokensPartial,
  };
}

function groupRows(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = {};
  for (const key of [...groups.keys()].sort()) out[key] = breakdownRow(groups.get(key));
  return out;
}

// Resolve a product run id or a ticket id to product runs; null when the id is not a product id.
function resolveProductRuns(db, { runId, taskId }) {
  if (!hasTable(db, 'runs')) return null;
  const cols = 'run_id AS runId, ticket_id AS ticketId, lead_task_id AS leadTaskId';
  const rows = runId
    ? db.prepare(`SELECT ${cols} FROM runs WHERE run_id = ?`).all(runId)
    : db.prepare(`SELECT ${cols} FROM runs WHERE ticket_id = ? ORDER BY created_at, run_id`).all(taskId);
  return rows.length ? rows : null;
}

function buildReport(db, { runId, taskId, priceTable, strict = false } = {}) {
  if (!runId === !taskId) throw new TypeError('Provide exactly one of runId or taskId');
  const ledger = hasTable(db, 'usage_ledger') ? new UsageLedger({ db, readonly: true }) : null;
  const productRuns = resolveProductRuns(db, { runId, taskId });
  let entries = [];
  let scope = runId ? { runId } : { taskId };
  let byRun;
  if (productRuns) {
    const seen = new Set();
    byRun = {};
    scope = runId ? { runId, ticketId: productRuns[0].ticketId } : { ticketId: taskId };
    for (const run of productRuns) {
      const own = [];
      if (ledger) {
        const rows = [...ledger.listByRecordedRun(run.runId), ...(run.leadTaskId ? ledger.listByRun(run.leadTaskId) : [])];
        for (const row of rows) {
          if (seen.has(row.entryId)) continue;
          seen.add(row.entryId);
          own.push(row);
        }
      }
      byRun[run.runId] = { leadTaskId: run.leadTaskId, ...breakdownRow(own) };
      entries = entries.concat(own);
    }
  } else if (ledger) {
    entries = runId ? ledger.listByRun(runId) : ledger.listByTask(taskId);
    if (runId && !entries.length) entries = ledger.listByRecordedRun(runId);
  }
  const knownLegacy = !productRuns && (entries.length > 0
    || (runId && hasTable(db, 'dispatch_journal')
      && db.prepare('SELECT 1 FROM dispatch_journal WHERE run_id = ? LIMIT 1').get(runId)));
  if (strict && !productRuns && !knownLegacy) {
    throw new Error(`Unknown ${runId ? 'run' : 'ticket or task'} id "${runId || taskId}": no product run, ticket or usage rows found`);
  }
  const byRole = {};
  for (const role of [...new Set(entries.map((row) => row.role))].sort()) {
    byRole[role] = summarize(entries.filter((row) => row.role === role));
  }
  const report = {
    scope,
    measured: { basis: 'subscription', cost: null },
    totals: summarize(entries),
    byRole,
    byKind: groupRows(entries, (row) => row.kind),
    byRoleKind: groupRows(entries, (row) => `${row.role}+${row.kind}`),
    attempts: entries.map(attemptRow),
    repeatedAssignments: runId && !productRuns && hasTable(db, 'dispatch_journal') ? repeatedAssignments(db, runId) : null,
  };
  if (byRun) report.byRun = byRun;
  if (priceTable) report.hypotheticalApiCost = hypotheticalCost(entries, priceTable);
  return report;
}

function parseArgs(argv) {
  const out = {};
  const flags = { '--run': 'runId', '--task': 'taskId', '--state': 'state', '--price-table': 'priceTable' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = flags[argv[i]];
    if (!key || i + 1 >= argv.length) throw new Error(`Unknown or incomplete argument "${argv[i]}"`);
    out[key] = argv[i + 1];
    i += 1;
  }
  if (!out.runId === !out.taskId) throw new Error('Provide exactly one of --run <runId> or --task <taskId>');
  return out;
}

function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const args = parseArgs(argv);
  const priceTable = args.priceTable ? JSON.parse(fs.readFileSync(args.priceTable, 'utf8')) : undefined;
  const file = stateDbPath(args.state || process.env.CODEX_A2A_STATE_DB || DEFAULT_STATE_DB);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    stdout.write(`${JSON.stringify(buildReport(db, { runId: args.runId, taskId: args.taskId, priceTable, strict: true }), null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`usage: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { buildReport, summarize, hypotheticalCost, parseArgs, main };
