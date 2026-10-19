'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalRoleId, getRole, legacyRoleId, roleDisplayName } = require('../src/role-names');

const EXPECTED = [
  ['orch-lead', 'coordinator', 'Team Coordinator'],
  ['orch-explorer', 'explorer', 'Code Explorer'],
  ['orch-builder', 'engineer', 'Software Engineer'],
  ['orch-verifier', 'verifier', 'QA (Quality Assistance)'],
  ['orch-auditor', 'auditor', 'Code Auditor'],
  ['orch-repair-xhigh', 'recovery-engineer', 'Recovery Engineer'],
  ['orch-repair-sol', 'senior-engineer', 'Senior Engineer'],
  ['orch-architect', 'architect', 'Systems Architect'],
  ['orch-scout', 'scout', 'Quick Scout'],
];

test('maps every legacy role ID to its canonical ID and display label', () => {
  for (const [legacy, canonical, display] of EXPECTED) {
    assert.equal(canonicalRoleId(legacy), canonical);
    assert.equal(legacyRoleId(canonical), legacy);
    assert.equal(roleDisplayName(legacy), display);
    assert.equal(roleDisplayName(canonical), display);
  }
  assert.equal(canonicalRoleId('custom-role'), 'custom-role');
  assert.equal(legacyRoleId('custom-role'), 'custom-role');
  assert.equal(roleDisplayName('custom-role'), 'custom-role');
});

test('resolves a role map entry by direct, canonical, or legacy key', () => {
  const canonical = { name: 'engineer' };
  const legacy = { name: 'orch-builder' };
  assert.equal(getRole(new Map([['engineer', canonical]]), 'engineer'), canonical);
  assert.equal(getRole(new Map([['engineer', canonical]]), 'orch-builder'), canonical);
  assert.equal(getRole(new Map([['orch-builder', legacy]]), 'engineer'), legacy);
  assert.equal(getRole(new Map(), 'engineer'), undefined);
});
