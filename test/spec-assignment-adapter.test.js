'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const contextApi = require('../src/spec-context');
const analyzer = require('../src/spec-analyzer');
const adapter = require('../src/spec-assignment-adapter');
const FIXTURE = path.join(__dirname, 'fixtures/spec-kit/pilot-price');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-adapter-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function writeJson(root, relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function load(root) {
  const accepted = readJson(root, 'context/accepted-context.json');
  const contextResult = contextApi.loadContext({
    workspaceRoot: root,
    contextPath: accepted.contextPath,
    expectedSha256: accepted.contextSha256,
  });
  const map = readJson(root, 'specs/pilot-price/traceability.json');
  const analysisResult = analyzer.analyzeTaskMap({
    workspaceRoot: root,
    contextResult,
    expectedContextSha256: accepted.contextSha256,
    map,
  });
  return { accepted, contextResult, map, analysisResult };
}

function adapt(root) {
  const { accepted, contextResult, map, analysisResult } = load(root);
  return adapter.adaptAssignments({
    workspaceRoot: root,
    contextResult,
    expectedContextSha256: accepted.contextSha256,
    map,
    analysisResult,
  });
}

function rebindContext(root, mutate) {
  const context = readJson(root, 'context/pilot-context.json');
  mutate(context);
  writeJson(root, 'context/pilot-context.json', context);
  const accepted = readJson(root, 'context/accepted-context.json');
  const contextSha256 = digest(fs.readFileSync(path.join(root, 'context/pilot-context.json')));
  accepted.contextSha256 = contextSha256;
  writeJson(root, 'context/accepted-context.json', accepted);
  const map = readJson(root, 'specs/pilot-price/traceability.json');
  map.contextSha256 = contextSha256;
  writeJson(root, 'specs/pilot-price/traceability.json', map);
}

function setTaskRows(root, map) {
  const tasksPath = path.join(root, 'specs/pilot-price/tasks.md');
  const original = fs.readFileSync(tasksPath, 'utf8');
  const before = original.slice(0, original.indexOf('<!-- harness-task-map:v1 begin -->'));
  const after = original.slice(original.indexOf('<!-- harness-task-map:v1 end -->') + '<!-- harness-task-map:v1 end -->'.length);
  const rows = map.tasks.map((task) => `- [ ] ${task.id}${task.parallel ? ' [P]' : ''} ${task.objective}`).join('\n');
  const text = `${before}<!-- harness-task-map:v1 begin -->\n${rows}\n<!-- harness-task-map:v1 end -->${after}`;
  fs.writeFileSync(tasksPath, text);
  map.artifactBindings.find((binding) => binding.role === 'tasks').sha256 = digest(fs.readFileSync(tasksPath));
  writeJson(root, 'specs/pilot-price/traceability.json', map);
}

test('F2 compiles complete implementation and verifier proposals through both real contract boundaries', () => {
  const root = copyFixture();
  try {
    const result = adapt(root);
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.implementationAcceptance, 'not_evaluated');
    assert.deepEqual(result.assumptions.attemptedRoles, []);
    assert.equal(result.proposals.length, 2);
    const [engineer, verifier] = result.proposals;
    assert.equal(engineer.kind, 'engineer');
    assert.equal(engineer.assignment.role, 'engineer');
    assert.equal(verifier.assignment.role, 'verifier');
    assert.deepEqual(engineer.assignment.allowedFiles, ['product/src/price.js']);
    assert.deepEqual(verifier.assignment.allowedFiles, ['verification/checks']);
    assert.deepEqual(engineer.assignment.review, verifier.assignment.review);
    assert.deepEqual(engineer.assignment.review, {
      kind: 'routine',
      checkpointId: 'pilot-price-T001',
      reason: 'Review the bounded arithmetic repair and verify that only the permitted product source changed.',
      paths: ['product/src/price.js', 'verification/checks'],
      evidenceIds: ['EVID-ACCEPTANCE-TESTS', 'EVID-DEFECT', 'EVID-FIXTURE-ACCEPTANCE', 'EVID-GOAL', 'EVID-MANDATORY-INVENTORY'],
      prerequisiteFor: [],
    });
    assert.match(engineer.assignment.inputs[0], /^REQUIREMENT REQ-1 source=canonical\/requirements\.md lines=9-10:/);
    assert.match(engineer.assignment.acceptanceCriteria[0], /^ACCEPTANCE AC-1 source=canonical\/requirements\.md lines=19-21:/);
    assert.match(engineer.assignment.evidence[0], /^EVIDENCE EVID-ACCEPTANCE-TESTS source=product\/test\/price\.test\.js lines=7-21 sha256=[a-f0-9]{64}:/);
    assert.deepEqual(engineer.assignment.checks, ['CHECK CHECK-1 argv=["npm","--prefix","product","test"] timeoutMs=60000']);
    assert.equal(engineer.assignment.stopConditions.length, 5);
    assert.deepEqual(engineer.assignment.skills, []);
    assert.equal(engineer.assignment.wave, null);
    assert.equal(engineer.assignment.continueFrom, null);
    assert.equal(engineer.assignment.repair, null);
    assert.equal(engineer.validation.validateDecision.ok, true);
    assert.equal(engineer.validation.checkSpecialistRequest.ok, true);
    assert.equal(verifier.validation.validateDecision.ok, true);
    assert.equal(verifier.validation.checkSpecialistRequest.ok, true);
    assert.deepEqual(result.reviewPlan[0].sequence, ['engineer', 'verifier']);
    assert.deepEqual(result.reviewPlan[0].futureEvidenceDependencies, [{ reviewer: 'verifier', requires: 'integrated_candidate', status: 'not_yet_available' }]);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('risk union retains tags and precedence and creates an auditor only for gated work', () => {
  for (const [tags, kind] of [
    [['risk_change'], 'risk_change'],
    [['performance'], 'performance'],
    [['component_complete'], 'component_complete'],
    [['component_complete', 'performance'], 'performance'],
    [['component_complete', 'performance', 'risk_change'], 'risk_change'],
  ]) {
    const root = copyFixture();
    try {
      rebindContext(root, (context) => {
        context.requirements[0].riskTags = tags;
        context.riskRules.find((rule) => rule.id === 'RISK-product-source').riskTags = tags;
      });
      const files = readJson(root, 'specs/pilot-price/traceability.json');
      files.tasks[0].declaredReviewKind = kind;
      writeJson(root, 'specs/pilot-price/traceability.json', files);
      const result = adapt(root);
      assert.equal(result.ok, true, `${tags}: ${JSON.stringify(result.findings)}`);
      assert.deepEqual(result.proposals.map((entry) => entry.kind), ['engineer', 'verifier', 'auditor']);
      assert.equal(result.reviewPlan[0].kind, kind);
      assert.deepEqual(result.reviewPlan[0].riskTags, tags.slice().sort((a, b) => ['risk_change', 'performance', 'component_complete'].indexOf(a) - ['risk_change', 'performance', 'component_complete'].indexOf(b)));
      const [engineer, verifier, auditor] = result.proposals.map((entry) => entry.assignment);
      assert.deepEqual(engineer.review, verifier.review);
      assert.deepEqual(verifier.review, auditor.review);
      assert.deepEqual(auditor.allowedFiles, []);
      assert.equal(auditor.role, 'auditor');
      assert.deepEqual(auditor.checks, ['Assess planned CHECK CHECK-1; verifier execution evidence is pending.']);
      for (const proposal of result.proposals) {
        assert.equal(proposal.validation.validateDecision.ok, true);
        assert.equal(proposal.validation.checkSpecialistRequest.ok, true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('selected verifier-scope risk and additional tags strengthen the derived review kind', () => {
  const root = copyFixture();
  try {
    rebindContext(root, (context) => {
      context.riskRules.find((rule) => rule.id === 'RISK-verifier-checks').riskTags = ['component_complete'];
    });
    const { map } = load(root);
    map.tasks[0].additionalRiskTags = ['performance'];
    map.tasks[0].declaredReviewKind = 'performance';
    writeJson(root, 'specs/pilot-price/traceability.json', map);
    const result = adapt(root);
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.reviewPlan[0].kind, 'performance');
    assert.deepEqual(result.reviewPlan[0].riskTags, ['performance', 'component_complete']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lowered declared risk and unsafe task scopes block otherwise valid proposals', () => {
  const root = copyFixture();
  try {
    const { map } = load(root);
    map.tasks[0].additionalRiskTags = ['risk_change'];
    writeJson(root, 'specs/pilot-price/traceability.json', map);
    let result = adapt(root);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((entry) => entry.code === 'review_risk_downgrade'));
    assert.equal(result.proposals.some((entry) => entry.kind === 'auditor'), true);

    const root2 = copyFixture();
    try {
      const { map: unsafeMap } = load(root2);
      unsafeMap.tasks[0].writePaths = [{ kind: 'file', path: 'product/test/price.test.js' }];
      writeJson(root2, 'specs/pilot-price/traceability.json', unsafeMap);
      result = adapt(root2);
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((entry) => entry.code === 'write_scope_denied'));
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('oversized source excerpts and malformed checks block without truncation', () => {
  const root = copyFixture();
  try {
    const longSourcePath = path.join(root, 'canonical/GOAL.txt');
    fs.writeFileSync(longSourcePath, `${'x'.repeat(3100)}\n`);
    rebindContext(root, (context) => {
      const source = context.sources.find((entry) => entry.id === 'canonical-goal');
      source.sha256 = digest(fs.readFileSync(longSourcePath));
      context.priorEvidence.find((entry) => entry.id === 'EVID-GOAL').sourceLocation = {
        sourceId: 'canonical-goal', startLine: 1, endLine: 1,
      };
    });
    let result = adapt(root);
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((entry) => entry.code === 'assignment_compile_failed'));
    assert.equal(result.proposals.find((entry) => entry.kind === 'engineer').assignment, null);

    const root2 = copyFixture();
    try {
      const { map } = load(root2);
      map.tasks[0].checkIds = ['CHECK-UNKNOWN'];
      writeJson(root2, 'specs/pilot-price/traceability.json', map);
      result = adapt(root2);
      assert.equal(result.ok, false);
      assert.ok(result.findings.some((entry) => entry.code === 'check_reference_unknown'));
      assert.equal(result.proposals.length, 2);
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('oversized assignment objectives block every role proposal', () => {
  const root = copyFixture();
  try {
    const accepted = readJson(root, 'context/accepted-context.json');
    const { contextResult, map } = load(root);
    map.tasks[0].objective = 'x'.repeat(3001);
    const analysisResult = analyzer.analyzeTaskMap({
      workspaceRoot: root,
      contextResult,
      expectedContextSha256: accepted.contextSha256,
      map,
    });
    const result = adapter.adaptAssignments({
      workspaceRoot: root,
      contextResult,
      expectedContextSha256: accepted.contextSha256,
      map,
      analysisResult,
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((item) => item.code === 'assignment_compile_failed'));
    assert.equal(result.proposals.length, 2);
    assert.equal(result.proposals.every((item) => !item.validation.ok), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every task is compiled and a bad task does not hide a valid sibling', () => {
  const root = copyFixture();
  try {
    const { map } = load(root);
    const second = structuredClone(map.tasks[0]);
    second.id = 'T002';
    second.checkpointId = 'pilot-price-T002';
    second.objective = 'A second bounded implementation task.';
    second.checkIds = ['CHECK-MISSING'];
    map.tasks.push(second);
    setTaskRows(root, map);
    const result = adapt(root);
    assert.equal(result.ok, false);
    assert.equal(result.proposals.length, 4);
    assert.equal(result.proposals.filter((entry) => entry.taskId === 'T001' && entry.validation.ok).length, 2);
    assert.equal(result.proposals.filter((entry) => entry.taskId === 'T002' && !entry.validation.ok).length, 2);
    assert.equal(result.reviewPlan.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter rejects missing structural analysis and malformed tasks as findings', () => {
  const root = copyFixture();
  try {
    const { accepted, contextResult, map } = load(root);
    map.tasks = [null, ...map.tasks];
    const result = adapter.adaptAssignments({
      workspaceRoot: root,
      contextResult,
      expectedContextSha256: accepted.contextSha256,
      map,
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((entry) => entry.code === 'analysis_result_missing'));
    assert.ok(result.findings.some((entry) => entry.code === 'task_shape_invalid'));
    assert.equal(result.implementationAcceptance, 'not_evaluated');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
