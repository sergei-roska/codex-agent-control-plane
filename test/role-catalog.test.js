'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLeadRole, loadRoles } = require('../src/role-catalog');

const PROFILES_DIR = path.resolve(__dirname, '..', 'profiles');
const EXPECTED_ROLE_SANDBOXES = {
  'orch-architect': 'read-only',
  'orch-auditor': 'read-only',
  'orch-builder': 'workspace-write',
  'orch-explorer': 'read-only',
  'orch-repair-sol': 'workspace-write',
  'orch-repair-xhigh': 'workspace-write',
  'orch-scout': 'read-only',
  'orch-verifier': 'workspace-write',
};
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

test('loads all eight source roles with valid model, effort, and sandbox settings', () => {
  const roles = loadRoles();
  assert.equal(roles.size, 8);
  assert.deepEqual([...roles.keys()].sort(), Object.keys(EXPECTED_ROLE_SANDBOXES).sort());

  for (const [name, sandbox] of Object.entries(EXPECTED_ROLE_SANDBOXES)) {
    const role = roles.get(name);
    assert.match(role.model, /^gpt-[a-z0-9-]+$/, `${name} model`);
    assert.ok(VALID_EFFORTS.has(role.effort), `${name} effort`);
    assert.equal(role.sandbox, sandbox, `${name} sandbox`);
    assert.equal(role.name, name);
    assert.ok(role.description.length > 0);
  }
});

test('resolved role instructions define A2A runtime behavior and an absolute local team-rules path', () => {
  for (const role of loadRoles().values()) {
    assert.match(role.instructions, /runtime A2A worker/i, role.name);
    assert.doesNotMatch(role.instructions, /\{\{[^}]+\}\}/, role.name);
    assert.match(role.instructions, /team rules at \/[^\n]+\/profiles\/TEAM\.md/, role.name);
  }
});

test('profiles work from a copied directory without the original source pack', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-role-catalog-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const copiedProfiles = path.join(tempRoot, 'profiles');
  fs.cpSync(PROFILES_DIR, copiedProfiles, { recursive: true });

  const roles = loadRoles({ profilesDir: copiedProfiles });
  assert.equal(roles.size, 8);
  for (const role of roles.values()) {
    assert.ok(role.instructions.includes(path.join(copiedProfiles, 'TEAM.md')));
    assert.doesNotMatch(role.instructions, /orchestrator-agent-pack/);
  }

  const lead = createLeadRole({ profilesDir: copiedProfiles });
  assert.match(lead.model, /^gpt-[a-z0-9-]+$/);
  assert.ok(VALID_EFFORTS.has(lead.effort));
  assert.equal(lead.sandbox, 'read-only');
  assert.match(lead.instructions, /A2A dispatch/i);
  assert.match(lead.instructions, /do not edit product files/i);
  assert.ok(lead.instructions.includes('Universal Orchestrator Development Team'));
  assert.ok(lead.instructions.includes(path.join(copiedProfiles, 'skills')));
  assert.match(lead.instructions, /not necessarily roles in the target orchestrator/i);
  assert.match(lead.instructions, /lead is read-only/i);
  assert.match(lead.instructions, /delegates filesystem mutations and git actions/i);
  assert.match(lead.instructions, /If no role is authorized/i);
  assert.doesNotMatch(lead.instructions, /It writes project instruction files and documentation/);
});

test('rejects profiles with missing required settings', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-role-invalid-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const copiedProfiles = path.join(tempRoot, 'profiles');
  fs.cpSync(PROFILES_DIR, copiedProfiles, { recursive: true });
  const builder = path.join(copiedProfiles, 'agents', 'orch-builder.toml');
  fs.writeFileSync(builder, fs.readFileSync(builder, 'utf8').replace('model_reasoning_effort = "high"\n', ''));

  assert.throws(() => loadRoles({ profilesDir: copiedProfiles }), /model_reasoning_effort is missing/);
});
