'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadLegacyPack, loadRolePack } = require('../src/role-pack');

const DELIVERY_DIR = path.resolve(__dirname, '..', 'profiles', 'delivery');

const DEFAULTS = {
  'dlv-project-manager': ['read-only', 'gpt-6-luna', 'xhigh'],
  'dlv-architect': ['read-only', 'gpt-6-luna', 'xhigh'],
  'dlv-developer': ['workspace-write', 'gpt-6-luna', 'high'],
  'dlv-developer-xhigh': ['workspace-write', 'gpt-6-luna', 'high'],
  'dlv-developer-sol': ['workspace-write', 'gpt-6-luna', 'high'],
  'dlv-qa': ['workspace-write', 'gpt-6-luna', 'high'],
  'dlv-reviewer': ['read-only', 'gpt-6-luna', 'high'],
  'dlv-security': ['read-only', 'gpt-6-luna', 'high'],
  'dlv-performance': ['workspace-write', 'gpt-6-luna', 'high'],
  'dlv-devops': ['workspace-write', 'gpt-6-luna', 'high'],
  'dlv-tech-writer': ['workspace-write', 'gpt-6-luna', 'high'],
};

const PRESET_TABLE = {
  feature: {
    stages: [['design', ['architect'], []], ['implement', ['developer'], ['design']], ['review', ['reviewer'], ['implement']], ['qa', ['qa'], ['implement']]],
    optionalRoles: ['security', 'performance', 'devops', 'tech-writer'], optionalDependsOn: ['implement'], minChecks: 1,
  },
  bugfix: {
    stages: [['reproduce', ['qa'], []], ['implement', ['developer'], ['reproduce']], ['review', ['reviewer'], ['implement']], ['verify', ['qa'], ['implement']]],
    optionalRoles: ['architect', 'security', 'performance'], optionalDependsOn: ['implement'], minChecks: 1,
  },
  docs: {
    stages: [['write', ['tech-writer'], []], ['review', ['reviewer'], ['write']]],
    optionalRoles: ['qa', 'architect'], optionalDependsOn: ['write'], minChecks: 1,
  },
  audit: {
    stages: [['investigate', ['architect', 'security', 'reviewer'], []], ['synthesis', ['reviewer'], ['investigate']]],
    optionalRoles: ['security', 'architect'], optionalDependsOn: ['investigate'], minChecks: 0,
  },
};

function copyPack(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'role-pack-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dir = path.join(tempRoot, 'delivery');
  fs.cpSync(DELIVERY_DIR, dir, { recursive: true });
  return dir;
}

function editJson(dir, rel, mutate) {
  const file = path.join(dir, rel);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = mutate(value);
  fs.writeFileSync(file, JSON.stringify(next === undefined ? value : next, null, 2));
}

test('real delivery pack loads with nine public roles and eleven runtime profiles', () => {
  const pack = loadRolePack({ packDir: DELIVERY_DIR });
  assert.equal(pack.packId, 'delivery');
  assert.equal(pack.version, '1.0.0');
  assert.match(pack.hash, /^[0-9a-f]{64}$/);
  assert.equal(pack.coordinator.publicId, 'project-manager');
  assert.equal(pack.coordinator.runtimeId, 'dlv-project-manager');
  assert.equal(pack.roles.length + 1, 9);
  assert.deepEqual(pack.roles.map((r) => r.publicId), ['architect', 'developer', 'qa', 'reviewer', 'security', 'performance', 'devops', 'tech-writer']);
  assert.deepEqual([...pack.repairProfiles.keys()], ['dlv-developer-xhigh', 'dlv-developer-sol']);
  assert.deepEqual(pack.repairChains, { 'dlv-developer': ['dlv-developer-xhigh', 'dlv-developer-sol'] });
  assert.deepEqual(pack.unavailablePresets, ['security', 'performance', 'environment', 'debt']);

  assert.equal(pack.runtimeRoles.size, 10);
  assert.equal(pack.runtimeRoles.has('dlv-project-manager'), false);
  const all = [pack.coordinator.role, ...pack.runtimeRoles.values()];
  assert.equal(all.length, 11);
  for (const role of all) {
    const [sandbox, model, effort] = DEFAULTS[role.name];
    assert.equal(role.sandbox, sandbox, `${role.name} sandbox`);
    assert.equal(role.model, model, `${role.name} model`);
    assert.equal(role.effort, effort, `${role.name} effort`);
    assert.deepEqual(role.tools, { mcpServers: [], skills: false }, role.name);
    assert.match(role.instructions, /team rules at \/[^\n]+TEAM\.md/, role.name);
    assert.doesNotMatch(role.instructions, /\{\{/, role.name);
  }
  assert.equal(Object.keys(DEFAULTS).length, all.length);
});

test('public and runtime ids map both ways, repair executors map to Developer', () => {
  const pack = loadRolePack({ packDir: DELIVERY_DIR });
  assert.equal(pack.publicToRuntime('project-manager'), 'dlv-project-manager');
  assert.equal(pack.publicToRuntime('tech-writer'), 'dlv-tech-writer');
  assert.equal(pack.publicToRuntime('nope'), null);
  assert.equal(pack.runtimeToPublic('dlv-qa'), 'qa');
  assert.equal(pack.runtimeToPublic('dlv-developer-sol'), 'developer');
  assert.equal(pack.runtimeToPublic('orch-builder'), null);
});

test('real presets match the table', () => {
  const pack = loadRolePack({ packDir: DELIVERY_DIR });
  assert.deepEqual([...pack.presets.keys()], ['feature', 'bugfix', 'docs', 'audit']);
  for (const [id, expected] of Object.entries(PRESET_TABLE)) {
    const preset = pack.presets.get(id);
    assert.equal(preset.presetId, id);
    assert.equal(preset.version, id === 'bugfix' ? '1.1.0' : '1.0.0');
    assert.equal(preset.classification, id);
    assert.ok(preset.description.length > 10);
    assert.deepEqual(preset.stages.map((s) => [s.key, s.roles, s.dependsOn]), expected.stages, id);
    for (const stage of preset.stages) {
      assert.equal(stage.required, true);
      assert.ok(stage.purpose.length > 10);
    }
    assert.deepEqual(preset.optionalRoles, expected.optionalRoles, id);
    assert.deepEqual(preset.optionalDependsOn, expected.optionalDependsOn, id);
    assert.equal(preset.minChecks, expected.minChecks, id);
  }
});

test('pack and profile files are ASCII only', () => {
  const files = ['pack.json', 'TEAM.md'];
  for (const sub of ['agents', 'presets']) files.push(...fs.readdirSync(path.join(DELIVERY_DIR, sub)).map((n) => `${sub}/${n}`));
  for (const rel of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(DELIVERY_DIR, rel), 'utf8'), /[^\x00-\x7F]/, rel);
  }
});

const INVALID = [
  ['unknown manifest key', (d) => editJson(d, 'pack.json', (m) => { m.extra = 1; }), /unknown key "extra"/],
  ['missing manifest key', (d) => editJson(d, 'pack.json', (m) => { delete m.unavailablePresets; }), /missing key "unavailablePresets"/],
  ['non-semver version', (d) => editJson(d, 'pack.json', (m) => { m.version = 'one'; }), /invalid version/],
  ['unknown identity key', (d) => editJson(d, 'pack.json', (m) => { m.roles[0].extra = 1; }), /unknown key "extra"/],
  ['duplicate publicId', (d) => editJson(d, 'pack.json', (m) => { m.roles[1].publicId = 'architect'; }), /duplicate publicId/],
  ['duplicate runtimeId', (d) => editJson(d, 'pack.json', (m) => { m.roles[1].runtimeId = 'dlv-architect'; }), /duplicate runtimeId/],
  ['bad runtimeId pattern', (d) => editJson(d, 'pack.json', (m) => { m.roles[1].runtimeId = 'Developer'; }), /invalid runtimeId/],
  ['missing profile file', (d) => fs.rmSync(path.join(d, 'agents', 'dlv-devops.toml')), /dlv-devops/],
  ['undeclared profile file', (d) => {
    const src = fs.readFileSync(path.join(d, 'agents', 'dlv-devops.toml'), 'utf8');
    fs.writeFileSync(path.join(d, 'agents', 'dlv-extra.toml'), src.replace('dlv-devops', 'dlv-extra'));
  }, /dlv-extra is not declared/],
  ['coordinator not read-only', (d) => {
    const file = path.join(d, 'agents', 'dlv-project-manager.toml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('read-only', 'workspace-write'));
  }, /coordinator profile must be read-only/],
  ['repair chain member missing', (d) => editJson(d, 'pack.json', (m) => { m.repairChains['dlv-developer'].push('dlv-ghost'); }), /dlv-ghost/],
  ['repair chain member not writable', (d) => {
    const file = path.join(d, 'agents', 'dlv-developer-sol.toml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('workspace-write', 'read-only'));
  }, /must be writable/],
  ['repair chain key not a specialist', (d) => editJson(d, 'pack.json', (m) => { m.repairChains = { 'dlv-project-manager': ['dlv-developer-xhigh'] }; }), /not a specialist runtimeId/],
  ['repair member is public role', (d) => editJson(d, 'pack.json', (m) => { m.repairChains['dlv-developer'] = ['dlv-qa']; }), /must not be a public role/],
  ['preset listed twice as unavailable', (d) => editJson(d, 'pack.json', (m) => { m.unavailablePresets.push('feature'); }), /both available and unavailable/],
  ['preset file missing', (d) => fs.rmSync(path.join(d, 'presets', 'docs.json')), /do not match declared presets/],
  ['undeclared preset file', (d) => fs.copyFileSync(path.join(d, 'presets', 'docs.json'), path.join(d, 'presets', 'extra.json')), /do not match declared presets/],
  ['preset id differs from file', (d) => editJson(d, 'presets/docs.json', (p) => { p.presetId = 'other'; }), /presetId must equal "docs"/],
  ['preset unknown key', (d) => editJson(d, 'presets/docs.json', (p) => { p.extra = 1; }), /unknown key "extra"/],
  ['preset unknown stage key', (d) => editJson(d, 'presets/docs.json', (p) => { p.stages[0].extra = 1; }), /unknown key "extra"/],
  ['preset bad version', (d) => editJson(d, 'presets/docs.json', (p) => { p.version = '1'; }), /invalid version/],
  ['preset unknown role', (d) => editJson(d, 'presets/docs.json', (p) => { p.stages[0].roles = ['dlv-tech-writer']; }), /unknown public role/],
  ['preset runtime repair role', (d) => editJson(d, 'presets/docs.json', (p) => { p.stages[0].roles = ['developer-xhigh']; }), /unknown public role/],
  ['preset duplicate stage key', (d) => editJson(d, 'presets/docs.json', (p) => { p.stages[1].key = 'write'; }), /duplicate stage key/],
  ['preset dependsOn later key', (d) => editJson(d, 'presets/docs.json', (p) => { p.stages[0].dependsOn = ['review']; }), /earlier stage key/],
  ['preset dependsOn self', (d) => editJson(d, 'presets/docs.json', (p) => { p.stages[0].dependsOn = ['write']; }), /earlier stage key/],
  ['preset optionalDependsOn unknown', (d) => editJson(d, 'presets/docs.json', (p) => { p.optionalDependsOn = ['ghost']; }), /optionalDependsOn "ghost"/],
  ['preset optional role unknown', (d) => editJson(d, 'presets/docs.json', (p) => { p.optionalRoles = ['ghost']; }), /optionalRoles/],
  ['preset empty stages', (d) => editJson(d, 'presets/docs.json', (p) => { p.stages = []; }), /stages must be an array/],
  ['preset negative minChecks', (d) => editJson(d, 'presets/docs.json', (p) => { p.minChecks = -1; }), /minChecks/],
  ['lean references a missing stage key', (d) => editJson(d, 'presets/bugfix.json', (p) => { p.lean.skip = ['ghost']; }), /missing stage key "ghost"/],
  ['lean key both skip and conditional', (d) => editJson(d, 'presets/bugfix.json', (p) => { p.lean.conditional = ['reproduce']; }), /both skip and conditional/],
  ['lean on a non-bugfix preset', (d) => editJson(d, 'presets/docs.json', (p) => { p.lean = { skip: [], conditional: [], purposeOverrides: {} }; }), /only allowed on a bugfix preset/],
  ['lean purposeOverrides references a missing stage', (d) => editJson(d, 'presets/bugfix.json', (p) => { p.lean.purposeOverrides = { ghost: 'x' }; }), /missing stage key "ghost"/],
  ['lean unknown key', (d) => editJson(d, 'presets/bugfix.json', (p) => { p.lean.extra = 1; }), /unknown key "extra"/],
  ['audit stage with only writable roles', (d) => editJson(d, 'presets/audit.json', (p) => { p.stages[0].roles = ['performance']; }), /writable role "performance"/],
  ['audit stage mixing read-only and writable roles', (d) => editJson(d, 'presets/audit.json', (p) => { p.stages[0].roles.push('performance'); }), /writable role "performance"/],
  ['audit optional writable role', (d) => editJson(d, 'presets/audit.json', (p) => { p.optionalRoles.push('performance'); }), /writable role "performance"/],
];

for (const [label, mutate, pattern] of INVALID) {
  test(`rejects invalid pack: ${label}`, (t) => {
    const dir = copyPack(t);
    mutate(dir);
    assert.throws(() => loadRolePack({ packDir: dir }), pattern);
  });
}

test('rejects a missing pack directory and invalid JSON', (t) => {
  assert.throws(() => loadRolePack({ packDir: path.join(os.tmpdir(), 'no-such-role-pack') }), /pack\.json/);
  const dir = copyPack(t);
  fs.writeFileSync(path.join(dir, 'pack.json'), '{');
  assert.throws(() => loadRolePack({ packDir: dir }), /invalid JSON/);
});

test('pack hash is stable and changes with any file', (t) => {
  const baseline = loadRolePack({ packDir: DELIVERY_DIR }).hash;
  const dir = copyPack(t);
  assert.equal(loadRolePack({ packDir: dir }).hash, baseline);

  const files = ['pack.json', 'TEAM.md'];
  for (const sub of ['agents', 'presets']) files.push(...fs.readdirSync(path.join(dir, sub)).map((n) => `${sub}/${n}`));
  for (const rel of files) {
    const file = path.join(dir, rel);
    const original = fs.readFileSync(file, 'utf8');
    const changed = rel === 'pack.json' ? `${original}\n` : rel.endsWith('.json') ? `${original}\n` : rel.endsWith('.md') ? `${original}\nx\n` : `${original}\n# note\n`;
    fs.writeFileSync(file, changed);
    assert.notEqual(loadRolePack({ packDir: dir }).hash, baseline, rel);
    fs.writeFileSync(file, original);
  }
  assert.equal(loadRolePack({ packDir: dir }).hash, baseline);
});

test('legacy pack loads the existing orch roles', () => {
  const pack = loadLegacyPack();
  assert.equal(pack.packId, 'legacy-orch');
  assert.equal(pack.version, '0');
  assert.match(pack.hash, /^[0-9a-f]{64}$/);
  assert.equal(pack.coordinator.runtimeId, 'orch-lead');
  assert.equal(pack.coordinator.role.sandbox, 'read-only');
  assert.equal(pack.runtimeRoles.size, 8);
  assert.equal(pack.runtimeRoles.has('orch-lead'), false);
  assert.deepEqual(pack.repairChains, { 'orch-builder': ['orch-repair-xhigh', 'orch-repair-sol'] });
  assert.deepEqual([...pack.repairProfiles.keys()], ['orch-repair-xhigh', 'orch-repair-sol']);
  assert.equal(pack.presets.size, 0);
  assert.deepEqual(pack.unavailablePresets, []);
  assert.equal(pack.publicToRuntime('orch-builder'), 'orch-builder');
  assert.equal(pack.runtimeToPublic('orch-repair-sol'), 'orch-builder');
});
