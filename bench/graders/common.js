'use strict';

const fs = require('node:fs');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

// grade({ finalText, workspace, disposition }) -> reasons array; empty means passed.
function run(fixture, grade) {
  const args = parseArgs(process.argv.slice(2));
  const reasons = [];
  let finalText = '';
  if (!args.final || !args.workspace) {
    reasons.push('usage: --final <file> --workspace <dir> [--disposition <value>]');
  } else {
    try {
      finalText = fs.readFileSync(args.final, 'utf8');
    } catch (error) {
      reasons.push(`cannot read final text: ${error.message}`);
    }
  }
  if (reasons.length === 0) {
    try {
      reasons.push(...grade({ finalText, workspace: args.workspace, disposition: args.disposition }));
    } catch (error) {
      reasons.push(`grader error: ${error.message}`);
    }
  }
  const passed = reasons.length === 0;
  process.stdout.write(`${JSON.stringify({ fixture, passed, reasons })}\n`);
  process.exit(passed ? 0 : 1);
}

module.exports = { parseArgs, run };
