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
    assert.match(role.model, /^gpt-[a-z0-9]+(?:[.-][a-z0-9]+)*$/, `${name} model`);
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
  assert.match(lead.model, /^gpt-[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
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

test('every shipped role and the lead have an empty MCP allowlist and skills off', () => {
  for (const role of [...loadRoles().values(), createLeadRole()]) {
    assert.deepEqual(role.tools, { mcpServers: [], skills: false }, role.name);
  }
});

function withProfile(mutate) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-role-tools-'));
  const copied = path.join(tempRoot, 'profiles');
  fs.cpSync(PROFILES_DIR, copied, { recursive: true });
  const builder = path.join(copied, 'agents', 'orch-builder.toml');
  fs.writeFileSync(builder, mutate(fs.readFileSync(builder, 'utf8')));
  return { copied, cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }) };
}

test('parses an a2a_tools table and treats a missing table as deny-all', (t) => {
  const allow = withProfile((source) => source.replace(/\[a2a_tools\][\s\S]*$/, '[a2a_tools]\nmcp_servers = ["alpha", "beta", "alpha"] # why\nskills = true\n'));
  t.after(allow.cleanup);
  assert.deepEqual(loadRoles({ profilesDir: allow.copied }).get('orch-builder').tools, { mcpServers: ['alpha', 'beta'], skills: true });

  const none = withProfile((source) => source.replace(/\n\[a2a_tools\][\s\S]*$/, '\n'));
  t.after(none.cleanup);
  assert.deepEqual(loadRoles({ profilesDir: none.copied }).get('orch-builder').tools, { mcpServers: [], skills: false });
});

test('rejects malformed a2a_tools tables', (t) => {
  const bad = [
    ['unknown key', (s) => `${s}extra = 1\n`],
    ['non-array allowlist', (s) => s.replace('mcp_servers = []', 'mcp_servers = "alpha"')],
    ['bad server name', (s) => s.replace('mcp_servers = []', 'mcp_servers = ["a b"]')],
    ['non-boolean skills', (s) => s.replace('skills = false', 'skills = "yes"')],
    ['duplicate field', (s) => `${s}skills = true\n`],
    ['unknown table', (s) => `${s}\n[other]\n`],
  ];
  for (const [label, mutate] of bad) {
    const fixture = withProfile(mutate);
    t.after(fixture.cleanup);
    assert.throws(() => loadRoles({ profilesDir: fixture.copied }), /orch-builder\.toml/, label);
  }
});
