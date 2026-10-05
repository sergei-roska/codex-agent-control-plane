'use strict';

// Times N single-row journal commits on a temp file database with synchronous NORMAL vs FULL.
// Usage: node bench/journal-commit-latency.js [count]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DispatchJournal } = require('../src/durable-store');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(mode, count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-latency-'));
  const db = new Database(path.join(dir, 'state.db'));
  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${mode}`);
  const journal = new DispatchJournal(db);
  const times = [];
  for (let i = 0; i < count; i += 1) {
    const start = process.hrtime.bigint();
    journal.recordSubmitting({
      attemptId: `r:r1:a${i}:t1`, runId: 'r', assignmentId: `r:r1:a${i}`, role: 'orch-x', sandbox: 'read-only', contextId: `c${i}`,
    });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return median(times);
}

const count = Number(process.argv[2]) || 500;
for (const mode of ['NORMAL', 'FULL']) {
  console.log(`${mode}: median ${measure(mode, count).toFixed(3)} ms over ${count} commits (${os.tmpdir()})`);
}
