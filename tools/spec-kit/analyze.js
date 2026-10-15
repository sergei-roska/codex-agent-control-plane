'use strict';

const { analyzeWorkspace } = require('../../src/spec-analyzer');

const EXIT = Object.freeze({ pass: 0, blocked: 1, review: 2, internal: 3 });
const VALUE_FLAGS = new Set(['--workspace', '--context', '--context-sha256', '--map', '--profiles']);

function minimalBlocked(code, actual = null) {
  return {
    schemaVersion: 'spec-analysis/v1',
    featureId: null,
    analysisFingerprint: null,
    inputManifest: null,
    assumptions: {
      mode: 'offline',
      plannedChecksExecuted: false,
      implementationAcceptance: 'not_evaluated',
    },
    findings: [{
      code,
      severity: 'error',
      path: '$arguments',
      taskIds: [],
      requirementIds: [],
      expected: null,
      actual: typeof actual === 'string' ? actual.slice(0, 300) : null,
    }],
    coverage: { requirements: [], acceptanceCriteria: [] },
    dependencyOrder: null,
    assignmentValidation: [],
    reviewPlan: [],
    passes: { snapshot: 'not_run', context: 'not_run', traceability: 'not_run', graph: 'not_run', projection: 'not_run', assignments: 'not_run', drift: 'not_run' },
    implementationAcceptance: 'not_evaluated',
    verdict: 'blocked',
  };
}

function parseArgs(argv) {
  const values = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      if (json) return { error: 'argument_duplicate', flag };
      json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return { error: 'argument_unknown', flag };
    if (Object.hasOwn(values, flag)) return { error: 'argument_duplicate', flag };
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return { error: 'argument_value_missing', flag };
    values[flag] = value;
    index += 1;
  }
  if (!json) return { error: 'json_flag_required', flag: '--json' };
  for (const required of VALUE_FLAGS) if (!Object.hasOwn(values, required)) return { error: 'argument_required', flag: required };
  return {
    options: {
      workspaceRoot: values['--workspace'],
      contextPath: values['--context'],
      contextSha256: values['--context-sha256'],
      mapPath: values['--map'],
      profilesDir: values['--profiles'],
    },
  };
}

function main(argv = process.argv.slice(2), io = process) {
  const parsed = parseArgs(argv);
  let report;
  let status;
  if (parsed.error) {
    report = minimalBlocked(parsed.error, parsed.flag || null);
    status = EXIT.blocked;
  } else {
    try {
      report = analyzeWorkspace(parsed.options);
      status = Object.hasOwn(EXIT, report.verdict) ? EXIT[report.verdict] : EXIT.internal;
      if (status === EXIT.internal) report = minimalBlocked('internal_report_invalid');
    } catch (error) {
      report = minimalBlocked('internal_error', error && error.message);
      status = EXIT.internal;
      io.stderr.write('spec analyzer internal failure\n');
    }
  }
  io.stdout.write(`${JSON.stringify(report)}\n`);
  return status;
}

if (require.main === module) process.exitCode = main();

module.exports = { EXIT, parseArgs, main };
