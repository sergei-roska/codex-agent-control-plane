'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createLeadRole, loadRoles } = require('./role-catalog');

const DEFAULT_PACK_DIR = path.resolve(__dirname, '..', 'profiles', 'delivery');
const DEFAULT_PROFILES_DIR = path.resolve(__dirname, '..', 'profiles');
const PUBLIC_ID = /^[a-z][a-z0-9-]{0,63}$/;
const RUNTIME_ID = /^(orch|dlv)-[a-z0-9-]+$/;
const PACK_ID = /^[a-z][a-z0-9-]{0,63}$/;
const STAGE_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_STAGES = 12;

const MANIFEST_KEYS = ['packId', 'version', 'coordinator', 'roles', 'repairChains', 'presets', 'unavailablePresets'];
const IDENTITY_KEYS = ['publicId', 'runtimeId', 'displayName'];
const PRESET_KEYS = ['presetId', 'version', 'classification', 'description', 'stages', 'optionalRoles', 'optionalDependsOn', 'minChecks'];
const LEAN_KEYS = ['skip', 'conditional', 'purposeOverrides'];
const STAGE_KEYS = ['key', 'roles', 'required', 'dependsOn', 'purpose'];

function fail(where, message) {
  throw new Error(`${where}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function requireExactKeys(value, keys, where) {
  if (!isPlainObject(value)) fail(where, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(where, `unknown key ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(where, `missing key ${JSON.stringify(key)}`);
  }
}

function requireStringArray(value, where, pattern) {
  if (!Array.isArray(value)) fail(where, 'must be an array');
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item)) fail(where, `invalid entry ${JSON.stringify(item)}`);
  }
  if (new Set(value).size !== value.length) fail(where, 'must not contain duplicates');
  return value;
}

function readJson(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`${filePath}: cannot read file`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON`, { cause: error });
  }
}

function listFiles(dir, suffix) {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(suffix)).sort();
}

/** sha256 over sorted relative paths and bytes of the given files. */
function hashFiles(root, relPaths) {
  const hash = crypto.createHash('sha256');
  for (const rel of [...relPaths].sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function packFiles(root) {
  return [
    'pack.json',
    'TEAM.md',
    ...listFiles(path.join(root, 'agents'), '').map((name) => `agents/${name}`),
    ...listFiles(path.join(root, 'presets'), '').map((name) => `presets/${name}`),
  ];
}

function validateIdentity(value, where) {
  requireExactKeys(value, IDENTITY_KEYS, where);
  if (typeof value.publicId !== 'string' || !PUBLIC_ID.test(value.publicId)) fail(where, 'invalid publicId');
  if (typeof value.runtimeId !== 'string' || !RUNTIME_ID.test(value.runtimeId)) fail(where, 'invalid runtimeId');
  if (!isNonEmptyString(value.displayName)) fail(where, 'displayName must be a non-empty string');
  return { publicId: value.publicId, runtimeId: value.runtimeId, displayName: value.displayName };
}

function validateLean(lean, preset, stageKeys, where) {
  const at = `${where} lean`;
  if (preset.classification !== 'bugfix') fail(at, 'lean is only allowed on a bugfix preset');
  requireExactKeys(lean, LEAN_KEYS, at);
  requireStringArray(lean.skip, `${at} skip`, STAGE_KEY);
  requireStringArray(lean.conditional, `${at} conditional`, STAGE_KEY);
  for (const key of [...lean.skip, ...lean.conditional]) {
    if (!stageKeys.has(key)) fail(at, `references missing stage key ${JSON.stringify(key)}`);
  }
  for (const key of lean.skip) {
    if (lean.conditional.includes(key)) fail(at, `stage key ${JSON.stringify(key)} is both skip and conditional`);
  }
  if (!isPlainObject(lean.purposeOverrides)) fail(at, 'purposeOverrides must be an object');
  for (const [key, text] of Object.entries(lean.purposeOverrides)) {
    if (!stageKeys.has(key)) fail(at, `purposeOverrides references missing stage key ${JSON.stringify(key)}`);
    if (!isNonEmptyString(text)) fail(at, `purposeOverrides.${key} must be a non-empty string`);
  }
}

function validatePreset(preset, where, { fileId, publicIds, sandboxByPublic }) {
  if (!isPlainObject(preset)) fail(where, 'must be an object');
  const { lean, ...presetCore } = preset;
  requireExactKeys(presetCore, PRESET_KEYS, where);
  if (preset.presetId !== fileId) fail(where, `presetId must equal ${JSON.stringify(fileId)}`);
  if (typeof preset.version !== 'string' || !SEMVER.test(preset.version)) fail(where, 'invalid version');
  if (!isNonEmptyString(preset.classification)) fail(where, 'classification must be a non-empty string');
  if (!isNonEmptyString(preset.description)) fail(where, 'description must be a non-empty string');
  if (!Number.isInteger(preset.minChecks) || preset.minChecks < 0) fail(where, 'minChecks must be a non-negative integer');
  if (!Array.isArray(preset.stages) || preset.stages.length < 1 || preset.stages.length > MAX_STAGES) {
    fail(where, `stages must be an array of 1..${MAX_STAGES} entries`);
  }

  const seen = new Set();
  preset.stages.forEach((stage, index) => {
    const at = `${where} stages[${index}]`;
    requireExactKeys(stage, STAGE_KEYS, at);
    if (typeof stage.key !== 'string' || !STAGE_KEY.test(stage.key)) fail(at, 'invalid key');
    if (seen.has(stage.key)) fail(at, `duplicate stage key ${JSON.stringify(stage.key)}`);
    if (stage.required !== true) fail(at, 'required must be true');
    if (!isNonEmptyString(stage.purpose)) fail(at, 'purpose must be a non-empty string');
    requireStringArray(stage.roles, `${at} roles`, PUBLIC_ID);
    if (stage.roles.length === 0) fail(at, 'roles must not be empty');
    for (const role of stage.roles) {
      if (!publicIds.has(role)) fail(at, `unknown public role ${JSON.stringify(role)}`);
    }
    requireStringArray(stage.dependsOn, `${at} dependsOn`, STAGE_KEY);
    for (const dep of stage.dependsOn) {
      if (!seen.has(dep)) fail(at, `dependsOn ${JSON.stringify(dep)} must name an earlier stage key`);
    }
    seen.add(stage.key);
  });

  requireStringArray(preset.optionalRoles, `${where} optionalRoles`, PUBLIC_ID);
  for (const role of preset.optionalRoles) {
    if (!publicIds.has(role)) fail(where, `optionalRoles has unknown public role ${JSON.stringify(role)}`);
  }
  requireStringArray(preset.optionalDependsOn, `${where} optionalDependsOn`, STAGE_KEY);
  for (const dep of preset.optionalDependsOn) {
    if (!seen.has(dep)) fail(where, `optionalDependsOn ${JSON.stringify(dep)} is not a stage key`);
  }

  if (lean !== undefined) validateLean(lean, preset, seen, where);

  if (preset.presetId === 'audit') {
    // Audit is read-only: no stage or optional role may be writable.
    const referenced = [...preset.stages.flatMap((stage) => stage.roles), ...preset.optionalRoles];
    for (const role of referenced) {
      if (sandboxByPublic.get(role) !== 'read-only') fail(where, `audit preset references writable role ${JSON.stringify(role)}`);
    }
  }
  return preset;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function buildPack({ packId, version, hash, coordinator, roles, repairProfiles, repairChains, presets, unavailablePresets }) {
  const runtimeRoles = new Map();
  for (const entry of roles) runtimeRoles.set(entry.runtimeId, entry.role);
  for (const [runtimeId, role] of repairProfiles) runtimeRoles.set(runtimeId, role);

  const publicToRuntimeMap = new Map();
  const runtimeToPublicMap = new Map();
  for (const entry of [coordinator, ...roles]) {
    publicToRuntimeMap.set(entry.publicId, entry.runtimeId);
    runtimeToPublicMap.set(entry.runtimeId, entry.publicId);
  }
  // A repair executor counts for the stage of the role it repairs.
  for (const [base, chain] of Object.entries(repairChains)) {
    for (const runtimeId of chain) runtimeToPublicMap.set(runtimeId, runtimeToPublicMap.get(base));
  }

  return {
    packId,
    version,
    hash,
    coordinator,
    roles,
    repairProfiles,
    repairChains,
    presets,
    unavailablePresets,
    runtimeRoles,
    publicToRuntime: (id) => publicToRuntimeMap.get(id) ?? null,
    runtimeToPublic: (id) => runtimeToPublicMap.get(id) ?? null,
  };
}

function loadRolePack({ packDir = DEFAULT_PACK_DIR } = {}) {
  const root = path.resolve(packDir);
  const manifestPath = path.join(root, 'pack.json');
  const manifest = readJson(manifestPath);
  requireExactKeys(manifest, MANIFEST_KEYS, manifestPath);

  if (typeof manifest.packId !== 'string' || !PACK_ID.test(manifest.packId)) fail(manifestPath, 'invalid packId');
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) fail(manifestPath, 'invalid version');

  const coordinatorId = validateIdentity(manifest.coordinator, `${manifestPath} coordinator`);
  if (!Array.isArray(manifest.roles) || manifest.roles.length === 0) fail(manifestPath, 'roles must be a non-empty array');
  const roleIds = manifest.roles.map((entry, index) => validateIdentity(entry, `${manifestPath} roles[${index}]`));

  const publicSeen = new Set();
  const runtimeSeen = new Set();
  for (const entry of [coordinatorId, ...roleIds]) {
    if (publicSeen.has(entry.publicId)) fail(manifestPath, `duplicate publicId ${entry.publicId}`);
    if (runtimeSeen.has(entry.runtimeId)) fail(manifestPath, `duplicate runtimeId ${entry.runtimeId}`);
    publicSeen.add(entry.publicId);
    runtimeSeen.add(entry.runtimeId);
  }

  if (!isPlainObject(manifest.repairChains)) fail(manifestPath, 'repairChains must be an object');
  const repairChains = {};
  const repairIds = new Set();
  for (const [base, chain] of Object.entries(manifest.repairChains)) {
    if (!roleIds.some((entry) => entry.runtimeId === base)) {
      fail(manifestPath, `repairChains key ${JSON.stringify(base)} is not a specialist runtimeId`);
    }
    requireStringArray(chain, `${manifestPath} repairChains.${base}`, RUNTIME_ID);
    if (chain.length === 0) fail(manifestPath, `repairChains.${base} must not be empty`);
    for (const member of chain) {
      if (runtimeSeen.has(member)) fail(manifestPath, `repair executor ${member} must not be a public role`);
      if (repairIds.has(member)) fail(manifestPath, `repair executor ${member} is used twice`);
      repairIds.add(member);
    }
    repairChains[base] = [...chain];
  }

  requireStringArray(manifest.presets, `${manifestPath} presets`, PUBLIC_ID);
  requireStringArray(manifest.unavailablePresets, `${manifestPath} unavailablePresets`, PUBLIC_ID);
  for (const id of manifest.unavailablePresets) {
    if (manifest.presets.includes(id)) fail(manifestPath, `preset ${id} is both available and unavailable`);
  }

  // Profiles: each runtime id needs its file and nothing else may be present.
  const profiles = loadRoles({ profilesDir: root });
  const expectedProfiles = new Set([coordinatorId.runtimeId, ...roleIds.map((e) => e.runtimeId), ...repairIds]);
  for (const runtimeId of expectedProfiles) {
    if (!profiles.has(runtimeId)) fail(manifestPath, `no profile file for runtimeId ${runtimeId}`);
  }
  for (const name of profiles.keys()) {
    if (!expectedProfiles.has(name)) fail(root, `profile ${name} is not declared in pack.json`);
  }

  const coordinatorRole = profiles.get(coordinatorId.runtimeId);
  if (coordinatorRole.sandbox !== 'read-only') fail(manifestPath, 'coordinator profile must be read-only');
  for (const chain of Object.values(repairChains)) {
    for (const member of chain) {
      if (profiles.get(member).sandbox !== 'workspace-write') fail(manifestPath, `repair executor ${member} must be writable`);
    }
  }

  const roles = roleIds.map((entry) => ({ ...entry, role: profiles.get(entry.runtimeId) }));
  const repairProfiles = new Map([...repairIds].map((id) => [id, profiles.get(id)]));
  const sandboxByPublic = new Map(roles.map((entry) => [entry.publicId, entry.role.sandbox]));
  const publicIds = new Set(roles.map((entry) => entry.publicId));

  // Presets: the directory must hold exactly the declared preset files.
  const presetsDir = path.join(root, 'presets');
  const presetFiles = listFiles(presetsDir, '');
  const declaredFiles = manifest.presets.map((id) => `${id}.json`).sort();
  if (JSON.stringify(presetFiles) !== JSON.stringify(declaredFiles)) {
    fail(presetsDir, `preset files ${JSON.stringify(presetFiles)} do not match declared presets ${JSON.stringify(declaredFiles)}`);
  }
  const presets = new Map();
  for (const id of manifest.presets) {
    const filePath = path.join(presetsDir, `${id}.json`);
    const preset = validatePreset(readJson(filePath), filePath, { fileId: id, publicIds, sandboxByPublic });
    presets.set(id, deepFreeze(preset));
  }

  return buildPack({
    packId: manifest.packId,
    version: manifest.version,
    hash: hashFiles(root, packFiles(root)),
    coordinator: { ...coordinatorId, role: coordinatorRole },
    roles,
    repairProfiles,
    repairChains,
    presets,
    unavailablePresets: [...manifest.unavailablePresets],
  });
}

function loadLegacyPack({ profilesDir = DEFAULT_PROFILES_DIR } = {}) {
  const root = path.resolve(profilesDir);
  const profiles = loadRoles({ profilesDir: root });
  const repairChains = { 'orch-builder': ['orch-repair-xhigh', 'orch-repair-sol'] };
  const repairIds = new Set(Object.values(repairChains).flat());
  for (const id of [...Object.keys(repairChains), ...repairIds]) {
    if (!profiles.has(id)) throw new Error(`${root}: legacy profile ${id} is missing`);
  }

  const identity = (name, role) => ({ publicId: name, runtimeId: name, displayName: name, role });
  const roles = [...profiles.entries()]
    .filter(([name]) => !repairIds.has(name))
    .map(([name, role]) => identity(name, role));
  const repairProfiles = new Map([...repairIds].map((id) => [id, profiles.get(id)]));
  const lead = createLeadRole({ profilesDir: root });

  return buildPack({
    packId: 'legacy-orch',
    version: '0',
    hash: hashFiles(root, [
      'TEAM.md',
      ...listFiles(path.join(root, 'agents'), '').map((name) => `agents/${name}`),
    ]),
    coordinator: identity(lead.name, lead),
    roles,
    repairProfiles,
    repairChains,
    presets: new Map(),
    unavailablePresets: [],
  });
}

module.exports = { loadLegacyPack, loadRolePack };
