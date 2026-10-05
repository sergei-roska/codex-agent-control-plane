'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./common');

const CALLERS = ['http-client.js', 'queue-worker.js', 'sync-job.js'];

run('F1', ({ finalText, workspace }) => {
  const reasons = [];
  const lines = fs.readFileSync(path.join(workspace, 'config', 'retry.js'), 'utf8').split('\n');
  const idx = lines.findIndex((l) => /^const DEFAULT_RETRY_LIMIT\s*=/.test(l));
  if (idx < 0) return ['defining line not found in workspace config/retry.js'];
  const want = idx + 1;
  const found = [...finalText.matchAll(/retry\.js:(\d+)/g)].map((m) => Number(m[1]));
  if (!found.includes(want)) reasons.push(`final text does not name config/retry.js:${want}`);
  for (const caller of CALLERS) {
    if (!finalText.includes(caller)) reasons.push(`final text does not name caller ${caller}`);
  }
  return reasons;
});
