'use strict';

// Per-project role overrides (model, reasoning effort, extra owner rules), kept in one JSON file per
// project: `.runtime/projects/<id>/role-overrides.json`. The launcher is the only writer; the project
// server re-reads the file whenever it changes. The profiles in profiles/agents stay untouched.

const fs = require('node:fs');
const path = require('node:path');
const { canonicalRoleId } = require('./role-names');
const { EFFORTS, MODEL_PATTERN, LEAD_ROLE_NAME } = require('./role-catalog');

const OVERRIDES_VERSION = 1;
const MAX_EXTRA_RULES = 4000;
const RULES_HEADING = 'Project rules from the owner (apply in this project only):';
const FIELDS = ['model', 'effort', 'extraRules'];

class RoleOverrideError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoleOverrideError';
  }
}

const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * Validates one role's override and returns it without empty fields. Empty, null, or absent fields mean
 * "use the profile default". Throws RoleOverrideError with a message fit for the owner.
 */
function normalizeOverride(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new RoleOverrideError('Override must be an object');
  for (const key of Object.keys(input)) {
    if (!FIELDS.includes(key)) throw new RoleOverrideError(`Unknown override field: ${key}`);
  }
  const out = {};
  if (!isBlank(input.model)) {
    if (typeof input.model !== 'string' || !MODEL_PATTERN.test(input.model.trim())) {
      throw new RoleOverrideError(`Invalid model ${JSON.stringify(input.model)}`);
    }
    out.model = input.model.trim();
  }
  if (!isBlank(input.effort)) {
    if (typeof input.effort !== 'string' || !EFFORTS.has(input.effort.trim())) {
      throw new RoleOverrideError(`Effort must be one of ${[...EFFORTS].join(', ')}`);
    }
    out.effort = input.effort.trim();
  }
  if (!isBlank(input.extraRules)) {
    if (typeof input.extraRules !== 'string') throw new RoleOverrideError('Extra rules must be text');
    const text = input.extraRules.trim();
    if (text.length > MAX_EXTRA_RULES) throw new RoleOverrideError(`Extra rules are limited to ${MAX_EXTRA_RULES} characters`);
    if (text.includes('{{') || text.includes('}}')) throw new RoleOverrideError('Extra rules must not contain "{{" or "}}"');
    out.extraRules = text;
  }
  return out;
}

/** The canonical role name when it is the lead or one of knownNames, else throws RoleOverrideError. */
function resolveRoleName(name, knownNames) {
  const canonical = canonicalRoleId(name);
  if (canonical === LEAD_ROLE_NAME || knownNames.includes(canonical)) return canonical;
  throw new RoleOverrideError(`Unknown role: ${name}`);
}

/**
 * Validates a whole overrides document. Returns { roles } with canonical role names and normalized
 * entries (roles whose entry is empty are dropped). Throws RoleOverrideError on any problem.
 */
function validateOverridesDocument(doc, knownNames) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new RoleOverrideError('Overrides file must be an object');
  if (doc.version !== OVERRIDES_VERSION) throw new RoleOverrideError(`Unsupported overrides version ${JSON.stringify(doc.version)}`);
  if (!doc.roles || typeof doc.roles !== 'object' || Array.isArray(doc.roles)) throw new RoleOverrideError('Overrides file needs a roles object');
  const roles = {};
  for (const [name, value] of Object.entries(doc.roles)) {
    const canonical = resolveRoleName(name, knownNames);
    const entry = normalizeOverride(value);
    if (Object.keys(entry).length > 0) roles[canonical] = entry;
  }
  return { roles };
}

/**
 * Reads the overrides file. Missing file -> no overrides. Invalid file -> no overrides plus a `warning`
 * (profile defaults apply); this never throws.
 */
function readOverridesFile(file, knownNames) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { roles: {}, warning: null };
    return { roles: {}, warning: `Role overrides ignored: cannot read ${file}: ${error && error.message}` };
  }
  try {
    return { ...validateOverridesDocument(JSON.parse(raw), knownNames), warning: null };
  } catch (error) {
    return { roles: {}, warning: `Role overrides ignored: ${file} is invalid: ${error && error.message}` };
  }
}

let tmpCounter = 0;

/** Writes the overrides atomically (temp file + rename). `roles` is the validated role -> override map. */
function writeOverridesFile(file, roles) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify({ version: OVERRIDES_VERSION, roles, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter += 1}`;
  const descriptor = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(descriptor, body);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** The role the Codex calls use: override model/effort replace the profile ones; extra rules are appended. */
function effectiveRole(baseRole, override) {
  if (!override || Object.keys(override).length === 0) return baseRole;
  const role = { ...baseRole };
  if (override.model) role.model = override.model;
  if (override.effort) role.effort = override.effort;
  if (override.extraRules) {
    role.instructions = `${baseRole.instructions || ''}\n\n${RULES_HEADING}\n${override.extraRules}`.trim();
  }
  return role;
}

/**
 * Live view of the roles with the overrides file applied. The file is stat-ed on every call and re-read
 * only when it changed, so a change applies from the next dispatch or lead turn. `roles()` and
 * `leadRole()` always come from the same read. Without a file the base roles are returned as they are.
 */
function createRoleOverrideSource({ file = null, roles: baseRoles, leadRole: baseLead, warn = () => {} }) {
  const knownNames = [...baseRoles.keys()].map(canonicalRoleId);
  let key = null;
  let current = { roles: baseRoles, leadRole: baseLead, overrides: {} };
  const listeners = new Set();

  function reload() {
    if (!file) return current;
    let next;
    try {
      const stat = fs.statSync(file);
      next = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch (_) {
      next = 'none';
    }
    if (next === key) return current;
    key = next;
    let overrides = {};
    if (next !== 'none') {
      const result = readOverridesFile(file, knownNames);
      if (result.warning) warn(result.warning);
      overrides = result.roles;
    }
    if (Object.keys(overrides).length === 0) {
      current = { roles: baseRoles, leadRole: baseLead, overrides };
    } else {
      const roles = new Map();
      for (const [name, role] of baseRoles) roles.set(name, effectiveRole(role, overrides[canonicalRoleId(name)]));
      current = { roles, leadRole: effectiveRole(baseLead, overrides[LEAD_ROLE_NAME]), overrides };
    }
    for (const listener of listeners) {
      try { listener(current); } catch (_) { /* A listener never breaks a read. */ }
    }
    return current;
  }

  return {
    file,
    roles: () => reload().roles,
    leadRole: () => reload().leadRole,
    overrides: () => reload().overrides,
    /** Calls `listener(snapshot)` after every reload (the first read included). */
    onReload: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

module.exports = {
  OVERRIDES_VERSION,
  MAX_EXTRA_RULES,
  RULES_HEADING,
  RoleOverrideError,
  normalizeOverride,
  resolveRoleName,
  validateOverridesDocument,
  readOverridesFile,
  writeOverridesFile,
  effectiveRole,
  createRoleOverrideSource,
};
