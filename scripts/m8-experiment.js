#!/usr/bin/env node
'use strict';

const { runExperiment, runLiveExperiment } = require('../src/m8/experiment');

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--live')) {
  process.stderr.write('Usage: node scripts/m8-experiment.js [--live]\n');
  process.exit(2);
}

(process.argv[2] === '--live' ? runLiveExperiment() : runExperiment()).then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
