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

function requiredStagesSucceeded(plan, stageStatuses) {
  return plan.stages.every((stage) => !stage.required || statusOf(stageStatuses, stage.stageId) === 'succeeded');
}

module.exports = {
  VALIDATOR_VERSION,
  STAGE_ROLES,
  WRITABLE_STAGE_ROLES,
  REPAIR_ROLES,
  NO_CHECKS_REASON,
  validatePlan,
  nextEligibleStages,
  isStageRole,
  requiredStagesSucceeded,
};
