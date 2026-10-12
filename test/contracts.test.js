'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WORKER_REPORT_SCHEMA, WORKER_REPORT_CONTRACT, validateWorkerReport, parseWorkerReport,
  DECISION_SCHEMA, validateDecision, classifyCodexError, findCodexErrorInfo, safeRelativePath,
  ASSIGNMENT_FIELDS, MAX_ASSIGNMENTS, BoundaryViolation, BOUNDARY_PREDICATES,
  checkSpecialistRequest, pathsOutsideAllowed, executionGroups, HUMAN_REASONS,
} = require('../src/contracts');

function walk(schema, visit) {
  if (!schema || typeof schema !== 'object') return;
  visit(schema);
  for (const value of Object.values(schema.properties || {})) walk(value, visit);
  if (schema.items) walk(schema.items, visit);
  for (const branch of schema.anyOf || []) walk(branch, visit);
}

test('exports constants', () => {
  assert.equal(WORKER_REPORT_CONTRACT, 'worker-report/v1');
  assert.equal(MAX_ASSIGNMENTS, 4);
  assert.equal(ASSIGNMENT_FIELDS.length, 8);
});

test('schemas satisfy strict structured output rules', () => {
  for (const schema of [WORKER_REPORT_SCHEMA, DECISION_SCHEMA]) {
    let objects = 0;
    walk(schema, (node) => {
      if (node.type === 'object') {
        objects += 1;
        assert.equal(node.additionalProperties, false);
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      }
    });
    assert.ok(objects > 2);
  }
  assert.equal(WORKER_REPORT_SCHEMA.properties.decisionRequest.anyOf[1].type, 'null');
  assert.equal(DECISION_SCHEMA.properties.humanInput.anyOf[1].type, 'null');
  assert.deepEqual(DECISION_SCHEMA.properties.action.enum, ['dispatch', 'finish', 'request_human_input']);
  assert.deepEqual(DECISION_SCHEMA.properties.assignments.items.required, [...ASSIGNMENT_FIELDS, 'skills', 'wave', 'continueFrom', 'review']);
  assert.deepEqual(DECISION_SCHEMA.properties.assignments.items.properties.continueFrom, { type: ['string', 'null'] });
  assert.deepEqual(DECISION_SCHEMA.properties.assignments.items.properties.wave, { type: ['integer', 'null'], minimum: 1 });
  assert.deepEqual(DECISION_SCHEMA.required, ['action', 'assignments', 'final', 'resolutions', 'humanInput', 'goalAchieved', 'acceptanceChecks', 'records']);
  assert.deepEqual(DECISION_SCHEMA.properties.goalAchieved, { type: ['boolean', 'null'] });
  const [checks, none] = DECISION_SCHEMA.properties.acceptanceChecks.anyOf;
  assert.equal(none.type, 'null');
  assert.equal(checks.type, 'array');
  assert.equal(checks.maxItems, 10);
  assert.deepEqual(checks.items.required, ['id', 'argv', 'timeoutMs']);
  assert.deepEqual(checks.items.properties.timeoutMs, { type: ['integer', 'null'] });
});

test('goalAchieved: finish needs a boolean, legacy decisions get null injected, other actions are normalized', () => {
  validateDecision(finish({ goalAchieved: true, acceptanceChecks: null }), ctx());
  validateDecision(finish({ goalAchieved: false, acceptanceChecks: [] }), ctx());
  const legacy = finish();
  validateDecision(legacy, ctx());
  assert.equal(legacy.goalAchieved, null);
  assert.equal(legacy.acceptanceChecks, null);
  let caught;
  try { validateDecision(finish({ goalAchieved: null }), ctx()); } catch (error) { caught = error; }
  assert.ok(caught instanceof BoundaryViolation);
  assert.equal(caught.violations[0].predicate, 'decision.goal');
  assert.equal(caught.violations[0].code, 'goal_unstated');
  assert.match(caught.message, /finish requires goalAchieved true or false/);
  assert.ok(BOUNDARY_PREDICATES['decision.goal'].includes('goal_unstated'));
  const dispatched = dispatch([assignment()], { goalAchieved: true });
  validateDecision(dispatched, ctx());
  assert.equal(dispatched.goalAchieved, null);
  const asked = ask({ goalAchieved: false });
  validateDecision(asked, ctx());
  assert.equal(asked.goalAchieved, null);
  throws(finish({ goalAchieved: 'yes' }), ctx(), /goalAchieved must be true, false, or null/);
  throws(finish({ goalAchieved: true, acceptanceChecks: {} }), ctx(), /acceptanceChecks must be an array or null/);
  throws(finish({ goalAchieved: true, other: 1 }), ctx(), /unsupported field/);
  assert.ok(BOUNDARY_PREDICATES['decision.acceptance_checks'].includes('acceptance_checks_invalid'));
});

function report(overrides = {}) {
  return {
    outcome: 'completed', summary: 'done', filesChanged: ['a.js'], filesInspected: ['b.js'],
    checks: [{ command: 'npm test', result: 'passed', detail: 'ok' }], risks: [],
    scopeExpansion: [], decisionRequest: null, ...overrides,
  };
}
function request(overrides = {}) {
  return {
    question: 'Which?', options: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }],
    evidenceChecked: ['src/x.js'], recommendation: 'a', consequenceIfWrong: 'rework', ...overrides,
  };
}

test('validateWorkerReport accepts valid reports', () => {
  assert.equal(validateWorkerReport(report()).ok, true);
  const needs = validateWorkerReport(report({ outcome: 'needs_decision', decisionRequest: request() }));
  assert.equal(needs.ok, true);
  assert.deepEqual(needs.errors, []);
  for (const outcome of ['blocked', 'failed']) assert.equal(validateWorkerReport(report({ outcome })).ok, true);
});

test('validateWorkerReport rejects invalid reports', () => {
  const bad = [
    null, [], 'x',
    { ...report(), extra: 1 },
    (() => { const r = report(); delete r.risks; return r; })(),
    report({ outcome: 'weird' }),
    report({ summary: 5 }),
    report({ filesChanged: [1] }),
    report({ checks: [{ command: 'x', result: 'maybe', detail: '' }] }),
    report({ checks: [{ command: 'x', result: 'passed' }] }),
    report({ scopeExpansion: [{ path: 'x' }] }),
    report({ decisionRequest: request() }),
    report({ outcome: 'needs_decision' }),
    report({ outcome: 'needs_decision', decisionRequest: request({ options: [{ id: 'a', description: 'A' }] }) }),
    report({ outcome: 'needs_decision', decisionRequest: request({ options: [{ id: 'a', description: 'A' }, { id: 'a', description: 'B' }] }) }),
    report({ outcome: 'needs_decision', decisionRequest: request({ options: [{ id: '', description: 'A' }, { id: 'b', description: 'B' }] }) }),
    report({ summary: 7 }),
    report({ outcome: 'needs_decision', decisionRequest: request({ question: '' }) }),
    report({ outcome: 'needs_decision', decisionRequest: request({ evidenceChecked: [] }) }),
    report({ outcome: 'needs_decision', decisionRequest: request({ extra: 1 }) }),
    report({ outcome: 'needs_decision', decisionRequest: 'nope' }),
  ];
  for (const value of bad) {
    const result = validateWorkerReport(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.report, null);
    assert.ok(result.errors.length > 0);
  }
});

test('a recommendation outside the options is cleared and noted, not rejected', () => {
  for (const recommendation of ['z', '']) {
    const input = report({ outcome: 'needs_decision', decisionRequest: request({ recommendation }) });
    const result = validateWorkerReport(input);
    assert.equal(result.ok, true);
    assert.equal(result.report.decisionRequest.recommendation, null);
    assert.equal(result.report.decisionRequest.question, 'Which?');
    assert.equal(result.report.normalizations.length, 1);
    assert.equal(result.report.normalizations[0].field, 'decisionRequest.recommendation');
    assert.equal(result.report.normalizations[0].action, 'cleared');
    assert.equal(input.decisionRequest.recommendation, recommendation);
  }
  assert.equal(validateWorkerReport(report()).report.normalizations, undefined);
});

test('over-long strings are truncated with a suffix and noted', () => {
  const long = 'x'.repeat(5000);
  const result = validateWorkerReport(report({ summary: long }));
  assert.equal(result.ok, true);
  assert.equal(result.report.summary.length, 3000);
  assert.ok(result.report.summary.endsWith('... [truncated]'));
  assert.deepEqual(result.report.normalizations.map((entry) => [entry.field, entry.action]), [['summary', 'truncated']]);
  const needs = validateWorkerReport(report({ outcome: 'needs_decision', decisionRequest: request({ question: long, consequenceIfWrong: long }) }));
  assert.equal(needs.ok, true);
  assert.ok(needs.report.decisionRequest.question.endsWith('... [truncated]'));
  assert.equal(needs.report.normalizations.length, 2);
  assert.equal(parseWorkerReport(JSON.stringify(report({ summary: long }))).report.summary.length, 3000);
  // Structural errors still invalidate even next to an over-long string.
  assert.equal(validateWorkerReport(report({ summary: long, filesChanged: [1] })).ok, false);
});

test('parseWorkerReport never throws', () => {
  const ok = parseWorkerReport(JSON.stringify(report()));
  assert.equal(ok.error, null);
  assert.equal(ok.report.outcome, 'completed');
  for (const input of ['', '   ', undefined, null, 42, 'not json', '{"outcome":"completed"}', '[]', 'null']) {
    const result = parseWorkerReport(input);
    assert.equal(result.report, null);
    assert.equal(typeof result.error, 'string');
  }
  assert.match(parseWorkerReport('not json').error, /valid JSON/);
  assert.match(parseWorkerReport('{"a":1}').error, /invalid/);
});

const roles = new Map([
  ['orch-planner', { name: 'orch-planner', sandbox: 'read-only' }],
  ['orch-builder', { name: 'orch-builder', sandbox: 'workspace-write' }],
  ['orch-verifier', { name: 'orch-verifier', sandbox: 'workspace-write' }],
  ['orch-repair-xhigh', { name: 'orch-repair-xhigh', sandbox: 'workspace-write' }],
  ['orch-repair-sol', { name: 'orch-repair-sol', sandbox: 'workspace-write' }],
  ['orch-architect', { name: 'orch-architect', sandbox: 'read-only' }],
  ['orch-auditor', { name: 'orch-auditor', sandbox: 'read-only' }],
]);
const INVESTIGATION = { assignmentId: 'run:r1:a0', round: 1 };
function ctx(overrides = {}) {
  return { roles, attemptedRoles: new Set(), outcomeCount: 1, openDecisionIds: new Set(), investigations: [INVESTIGATION], ...overrides };
}
function assignment(overrides = {}) {
  return {
    role: 'orch-planner', objective: 'Plan it', allowedFiles: [], inputs: ['i'], evidence: ['e'],
    acceptanceCriteria: ['ac'], checks: ['c'], stopConditions: ['s'], ...overrides,
  };
}
function dispatch(assignments = [assignment()], overrides = {}) {
  return { action: 'dispatch', assignments, final: '', resolutions: [], humanInput: null, ...overrides };
}
function finish(overrides = {}) {
  return { action: 'finish', assignments: [], final: 'All done', resolutions: [], humanInput: null, ...overrides };
}
function human(overrides = {}) {
  return {
    reason: 'credentials_or_access', question: 'Which?', options: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }],
    recommendation: 'a', evidenceChecked: ['run:r1:a0 found no deploy token'], independentWork: 'none', relatedDecisionIds: [], ...overrides,
  };
}
function ask(overrides = {}) {
  return { action: 'request_human_input', assignments: [], final: '', resolutions: [], humanInput: human(), ...overrides };
}
const throws = (decision, context, pattern) => assert.throws(() => validateDecision(decision, context), pattern);

test('validateDecision accepts valid finish, dispatch, and request_human_input', () => {
  validateDecision(finish(), ctx());
  validateDecision(dispatch(), ctx());
  validateDecision(dispatch([assignment({ role: 'orch-builder', allowedFiles: ['src/a.js'] })]), ctx());
  validateDecision(ask(), ctx());
  validateDecision(dispatch(Array.from({ length: MAX_ASSIGNMENTS }, () => assignment())), ctx());
});

test('validateDecision enforces shape and action rules', () => {
  throws(null, ctx(), /JSON object/);
  throws({ action: 'finish', assignments: [], final: 'x' }, ctx(), /unsupported field/);
  throws({ ...finish(), extra: 1 }, ctx(), /unsupported field/);
  throws(finish({ action: 'stop' }), ctx(), /Unsupported lead action/);
  throws(finish({ assignments: 'x' }), ctx(), /assignments must be an array/);
  throws(finish({ final: 1 }), ctx(), /final must be a string/);
  throws(finish({ resolutions: null }), ctx(), /resolutions must be an array/);
  throws(finish({ humanInput: 'x' }), ctx(), /humanInput must be null or an object/);
  throws(finish({ final: ' ' }), ctx(), /non-empty final/);
  throws(finish({ assignments: [assignment()] }), ctx(), /no assignments/);
  throws(finish({ humanInput: human() }), ctx(), /humanInput null/);
  throws(dispatch([]), ctx(), /between 1 and 4/);
  throws(dispatch(Array.from({ length: 5 }, () => assignment())), ctx(), /between 1 and 4/);
  throws(dispatch([assignment()], { final: 'x' }), ctx(), /leave final empty/);
  throws(dispatch([assignment()], { humanInput: human() }), ctx(), /humanInput null/);
  throws(ask({ assignments: [assignment()] }), ctx(), /no assignments/);
  throws(ask({ final: 'x' }), ctx(), /final empty/);
  throws(ask({ humanInput: null }), ctx(), /humanInput object/);
});

test('validateDecision enforces assignment rules', () => {
  const bad = (overrides, pattern, context = ctx()) => throws(dispatch([assignment(overrides)]), context, pattern);
  throws(dispatch(['x']), ctx(), /must be an object/);
  throws(dispatch([{ role: 'orch-planner' }]), ctx(), /exactly role/);
  bad({ role: 'nope' }, /Unknown role/);
  bad({ objective: ' ' }, /needs an objective/);
  for (const field of ['allowedFiles', 'inputs', 'evidence', 'acceptanceCriteria', 'checks', 'stopConditions']) {
    bad({ [field]: 'x' }, /string array/);
    bad({ [field]: [''] }, /string array/);
    bad({ [field]: Array.from({ length: 21 }, () => 'x') }, /size limit/);
    bad({ [field]: ['x'.repeat(3001)] }, /size limit/);
  }
  bad({ inputs: [] }, /bounded inputs/);
  bad({ evidence: [] }, /prior evidence/);
  bad({ acceptanceCriteria: [] }, /requires acceptanceCriteria/);
  bad({ checks: [] }, /requires acceptanceCriteria/);
  bad({ stopConditions: [] }, /requires acceptanceCriteria/);
  bad({ role: 'orch-builder', allowedFiles: [] }, /requires explicit allowedFiles/);
  for (const file of ['/abs', '../x', 'a/../b', './a', 'a//b', 'a\\b', 'C:\\x']) {
    bad({ role: 'orch-builder', allowedFiles: [file] }, /Unsafe allowedFiles/);
  }
  const writer = { allowedFiles: ['a.js'] };
  bad({ role: 'orch-repair-xhigh', ...writer }, /after an engineer attempt/);
  bad({ role: 'orch-repair-sol', ...writer }, /after a recovery-engineer attempt/);
  validateDecision(dispatch([assignment({ role: 'orch-repair-xhigh', ...writer })]), ctx({ attemptedRoles: new Set(['orch-builder']) }));
  validateDecision(dispatch([assignment({ role: 'orch-repair-sol', ...writer })]), ctx({ attemptedRoles: new Set(['orch-repair-xhigh']) }));
  bad({ role: 'orch-architect' }, /prior evidence/, ctx({ outcomeCount: 0 }));
  bad({ role: 'orch-architect', objective: 'x'.repeat(241) }, /narrowly framed/);
  throws(dispatch([assignment({ role: 'orch-architect' }), assignment()]), ctx(), /narrowly framed/);
  validateDecision(dispatch([assignment({ role: 'orch-architect', objective: 'x'.repeat(240) })]), ctx());
});

test('verifier remains a writable role and reports its bounded test scope requirement', () => {
  const review = { kind: 'routine', checkpointId: 'verifier-scope', reason: 'Verify the change', paths: ['src/file.js'], evidenceIds: ['issue-scope'] };
  assert.throws(() => validateDecision(dispatch([assignment({ role: 'orch-verifier', allowedFiles: [], review })]), ctx()), (error) => {
    assert.equal(error.violations[0].predicate, 'assignment.writer_scope');
    assert.equal(error.violations[0].code, 'writer_scope_missing');
    assert.match(error.message, /Writable role orch-verifier requires explicit allowedFiles/);
    assert.match(error.message, /1-20 bounded existing test\/check paths/);
    assert.match(error.message, /grants write permission but does not require edits/);
    return true;
  });
  assert.throws(() => validateDecision(dispatch([assignment({ role: 'orch-builder', allowedFiles: [] })]), ctx()), (error) => {
    assert.equal(error.violations[0].predicate, 'assignment.writer_scope');
    assert.equal(error.violations[0].code, 'writer_scope_missing');
    assert.doesNotMatch(error.message, /orch-verifier/);
    return true;
  });
});

test('canonical role IDs and legacy assignment IDs resolve to the same escalation gates', () => {
  const canonicalRoles = new Map([
    ['engineer', { name: 'engineer', sandbox: 'workspace-write' }],
    ['recovery-engineer', { name: 'recovery-engineer', sandbox: 'workspace-write' }],
    ['senior-engineer', { name: 'senior-engineer', sandbox: 'workspace-write' }],
  ]);
  const recovery = assignment({ role: 'recovery-engineer', allowedFiles: ['src/a.js'] });
  throws(dispatch([recovery]), ctx({ roles: canonicalRoles }), /recovery-engineer.*engineer/);
  const oldBuilder = assignment({ role: 'orch-builder', allowedFiles: ['src/a.js'] });
  validateDecision(dispatch([oldBuilder]), ctx({ roles: canonicalRoles }));
  assert.equal(oldBuilder.role, 'engineer');
  validateDecision(dispatch([recovery]), ctx({ roles: canonicalRoles, attemptedRoles: new Set(['orch-builder']) }));
  throws(dispatch([assignment({ role: 'senior-engineer', allowedFiles: ['src/a.js'] })]), ctx({ roles: canonicalRoles }), /senior-engineer.*recovery-engineer/);
});

test('assignment skills are bounded, unique, catalog-selectable, and legacy decisions remain valid', () => {
  const legacy = dispatch(); // Older runtime callers omit skills and review metadata.
  validateDecision(legacy, ctx());
  assert.equal(legacy.assignments[0].review, null);
  assert.deepEqual(legacy.records, []);
  const candidateCtx = ctx({ skillCandidateIds: new Set(['design', 'testing']), skillCatalog: new Map([['design', {}], ['testing', {}]]) });
  validateDecision(dispatch([assignment({ skills: ['design', 'testing'] })]), candidateCtx);
  throws(dispatch([assignment({ skills: ['design', 'design'] })]), ctx(), /skills must be unique/);
  throws(dispatch([assignment({ skills: Array.from({ length: 6 }, (_, i) => `skill-${i}`) })]), ctx(), /at most 5/);
  throws(dispatch([assignment({ skills: ['unknown'] })]), candidateCtx, /not advertised/);
  throws(dispatch([assignment({ skills: ['not-catalogued'] })]), ctx({ skillCatalog: new Map() }), /Unknown skill/);
  throws(dispatch([{ ...assignment(), skills: [], skillPins: [] }]), ctx(), /optionally skills/);
});

test('structured records require safe architecture paths and correlate remedies to problems', () => {
  const problem = { id: 'problem-1', kind: 'problem', status: 'open', summary: 'A boundary check is missing.', evidenceIds: ['test-a'], relatedIds: [], adrPath: null };
  const remedy = { id: 'remedy-1', kind: 'remedy', status: 'implemented', summary: 'Added the check.', evidenceIds: ['test-b'], relatedIds: ['problem-1'], adrPath: null };
  const architecture = { id: 'architecture-1', kind: 'architecture', status: 'accepted', summary: 'Keep scope identity path-bound.', evidenceIds: ['decision-1'], relatedIds: [], adrPath: 'architecture/review-policy.md' };
  const accepted = finish({ records: [problem, remedy, architecture] });
  validateDecision(accepted, ctx());
  assert.deepEqual(accepted.records.map((record) => record.id), ['problem-1', 'remedy-1', 'architecture-1']);
  throws(finish({ records: [remedy] }), ctx(), /relate to an existing problem record ID/);
  throws(finish({ records: [{ ...architecture, adrPath: '../adr.md' }] }), ctx(), /safe workspace-relative \.md path/);
  throws(finish({ records: [{ ...problem, adrPath: 'problem.md' }] }), ctx(), /adrPath must be null/);
  throws(finish({ records: Array.from({ length: 21 }, (_, index) => ({ ...problem, id: `p-${index}` })) }), ctx(), /at most 20/);
});

test('reviewers need matching contexts and ordered non-concurrent execution groups', () => {
  const review = { kind: 'risk_change', checkpointId: 'cp-1', reason: 'Trust boundary', paths: ['src/file.js'], evidenceIds: ['e-1'] };
  const writer = assignment({ role: 'orch-builder', allowedFiles: ['src/file.js'], review });
  const verifier = assignment({ role: 'orch-verifier', allowedFiles: ['test'], review });
  const auditor = assignment({ role: 'orch-auditor', allowedFiles: [], review });
  validateDecision(dispatch([writer, verifier, auditor]), ctx());
  throws(dispatch([{ ...writer, wave: 1 }, { ...verifier, wave: 1 }, auditor]), ctx(), /cannot share a wave with writer/);
  throws(dispatch([writer, auditor, verifier]), ctx(), /Run the verifier before the auditor/);
  throws(dispatch([writer, { ...verifier, review: { ...review, paths: ['src'] } }, auditor]), ctx(), /same review kind, reason, scope, and evidence IDs/);
  throws(dispatch([assignment({ role: 'orch-auditor', allowedFiles: [] })]), ctx(), /requires review metadata/);
});

test('validateDecision enforces humanInput rules', () => {
  const open = ctx({ openDecisionIds: new Set(['d1']) });
  const bad = (overrides, pattern, context = ctx()) => throws(ask({ humanInput: human(overrides) }), context, pattern);
  bad({ reason: 'whim' }, /reason must be an owner-only decision/);
  bad({ question: '' }, /question must not be empty/);
  bad({ question: 'x'.repeat(3001) }, /size limit/);
  bad({ independentWork: 5 }, /independentWork must be a string/);
  bad({ options: [{ id: 'a', description: 'A' }] }, /at least 2 options/);
  bad({ options: [{ id: 'a', description: 'A' }, { id: 'a', description: 'B' }] }, /unique/);
  bad({ options: [{ id: 'a', description: 'A' }, { id: 'b' }] }, /exactly id and description/);
  bad({ recommendation: 'z' }, /recommendation must be one of/);
  bad({ evidenceChecked: [] }, /must not be empty/);
  bad({ relatedDecisionIds: ['ghost'] }, /not open/, open);
  throws(ask({ humanInput: { ...human(), extra: 1 } }), ctx(), /exactly reason/);
  validateDecision(ask({ humanInput: human({ relatedDecisionIds: ['d1'] }) }), open);
});

test('validateDecision enforces resolutions and open decisions', () => {
  const open = ctx({ openDecisionIds: new Set(['d1', 'd2']) });
  const res = (decisionId, extra = {}) => ({ decisionId, choice: 'a', rationale: 'because', ...extra });
  validateDecision(finish({ resolutions: [res('d1'), res('d2')] }), open);
  validateDecision(dispatch([assignment()], { resolutions: [res('d1'), res('d2')] }), open);
  validateDecision(ask({ resolutions: [res('d1')], humanInput: human({ relatedDecisionIds: ['d2'] }) }), open);
  throws(finish({ resolutions: [res('d1')] }), open, /Open decision d2 must be resolved/);
  throws(finish(), open, /Open decision d1 must be resolved/);
  throws(dispatch([assignment({ role: 'orch-builder', allowedFiles: ['src/a.js'] })], { resolutions: [res('d1')] }), open, /Open decision d2/);
  // LL-6: a read-only dispatch may keep open decisions open while it investigates them.
  validateDecision(dispatch([assignment()], { resolutions: [res('d1')] }), open);
  validateDecision(dispatch([assignment()]), open);
  throws(finish({ resolutions: [res('zzz')] }), ctx(), /not open/);
  throws(finish({ resolutions: [res('d1'), res('d1'), res('d2')] }), open, /Duplicate resolution/);
  throws(finish({ resolutions: [res('d1', { choice: ' ' }), res('d2')] }), open, /choice must not be empty/);
  throws(finish({ resolutions: [res('d1', { rationale: '' }), res('d2')] }), open, /rationale must not be empty/);
  throws(finish({ resolutions: [{ decisionId: 'd1', choice: 'a' }, res('d2')] }), open, /exactly decisionId/);
  throws(finish({ resolutions: [res('d1', { choice: 'x'.repeat(3001) }), res('d2')] }), open, /size limit/);
});

test('safeRelativePath', () => {
  assert.equal(safeRelativePath('src/a.js'), true);
  assert.equal(safeRelativePath('a'), true);
  for (const value of ['', ' ', '/a', '..', 'a/..', './a', 'a/', 'a\\b', 'a\0b', 5, null]) assert.equal(safeRelativePath(value), false);
});

test('classifyCodexError detects usage limits', () => {
  const withInfo = (info, where = 'codexError') => Object.assign(new Error('x'), where === 'codexError' ? { codexError: { codexErrorInfo: info } } : { rpcData: { codexErrorInfo: info } });
  assert.equal(classifyCodexError(withInfo('usageLimitExceeded')), 'usage_limit');
  assert.equal(classifyCodexError(withInfo('rateLimitExceeded', 'rpcData')), 'usage_limit');
  assert.equal(classifyCodexError(withInfo({ httpConnectionFailed: { httpStatusCode: 429 } })), 'usage_limit');
  assert.equal(classifyCodexError(withInfo({ responseStreamDisconnected: { httpStatusCode: 429 } }, 'rpcData')), 'usage_limit');
  assert.equal(classifyCodexError(new Error('outer', { cause: new Error('mid', { cause: withInfo('usageLimitExceeded') }) })), 'usage_limit');
  assert.equal(classifyCodexError(withInfo({ httpConnectionFailed: { httpStatusCode: 500 } })), 'other');
  assert.equal(classifyCodexError(withInfo({ httpConnectionFailed: { httpStatusCode: null } })), 'other');
  assert.equal(classifyCodexError(withInfo('badRequest')), 'other');
  assert.equal(classifyCodexError(withInfo(null)), 'other');
  assert.equal(classifyCodexError(new Error('You hit your usage limit')), 'other');
  for (const value of [undefined, null, 'usageLimitExceeded', 5]) assert.equal(classifyCodexError(value), 'other');
});

test('classifyCodexError guards cause cycles and depth', () => {
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  a.cause = b;
  assert.equal(classifyCodexError(a), 'other');
  let deep = Object.assign(new Error('deep'), { codexError: { codexErrorInfo: 'usageLimitExceeded' } });
  for (let i = 0; i < 6; i += 1) deep = new Error(`wrap ${i}`, { cause: deep });
  assert.equal(classifyCodexError(deep), 'other');
  let near = Object.assign(new Error('near'), { codexError: { codexErrorInfo: 'usageLimitExceeded' } });
  for (let i = 0; i < 5; i += 1) near = new Error(`wrap ${i}`, { cause: near });
  assert.equal(classifyCodexError(near), 'usage_limit');
});

test('findCodexErrorInfo returns the raw value or null', () => {
  const info = { httpConnectionFailed: { httpStatusCode: 429 } };
  assert.deepEqual(findCodexErrorInfo(new Error('x', { cause: { rpcData: { codexErrorInfo: info } } })), info);
  assert.equal(findCodexErrorInfo(new Error('x')), null);
  assert.equal(findCodexErrorInfo(undefined), null);
});

test('validateDecision refuses a writable dispatch while writer outcomes are unresolved', () => {
  const roles = new Map([
    ['orch-builder', { name: 'orch-builder', sandbox: 'workspace-write' }],
    ['orch-explorer', { name: 'orch-explorer', sandbox: 'read-only' }],
  ]);
  const assignment = (role) => ({
    role,
    objective: 'Do it',
    allowedFiles: ['src/a.js'],
    inputs: ['x'],
    evidence: ['y'],
    acceptanceCriteria: ['z'],
    checks: ['c'],
    stopConditions: ['s'],
  });
  const dispatch = (role) => ({ action: 'dispatch', assignments: [assignment(role)], final: '', resolutions: [], humanInput: null });
  const ctx = (unresolvedWriterCount) => ({
    roles, attemptedRoles: new Set(), outcomeCount: 0, openDecisionIds: new Set(), unresolvedWriterCount,
  });
  assert.throws(() => validateDecision(dispatch('orch-builder'), ctx(2)), /Writable dispatch refused: 2 writer outcome\(s\) are unresolved/);
  assert.doesNotThrow(() => validateDecision(dispatch('orch-builder'), ctx(0)));
  assert.doesNotThrow(() => validateDecision(dispatch('orch-explorer'), ctx(2)));
});

test('validateDecision throws BoundaryViolation with predicate ids and codes', () => {
  const roles = new Map([
    ['orch-builder', { name: 'orch-builder', sandbox: 'workspace-write' }],
    ['orch-explorer', { name: 'orch-explorer', sandbox: 'read-only' }],
    ['recovery-engineer', { name: 'recovery-engineer', sandbox: 'workspace-write' }],
    ['orch-architect', { name: 'orch-architect', sandbox: 'read-only' }],
  ]);
  const base = (role = 'orch-builder', allowedFiles = ['src/a.js']) => ({
    role, objective: 'Do it', allowedFiles, inputs: ['x'], evidence: ['y'], acceptanceCriteria: ['z'], checks: ['c'], stopConditions: ['s'], skills: [],
  });
  const dispatch = (...assignments) => ({ action: 'dispatch', assignments, final: '', resolutions: [], humanInput: null });
  const ctx = (extra = {}) => ({
    roles, attemptedRoles: new Set(), outcomeCount: 0, openDecisionIds: new Set(), unresolvedWriterCount: 0, ...extra,
  });
  const expectFail = (decision, context, predicate, code, message) => {
    let caught;
    try { validateDecision(decision, context); } catch (error) { caught = error; }
    assert.ok(caught instanceof BoundaryViolation, `${code} should throw BoundaryViolation`);
    assert.ok(caught instanceof Error);
    assert.equal(caught.violations.length, 1);
    const [violation] = caught.violations;
    assert.equal(violation.predicate, predicate);
    assert.equal(violation.code, code);
    assert.equal(violation.result, 'FAIL');
    assert.equal(violation.boundary, 'dispatch');
    assert.ok(violation.detail.length <= 500);
    assert.ok(BOUNDARY_PREDICATES[predicate].includes(code));
    if (message) assert.match(caught.message, message);
  };
  const withField = (field, value) => ({ ...base(), [field]: value });

  expectFail('nope', ctx(), 'decision.envelope', 'decision_envelope_invalid', /must be a JSON object/);
  expectFail({ ...dispatch(base()), action: 'bogus' }, ctx(), 'decision.envelope', 'decision_envelope_invalid', /Unsupported lead action/);
  expectFail(dispatch(), ctx(), 'decision.envelope', 'assignment_count_invalid', /between 1 and 4/);
  expectFail({ ...dispatch(base()), resolutions: [{ decisionId: 'd1', choice: 'a', rationale: 'b' }] }, ctx(), 'decision.resolutions', 'decision_unresolved', /not open/);
  expectFail(dispatch(base()), ctx({ openDecisionIds: new Set(['d1']) }), 'decision.resolutions', 'decision_unresolved', /Open decision d1/);
  expectFail(dispatch('str'), ctx(), 'assignment.shape', 'assignment_shape_invalid', /must be an object/);
  expectFail(dispatch(base('ghost')), ctx(), 'assignment.shape', 'role_unknown', /Unknown role: ghost/);
  expectFail(dispatch(withField('objective', '')), ctx(), 'assignment.shape', 'field_invalid', /needs an objective/);
  expectFail(dispatch(withField('objective', 'x'.repeat(3001))), ctx(), 'assignment.shape', 'field_invalid', /size limit for objective/);
  expectFail(dispatch(base('orch-builder', [])), ctx(), 'assignment.writer_scope', 'writer_scope_missing', /requires explicit allowedFiles/);
  expectFail(dispatch(base('orch-builder', ['.'])), ctx(), 'assignment.paths', 'path_unsafe', /Unsafe allowedFiles path/);
  expectFail(dispatch(base('orch-builder', ['../x'])), ctx(), 'assignment.paths', 'path_unsafe', /Unsafe allowedFiles path/);
  for (const glob of ['src/*', 'src/a?.js', 'src/[ab].js']) {
    expectFail(dispatch(base('orch-builder', [glob])), ctx(), 'assignment.paths', 'path_glob_unsupported', /Unsupported glob/);
  }
  expectFail(dispatch(withField('skills', ['x', 'x'])), ctx(), 'assignment.skills', 'skill_invalid', /skills must be unique/);
  expectFail(dispatch(withField('skills', ['x'])), ctx({ skillCatalog: new Map() }), 'assignment.skills', 'skill_invalid', /Unknown skill: x/);
  expectFail(dispatch(base('recovery-engineer')), ctx(), 'assignment.role_ladder', 'role_ladder_violation', /after an engineer attempt/);
  expectFail(dispatch(base('orch-architect', [])), ctx(), 'assignment.role_ladder', 'architect_constraint', /requires inspected prior evidence/);
  expectFail(dispatch(base()), ctx({ unresolvedWriterCount: 1 }), 'dispatch.writer_unresolved', 'writer_unresolved', /Writable dispatch refused/);

  assert.doesNotThrow(() => validateDecision(dispatch(base('orch-explorer', [])), ctx()));
  assert.throws(() => Object.assign(BOUNDARY_PREDICATES, { x: 1 }));
});

// ---------------------------------------------------------------- direct specialist requests

const WRITER = { id: 'engineer', name: 'orch-builder', sandbox: 'workspace-write' };
const READER = { id: 'explorer', name: 'orch-explorer', sandbox: 'read-only' };

function specialist(overrides = {}) {
  return {
    role: 'orch-builder', objective: 'Do it', allowedFiles: ['src'], inputs: ['a'], evidence: ['b'],
    acceptanceCriteria: ['c'], checks: ['d'], stopConditions: ['e'], skills: [], skillPins: [],
    assignmentId: 'a-1', workspace: '/ws', reportContract: 'worker-report/v1', ...overrides,
  };
}

function specialistCode(request, role, expectedPredicate, expectedCode) {
  assert.throws(() => checkSpecialistRequest(request, role, { workspace: '/ws' }), (error) => {
    assert.ok(error instanceof BoundaryViolation);
    assert.equal(error.violations[0].predicate, expectedPredicate);
    assert.equal(error.violations[0].code, expectedCode);
    assert.equal(error.violations[0].boundary, 'dispatch');
    assert.ok(BOUNDARY_PREDICATES[expectedPredicate].includes(expectedCode));
    return true;
  });
}

test('checkSpecialistRequest accepts the shape the lead sends and returns a copy', () => {
  const input = specialist();
  const out = checkSpecialistRequest(input, WRITER, { workspace: '/ws' });
  assert.deepEqual(out, input);
  assert.notEqual(out.allowedFiles, input.allowedFiles);
  const minimal = checkSpecialistRequest({ objective: 'x', allowedFiles: [] }, READER, { workspace: '/ws' });
  assert.deepEqual(minimal.inputs, []);
  assert.equal(checkSpecialistRequest(specialist({ role: 'engineer' }), WRITER, { workspace: '/ws' }).role, 'engineer');
});

test('checkSpecialistRequest rejects shape problems', () => {
  specialistCode('x', WRITER, 'assignment.shape', 'assignment_shape_invalid');
  specialistCode({ objective: 'x' }, WRITER, 'assignment.shape', 'assignment_shape_invalid');
  specialistCode(specialist({ role: 'orch-auditor' }), WRITER, 'assignment.shape', 'role_unknown');
  specialistCode(specialist({ objective: ' ' }), WRITER, 'assignment.shape', 'field_invalid');
  specialistCode(specialist({ allowedFiles: 'src' }), WRITER, 'assignment.shape', 'field_invalid');
  specialistCode(specialist({ inputs: [1] }), WRITER, 'assignment.shape', 'field_invalid');
  specialistCode(specialist({ checks: Array(21).fill('x') }), WRITER, 'assignment.shape', 'field_invalid');
});

test('checkSpecialistRequest rejects writer scope, paths, and request input problems', () => {
  specialistCode(specialist({ allowedFiles: [] }), WRITER, 'assignment.writer_scope', 'writer_scope_missing');
  specialistCode(specialist({ allowedFiles: ['.'] }), WRITER, 'assignment.paths', 'path_unsafe');
  specialistCode(specialist({ allowedFiles: ['../x'] }), WRITER, 'assignment.paths', 'path_unsafe');
  specialistCode(specialist({ allowedFiles: ['/etc/x'] }), WRITER, 'assignment.paths', 'path_unsafe');
  specialistCode(specialist({ allowedFiles: ['src/*.js'] }), WRITER, 'assignment.paths', 'path_glob_unsupported');
  specialistCode(specialist({ requireAcceptance: true }), WRITER, 'dispatch.request_input', 'guarantee_unavailable');
  specialistCode(specialist({ workspace: '/other' }), WRITER, 'dispatch.request_input', 'request_invalid');
  specialistCode(specialist({ surprise: 1 }), WRITER, 'dispatch.request_input', 'request_invalid');
  assert.equal(checkSpecialistRequest(specialist({ requireAcceptance: false }), WRITER, { workspace: '/ws' }).allowedFiles[0], 'src');
});

test('checkSpecialistRequest validates and normalizes the continuation key', () => {
  const full = { ofAttemptId: 'run:r1:a0:t1', threadId: 'th-1', laneId: 'lane-1', codexHome: '/home/x/.codex' };
  assert.deepEqual(checkSpecialistRequest(specialist({ continuation: full }), WRITER, { workspace: '/ws' }).continuation, full);
  assert.deepEqual(
    checkSpecialistRequest(specialist({ role: 'orch-explorer', allowedFiles: [], continuation: { ofAttemptId: 'a:t1', threadId: 'th' } }), READER, { workspace: '/ws' }).continuation,
    { ofAttemptId: 'a:t1', threadId: 'th', laneId: null, codexHome: null },
  );
  assert.equal(checkSpecialistRequest(specialist(), WRITER, { workspace: '/ws' }).continuation, undefined);
  for (const bad of ['x', null, [], {}, { ofAttemptId: '' }, { ofAttemptId: 'a', threadId: 5 }, { ofAttemptId: 'a', laneId: '' },
    { ofAttemptId: 'a', extra: 1 }]) {
    specialistCode(specialist({ continuation: bad }), WRITER, 'assignment.shape', 'field_invalid');
  }
});

test('checkSpecialistRequest drops "." and "./" from read-only scope', () => {
  const out = checkSpecialistRequest(specialist({ role: 'orch-explorer', allowedFiles: ['.', './', 'docs'] }), READER, { workspace: '/ws' });
  assert.deepEqual(out.allowedFiles, ['docs']);
  assert.deepEqual(checkSpecialistRequest(specialist({ role: 'orch-explorer', allowedFiles: ['.'] }), READER, { workspace: '/ws' }).allowedFiles, []);
  specialistCode(specialist({ role: 'orch-explorer', allowedFiles: ['../x'] }), READER, 'assignment.paths', 'path_unsafe');
});

test('pathsOutsideAllowed matches exact files and directory prefixes', () => {
  assert.deepEqual(pathsOutsideAllowed(['a.js', 'b.js'], ['a.js'], '/ws'), ['b.js']);
  assert.deepEqual(pathsOutsideAllowed(['src/a.js', 'src/deep/b.js', 'srcx/c.js'], ['src'], '/ws'), ['srcx/c.js']);
  assert.deepEqual(pathsOutsideAllowed(['src/a.js', 'lib/b.js'], ['src/'], '/ws'), ['lib/b.js']);
  assert.deepEqual(pathsOutsideAllowed(['/ws/src/a.js', '/ws/lib/b.js'], ['src'], '/ws'), ['/ws/lib/b.js']);
  assert.deepEqual(pathsOutsideAllowed(['./src/a.js'], ['./src'], '/ws'), []);
  assert.deepEqual(pathsOutsideAllowed(['src/a.js'], [], '/ws'), ['src/a.js']);
  assert.deepEqual(pathsOutsideAllowed(['/elsewhere/x.js'], ['src'], '/ws'), ['/elsewhere/x.js']);
});

test('executionGroups groups consecutive equal non-null waves; null is a group of one', () => {
  const groups = (...waves) => executionGroups(waves.map((wave) => ({ wave })));
  assert.deepEqual(groups(1, 1, 1), [[0, 1, 2]]);
  assert.deepEqual(groups(null, null), [[0], [1]]);
  assert.deepEqual(groups(1, 1, null, 2), [[0, 1], [2], [3]]);
  assert.deepEqual(groups(1, 2, 1), [[0], [1], [2]]);
  assert.deepEqual(executionGroups([{}, {}]), [[0], [1]]);
  assert.deepEqual(executionGroups([]), []);
});

test('assignment.wave is a known predicate with both codes', () => {
  assert.deepEqual([...BOUNDARY_PREDICATES['assignment.wave']], ['wave_invalid', 'wave_scope_overlap']);
});

test('review gate and direct review guards have registered stable boundary codes', () => {
  assert.deepEqual([...BOUNDARY_PREDICATES['decision.review_gate']], [
    'review_receipt_missing', 'review_checkpoint_pending', 'review_context_mismatch', 'verifier_receipt_missing',
  ]);
  assert.deepEqual([...BOUNDARY_PREDICATES['review.continuation']], ['review_origin_unknown', 'review_origin_stale']);
  assert.deepEqual([...BOUNDARY_PREDICATES['review.concurrent_writer']], ['review_writer_unsettled']);
  assert.deepEqual([...BOUNDARY_PREDICATES['review.reservation']], ['review_reservation_unavailable']);
  assert.deepEqual([...BOUNDARY_PREDICATES['review.target']], ['review_target_unknown']);
});

test('a legacy assignment gets wave null injected', () => {
  const legacy = assignment();
  validateDecision(dispatch([legacy]), ctx());
  assert.equal(legacy.wave, null);
  assert.deepEqual(legacy.skills, []);
  const withWave = assignment({ skills: [], wave: 2 });
  validateDecision(dispatch([withWave]), ctx());
  assert.equal(withWave.wave, 2);
});

test('wave_invalid rejects non-integer or < 1 waves', () => {
  for (const wave of [0, -1, 1.5, '1']) {
    assert.throws(() => validateDecision(dispatch([assignment({ wave })]), ctx()), (error) => error.violations[0].code === 'wave_invalid');
  }
});

test('wave_scope_overlap checks writers of one group for overlapping allowedFiles', () => {
  const writer = (allowedFiles, wave = 1, role = 'orch-builder') => assignment({ role, allowedFiles, wave });
  const overlap = (assignments, pattern) => assert.throws(() => validateDecision(dispatch(assignments), ctx()), (error) => {
    assert.equal(error.violations[0].predicate, 'assignment.wave');
    assert.equal(error.violations[0].code, 'wave_scope_overlap');
    if (pattern) assert.match(error.violations[0].detail, pattern);
    return true;
  });
  validateDecision(dispatch([writer(['src/a']), writer(['src/b'])]), ctx());
  validateDecision(dispatch([writer(['src/ab.js']), writer(['src/a'])]), ctx());
  validateDecision(dispatch([writer(['src/a']), writer(['src/a/b.js'], 2)]), ctx());
  validateDecision(dispatch([writer(['src/a']), writer(['src/a'], null)]), ctx());
  validateDecision(dispatch([writer(['src/a']), assignment({ wave: 1, allowedFiles: ['src/a'] })]), ctx());
  overlap([writer(['src/a.js']), writer(['src/a.js'])], /#0 \(orch-builder\) and #1 \(orch-builder\).*src\/a\.js/);
  overlap([writer(['src/a']), writer(['src/a/b.js'])], /src\/a vs src\/a\/b\.js/);
  // A bare root scope never reaches the group check: the path rules refuse it first.
  assert.throws(() => validateDecision(dispatch([writer(['x.js']), writer(['.'])]), ctx()), (error) => error.violations[0].code === 'path_unsafe');
  overlap([writer(['lib']), writer(['src/z']), writer(['src/z/y.js'])]);
});

test('settle.lane_scope is a known predicate that acceptance does not aggregate', () => {
  assert.deepEqual([...BOUNDARY_PREDICATES['settle.lane_scope']], ['lane_scope_refused']);
  const { computeDisposition } = require('../src/acceptance');
  const outcome = computeDisposition({ writers: [{ attemptId: 'a', ran: false, completed: false, reportValid: false, reportedScopeViolations: [], attestedScopeViolations: [], deltaKnown: false }] });
  assert.ok(!outcome.issues.some((issue) => issue.predicate === 'settle.lane_scope' || issue.code === 'lane_scope_refused'));
});

// ---------------------------------------------------------------- continueFrom (LL-5)
const continuable = (entries = [['a-1', 'orch-builder']]) => new Map(entries);
const codeOf = (fn) => { try { fn(); } catch (error) { return error.violations?.[0]; } return null; };

test('continueFrom is injected as null for legacy assignments and accepted for a finished same-role outcome', () => {
  const legacy = assignment();
  validateDecision(dispatch([legacy]), ctx());
  assert.equal(legacy.continueFrom, null);
  const next = assignment({ role: 'orch-builder', allowedFiles: ['src'], continueFrom: 'a-1' });
  validateDecision(dispatch([next]), ctx({ continuable: continuable() }));
  assert.equal(next.continueFrom, 'a-1');
});

test('continueFrom violations carry assignment.continue_from codes', () => {
  const builder = (overrides) => assignment({ role: 'orch-builder', allowedFiles: ['src'], ...overrides });
  let found = codeOf(() => validateDecision(dispatch([builder({ continueFrom: 'nope' })]), ctx({ continuable: continuable() })));
  assert.equal(found.predicate, 'assignment.continue_from');
  assert.equal(found.code, 'continue_from_unknown');
  found = codeOf(() => validateDecision(dispatch([builder({ continueFrom: 'a-1' })]), ctx()));
  assert.equal(found.code, 'continue_from_unknown');
  found = codeOf(() => validateDecision(dispatch([builder({ continueFrom: 'a-1' })]), ctx({ continuable: continuable([['a-1', 'orch-planner']]) })));
  assert.equal(found.code, 'continue_from_role');
  found = codeOf(() => validateDecision(dispatch([builder({ continueFrom: 'a-1' }), builder({ continueFrom: 'a-1', allowedFiles: ['lib'] })]), ctx({ continuable: continuable() })));
  assert.equal(found.code, 'continue_from_duplicate');
  for (const code of ['continue_from_unknown', 'continue_from_role', 'continue_from_duplicate']) {
    assert.ok(BOUNDARY_PREDICATES['assignment.continue_from'].includes(code));
  }
  found = codeOf(() => validateDecision(dispatch([builder({ continueFrom: '' })]), ctx({ continuable: continuable() })));
  assert.equal(found.code, 'field_invalid');
});

test('checkSpecialistRequest keeps a scope continuation reason and rejects other reasons', () => {
  const out = checkSpecialistRequest(specialist({ continuation: { ofAttemptId: 'x', threadId: 't', laneId: null, codexHome: null, reason: 'scope' } }), { id: 'orch-builder', sandbox: 'workspace-write' }, { workspace: '/ws' });
  assert.equal(out.continuation.reason, 'scope');
  specialistCode(specialist({ continuation: { ofAttemptId: 'x', reason: 'other' } }), { id: 'orch-builder', sandbox: 'workspace-write' }, 'assignment.shape', 'field_invalid');
});

// ------------------------------------------------- LL-6: investigate before asking

const investigateFirst = (decision, context) => {
  let caught;
  try { validateDecision(decision, context); } catch (error) { caught = error; }
  assert.ok(caught instanceof BoundaryViolation, 'expected investigation_missing');
  assert.equal(caught.violations[0].predicate, 'decision.investigate_first');
  assert.equal(caught.violations[0].code, 'investigation_missing');
  assert.ok(BOUNDARY_PREDICATES['decision.investigate_first'].includes('investigation_missing'));
  return caught;
};

test('only the closed list of owner-only decisions may reach the owner', () => {
  assert.deepEqual(HUMAN_REASONS, ['paid_resources', 'credentials_or_access', 'external_write', 'irreversible_operation', 'prd_requirement_change', 'infeasible_requirement']);
  assert.deepEqual(DECISION_SCHEMA.properties.humanInput.anyOf[0].properties.reason.enum, HUMAN_REASONS);
  for (const reason of HUMAN_REASONS) validateDecision(ask({ humanInput: human({ reason }) }), ctx());
  for (const reason of ['product_choice', 'missing_authority', 'irreversible_or_external', 'scope_change']) {
    throws(ask({ humanInput: human({ reason }) }), ctx(), /humanInput\.reason must be an owner-only decision: one of paid_resources, credentials_or_access/);
  }
});

test('humanInput.reason infeasible_requirement is accepted and an unknown reason is still rejected', () => {
  validateDecision(ask({ humanInput: human({ reason: 'infeasible_requirement' }) }), ctx());
  throws(ask({ humanInput: human({ reason: 'infeasible' }) }), ctx(), /humanInput\.reason must be an owner-only decision: one of paid_resources, credentials_or_access, external_write, irreversible_operation, prd_requirement_change, infeasible_requirement/);
});

test('request_human_input needs a cited investigation from a round after the blocker appeared', () => {
  // No investigation in the run at all.
  investigateFirst(ask(), ctx({ investigations: [] }));
  // An investigation exists but is not cited.
  investigateFirst(ask({ humanInput: human({ evidenceChecked: ['README.md'] }) }), ctx());
  // A longer id does not cite a shorter one.
  investigateFirst(ask({ humanInput: human({ evidenceChecked: ['run:r1:a01 says so'] }) }), ctx());
  // Cited in relatedDecisionIds by assignmentId instead of in evidenceChecked.
  validateDecision(ask({ humanInput: human({ evidenceChecked: ['README.md'], relatedDecisionIds: ['run:r1:a0'] }) }), ctx());
  // The blocker is the open decision d1 raised in round 2: an investigation of round 2 is not after it.
  const open = (investigations) => ctx({ openDecisionIds: new Set(['d1']), openDecisionRounds: new Map([['d1', 2]]), investigations });
  const asked = ask({ humanInput: human({ relatedDecisionIds: ['d1'], evidenceChecked: ['run:r2:a0 traced it'] }) });
  investigateFirst(asked, open([{ assignmentId: 'run:r2:a0', round: 2 }]));
  const caught = investigateFirst(ask({ humanInput: human({ relatedDecisionIds: ['d1'], evidenceChecked: ['run:r1:a0'] }) }), open([INVESTIGATION]));
  assert.match(caught.message, /from a round after 2/);
  validateDecision(ask({ humanInput: human({ relatedDecisionIds: ['d1'], evidenceChecked: ['run:r3:a1 traced it'] }) }), open([{ assignmentId: 'run:r3:a1', round: 3 }]));
  // A non-open id that is no investigation is still refused.
  throws(ask({ humanInput: human({ relatedDecisionIds: ['ghost'] }) }), ctx(), /not open: ghost/);
});

test('a repeated unmet-goal finish needs an investigation finished after the first one, cited in final', () => {
  const since = (round, investigations) => ctx({ goalInvestigationRound: round, investigations });
  validateDecision(finish({ goalAchieved: false, final: 'Blocked on X' }), ctx());
  investigateFirst(finish({ goalAchieved: false, final: 'Still blocked on X' }), since(2, [INVESTIGATION]));
  investigateFirst(finish({ goalAchieved: false, final: 'run:r1:a0 shows X' }), since(2, [INVESTIGATION]));
  const caught = investigateFirst(finish({ goalAchieved: false, final: 'No evidence' }), since(2, [{ assignmentId: 'run:r3:a0', round: 3 }]));
  assert.match(caught.message, /state why each remaining blocker is owner-only/);
  validateDecision(finish({ goalAchieved: false, final: 'X needs a paid license (run:r3:a0)' }), since(2, [{ assignmentId: 'run:r3:a0', round: 3 }]));
  validateDecision(finish({ goalAchieved: true, final: 'Done' }), since(2, []));
});
