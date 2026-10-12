'use strict';

const Database = require('better-sqlite3');
const { DEFAULT_STATE_DB, stateDbPath } = require('./durable-store');
const { StagingLog, hasStagingTable } = require('./staging-log');

function parseArgs(argv) {
  const out = {};
  const valueFlags = { '--state': 'state', '--run': 'runId', '--problem': 'problemId', '--type': 'type', '--limit': 'limit' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') {
      if (out.json) throw new Error('--json may be supplied only once');
      out.json = true;
      continue;
    }
    const key = valueFlags[flag];
    if (!key || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument "${flag}"`);
    if (out[key] !== undefined) throw new Error(`${flag} may be supplied only once`);
    out[key] = argv[i + 1];
    i += 1;
  }
  if (out.limit !== undefined) {
    if (!/^\d+$/.test(out.limit)) throw new Error('--limit must be an integer from 1 to 10000');
    out.limit = Number(out.limit);
    if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 10000) throw new Error('--limit must be an integer from 1 to 10000');
  } else out.limit = 1000;
  return out;
}

function groupBy(rows, keyName, partial) {
  const groups = new Map();
  for (const row of rows) {
    const id = row[keyName];
    if (id == null) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return [...groups].map(([id, events]) => ({
    id,
    status: events.at(-1).status,
    statusScope: partial ? 'latest event in retained window' : 'complete history',
    statusComplete: !partial,
    events: events.map((event) => ({
      eventId: event.eventId,
      type: event.type,
      status: event.status,
      createdAt: event.createdAt,
      target: event.target,
      payload: event.payload,
    })),
  }));
}

function buildReport(db, filters = {}) {
  if (!hasStagingTable(db)) return { available: false, message: 'Staging event log unavailable: staging_events table is missing.' };
  const log = new StagingLog({ db, readonly: true });
  const events = log.list(filters);
  const totalEvents = log.count(filters);
  const partial = events.length < totalEvents;
  const roleCounts = {};
  const typeCounts = {};
  for (const event of events) {
    const role = event.role || 'unknown';
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    typeCounts[event.type] = (typeCounts[event.type] || 0) + 1;
  }
  return {
    available: true,
    filters: { runId: filters.runId || null, problemId: filters.problemId || null, type: filters.type || null, limit: filters.limit || 1000 },
    count: events.length,
    coverage: { totalEvents, returnedEvents: events.length, partial },
    roleCounts,
    typeCounts,
    problems: groupBy(events, 'problemId', partial),
    decisions: groupBy(events, 'decisionId', partial),
    events,
  };
}

function renderReport(report) {
  if (!report.available) return `${report.message}\n`;
  const lines = [
    `Staging events: ${report.count}`,
    `Coverage: ${report.coverage.returnedEvents}/${report.coverage.totalEvents} events${report.coverage.partial ? ' (partial)' : ' (complete)'}`,
    'By role:',
  ];
  for (const [role, count] of Object.entries(report.roleCounts).sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${role}: ${count}`);
  lines.push('By type:');
  for (const [type, count] of Object.entries(report.typeCounts).sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${type}: ${count}`);
  lines.push('Problems:');
  for (const item of report.problems) lines.push(`  ${item.id} status=${item.status || 'unknown'} scope=${item.statusScope} events=${item.events.length}`);
  lines.push('Decisions:');
  for (const item of report.decisions) lines.push(`  ${item.id} status=${item.status || 'unknown'} scope=${item.statusScope} events=${item.events.length}`);
  lines.push('Event history:');
  for (const event of report.events) {
    const refs = [event.target, event.payload.evidenceRef, event.payload.artifactRef].filter((value) => typeof value === 'string');
    lines.push(`  ${event.createdAt} ${event.eventId} ${event.type} role=${event.role || 'unknown'} status=${event.status || 'unknown'}${refs.length ? ` evidence=${refs.join(',')}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let args;
  try { args = parseArgs(argv); } catch (error) {
    stderr.write(`usage: ${error.message}\n`);
    return 2;
  }
  let db;
  try {
    const file = stateDbPath(args.state || env.CODEX_A2A_STATE_DB || DEFAULT_STATE_DB);
    db = new Database(file, { readonly: true, fileMustExist: true });
    const report = buildReport(db, args);
    stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
    return 0;
  } catch (error) {
    stderr.write(`staging_report_error: ${error.message}\n`);
    return 1;
  } finally {
    if (db) db.close();
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArgs, buildReport, renderReport, main };
