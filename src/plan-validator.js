'use strict';

const { safeRelativePath } = require('./contracts');

const VALIDATOR_VERSION = 'm3-plan-v1';
const STAGE_ROLES = Object.freeze(['orch-explorer', 'orch-scout', 'orch-architect', 'orch-builder', 'orch-verifier', 'orch-auditor']);
const WRITABLE_STAGE_ROLES = Object.freeze(['orch-builder', 'orch-verifier']);
const REPAIR_ROLES = Object.freeze(['orch-repair-xhigh', 'orch-repair-sol']);
const MAX_STAGES = 12;
const MAX_OBJECTIVE = 2000;
const MAX_FILES = 20;
const STAGE_ID = /^[a-z0-9-]{1,40}$/;
const PROTECTED_SEGMENTS = Object.freeze(['.git', '.codex', '.claude']);
const PROTECTED_BASENAMES = Object.freeze(['agents.md', 'claude.md']);
const NO_CHECKS_REASON = 'no approved acceptance checks configured';

function isProtectedPath(file) {
  const segments = file.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => PROTECTED_SEGMENTS.includes(segment))) return true;
  return PROTECTED_BASENAMES.includes(segments[segments.length - 1]);
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// True when stage `from` reaches stage `to` through dependency edges (or is it).
function dependsOn(stagesById, from, to, seen = new Set()) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const stage = stagesById.get(from);
  if (!stage) return false;
  return stage.dependencies.some((dep) => dependsOn(stagesById, dep, to, seen));
}

function validatePlan(plan, { classification, projectCheckIds = [] } = {}) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!isObject(plan)) {
    fail('plan', 'plan must be an object');
    return { ok: false, errors, plan: null };
  }
  const rawStages = plan.stages;
  const normalizedStages = [];
  if (!Array.isArray(rawStages) || rawStages.length < 1 || rawStages.length > MAX_STAGES) {
    fail('plan.stages', `plan must have 1..${MAX_STAGES} stages`);
  } else {
    const declared = new Set();
    const allIds = new Set(rawStages.map((stage) => (isObject(stage) && typeof stage.stageId === 'string' ? stage.stageId.trim() : null)));
    rawStages.forEach((stage, index) => {
      const at = `plan.stages[${index}]`;
      if (!isObject(stage)) {
        fail(at, 'stage must be an object');
        return;
      }
      const stageId = typeof stage.stageId === 'string' ? stage.stageId.trim() : '';
      if (!STAGE_ID.test(stageId)) fail(`${at}.stageId`, 'stageId must match ^[a-z0-9-]{1,40}$');
      else if (declared.has(stageId)) fail(`${at}.stageId`, `stageId "${stageId}" is duplicated`);
      const roleId = typeof stage.roleId === 'string' ? stage.roleId.trim() : '';
      if (!STAGE_ROLES.includes(roleId)) {
        fail(`${at}.roleId`, REPAIR_ROLES.includes(roleId)
          ? `${roleId} is a repair role and cannot be a stage role`
          : `roleId must be one of ${STAGE_ROLES.join(', ')}`);
      }
      const objective = typeof stage.objective === 'string' ? stage.objective.trim() : '';
      if (!objective || objective.length > MAX_OBJECTIVE) fail(`${at}.objective`, `objective must be 1..${MAX_OBJECTIVE} chars`);
      const dependencies = [];
      if (!Array.isArray(stage.dependencies) || stage.dependencies.some((dep) => typeof dep !== 'string')) {
        fail(`${at}.dependencies`, 'dependencies must be an array of stage ids');
      } else {
        stage.dependencies.forEach((raw) => {
          const dep = raw.trim();
          if (dep === stageId) fail(`${at}.dependencies`, `stage "${stageId}" depends on itself`);
          else if (!allIds.has(dep)) fail(`${at}.dependencies`, `unknown dependency "${dep}"`);
          else if (!declared.has(dep)) fail(`${at}.dependencies`, `dependency "${dep}" is not declared earlier (forward reference or cycle)`);
          if (!dependencies.includes(dep)) dependencies.push(dep);
        });
      }
      const allowedFiles = [];
      const writable = WRITABLE_STAGE_ROLES.includes(roleId);
      if (!Array.isArray(stage.allowedFiles) || stage.allowedFiles.some((file) => typeof file !== 'string')) {
        fail(`${at}.allowedFiles`, 'allowedFiles must be an array of strings');
      } else {
        stage.allowedFiles.forEach((raw) => {
          const file = raw.trim();
          if (!safeRelativePath(file)) fail(`${at}.allowedFiles`, `unsafe path "${file}"`);
          else if (isProtectedPath(file)) fail(`${at}.allowedFiles`, `protected path "${file}"`);
          if (!allowedFiles.includes(file)) allowedFiles.push(file);
        });
        if (writable && (stage.allowedFiles.length < 1 || stage.allowedFiles.length > MAX_FILES)) {
          fail(`${at}.allowedFiles`, `${roleId} needs 1..${MAX_FILES} allowedFiles`);
        }
        if (!writable && STAGE_ROLES.includes(roleId) && stage.allowedFiles.length > 0) {
          fail(`${at}.allowedFiles`, `${roleId} is read-only and must have no allowedFiles`);
        }
      }
      if (typeof stage.required !== 'boolean') fail(`${at}.required`, 'required must be a boolean');
      if (STAGE_ID.test(stageId)) declared.add(stageId);
      normalizedStages.push({ stageId, roleId, objective, dependencies, allowedFiles, required: stage.required === true });
    });
  }

  const checkIds = [];
  if (!Array.isArray(plan.checkIds) || plan.checkIds.some((id) => typeof id !== 'string')) {
    fail('plan.checkIds', 'checkIds must be an array of strings');
  } else {
    const known = new Set(projectCheckIds);
    plan.checkIds.forEach((raw) => {
      const id = raw.trim();
      if (!known.has(id)) fail('plan.checkIds', `unknown checkId "${id}"`);
      if (!checkIds.includes(id)) checkIds.push(id);
    });
  }

  if (!['feature', 'bugfix', 'docs', 'audit'].includes(classification)) {
    fail('classification', 'classification must be feature, bugfix, docs, or audit');
  } else {
    const stagesById = new Map(normalizedStages.map((stage) => [stage.stageId, stage]));
    const required = (role) => normalizedStages.filter((stage) => stage.roleId === role && stage.required);
    const builders = required('orch-builder');
    const auditors = required('orch-auditor');
    const verifiers = required('orch-verifier');
    const needAfterBuilder = (list, role) => {
      if (list.length === 0) fail('plan.stages', `${classification} plan needs a required ${role} stage`);
      else if (builders.length > 0 && !list.some((stage) => builders.some((b) => dependsOn(stagesById, stage.stageId, b.stageId) && stage.stageId !== b.stageId))) {
        fail('plan.stages', `a required ${role} stage must depend (directly or transitively) on the builder stage`);
      }
    };
    if (classification === 'feature' || classification === 'bugfix') {
      if (builders.length === 0) fail('plan.stages', `${classification} plan needs a required orch-builder stage`);
      needAfterBuilder(verifiers, 'orch-verifier');
      needAfterBuilder(auditors, 'orch-auditor');
      if (projectCheckIds.length === 0) fail('plan.checkIds', NO_CHECKS_REASON);
      else if (checkIds.length === 0) fail('plan.checkIds', `${classification} plan needs at least one checkId`);
    } else if (classification === 'docs') {
      if (builders.length === 0) fail('plan.stages', 'docs plan needs a required orch-builder stage');
      if (auditors.length === 0) fail('plan.stages', 'docs plan needs a required orch-auditor stage');
      if (projectCheckIds.length === 0) fail('plan.checkIds', NO_CHECKS_REASON);
      else if (checkIds.length === 0) fail('plan.checkIds', 'docs plan needs at least one checkId');
    } else {
      if (normalizedStages.some((stage) => WRITABLE_STAGE_ROLES.includes(stage.roleId))) {
        fail('plan.stages', 'audit plan must be read-only (no writable stage)');
      }
      if (auditors.length === 0) fail('plan.stages', 'audit plan needs a required orch-auditor stage');
    }
  }

  const ok = errors.length === 0;
  return { ok, errors, plan: ok ? { stages: normalizedStages, checkIds } : null };
}

const PRESET_VALIDATOR_VERSION = 'm4-plan-v1';
const WRITABLE_SANDBOX = 'workspace-write';

// Pack lookups may be a function, Map or plain object; read all three.
function mapGet(source, key) {
  if (typeof source === 'function') {
    const found = source(key);
    return found === null ? undefined : found;
  }
  if (source instanceof Map) return source.get(key);
  return source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function runtimeRoleOf(pack, publicId) {
  const runtimeId = mapGet(pack && pack.publicToRuntime, publicId);
  return typeof runtimeId === 'string' ? runtimeId : null;
}

function sandboxOf(pack, runtimeId) {
  const entry = ((pack && pack.roles) || []).find((item) => item.runtimeId === runtimeId);
  return entry && entry.role ? entry.role.sandbox : undefined;
}

function repairChainOf(pack, runtimeId) {
  const chain = mapGet(pack && pack.repairChains, runtimeId);
  return Array.isArray(chain) ? chain : [];
}

// Validates a plan against a delivery preset. Stage roleId is a public role id on input; the
// normalized plan carries both publicRoleId and the runtime roleId from pack.publicToRuntime.
function validatePresetPlan(plan, { pack, preset, projectCheckIds = [] } = {}) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!isObject(plan)) {
    fail('plan', 'plan must be an object');
    return { ok: false, errors, plan: null };
  }
  if (!isObject(pack) || !isObject(preset)) {
    fail('plan', 'pack and preset are required');
    return { ok: false, errors, plan: null };
  }
  const publicIds = (pack.roles || []).map((role) => role.publicId);
  if (plan.presetId !== preset.presetId) fail('plan.presetId', `presetId must be "${preset.presetId}"`);
  const presetStages = Array.isArray(preset.stages) ? preset.stages : [];
  const presetByKey = new Map(presetStages.map((item) => [item.key, item]));
  const optionalRoles = preset.optionalRoles || [];
  const optionalDeps = preset.optionalDependsOn || [];
  const normalizedStages = [];
  const rawStages = plan.stages;
  if (!Array.isArray(rawStages) || rawStages.length < 1 || rawStages.length > MAX_STAGES) {
    fail('plan.stages', `plan must have 1..${MAX_STAGES} stages`);
  } else {
    const declared = new Set();
    const allIds = new Set(rawStages.map((stage) => (isObject(stage) && typeof stage.stageId === 'string' ? stage.stageId.trim() : null)));
    rawStages.forEach((stage, index) => {
      const at = `plan.stages[${index}]`;
      if (!isObject(stage)) {
        fail(at, 'stage must be an object');
        return;
      }
      const stageId = typeof stage.stageId === 'string' ? stage.stageId.trim() : '';
      if (!STAGE_ID.test(stageId)) fail(`${at}.stageId`, 'stageId must match ^[a-z0-9-]{1,40}$');
      else if (declared.has(stageId)) fail(`${at}.stageId`, `stageId "${stageId}" is duplicated`);
      const publicRoleId = typeof stage.roleId === 'string' ? stage.roleId.trim() : '';
      const runtimeId = publicIds.includes(publicRoleId) ? runtimeRoleOf(pack, publicRoleId) : null;
      if (!runtimeId) fail(`${at}.roleId`, `roleId must be one of ${publicIds.join(', ')}`);
      const writable = runtimeId ? sandboxOf(pack, runtimeId) === WRITABLE_SANDBOX : false;
      const key = stage.presetStageKey === undefined ? null : stage.presetStageKey;
      let presetStage = null;
      if (key !== null && typeof key !== 'string') {
        fail(`${at}.presetStageKey`, 'presetStageKey must be a string or null');
      } else if (key !== null) {
        presetStage = presetByKey.get(key) || null;
        if (!presetStage) fail(`${at}.presetStageKey`, `unknown preset stage "${key}"`);
        else if (runtimeId && !presetStage.roles.includes(publicRoleId)) {
          fail(`${at}.roleId`, `preset stage "${key}" needs one of ${presetStage.roles.join(', ')}`);
        }
      } else if (runtimeId && !optionalRoles.includes(publicRoleId)) {
        fail(`${at}.roleId`, `${publicRoleId} is not an optional role of preset ${preset.presetId} (allowed: ${optionalRoles.join(', ') || 'none'})`);
      }
      if (preset.classification === 'audit' && writable) fail(`${at}.roleId`, `audit plan must be read-only: ${publicRoleId} is writable`);
      const objective = typeof stage.objective === 'string' ? stage.objective.trim() : '';
      if (!objective || objective.length > MAX_OBJECTIVE) fail(`${at}.objective`, `objective must be 1..${MAX_OBJECTIVE} chars`);
      const dependencies = [];
      if (!Array.isArray(stage.dependencies) || stage.dependencies.some((dep) => typeof dep !== 'string')) {
        fail(`${at}.dependencies`, 'dependencies must be an array of stage ids');
      } else {
        stage.dependencies.forEach((raw) => {
          const dep = raw.trim();
          if (dep === stageId) fail(`${at}.dependencies`, `stage "${stageId}" depends on itself`);
          else if (!allIds.has(dep)) fail(`${at}.dependencies`, `unknown dependency "${dep}"`);
          else if (!declared.has(dep)) fail(`${at}.dependencies`, `dependency "${dep}" is not declared earlier (forward reference or cycle)`);
          if (!dependencies.includes(dep)) dependencies.push(dep);
        });
      }
      const allowedFiles = [];
      if (!Array.isArray(stage.allowedFiles) || stage.allowedFiles.some((file) => typeof file !== 'string')) {
        fail(`${at}.allowedFiles`, 'allowedFiles must be an array of strings');
      } else {
        stage.allowedFiles.forEach((raw) => {
          const file = raw.trim();
          if (!safeRelativePath(file)) fail(`${at}.allowedFiles`, `unsafe path "${file}"`);
          else if (isProtectedPath(file)) fail(`${at}.allowedFiles`, `protected path "${file}"`);
          if (!allowedFiles.includes(file)) allowedFiles.push(file);
        });
        if (writable && (stage.allowedFiles.length < 1 || stage.allowedFiles.length > MAX_FILES)) {
          fail(`${at}.allowedFiles`, `${publicRoleId} needs 1..${MAX_FILES} allowedFiles`);
        }
        if (runtimeId && !writable && stage.allowedFiles.length > 0) {
          fail(`${at}.allowedFiles`, `${publicRoleId} is read-only and must have no allowedFiles`);
        }
      }
      if (typeof stage.required !== 'boolean') fail(`${at}.required`, 'required must be a boolean');
      else if (presetStage && stage.required !== true) fail(`${at}.required`, `preset stage "${key}" must be required`);
      if (STAGE_ID.test(stageId)) declared.add(stageId);
      normalizedStages.push({
        stageId,
        presetStageKey: typeof key === 'string' ? key : null,
        publicRoleId,
        roleId: runtimeId || publicRoleId,
        objective,
        dependencies,
        allowedFiles,
        required: stage.required === true,
      });
    });
  }

  // Every required preset stage exactly once, with mapped dependencies present.
  const byKey = new Map();
  for (const stage of normalizedStages) {
    if (stage.presetStageKey === null) continue;
    if (!byKey.has(stage.presetStageKey)) byKey.set(stage.presetStageKey, []);
    byKey.get(stage.presetStageKey).push(stage);
  }
  for (const presetStage of presetStages) {
    if (presetStage.required === false) continue;
    const found = byKey.get(presetStage.key) || [];
    if (found.length === 0) fail('plan.stages', `plan is missing required preset stage "${presetStage.key}"`);
    else if (found.length > 1) fail('plan.stages', `preset stage "${presetStage.key}" appears ${found.length} times`);
  }
  const stageIdOfKey = (key) => (byKey.get(key) || [])[0];
  for (const stage of normalizedStages) {
    const presetStage = stage.presetStageKey === null ? null : presetByKey.get(stage.presetStageKey);
    const wanted = presetStage ? presetStage.dependsOn || [] : (stage.presetStageKey === null ? optionalDeps : []);
    for (const key of wanted) {
      const target = stageIdOfKey(key);
      if (target && !stage.dependencies.includes(target.stageId)) {
        fail('plan.stages', `stage "${stage.stageId}" must depend on preset stage "${key}" (${target.stageId})`);
      }
    }
  }

  const checkIds = [];
  if (!Array.isArray(plan.checkIds) || plan.checkIds.some((id) => typeof id !== 'string')) {
    fail('plan.checkIds', 'checkIds must be an array of strings');
  } else {
    const known = new Set(projectCheckIds);
    plan.checkIds.forEach((raw) => {
      const id = raw.trim();
      if (!known.has(id)) fail('plan.checkIds', `unknown checkId "${id}"`);
      if (!checkIds.includes(id)) checkIds.push(id);
    });
    const minChecks = Number.isInteger(preset.minChecks) ? preset.minChecks : 0;
    if (minChecks > 0) {
      if (projectCheckIds.length === 0) fail('plan.checkIds', NO_CHECKS_REASON);
      else if (checkIds.length < minChecks) fail('plan.checkIds', `${preset.presetId} plan needs at least ${minChecks} checkId${minChecks === 1 ? '' : 's'}`);
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    plan: ok
      ? {
        presetId: preset.presetId,
        presetVersion: preset.version,
        rolePack: pack.packId,
        rolePackVersion: pack.version,
        validatorVersion: PRESET_VALIDATOR_VERSION,
        stages: normalizedStages,
        checkIds,
      }
      : null,
  };
}

function statusOf(stageStatuses, stageId) {
  const value = stageStatuses instanceof Map ? stageStatuses.get(stageId) : (stageStatuses || {})[stageId];
  return value || 'pending';
}

// Stages not yet succeeded whose dependencies have all succeeded, in plan order.
function nextEligibleStages(plan, stageStatuses) {
  return plan.stages.filter((stage) => statusOf(stageStatuses, stage.stageId) !== 'succeeded'
    && stage.dependencies.every((dep) => statusOf(stageStatuses, dep) === 'succeeded'));
}

function isStageRole(stage, role, attemptedRoles = new Set()) {
  if (!stage) return false;
  if (stage.roleId === role) return true;
  const attempted = attemptedRoles instanceof Set ? attemptedRoles : new Set(attemptedRoles);
  return stage.roleId === 'orch-builder' && REPAIR_ROLES.includes(role) && attempted.size > 0;
}

// Pack-aware role match: a repair executor may serve a stage only for a role whose pack
// repairChain lists it, after a prior attempt, and only once earlier chain entries were tried.
function stageRoleMatches(stage, runtimeRole, attemptedRoles = new Set(), pack = null) {
  if (!stage) return false;
  if (stage.roleId === runtimeRole) return true;
  const attempted = attemptedRoles instanceof Set ? attemptedRoles : new Set(attemptedRoles);
  if (attempted.size === 0) return false;
  const chain = repairChainOf(pack, stage.roleId);
  const at = chain.indexOf(runtimeRole);
  if (at < 0) return false;
  return chain.slice(0, at).every((earlier) => attempted.has(earlier));
}

function requiredStagesSucceeded(plan, stageStatuses) {
  return plan.stages.every((stage) => !stage.required || statusOf(stageStatuses, stage.stageId) === 'succeeded');
}

module.exports = {
  VALIDATOR_VERSION,
  STAGE_ROLES,
  WRITABLE_STAGE_ROLES,
  REPAIR_ROLES,
  NO_CHECKS_REASON,
  PRESET_VALIDATOR_VERSION,
  validatePlan,
  validatePresetPlan,
  stageRoleMatches,
  nextEligibleStages,
  isStageRole,
  requiredStagesSucceeded,
};
