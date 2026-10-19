'use strict';

const ROLE_NAMES = Object.freeze({
  'orch-lead': { id: 'coordinator', displayName: 'Team Coordinator' },
  'orch-explorer': { id: 'explorer', displayName: 'Code Explorer' },
  'orch-builder': { id: 'engineer', displayName: 'Software Engineer' },
  'orch-verifier': { id: 'verifier', displayName: 'QA (Quality Assistance)' },
  'orch-auditor': { id: 'auditor', displayName: 'Code Auditor' },
  'orch-repair-xhigh': { id: 'recovery-engineer', displayName: 'Recovery Engineer' },
  'orch-repair-sol': { id: 'senior-engineer', displayName: 'Senior Engineer' },
  'orch-architect': { id: 'architect', displayName: 'Systems Architect' },
  'orch-scout': { id: 'scout', displayName: 'Quick Scout' },
});

const LEGACY_BY_CANONICAL = Object.freeze(Object.fromEntries(
  Object.entries(ROLE_NAMES).map(([legacy, role]) => [role.id, legacy]),
));

function canonicalRoleId(id) {
  const value = String(id ?? '');
  return ROLE_NAMES[value]?.id || value;
}

function legacyRoleId(id) {
  const value = String(id ?? '');
  return LEGACY_BY_CANONICAL[canonicalRoleId(value)] || value;
}

function roleDisplayName(id) {
  const value = String(id ?? '');
  const canonical = canonicalRoleId(value);
  return ROLE_NAMES[value]?.displayName
    || ROLE_NAMES[LEGACY_BY_CANONICAL[canonical]]?.displayName
    || value;
}

function getRole(roles, id) {
  if (!roles || typeof roles.get !== 'function') return undefined;
  const value = String(id ?? '');
  const canonical = canonicalRoleId(value);
  const legacy = legacyRoleId(canonical);
  return roles.get(value) || roles.get(canonical) || roles.get(legacy);
}

module.exports = { canonicalRoleId, legacyRoleId, roleDisplayName, getRole };
