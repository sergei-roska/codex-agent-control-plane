'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const contextApi = require('../src/spec-context');
const analyzer = require('../src/spec-analyzer');
const FIXTURE = path.join(__dirname, 'fixtures/spec-kit/pilot-price');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-analyzer-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function loadContext(root) {
  const accepted = JSON.parse(fs.readFileSync(path.join(root, 'context/accepted-context.json'), 'utf8'));
  return contextApi.loadContext({
    workspaceRoot: root,
    contextPath: accepted.contextPath,
    expectedSha256: accepted.contextSha256,
  });
}

function loadMap(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'specs/pilot-price/traceability.json'), 'utf8'));
}

function taskFrom(base, id, { dependsOn = [], parallel = false, writePaths = base.writePaths, checkIds = base.checkIds, requirementIds = base.requirementIds, acceptanceIds = base.acceptanceIds } = {}) {
  return {
    ...structuredClone(base),
    id,
    objective: `Task ${id} objective.`,
    requirementIds: [...requirementIds],
    acceptanceIds: [...acceptanceIds],
    dependsOn: [...dependsOn],
    parallel,
    writePaths: structuredClone(writePaths),
    checkIds: [...checkIds],
    checkpointId: `pilot-price-${id}`,
  };
}

function syncTaskArtifact(root, map, { outsideRows = [], prefix = '', suffix = '' } = {}) {
  const rows = map.tasks.map((task) => `- [ ] ${task.id}${task.parallel ? ' [P]' : ''} ${task.objective}`);
  const text = `${prefix}\n<!-- harness-task-map:v1 begin -->\n${rows.join('\n')}\n<!-- harness-task-map:v1 end -->\n${outsideRows.join('\n')}\n${suffix}\n`;
  const tasksPath = path.join(root, 'specs/pilot-price/tasks.md');
  fs.writeFileSync(tasksPath, text);
  map.artifactBindings.find((binding) => binding.role === 'tasks').sha256 = digest(fs.readFileSync(tasksPath));
  return text;
}

function analyze(root, map = loadMap(root)) {
  const contextResult = loadContext(root);
  const accepted = JSON.parse(fs.readFileSync(path.join(root, 'context/accepted-context.json'), 'utf8'));
  return analyzer.analyzeTaskMap({
    workspaceRoot: root,
    contextResult,
    expectedContextSha256: accepted.contextSha256,
    map,
  });
}

function codes(result) {
  return new Set(result.findings.map((item) => item.code));
}

test('accepted F2 map analyzes deterministically with stable order and checkbox state', () => {
  const root = copyFixture();
  try {
    const first = analyze(root);
    const second = analyze(root);
    assert.equal(first.ok, true, JSON.stringify(first.findings));
    assert.deepEqual(first.graph.taskOrder, ['T001']);
    assert.deepEqual(first.projection.taskStates, [{ id: 'T001', checked: false, parallel: false, line: 6 }]);
    assert.equal(first.assignmentValidation, 'pending');
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DAG order is stable, cycle witnesses are stable, and dangling edges block graph analysis', () => {
  const root = copyFixture();
  try {
    const map = loadMap(root);
    const base = map.tasks[0];
    map.tasks = [
      taskFrom(base, 'T003', { dependsOn: ['T001'] }),
      taskFrom(base, 'T002'),
      taskFrom(base, 'T001'),
    ];
    syncTaskArtifact(root, map);
    let result = analyze(root, map);
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.graph.taskOrder, ['T001', 'T002', 'T003']);

    map.tasks[0].dependsOn = ['T001'];
    map.tasks[1].dependsOn = ['T003'];
    map.tasks[2].dependsOn = ['T002'];
    syncTaskArtifact(root, map);
    result = analyze(root, map);
    assert.equal(result.graph.taskOrder, null);
    assert.deepEqual(result.graph.cycles, [{ taskIds: ['T001', 'T002', 'T003'], witness: ['T001', 'T002', 'T003', 'T001'] }]);
    assert.ok(codes(result).has('dependency_cycle'));

    map.tasks[0].dependsOn = [];
    map.tasks[1].dependsOn = [];
    map.tasks[2].dependsOn = ['T001'];
    syncTaskArtifact(root, map);
    result = analyze(root, map);
    assert.deepEqual(result.graph.cycles, [{ taskIds: ['T001'], witness: ['T001', 'T001'] }]);

    map.tasks[0].dependsOn = ['T999'];
    syncTaskArtifact(root, map);
    result = analyze(root, map);
    assert.ok(codes(result).has('dependency_reference_unknown'));
    assert.ok(codes(result).has('graph_skipped_invalid_references'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parallel conflicts include transitive dependencies and parent-child writes', () => {
  const root = copyFixture();
  try {
    const map = loadMap(root);
    const base = map.tasks[0];
    map.tasks = [
      taskFrom(base, 'T001', { parallel: true, writePaths: [{ kind: 'file', path: 'product/src/price.js' }] }),
      taskFrom(base, 'T002', { parallel: true, writePaths: [{ kind: 'directory', path: 'verification/checks' }] }),
    ];
    syncTaskArtifact(root, map);
    let result = analyze(root, map);
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.deepEqual(result.graph.parallelConflicts, []);

    map.tasks = [
      taskFrom(base, 'T001', { dependsOn: ['T002'], parallel: true, writePaths: [{ kind: 'file', path: 'product/src/price.js' }] }),
      taskFrom(base, 'T002', { dependsOn: ['T003'], writePaths: [{ kind: 'file', path: 'product/src/price.js' }] }),
      taskFrom(base, 'T003', { parallel: true, writePaths: [{ kind: 'directory', path: 'verification/checks' }] }),
    ];
    syncTaskArtifact(root, map);
    result = analyze(root, map);
    assert.ok(codes(result).has('parallel_dependency_conflict'));

    map.tasks[0].dependsOn = [];
    map.tasks[0].writePaths = [{ kind: 'directory', path: 'verification/checks' }];
    map.tasks[2].writePaths = [{ kind: 'file', path: 'verification/checks/result.json' }];
    syncTaskArtifact(root, map);
    result = analyze(root, map);
    assert.ok(codes(result).has('parallel_write_conflict'));
    assert.deepEqual(result.graph.parallelConflicts.map((item) => item.taskIds), [['T001', 'T003']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('base map findings cover requirement, acceptance, evidence, check, and decision defects', () => {
  const root = copyFixture();
  try {
    const map = loadMap(root);
    const base = map.tasks[0];
    const cases = [
      ['mandatory_requirement_unassigned', (task) => { task.requirementIds = ['REQ-2', 'REQ-3', 'REQ-4']; }],
      ['mandatory_acceptance_unassigned', (task) => { task.acceptanceIds = []; }],
      ['array_bounds', (task) => { task.requirementIds = []; }],
      ['requirement_reference_unknown', (task) => { task.requirementIds = ['REQ-MISSING']; }],
      ['acceptance_reference_unknown', (task) => { task.acceptanceIds = ['AC-MISSING']; }],
      ['check_reference_unknown', (task) => { task.checkIds = ['CHECK-MISSING']; }],
      ['dependency_reference_unknown', (task) => { task.dependsOn = ['T999']; }],
      ['evidence_reference_unknown', (task) => { task.priorEvidenceIds = ['E-MISSING']; }],
      ['array_bounds', (task) => { task.priorEvidenceIds = []; }],
      ['required_check_unassigned', (task) => { task.checkIds = []; }],
      ['review_kind_mismatch', (task) => { task.declaredReviewKind = 'risk_change'; }],
      ['path_unsafe', (task) => { task.writePaths = [{ kind: 'file', path: '../escape' }]; }],
      ['write_scope_denied', (task) => { task.writePaths = [{ kind: 'file', path: 'product/test/price.test.js' }]; }],
      ['write_scope_denied', (task) => { task.writePaths = [{ kind: 'directory', path: 'product' }]; }],
      ['write_scope_denied', (task) => { task.writePaths = [{ kind: 'file', path: 'product/src2/new.js' }]; }],
      ['risk_rule_missing', (task) => { task.writePaths = [{ kind: 'file', path: 'product/src/new.js' }]; }],
      ['artifact_digest_mismatch', (_task, target) => { target.artifactBindings.find((binding) => binding.role === 'spec').sha256 = '0'.repeat(64); }],
    ];
    for (const [expectedCode, mutate] of cases) {
      const target = structuredClone(map);
      mutate(target.tasks[0], target);
      const result = analyze(root, target);
      assert.ok(codes(result).has(expectedCode), `${expectedCode}: ${JSON.stringify(result.findings)}`);
    }
    const duplicate = structuredClone(map);
    duplicate.tasks.push(structuredClone(duplicate.tasks[0]));
    assert.ok(codes(analyze(root, duplicate)).has('duplicate_task_id'));

    const contextResult = loadContext(root);
    contextResult.context.acceptanceCriteria[0].requirementIds = ['REQ-1'];
    const mismatchedMap = structuredClone(map);
    mismatchedMap.tasks[0].requirementIds = ['REQ-2'];
    const accepted = JSON.parse(fs.readFileSync(path.join(root, 'context/accepted-context.json'), 'utf8'));
    const mismatchResult = analyzer.analyzeTaskMap({ workspaceRoot: root, contextResult, expectedContextSha256: accepted.contextSha256, map: mismatchedMap });
    assert.ok(codes(mismatchResult).has('acceptance_requirement_mismatch'));

    const decisionContextValue = structuredClone(loadContext(root).context);
    decisionContextValue.decisions.push({
      id: 'D-UNRESOLVED', status: 'unresolved', affectedRequirementIds: ['REQ-1'],
      sourceLocation: { sourceId: 'mandatory-inventory', startLine: 9, endLine: 10 },
      rationale: 'Synthetic unresolved decision.', resolution: null,
    });
    const syntheticContextBytes = Buffer.from(`${JSON.stringify(decisionContextValue, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'context/synthetic-context.json'), syntheticContextBytes);
    const syntheticContextSha256 = digest(syntheticContextBytes);
    const decisionContext = contextApi.loadContext({
      workspaceRoot: root,
      contextPath: 'context/synthetic-context.json',
      expectedSha256: syntheticContextSha256,
    });
    assert.equal(decisionContext.ok, true, JSON.stringify(decisionContext.errors));
    const decisionMap = structuredClone(map);
    decisionMap.contextSha256 = syntheticContextSha256;
    const decisionResult = analyzer.analyzeTaskMap({
      workspaceRoot: root,
      contextResult: decisionContext,
      expectedContextSha256: syntheticContextSha256,
      map: decisionMap,
    });
    assert.ok(codes(decisionResult).has('decision_unresolved'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projection requires exact inventory, markers, and parallel annotations', () => {
  const root = copyFixture();
  try {
    const map = loadMap(root);
    let text = syncTaskArtifact(root, map, { outsideRows: ['- [ ] T999 Outside task.'] });
    let result = analyze(root, map);
    assert.ok(codes(result).has('projection_task_outside_block'));

    map.tasks[0].parallel = true;
    text = syncTaskArtifact(root, map);
    result = analyze(root, map);
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    assert.equal(result.projection.taskStates[0].parallel, true);

    const annotationMismatch = text.replace('- [ ] T001 [P]', '- [ ] T001');
    assert.ok(analyzer.analyzeProjection(annotationMismatch, map).findings.some((item) => item.code === 'projection_parallel_mismatch'));

    const duplicateText = text.replace('<!-- harness-task-map:v1 end -->', '- [ ] T001 Duplicate.\n<!-- harness-task-map:v1 end -->');
    const projection = analyzer.analyzeProjection(duplicateText, map);
    assert.ok(projection.findings.some((item) => item.code === 'projection_task_duplicate'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Markdown scanner ignores fenced/comment examples but rejects malformed hiding constructs', () => {
  const valid = [
    '```md',
    '- [ ] T900 Fenced example.',
    '<!-- harness-task-map:v1 begin -->',
    '```',
    '<!-- - [ ] T901 Commented example. -->',
    '<!-- docs mention harness-task-map:v1 as literal prose -->',
    '<!-- harness-task-map:v1 begin -->',
    '- [ ] T001 Real task.',
    '<!-- harness-task-map:v1 end -->',
  ].join('\n');
  const scan = analyzer.scanTasksMarkdown(valid);
  assert.deepEqual(scan.rows.map((row) => row.id), ['T001']);
  assert.deepEqual(scan.markers.map((marker) => marker.kind), ['begin', 'end']);
  const checked = analyzer.scanTasksMarkdown('<!-- harness-task-map:v1 begin -->\n- [X] T002 Checked task.\n<!-- harness-task-map:v1 end -->');
  assert.equal(checked.rows[0].checked, true);

  for (const [text, code] of [
    ['<!-- harness-task-map:v1 begin\n- [ ] T001 Hidden.', 'projection_comment_unclosed'],
    ['```md\n- [ ] T001 Hidden.', 'projection_fence_unclosed'],
    ['<!-- harness-task-map:v1 start -->', 'projection_marker_malformed'],
    ['<!-- harness-task-map:v1 end -->', 'projection_markers_invalid'],
  ]) {
    const projection = analyzer.analyzeProjection(text, { tasks: [] });
    assert.ok(projection.findings.some((item) => item.code === code), `${code}: ${JSON.stringify(projection.findings)}`);
  }
  const emptyText = analyzer.analyzeProjection('<!-- harness-task-map:v1 begin -->\n- [ ] T001\n<!-- harness-task-map:v1 end -->', {
    tasks: [{ id: 'T001', parallel: false }],
  });
  assert.ok(emptyText.findings.some((item) => item.code === 'projection_task_text_empty'));
});

test('null and malformed map inputs remain nonthrowing and finding bounds are explicit', () => {
  const malformed = analyzer.analyzeTaskMap({ map: null });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.findings.length > 0);

  const root = copyFixture();
  try {
    const map = loadMap(root);
    const duplicateRows = Array.from({ length: 1200 }, () => '- [ ] T999 Duplicate unknown task.');
    syncTaskArtifact(root, map, { outsideRows: duplicateRows });
    const result = analyze(root, map);
    assert.ok(result.findings.length <= analyzer.MAX_FINDINGS);
    assert.ok(codes(result).has('finding_limit_exceeded'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
