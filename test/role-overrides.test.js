'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { createLeadRole, loadRoles } = require('../src/role-catalog');
const {
  RULES_HEADING,
  RoleOverrideError,
  loadEffectiveRoles,
  effectiveRole,
  normalizeOverride,
  readOverridesFile,
  resolveRoleName,
  validateOverridesDocument,
  writeOverridesFile,
} = require('../src/role-overrides');

let tmp;
let file;
let baseRoles;
let baseLead;
let known;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'role-overrides-'));
  file = path.join(tmp, 'projects', 'p1', 'role-overrides.json');
  baseRoles = loadRoles();
  baseLead = createLeadRole();
  known = [...baseRoles.keys()];
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const writeRaw = (value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};

describe('normalizeOverride', () => {
  it('keeps set fields and drops empty ones', () => {
    assert.deepEqual(normalizeOverride({ model: ' gpt-6-luna ', effort: 'xhigh', extraRules: ' rule ' }), { model: 'gpt-6-luna', effort: 'xhigh', extraRules: 'rule' });
    assert.deepEqual(normalizeOverride({ model: '', effort: null, extraRules: '  \n' }), {});
    assert.deepEqual(normalizeOverride(null), {});
    assert.deepEqual(normalizeOverride(undefined), {});
  });

  it('rejects bad values with a message', () => {
    for (const input of [
      { model: 'claude-3' }, { model: 'gpt-' }, { model: 7 }, { effort: 'max' }, { effort: 1 },
      { extraRules: 'a {{X}}' }, { extraRules: 'a }}' }, { extraRules: 'x'.repeat(4001) }, { extraRules: {} },
      { extra: 'x' }, [], 'text',
    ]) {
      assert.throws(() => normalizeOverride(input), RoleOverrideError, JSON.stringify(input).slice(0, 40));
    }
    assert.equal(normalizeOverride({ extraRules: 'x'.repeat(4000) }).extraRules.length, 4000);
  });
});

describe('role names and documents', () => {
  it('resolves canonical and legacy names, the lead, and rejects unknown roles', () => {
    assert.equal(resolveRoleName('orch-architect', known), 'architect');
    assert.equal(resolveRoleName('architect', known), 'architect');
    assert.equal(resolveRoleName('coordinator', known), 'coordinator');
    assert.equal(resolveRoleName('orch-lead', known), 'coordinator');
    assert.throws(() => resolveRoleName('ghost', known), /Unknown role/);
  });

  it('validates the document shape and drops empty entries', () => {
    assert.deepEqual(validateOverridesDocument({ version: 1, roles: { architect: { effort: 'low' }, engineer: {} } }, known), { roles: { architect: { effort: 'low' } } });
    assert.throws(() => validateOverridesDocument({ version: 2, roles: {} }, known), /version/);
    assert.throws(() => validateOverridesDocument({ version: 1 }, known), /roles object/);
    assert.throws(() => validateOverridesDocument({ version: 1, roles: { ghost: { effort: 'low' } } }, known), /Unknown role/);
    assert.throws(() => validateOverridesDocument([], known), /object/);
  });
});

describe('effectiveRole', () => {
  it('returns the base role itself without an override', () => {
    const base = baseRoles.get('architect');
    assert.equal(effectiveRole(base, undefined), base);
    assert.equal(effectiveRole(base, {}), base);
  });

  it('replaces model and effort and appends the rules block, leaving the base untouched', () => {
    const base = baseRoles.get('architect');
    const original = { ...base };
    const role = effectiveRole(base, { model: 'gpt-6-luna', effort: 'low', extraRules: 'Be brief.' });
    assert.equal(role.model, 'gpt-6-luna');
    assert.equal(role.effort, 'low');
    assert.equal(role.instructions, `${base.instructions}\n\n${RULES_HEADING}\nBe brief.`);
    assert.equal(role.sandbox, base.sandbox);
    assert.deepEqual(base, original);
    const onlyRules = effectiveRole(base, { extraRules: 'R' });
    assert.equal(onlyRules.model, base.model);
    assert.equal(onlyRules.effort, base.effort);
    const onlyModel = effectiveRole(base, { model: 'gpt-6-luna' });
    assert.equal(onlyModel.instructions, base.instructions);
  });
});

describe('file read and write', () => {
  it('writes atomically with the documented shape and reads it back', () => {
    writeOverridesFile(file, { architect: { model: 'gpt-6-luna', extraRules: 'x' } });
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.roles, { architect: { model: 'gpt-6-luna', extraRules: 'x' } });
    assert.ok(!Number.isNaN(Date.parse(doc.updatedAt)));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['role-overrides.json']);
    assert.deepEqual(readOverridesFile(file, known), { roles: { architect: { model: 'gpt-6-luna', extraRules: 'x' } }, warning: null });
  });

  it('a missing file means no overrides; an invalid file is ignored with a warning, never thrown', () => {
    assert.deepEqual(readOverridesFile(file, known), { roles: {}, warning: null });
    for (const raw of ['{ nope', '[]', JSON.stringify({ version: 1, roles: { architect: { effort: 'max' } } }), JSON.stringify({ version: 1, roles: { architect: { effort: 'low' }, ghost: { effort: 'low' } } })]) {
      writeRaw(raw);
      const result = readOverridesFile(file, known);
      assert.deepEqual(result.roles, {});
      assert.match(result.warning, /Role overrides ignored/);
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.match(readOverridesFile(file, known).warning, /Role overrides ignored/);
  });
});

describe('loadEffectiveRoles', () => {
  it('without a file returns the base roles as they are', () => {
    const loaded = loadEffectiveRoles({ roles: baseRoles, leadRole: baseLead });
    assert.equal(loaded.roles, baseRoles);
    assert.equal(loaded.leadRole, baseLead);
  });

  it('a missing file means the defaults without a warning', () => {
    const warnings = [];
    const loaded = loadEffectiveRoles({ file, roles: baseRoles, leadRole: baseLead, warn: (m) => warnings.push(m) });
    assert.equal(loaded.roles, baseRoles);
    assert.equal(loaded.leadRole, baseLead);
    assert.deepEqual(warnings, []);
  });

  it('applies the file to the roles and the lead once and leaves the base roles untouched', () => {
    writeOverridesFile(file, { architect: { model: 'gpt-6-luna' }, coordinator: { effort: 'high', extraRules: 'Lead rule.' } });
    const loaded = loadEffectiveRoles({ file, roles: baseRoles, leadRole: baseLead });
    assert.notEqual(loaded.roles, baseRoles);
    assert.equal(loaded.roles.get('architect').model, 'gpt-6-luna');
    assert.equal(loaded.roles.get('engineer'), baseRoles.get('engineer'));
    assert.equal(loaded.leadRole.effort, 'high');
    assert.match(loaded.leadRole.instructions, /Lead rule\.$/);
    assert.equal(baseRoles.get('architect').model, loadRoles().get('architect').model);
    // Load-once: a later edit of the file does not change what was loaded.
    writeOverridesFile(file, { architect: { effort: 'low' } });
    assert.equal(loaded.roles.get('architect').model, 'gpt-6-luna');
    assert.equal(loaded.roles.get('architect').effort, baseRoles.get('architect').effort);
  });

  it('falls back to the defaults with one warning on an invalid file', () => {
    const warnings = [];
    writeRaw('{ nope');
    const loaded = loadEffectiveRoles({ file, roles: baseRoles, leadRole: baseLead, warn: (m) => warnings.push(m) });
    assert.equal(loaded.roles, baseRoles);
    assert.equal(loaded.leadRole, baseLead);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Role overrides ignored/);
  });
});
