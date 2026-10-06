'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const intake = require('../src/intake');
const { loadProjectConfig } = require('../src/project-config');
const { loadRolePack } = require('../src/role-pack');

const pack = loadRolePack({ packDir: path.resolve(__dirname, '..', 'profiles', 'delivery') });
const base = { baseRef: 'main', checks: [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 1, description: 'Unit tests' }] };
const revision = { title: 'T', description: 'D', criteria: [] };
const promptFor = (projectConfig) => intake.buildIntakePrompt({ revision, projectConfig, pack, presets: pack.presets })
  .replace(/UNTRUSTED-[0-9a-f]{16}/g, 'UNTRUSTED-X');

const stage = (stageId, key, roleId, dependencies = [], allowedFiles = []) => ({
  stageId, presetStageKey: key, roleId, objective: 'do it', dependencies, allowedFiles, required: true,
});
const bugfixPlan = (extra = {}, files = ['src/a.js'], checkIds = ['unit']) => ({
  presetId: 'bugfix',
  checkIds,
  stages: [
    stage('repro', 'reproduce', 'qa', [], ['test/a.test.js']),
    stage('impl', 'implement', 'developer', ['repro'], files),
    stage('rev', 'review', 'reviewer', ['impl']),
    stage('ver', 'verify', 'qa', ['impl'], ['test/a.test.js']),
  ],
  ...extra,
});
const output = (plan, classification = 'bugfix') => ({
  readiness: 'ready', classification, requirements: { summary: 's', scope: [], outOfScope: [], unknowns: [], expectedOutcomes: [] },
  questions: [], unsupportedReason: null, plan,
});
const validate = (plan, policy, classification) => intake.validateIntakeOutput(output(plan, classification), {
  projectConfig: { ...base, ...policy }, pack, presets: pack.presets,
});

test('real bugfix preset carries the lean block at 1.1.0', () => {
  const preset = pack.presets.get('bugfix');
  assert.equal(preset.version, '1.1.0');
  assert.deepEqual(preset.lean.skip, ['reproduce']);
  assert.deepEqual(preset.lean.conditional, ['review']);
  assert.match(preset.lean.purposeOverrides.implement, /BEFORE changing anything record executed baseline evidence/);
  assert.equal(pack.presets.get('feature').lean, undefined);
});

test('prompt is byte-identical with adaptiveRoute off or absent', () => {
  const plain = promptFor(base);
  assert.equal(promptFor({ ...base, adaptiveRoute: 'off' }), plain);
  assert.equal(promptFor({ ...base, adaptiveRoute: 'off', routeLimits: { maxFiles: 9 } }), plain);
  assert.doesNotMatch(plain, /plan\.route/);
});

test('schema is untouched with off and carries the route proposal with shadow or on', () => {
  assert.equal(intake.intakeSchemaFor({ pack, projectConfig: base }), intake.INTAKE_SCHEMA_V2);
  assert.equal(intake.intakeSchemaFor({ projectConfig: { ...base, adaptiveRoute: 'off' } }), intake.INTAKE_SCHEMA);
  for (const mode of ['shadow', 'on']) {
    const schema = intake.intakeSchemaFor({ pack, projectConfig: { ...base, adaptiveRoute: mode } });
    const plan = schema.properties.plan;
    assert.deepEqual(plan.required, ['presetId', 'stages', 'checkIds', 'route', 'routeReason']);
    assert.deepEqual(plan.properties.route.enum, ['full', 'lean', null]);
    assert.equal(plan.properties.routeReason.maxLength, 200);
  }
  assert.equal(intake.INTAKE_SCHEMA_V2.properties.plan.properties.route, undefined);
  const legacy = intake.intakeSchemaFor({ projectConfig: { ...base, adaptiveRoute: 'on' } });
  assert.ok(legacy.properties.plan.properties.route);
});

test('prompt describes the lean proposal with limits only when shadow or on', () => {
  const text = promptFor({ ...base, adaptiveRoute: 'shadow', routeLimits: { maxFiles: 2, maxChangedLines: 12, protectedPaths: ['src/legacy/'] } });
  assert.match(text, /plan\.route to "lean" only when/);
  assert.match(text, /at most 2 allowedFiles/);
  assert.match(text, /at most 12 lines/);
  assert.match(text, /src\/legacy\//);
  assert.match(text, /authentication, authorization or access control/);
  assert.match(promptFor({ ...base, adaptiveRoute: 'on' }), /at most 3 allowedFiles in total, a change of at most 30 lines/);
  assert.match(text, /^[\x00-\x7f]*$/);
});

test('off attaches nothing and drops route fields', () => {
  const result = validate(bugfixPlan({ route: 'lean', routeReason: 'tiny' }), {});
  assert.equal(result.ok, true);
  assert.equal(result.value.plan.routeDecision, undefined);
  assert.equal(result.value.plan.route, undefined);
  assert.equal(result.value.plan.routeReason, undefined);
});

test('eligible lean proposal: shadow keeps effective full, on makes it lean', () => {
  const shadow = validate(bugfixPlan({ route: 'lean', routeReason: ' one line fix ' }), { adaptiveRoute: 'shadow' });
  assert.equal(shadow.ok, true);
  assert.equal(shadow.value.plan.route, 'lean');
  assert.equal(shadow.value.plan.routeReason, 'one line fix');
  assert.deepEqual(shadow.value.plan.routeDecision, { requested: 'lean', verdict: 'lean', effective: 'full', mode: 'shadow', reasons: [] });
  const on = validate(bugfixPlan({ route: 'lean' }), { adaptiveRoute: 'on' });
  assert.deepEqual(on.value.plan.routeDecision, { requested: 'lean', verdict: 'lean', effective: 'lean', mode: 'on', reasons: [] });
});

test('ineligible proposals are not errors: verdict full with reason codes', () => {
  const on = { adaptiveRoute: 'on' };
  const prot = validate(bugfixPlan({ route: 'lean' }, ['web/modules/custom/x/x.routing.yml']), on);
  assert.equal(prot.ok, true);
  assert.deepEqual(prot.value.plan.routeDecision.reasons, ['protected_path:web/modules/custom/x/x.routing.yml']);
  assert.equal(prot.value.plan.routeDecision.effective, 'full');
  const many = validate(bugfixPlan({ route: 'lean' }, ['a.js', 'b.js', 'c.js', 'd.js']), on);
  assert.deepEqual(many.value.plan.routeDecision.reasons, ['too_many_files']);
  const noCheck = validate(bugfixPlan({ route: 'lean' }, ['src/a.js'], []), { adaptiveRoute: 'on', checks: [] });
  assert.equal(noCheck.ok, false);
  const gateOnly = intake.validateIntakeOutput(output(bugfixPlan({ route: 'lean' })), { projectConfig: { ...base, adaptiveRoute: 'on', checks: base.checks }, pack, presets: pack.presets });
  assert.equal(gateOnly.value.plan.routeDecision.verdict, 'lean');
  const notRequested = validate(bugfixPlan({ route: 'full' }), on);
  assert.deepEqual(notRequested.value.plan.routeDecision.reasons, ['not_requested']);
  const absent = validate(bugfixPlan(), on);
  assert.equal(absent.value.plan.routeDecision.requested, null);
  assert.equal(absent.value.plan.route, undefined);
});

test('invalid route is ignored, long reason is capped, other classifications get no decision', () => {
  const bad = validate(bugfixPlan({ route: 'turbo', routeReason: 'x' }), { adaptiveRoute: 'on' });
  assert.equal(bad.ok, true);
  assert.equal(bad.value.plan.route, undefined);
  assert.equal(bad.value.plan.routeReason, undefined);
  assert.equal(bad.value.plan.routeDecision.requested, null);
  const long = validate(bugfixPlan({ route: 'lean', routeReason: 'y'.repeat(500) }), { adaptiveRoute: 'on' });
  assert.equal(long.value.plan.routeReason.length, 200);
  const num = validate(bugfixPlan({ route: 'lean', routeReason: 7 }), { adaptiveRoute: 'on' });
  assert.equal(num.value.plan.routeReason, undefined);
  const docs = validate({
    presetId: 'docs', checkIds: ['unit'], route: 'lean',
    stages: [stage('w', 'write', 'tech-writer', [], ['docs/a.md']), stage('r', 'review', 'reviewer', ['w'])],
  }, { adaptiveRoute: 'on' }, 'docs');
  assert.equal(docs.ok, true);
  assert.equal(docs.value.plan.routeDecision, undefined);
});

test('project policy: adaptiveRoute and routeLimits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-policy-'));
  const load = (obj) => {
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify(obj));
    return loadProjectConfig({ filePath: file });
  };
  try {
    assert.equal(loadProjectConfig({}).adaptiveRoute, undefined);
    assert.equal(loadProjectConfig({}).routeLimits, undefined);
    assert.equal(load({}).adaptiveRoute, undefined);
    assert.equal(load({ adaptiveRoute: 'off' }).adaptiveRoute, undefined);
    for (const mode of ['shadow', 'on']) assert.equal(load({ adaptiveRoute: mode }).adaptiveRoute, mode);
    assert.throws(() => load({ adaptiveRoute: 'auto' }), /adaptiveRoute must be one of off, shadow, on/);
    assert.throws(() => load({ adaptiveRoute: true }), /adaptiveRoute/);
    assert.deepEqual(load({ routeLimits: { maxFiles: 2, maxChangedLines: 10, protectedPaths: [' src/x/ ', 'src/x/'] } }).routeLimits,
      { maxFiles: 2, maxChangedLines: 10, protectedPaths: ['src/x/'] });
    assert.deepEqual(load({ routeLimits: {} }).routeLimits, {});
    for (const bad of [{ maxFiles: 0 }, { maxFiles: 1.5 }, { maxChangedLines: '5' }, { protectedPaths: 'x' }, { protectedPaths: [''] }, { protectedPaths: [3] }, { extra: 1 }]) {
      assert.throws(() => load({ routeLimits: bad }), /routeLimits/);
    }
    assert.throws(() => load({ routeLimits: [] }), /routeLimits must be an object/);
    assert.notEqual(load({ adaptiveRoute: 'on' }).revision, load({}).revision);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
