'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WORKER_REPORT_SCHEMA, WORKER_REPORT_CONTRACT, validateWorkerReport, parseWorkerReport,
  DECISION_SCHEMA, validateDecision, classifyCodexError, findCodexErrorInfo, safeRelativePath,
  ASSIGNMENT_FIELDS, MAX_ASSIGNMENTS,
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
    report({ outcome: 'needs_decision', decisionRequest: request({ recommendation: 'z' }) }),
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
  ['orch-repair-xhigh', { name: 'orch-repair-xhigh', sandbox: 'workspace-write' }],
  ['orch-repair-sol', { name: 'orch-repair-sol', sandbox: 'workspace-write' }],
  ['orch-architect', { name: 'orch-architect', sandbox: 'read-only' }],
]);
function ctx(overrides = {}) {
  return { roles, attemptedRoles: new Set(), outcomeCount: 1, openDecisionIds: new Set(), ...overrides };
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
    reason: 'product_choice', question: 'Which?', options: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }],
    recommendation: 'a', evidenceChecked: ['x'], independentWork: 'none', relatedDecisionIds: [], ...overrides,
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
  throws({ action: 'finish', assignments: [], final: 'x' }, ctx(), /only action, assignments, final, resolutions, and humanInput/);
  throws({ ...finish(), extra: 1 }, ctx(), /only action/);
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
  bad({ role: 'orch-repair-xhigh', ...writer }, /after an orch-builder attempt/);
  bad({ role: 'orch-repair-sol', ...writer }, /after an orch-repair-xhigh attempt/);
  validateDecision(dispatch([assignment({ role: 'orch-repair-xhigh', ...writer })]), ctx({ attemptedRoles: new Set(['orch-builder']) }));
  validateDecision(dispatch([assignment({ role: 'orch-repair-sol', ...writer })]), ctx({ attemptedRoles: new Set(['orch-repair-xhigh']) }));
  bad({ role: 'orch-architect' }, /prior evidence/, ctx({ outcomeCount: 0 }));
  bad({ role: 'orch-architect', objective: 'x'.repeat(241) }, /narrowly framed/);
  throws(dispatch([assignment({ role: 'orch-architect' }), assignment()]), ctx(), /narrowly framed/);
  validateDecision(dispatch([assignment({ role: 'orch-architect', objective: 'x'.repeat(240) })]), ctx());
});

test('validateDecision enforces humanInput rules', () => {
  const open = ctx({ openDecisionIds: new Set(['d1']) });
  const bad = (overrides, pattern, context = ctx()) => throws(ask({ humanInput: human(overrides) }), context, pattern);
  bad({ reason: 'whim' }, /reason must be one of/);
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
  throws(dispatch([assignment()], { resolutions: [res('d1')] }), open, /Open decision d2/);
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

test('classifyCodexError detects authentication failures after usage limits', () => {
  const withInfo = (info, where = 'codexError') => Object.assign(new Error('x'), where === 'codexError' ? { codexError: { codexErrorInfo: info } } : { rpcData: { codexErrorInfo: info } });
  assert.equal(classifyCodexError(withInfo('unauthorized')), 'auth');
  assert.equal(classifyCodexError(withInfo('unauthorized', 'rpcData')), 'auth');
  assert.equal(classifyCodexError(withInfo({ httpConnectionFailed: { httpStatusCode: 401 } })), 'auth');
  assert.equal(classifyCodexError(new Error('outer', { cause: withInfo('unauthorized') })), 'auth');
  // usage_limit wins when both signals are present
  assert.equal(classifyCodexError(Object.assign(new Error('Please sign in again'), { codexError: { codexErrorInfo: 'usageLimitExceeded' } })), 'usage_limit');
  const messages = [
    'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.',
    'ACCESS TOKEN COULD NOT BE REFRESHED',
    'Session ended, please Log In Again',
    'You have logged out or signed in to another account',
    'The refresh token was revoked',
    'refresh token is expired',
    'Refresh token invalid',
    'refresh token reused',
  ];
  for (const message of messages) {
    assert.equal(classifyCodexError(new Error(message)), 'auth', message);
    assert.equal(classifyCodexError(Object.assign(new Error('x'), { codexError: { message } })), 'auth', message);
    assert.equal(classifyCodexError(Object.assign(new Error('x'), { rpcData: { message } })), 'auth', message);
    assert.equal(classifyCodexError(new Error('outer', { cause: new Error(message) })), 'auth', message);
  }
  for (const message of ['The refresh token was rotated', 'access token', 'Please sign in', 'login failed', 'unauthorized access to file', 'HTTP 401', '']) {
    assert.equal(classifyCodexError(new Error(message)), 'other', message);
  }
  assert.equal(classifyCodexError(withInfo({ httpConnectionFailed: { httpStatusCode: 403 } })), 'other');
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

test('schemas tell the model that recommendation must be an option id', () => {
  const requestProps = WORKER_REPORT_SCHEMA.properties.decisionRequest.anyOf[0].properties;
  const humanProps = DECISION_SCHEMA.properties.humanInput.anyOf[0].properties;
  for (const props of [requestProps, humanProps]) {
    assert.equal(props.recommendation.type, 'string');
    assert.match(props.recommendation.description, /exactly the id of one of the options/);
    assert.match(props.options.items.properties.id.description, /identifier/);
  }
});

test('decision schema describes the cross-field rules enforced by validateDecision', () => {
  const props = DECISION_SCHEMA.properties;
  assert.match(props.action.description, /dispatch.*finish.*request_human_input/s);
  assert.match(props.assignments.description, /empty for finish and request_human_input/);
  assert.match(props.final.description, /empty string for dispatch and request_human_input.*non-empty for finish/s);
  assert.match(props.humanInput.description, /null for dispatch and finish/);
});
