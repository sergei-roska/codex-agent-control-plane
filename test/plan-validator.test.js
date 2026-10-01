'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pv = require('../src/plan-validator');

const stage = (stageId, roleId, extra = {}) => ({
  stageId,
  roleId,
  objective: 'do it',
  dependencies: [],
  allowedFiles: ['orch-builder', 'orch-verifier'].includes(roleId) ? ['src/a.js'] : [],
  required: true,
  ...extra,
});
const featurePlan = () => ({
  stages: [
    stage('build', 'orch-builder'),
    stage('verify', 'orch-verifier', { dependencies: ['build'] }),
    stage('audit', 'orch-auditor', { dependencies: ['verify'] }),
  ],
  checkIds: ['unit'],
});
const opts = (extra = {}) => ({ classification: 'feature', projectCheckIds: ['unit'], ...extra });
const msgs = (r) => r.errors.map((e) => `${e.path}: ${e.message}`).join('\n');

test('valid feature plan passes and is normalized', () => {
  const plan = featurePlan();
  plan.stages[0].objective = '  pad  ';
  plan.stages[0].allowedFiles = [' src/a.js '];
  plan.checkIds = [' unit ', 'unit'];
  const r = pv.validatePlan(plan, opts());
  assert.ok(r.ok, msgs(r));
  assert.equal(r.plan.stages[0].objective, 'pad');
  assert.deepEqual(r.plan.stages[0].allowedFiles, ['src/a.js']);
  assert.deepEqual(r.plan.checkIds, ['unit']);
  assert.equal(pv.VALIDATOR_VERSION, 'm3-plan-v1');
});

test('non-object plan and missing stages', () => {
  assert.equal(pv.validatePlan(null, opts()).ok, false);
  assert.equal(pv.validatePlan({ stages: [], checkIds: [] }, opts()).ok, false);
});

test('stage count boundary 12/13', () => {
  const mk = (n) => {
    const stages = [stage('build', 'orch-builder'), stage('verify', 'orch-verifier', { dependencies: ['build'] }), stage('audit', 'orch-auditor', { dependencies: ['build'] })];
    for (let i = stages.length; i < n; i += 1) stages.push(stage(`s${i}`, 'orch-explorer'));
    return { stages, checkIds: ['unit'] };
  };
  assert.ok(pv.validatePlan(mk(12), opts()).ok);
  const r = pv.validatePlan(mk(13), opts());
  assert.equal(r.ok, false);
  assert.match(msgs(r), /1\.\.12 stages/);
});

test('stageId pattern and uniqueness', () => {
  for (const bad of ['Build', 'a_b', '', 'a'.repeat(41)]) {
    const p = featurePlan();
    p.stages[2].stageId = bad;
    assert.equal(pv.validatePlan(p, opts()).ok, false, bad);
  }
  const p = featurePlan();
  p.stages[2].stageId = 'a'.repeat(40);
  assert.ok(pv.validatePlan(p, opts()).ok);
  const d = featurePlan();
  d.stages[2].stageId = 'build';
  assert.match(msgs(pv.validatePlan(d, opts())), /duplicated/);
});

test('dependencies: forward, unknown, self, cyclic rejected', () => {
  const fwd = featurePlan();
  fwd.stages[0].dependencies = ['audit'];
  assert.match(msgs(pv.validatePlan(fwd, opts())), /not declared earlier/);
  const unk = featurePlan();
  unk.stages[1].dependencies = ['ghost'];
  assert.match(msgs(pv.validatePlan(unk, opts())), /unknown dependency/);
  const self = featurePlan();
  self.stages[1].dependencies = ['verify'];
  assert.match(msgs(pv.validatePlan(self, opts())), /itself/);
  const cyc = {
    stages: [stage('a', 'orch-explorer', { dependencies: ['b'] }), stage('b', 'orch-explorer', { dependencies: ['a'] })],
    checkIds: [],
  };
  assert.equal(pv.validatePlan(cyc, { classification: 'audit', projectCheckIds: [] }).ok, false);
});

test('objective bounds', () => {
  const p = featurePlan();
  p.stages[0].objective = '   ';
  assert.equal(pv.validatePlan(p, opts()).ok, false);
  p.stages[0].objective = 'x'.repeat(2000);
  assert.ok(pv.validatePlan(p, opts()).ok);
  p.stages[0].objective = 'x'.repeat(2001);
  assert.equal(pv.validatePlan(p, opts()).ok, false);
});

test('writable stage allowedFiles rules', () => {
  const none = featurePlan();
  none.stages[0].allowedFiles = [];
  assert.match(msgs(pv.validatePlan(none, opts())), /needs 1\.\.20 allowedFiles/);
  const twenty = featurePlan();
  twenty.stages[0].allowedFiles = Array.from({ length: 20 }, (_, i) => `f${i}.js`);
  assert.ok(pv.validatePlan(twenty, opts()).ok);
  twenty.stages[0].allowedFiles.push('f20.js');
  assert.equal(pv.validatePlan(twenty, opts()).ok, false);
  for (const bad of ['../x', '/abs', 'a//b', './a', 'a\\b']) {
    const p = featurePlan();
    p.stages[0].allowedFiles = [bad];
    assert.match(msgs(pv.validatePlan(p, opts())), /unsafe path/, bad);
  }
  const ro = featurePlan();
  ro.stages[2].allowedFiles = ['a.js'];
  assert.match(msgs(pv.validatePlan(ro, opts())), /read-only/);
});

test('roles: repair and unknown roles rejected', () => {
  for (const role of ['orch-repair-xhigh', 'orch-repair-sol', 'orch-lead']) {
    const p = featurePlan();
    p.stages[2].roleId = role;
    assert.equal(pv.validatePlan(p, opts()).ok, false, role);
  }
  const p = featurePlan();
  p.stages[2].roleId = 'orch-repair-sol';
  assert.match(msgs(pv.validatePlan(p, opts())), /repair role/);
});

test('feature/bugfix role requirements', () => {
  for (const classification of ['feature', 'bugfix']) {
    const o = opts({ classification });
    assert.ok(pv.validatePlan(featurePlan(), o).ok);
    const noV = featurePlan();
    noV.stages.splice(1, 1);
    noV.stages[1].dependencies = ['build'];
    assert.match(msgs(pv.validatePlan(noV, o)), /orch-verifier/);
    const noA = featurePlan();
    noA.stages.splice(2, 1);
    assert.match(msgs(pv.validatePlan(noA, o)), /orch-auditor/);
    const noB = featurePlan();
    noB.stages.shift();
    noB.stages.forEach((s) => { s.dependencies = []; });
    assert.match(msgs(pv.validatePlan(noB, o)), /orch-builder/);
    const optionalV = featurePlan();
    optionalV.stages[1].required = false;
    assert.match(msgs(pv.validatePlan(optionalV, o)), /orch-verifier/);
  }
});

test('auditor/verifier must depend on builder, transitively allowed', () => {
  const o = opts();
  const indep = featurePlan();
  indep.stages[2].dependencies = [];
  assert.match(msgs(pv.validatePlan(indep, o)), /orch-auditor stage must depend/);
  const indepV = featurePlan();
  indepV.stages[1].dependencies = [];
  indepV.stages[2].dependencies = ['build'];
  assert.match(msgs(pv.validatePlan(indepV, o)), /orch-verifier stage must depend/);
  const transitive = featurePlan();
  transitive.stages[2].dependencies = ['verify'];
  assert.ok(pv.validatePlan(transitive, o).ok);
  const viaExplorer = {
    stages: [stage('build', 'orch-builder'), stage('x', 'orch-explorer', { dependencies: ['build'] }),
      stage('verify', 'orch-verifier', { dependencies: ['x'] }), stage('audit', 'orch-auditor', { dependencies: ['x'] })],
    checkIds: ['unit'],
  };
  assert.ok(pv.validatePlan(viaExplorer, o).ok);
});

test('docs and audit classifications', () => {
  const docs = { stages: [stage('w', 'orch-builder'), stage('r', 'orch-auditor')], checkIds: ['unit'] };
  assert.ok(pv.validatePlan(docs, { classification: 'docs', projectCheckIds: ['unit'] }).ok);
  docs.stages.pop();
  assert.match(msgs(pv.validatePlan(docs, { classification: 'docs', projectCheckIds: ['unit'] })), /orch-auditor/);
  const audit = { stages: [stage('r', 'orch-auditor')], checkIds: [] };
  assert.ok(pv.validatePlan(audit, { classification: 'audit', projectCheckIds: [] }).ok);
  audit.stages.unshift(stage('w', 'orch-builder'));
  assert.match(msgs(pv.validatePlan(audit, { classification: 'audit', projectCheckIds: [] })), /read-only/);
  const noAud = { stages: [stage('e', 'orch-explorer')], checkIds: [] };
  assert.match(msgs(pv.validatePlan(noAud, { classification: 'audit', projectCheckIds: [] })), /orch-auditor/);
  assert.equal(pv.validatePlan(featurePlan(), { classification: 'nope', projectCheckIds: ['unit'] }).ok, false);
});

test('checkIds rules', () => {
  const unknown = featurePlan();
  unknown.checkIds = ['unit', 'ghost'];
  assert.match(msgs(pv.validatePlan(unknown, opts())), /unknown checkId "ghost"/);
  const empty = featurePlan();
  empty.checkIds = [];
  assert.match(msgs(pv.validatePlan(empty, opts())), /at least one checkId/);
  const none = pv.validatePlan(featurePlan(), opts({ projectCheckIds: [] }));
  assert.equal(none.ok, false);
  assert.match(msgs(none), /no approved acceptance checks configured/);
});

test('nextEligibleStages', () => {
  const { plan } = pv.validatePlan(featurePlan(), opts());
  assert.deepEqual(pv.nextEligibleStages(plan, {}).map((s) => s.stageId), ['build']);
  assert.deepEqual(pv.nextEligibleStages(plan, { build: 'succeeded' }).map((s) => s.stageId), ['verify']);
  assert.deepEqual(pv.nextEligibleStages(plan, new Map([['build', 'failed']])).map((s) => s.stageId), ['build']);
  assert.deepEqual(pv.nextEligibleStages(plan, { build: 'succeeded', verify: 'succeeded', audit: 'succeeded' }), []);
});

test('isStageRole', () => {
  const builder = stage('build', 'orch-builder');
  assert.ok(pv.isStageRole(builder, 'orch-builder', new Set()));
  assert.equal(pv.isStageRole(builder, 'orch-repair-xhigh', new Set()), false);
  assert.ok(pv.isStageRole(builder, 'orch-repair-xhigh', new Set(['orch-builder'])));
  assert.ok(pv.isStageRole(builder, 'orch-repair-sol', new Set(['orch-builder', 'orch-repair-xhigh'])));
  const verifier = stage('v', 'orch-verifier');
  assert.equal(pv.isStageRole(verifier, 'orch-repair-xhigh', new Set(['orch-verifier'])), false);
  assert.equal(pv.isStageRole(builder, 'orch-auditor', new Set(['orch-builder'])), false);
  assert.equal(pv.isStageRole(undefined, 'orch-builder'), false);
});

test('requiredStagesSucceeded ignores optional stages', () => {
  const plan = { stages: [stage('a', 'orch-builder'), stage('b', 'orch-explorer', { required: false })], checkIds: [] };
  assert.equal(pv.requiredStagesSucceeded(plan, {}), false);
  assert.ok(pv.requiredStagesSucceeded(plan, { a: 'succeeded' }));
  assert.equal(pv.requiredStagesSucceeded(plan, { a: 'failed' }), false);
});

test('role constants', () => {
  assert.deepEqual([...pv.WRITABLE_STAGE_ROLES], ['orch-builder', 'orch-verifier']);
  assert.equal(pv.STAGE_ROLES.length, 6);
  for (const r of pv.REPAIR_ROLES) assert.ok(!pv.STAGE_ROLES.includes(r));
});

test('docs plans need at least one check id', () => {
  const docs = () => ({ stages: [stage('w', 'orch-builder'), stage('r', 'orch-auditor')], checkIds: ['unit'] });
  assert.ok(pv.validatePlan(docs(), { classification: 'docs', projectCheckIds: ['unit'] }).ok);
  const empty = docs();
  empty.checkIds = [];
  assert.match(msgs(pv.validatePlan(empty, { classification: 'docs', projectCheckIds: ['unit'] })), /at least one checkId/);
  assert.match(msgs(pv.validatePlan(empty, { classification: 'docs', projectCheckIds: [] })), /no approved acceptance checks configured/);
});

test('protected allowedFiles are rejected', () => {
  const bad = ['.git/config', 'a/.GIT/hooks/x', '.codex/config.toml', 'src/.Claude/x.md', '.claude', 'AGENTS.md', 'docs/agents.MD', 'sub/Claude.md'];
  for (const file of bad) {
    const plan = featurePlan();
    plan.stages[0].allowedFiles = [file];
    const r = pv.validatePlan(plan, opts());
    assert.equal(r.ok, false, file);
    assert.match(msgs(r), /protected path/, file);
  }
  for (const file of ['src/git/a.js', 'docs/AGENTS.md.txt', '.github/ci.yml', 'CLAUDE.md.bak']) {
    const plan = featurePlan();
    plan.stages[0].allowedFiles = [file];
    assert.ok(pv.validatePlan(plan, opts()).ok, file);
  }
});

// ---- M4 preset fixtures (shape of loadRolePack output) ----
const FX_ROLES = [
  ['architect', 'dlv-architect', 'Architect', 'read-only', 'Scoped technical plan.'],
  ['developer', 'dlv-developer', 'Developer', 'workspace-write', 'Bounded implementation within allowedFiles.'],
  ['qa', 'dlv-qa', 'QA', 'workspace-write', 'Executes checks and reports failures.'],
  ['reviewer', 'dlv-reviewer', 'Reviewer', 'read-only', 'Reviews the delta against the contract.'],
  ['security', 'dlv-security', 'Security', 'read-only', 'Flags unsafe access boundaries.'],
  ['performance', 'dlv-performance', 'Performance', 'workspace-write', 'Measures and labels hypotheses.'],
  ['devops', 'dlv-devops', 'DevOps', 'workspace-write', 'Environment and pipeline setup.'],
  ['tech-writer', 'dlv-tech-writer', 'Technical Writer', 'workspace-write', 'Verifies documentation examples.'],
];
const fxPack = () => ({
  packId: 'delivery',
  version: '1.0.0',
  coordinator: { publicId: 'project-manager', runtimeId: 'dlv-project-manager', displayName: 'Project Manager' },
  roles: FX_ROLES.map(([publicId, runtimeId, displayName, sandbox, description]) => ({ publicId, runtimeId, displayName, role: { name: runtimeId, sandbox, description } })),
  repairChains: { 'dlv-developer': ['dlv-developer-xhigh', 'dlv-developer-sol'] },
  presets: new Map(),
  unavailablePresets: ['security', 'performance', 'environment', 'debt'],
  publicToRuntime: new Map(FX_ROLES.map((r) => [r[0], r[1]])),
  runtimeToPublic: new Map(FX_ROLES.map((r) => [r[1], r[0]])),
});
const fxStage = (key, roles, dependsOn = []) => ({ key, roles, required: true, dependsOn, purpose: key });
const fxPresets = () => new Map([
  ['feature', { presetId: 'feature', version: '1.0.0', classification: 'feature', description: 'f', stages: [fxStage('design', ['architect']), fxStage('implement', ['developer'], ['design']), fxStage('review', ['reviewer'], ['implement']), fxStage('qa', ['qa'], ['implement'])], optionalRoles: ['security', 'performance', 'devops', 'tech-writer'], optionalDependsOn: ['implement'], minChecks: 1 }],
  ['bugfix', { presetId: 'bugfix', version: '1.0.0', classification: 'bugfix', description: 'b', stages: [fxStage('reproduce', ['qa']), fxStage('implement', ['developer'], ['reproduce']), fxStage('review', ['reviewer'], ['implement']), fxStage('verify', ['qa'], ['implement'])], optionalRoles: ['architect', 'security', 'performance'], optionalDependsOn: ['implement'], minChecks: 1 }],
  ['docs', { presetId: 'docs', version: '1.0.0', classification: 'docs', description: 'd', stages: [fxStage('write', ['tech-writer']), fxStage('review', ['reviewer'], ['write'])], optionalRoles: ['qa', 'architect'], optionalDependsOn: ['write'], minChecks: 1 }],
  ['audit', { presetId: 'audit', version: '1.0.0', classification: 'audit', description: 'a', stages: [fxStage('investigate', ['architect', 'security', 'performance', 'reviewer']), fxStage('synthesis', ['reviewer'], ['investigate'])], optionalRoles: ['security', 'performance', 'architect'], optionalDependsOn: ['investigate'], minChecks: 0 }],
]);
const WRITABLE_PUBLIC = ['developer', 'qa', 'performance', 'devops', 'tech-writer'];
const pst = (stageId, key, roleId, dependencies = [], extra = {}) => ({
  stageId, presetStageKey: key, roleId, objective: 'do it', dependencies,
  allowedFiles: WRITABLE_PUBLIC.includes(roleId) ? ['src/a.js'] : [], required: key !== null, ...extra,
});
const presetPlans = () => ({
  feature: { presetId: 'feature', checkIds: ['unit'], stages: [pst('design', 'design', 'architect'), pst('impl', 'implement', 'developer', ['design']), pst('rev', 'review', 'reviewer', ['impl']), pst('qa', 'qa', 'qa', ['impl'])] },
  bugfix: { presetId: 'bugfix', checkIds: ['unit'], stages: [pst('repro', 'reproduce', 'qa'), pst('impl', 'implement', 'developer', ['repro']), pst('rev', 'review', 'reviewer', ['impl']), pst('ver', 'verify', 'qa', ['impl'])] },
  docs: { presetId: 'docs', checkIds: ['unit'], stages: [pst('write', 'write', 'tech-writer'), pst('rev', 'review', 'reviewer', ['write'])] },
  audit: { presetId: 'audit', checkIds: [], stages: [pst('inv', 'investigate', 'architect'), pst('syn', 'synthesis', 'reviewer', ['inv'])] },
});

const preset = (id) => fxPresets().get(id);
const runPreset = (plan, id = plan.presetId, extra = {}) => pv.validatePresetPlan(plan, { pack: fxPack(), preset: preset(id), projectCheckIds: ['unit'], ...extra });
const messages = (result) => result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');

for (const id of ['feature', 'bugfix', 'docs', 'audit']) {
  test(`preset ${id} happy path`, () => {
    const result = runPreset(presetPlans()[id]);
    assert.equal(result.ok, true, messages(result));
    assert.equal(result.plan.presetId, id);
    assert.equal(result.plan.presetVersion, '1.0.0');
    assert.equal(result.plan.rolePack, 'delivery');
    assert.equal(result.plan.rolePackVersion, '1.0.0');
    assert.equal(result.plan.validatorVersion, 'm4-plan-v1');
  });
}

test('preset plan maps public role ids to runtime ids and keeps both', () => {
  const result = runPreset(presetPlans().feature);
  const impl = result.plan.stages.find((s) => s.stageId === 'impl');
  assert.equal(impl.publicRoleId, 'developer');
  assert.equal(impl.roleId, 'dlv-developer');
  assert.equal(impl.presetStageKey, 'implement');
  assert.equal(result.plan.stages.find((s) => s.stageId === 'rev').roleId, 'dlv-reviewer');
});

test('preset plan rejects a missing required stage', () => {
  const plan = presetPlans().feature;
  plan.stages = plan.stages.filter((s) => s.presetStageKey !== 'qa');
  const result = runPreset(plan);
  assert.equal(result.ok, false);
  assert.match(messages(result), /missing required preset stage "qa"/);
});

test('preset plan rejects a duplicated required stage', () => {
  const plan = presetPlans().feature;
  plan.stages.push(pst('qa2', 'qa', 'qa', ['impl']));
  const result = runPreset(plan);
  assert.equal(result.ok, false);
  assert.match(messages(result), /"qa" appears 2 times/);
});

test('preset plan rejects the wrong role for a preset stage', () => {
  const plan = presetPlans().feature;
  plan.stages[1] = pst('impl', 'implement', 'qa', ['design']);
  const result = runPreset(plan);
  assert.equal(result.ok, false);
  assert.match(messages(result), /needs one of developer/);
});

test('preset plan rejects unknown role ids, including runtime ids and the coordinator', () => {
  for (const bad of ['dlv-developer', 'project-manager', 'orch-builder']) {
    const plan = presetPlans().feature;
    plan.stages[1] = pst('impl', 'implement', bad, ['design'], { allowedFiles: ['src/a.js'] });
    assert.equal(runPreset(plan).ok, false, bad);
  }
});

test('audit investigate accepts each of its four role options', () => {
  for (const role of ['architect', 'security', 'performance', 'reviewer']) {
    const plan = presetPlans().audit;
    plan.stages[0] = pst('inv', 'investigate', role);
    const result = runPreset(plan);
    if (role === 'performance') {
      // performance is writable in the fixture pack, so the audit read-only rule applies
      assert.equal(result.ok, false);
      assert.match(messages(result), /audit plan must be read-only/);
    } else {
      assert.equal(result.ok, true, `${role}: ${messages(result)}`);
    }
  }
});

test('audit investigate with a read-only performance role is accepted', () => {
  const pack = fxPack();
  pack.roles.find((r) => r.publicId === 'performance').role.sandbox = 'read-only';
  const plan = presetPlans().audit;
  plan.stages[0] = pst('inv', 'investigate', 'performance', [], { allowedFiles: [] });
  const result = pv.validatePresetPlan(plan, { pack, preset: preset('audit'), projectCheckIds: [] });
  assert.equal(result.ok, true, messages(result));
});

test('optional stage happy path and its rules', () => {
  const plan = presetPlans().feature;
  plan.stages.push(pst('sec', null, 'security', ['impl']));
  assert.equal(runPreset(plan).ok, true);
  const notListed = presetPlans().docs;
  notListed.stages.push(pst('sec', null, 'security', ['write']));
  const r1 = runPreset(notListed);
  assert.equal(r1.ok, false);
  assert.match(messages(r1), /not an optional role/);
  const noDep = presetPlans().feature;
  noDep.stages.push(pst('perf', null, 'performance', ['design']));
  const r2 = runPreset(noDep);
  assert.equal(r2.ok, false);
  assert.match(messages(r2), /must depend on preset stage "implement"/);
});

test('optional stage may carry extra dependencies', () => {
  const plan = presetPlans().feature;
  plan.stages.push(pst('sec', null, 'security', ['impl', 'design']));
  assert.equal(runPreset(plan).ok, true);
});

test('required stage must include its preset dependencies', () => {
  const plan = presetPlans().feature;
  plan.stages[3] = pst('qa', 'qa', 'qa', ['design']);
  const result = runPreset(plan);
  assert.equal(result.ok, false);
  assert.match(messages(result), /must depend on preset stage "implement"/);
});

test('audit rejects a writable role', () => {
  const plan = presetPlans().audit;
  plan.stages.push(pst('perf', null, 'performance', ['inv']));
  const result = runPreset(plan);
  assert.equal(result.ok, false);
  assert.match(messages(result), /audit plan must be read-only/);
});

test('read-only roles never get allowedFiles; writable roles need 1..20', () => {
  const ro = presetPlans().feature;
  ro.stages[0].allowedFiles = ['src/a.js'];
  const r1 = runPreset(ro);
  assert.equal(r1.ok, false);
  assert.match(messages(r1), /read-only and must have no allowedFiles/);
  const empty = presetPlans().feature;
  empty.stages[1].allowedFiles = [];
  assert.match(messages(runPreset(empty)), /needs 1\.\.20 allowedFiles/);
  const protectedPath = presetPlans().feature;
  protectedPath.stages[1].allowedFiles = ['.codex/config.toml'];
  assert.match(messages(runPreset(protectedPath)), /protected path/);
});

test('minChecks: docs needs 1, audit needs 0', () => {
  const docs = presetPlans().docs;
  docs.checkIds = [];
  const r1 = runPreset(docs);
  assert.equal(r1.ok, false);
  assert.match(messages(r1), /at least 1 checkId/);
  const noneConfigured = runPreset(presetPlans().docs, 'docs', { projectCheckIds: [] });
  assert.match(messages(noneConfigured), /no approved acceptance checks configured/);
  const audit = runPreset(presetPlans().audit, 'audit', { projectCheckIds: [] });
  assert.equal(audit.ok, true, messages(audit));
  const unknown = presetPlans().docs;
  unknown.checkIds = ['nope'];
  assert.match(messages(runPreset(unknown)), /unknown checkId/);
});

test('presetId must equal the preset id (classification mismatch)', () => {
  const plan = presetPlans().feature;
  plan.presetId = 'bugfix';
  const result = runPreset(plan, 'feature');
  assert.equal(result.ok, false);
  assert.match(messages(result), /presetId must be "feature"/);
});

test('preset plan keeps stage-count, cycle and shape rules', () => {
  const plan = presetPlans().feature;
  plan.stages[0].dependencies = ['rev'];
  assert.match(messages(runPreset(plan)), /forward reference or cycle/);
  const many = presetPlans().feature;
  for (let i = 0; i < 9; i += 1) many.stages.push(pst(`o${i}`, null, 'security', ['impl']));
  assert.match(messages(runPreset(many)), /1\.\.12 stages/);
  assert.equal(runPreset('x', 'feature').ok, false);
});

test('stageRoleMatches follows pack repair chain order', () => {
  const pack = fxPack();
  const devStage = { roleId: 'dlv-developer' };
  assert.equal(pv.stageRoleMatches(devStage, 'dlv-developer', new Set(), pack), true);
  assert.equal(pv.stageRoleMatches(devStage, 'dlv-developer-xhigh', new Set(), pack), false);
  assert.equal(pv.stageRoleMatches(devStage, 'dlv-developer-xhigh', new Set(['dlv-developer']), pack), true);
  assert.equal(pv.stageRoleMatches(devStage, 'dlv-developer-sol', new Set(['dlv-developer']), pack), false);
  assert.equal(pv.stageRoleMatches(devStage, 'dlv-developer-sol', ['dlv-developer', 'dlv-developer-xhigh'], pack), true);
  assert.equal(pv.stageRoleMatches({ roleId: 'dlv-qa' }, 'dlv-developer-xhigh', new Set(['dlv-qa']), pack), false);
  assert.equal(pv.stageRoleMatches({ roleId: 'dlv-reviewer' }, 'dlv-developer', new Set(['x']), pack), false);
});

test('legacy validatePlan and isStageRole are unchanged', () => {
  assert.equal(pv.VALIDATOR_VERSION, 'm3-plan-v1');
  const result = pv.validatePlan(featurePlan(), { classification: 'feature', projectCheckIds: ['unit'] });
  assert.equal(result.ok, true);
  assert.equal(result.plan.validatorVersion, undefined);
  assert.equal(result.plan.stages[0].publicRoleId, undefined);
  assert.equal(pv.isStageRole({ roleId: 'orch-builder' }, 'orch-repair-sol', new Set(['orch-builder'])), true);
  assert.equal(pv.isStageRole({ roleId: 'orch-builder' }, 'orch-repair-sol', new Set()), false);
});

test('validatePresetPlan accepts a V2 plan against the real loaded role pack', () => {
  const { loadRolePack } = require('../src/role-pack');
  const pack = loadRolePack({ packDir: 'profiles/delivery' });
  const result = pv.validatePresetPlan(presetPlans().feature, { pack, preset: pack.presets.get('feature'), projectCheckIds: ['unit'] });
  assert.equal(result.ok, true, messages(result));
  const impl = result.plan.stages.find((s) => s.stageId === 'impl');
  assert.equal(impl.publicRoleId, 'developer');
  assert.equal(impl.roleId, 'dlv-developer');
});
