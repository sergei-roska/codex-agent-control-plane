'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_PATH_ENTRIES = 64;
const MAX_CHECKS = 10;
const POLICY_LOOKUP_TIMEOUT_MS = 2000;
const POLICY_CACHE_MAX_AGE_MS = 30000;
const permissionCache = new WeakMap();

function executableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function findExecutable(command, cwd, env = process.env) {
  if (typeof command !== 'string' || !command || command.length > 4096) return { status: 'unknown', reason: 'invalid_executable' };
  try {
    if (command.includes('/') || command.includes('\\')) {
      const candidate = path.resolve(cwd, command);
      return executableFile(candidate)
        ? { status: 'available' }
        : { status: 'unavailable', reason: 'executable_not_found' };
    }
    const rawPath = env.PATH ?? env.Path;
    if (typeof rawPath !== 'string') return { status: 'unknown', reason: 'path_unavailable' };
    const entries = rawPath.split(path.delimiter);
    if (entries.length > MAX_PATH_ENTRIES) return { status: 'unknown', reason: 'path_too_large' };
    for (const entry of entries) {
      const directory = entry ? path.resolve(cwd, entry) : cwd;
      if (executableFile(path.join(directory, command))) return { status: 'available' };
    }
    return { status: 'unavailable', reason: 'executable_not_found' };
  } catch (_) {
    return { status: 'unknown', reason: 'inspection_failed' };
  }
}

function boundedPolicyRead(read, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish({ mode: 'unknown', reason: 'inspection_aborted' });
    const timer = setTimeout(() => finish({ mode: 'unknown', reason: 'policy_lookup_timeout' }), POLICY_LOOKUP_TIMEOUT_MS);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(read).then(finish, () => finish({ mode: 'unknown', reason: 'policy_resolution_unverified' }));
  });
}

async function resolvedPolicy(appServer, cwd, requested, signal) {
  if (requested === 'strict') return { mode: 'strict', reason: 'strict_setting' };
  if (!appServer || (typeof appServer.resolveExecutionPermissions !== 'function'
    && (typeof appServer.readConfig !== 'function' || typeof appServer._request !== 'function'))) {
    return { mode: 'unknown', reason: 'policy_api_unavailable' };
  }
  let cache = permissionCache.get(appServer);
  if (!cache) {
    cache = new Map();
    permissionCache.set(appServer, cache);
  }
  const generation = appServer.generation ?? null;
  const account = typeof appServer.getCodexHome === 'function' ? appServer.getCodexHome() : null;
  const key = `${path.resolve(cwd)}\0${requested || 'inherit'}\0${generation}\0${account || ''}`;
  let cached = cache.get(key);
  if (cached && Date.now() - cached.at > POLICY_CACHE_MAX_AGE_MS) {
    cache.delete(key);
    cached = null;
  }
  if (!cached) {
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    const pending = Promise.resolve().then(async () => {
      if (typeof appServer.resolveExecutionPermissions === 'function') {
        return await appServer.resolveExecutionPermissions(cwd, requested || 'inherit');
      }
      const { resolveExecutionPermissions } = require('./execution-permissions');
      return await resolveExecutionPermissions(appServer, cwd, requested || 'inherit');
    }).catch(() => null);
    cached = { at: Date.now(), pending };
    cache.set(key, cached);
  }
  const policy = await boundedPolicyRead(() => cached.pending, signal);
  if (policy?.mode === 'inherit' || policy?.mode === 'strict') {
    return {
      mode: policy.mode,
      reason: policy.reason || null,
      profileApi: policy.profileApi === true,
      readOnlyProfile: typeof policy.readOnlyProfile === 'string' ? policy.readOnlyProfile : null,
      writerProfile: typeof policy.writerProfile === 'string' ? policy.writerProfile : null,
      sandboxMode: typeof policy.sandboxMode === 'string' ? policy.sandboxMode : null,
      approvalPolicy: typeof policy.approvalPolicy === 'string' ? policy.approvalPolicy : null,
      approvalsReviewer: typeof policy.approvalsReviewer === 'string' ? policy.approvalsReviewer : null,
    };
  }
  if (policy?.reason === 'policy_lookup_timeout' || policy?.reason === 'policy_resolution_unverified') cache.delete(key);
  return { mode: 'unknown', reason: policy?.reason || 'policy_resolution_unverified' };
}

function routeIdentity({ project, contract, policy, policySetting }) {
  const checks = (contract?.requiredChecks || []).slice(0, MAX_CHECKS).map((check) => ({
    id: String(check?.id || '').slice(0, 64),
    argv: Array.isArray(check?.argv) ? check.argv.slice(0, 64).map((arg) => String(arg).slice(0, 4096)) : [],
  }));
  const scope = {
    version: 1,
    project: path.resolve(project),
    source: contract?.source === 'agent' ? 'agent' : 'owner',
    policy: {
      setting: policySetting || 'inherit', resolved: policy.mode, profileApi: policy.profileApi,
      readOnlyProfile: policy.readOnlyProfile, writerProfile: policy.writerProfile,
      sandboxMode: policy.sandboxMode, approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer,
    },
    checks,
  };
  return `local-verification/v1:${crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 32)}`;
}

async function preflightVerification({ appServer, workspace, contract, executionPermissions = 'inherit', env = process.env, signal } = {}) {
  const checks = Array.isArray(contract?.requiredChecks) ? contract.requiredChecks.slice(0, MAX_CHECKS) : [];
  let policy = { mode: 'unknown', reason: 'no_checks' };
  if (checks.length > 0 && contract?.source === 'agent') policy = await resolvedPolicy(appServer, workspace, executionPermissions, signal);
  const execAvailable = typeof appServer?.execCommand === 'function';
  const checkResults = checks.map((check) => {
    const command = Array.isArray(check?.argv) ? check.argv[0] : null;
    if (contract?.source === 'agent') {
      const status = !execAvailable ? 'unavailable' : policy.mode === 'unknown' ? 'unknown' : 'available';
      return { id: String(check?.id || '').slice(0, 64), status,
        reason: !execAvailable ? 'exec_command_unavailable' : policy.mode !== 'inherit' ? policy.reason || 'sandbox_policy_unavailable' : null,
        dependencies: 'unverified' };
    }
    const executable = findExecutable(command, workspace, env);
    return { id: String(check?.id || '').slice(0, 64), status: executable.status, reason: executable.reason || null, dependencies: 'unverified' };
  });
  const statuses = checkResults.map((entry) => entry.status);
  const status = statuses.includes('unavailable') ? 'unavailable'
    : statuses.includes('unknown') ? 'unknown'
      : checks.length ? 'available' : 'not_required';
  const route = routeIdentity({ project: workspace, contract, policy, policySetting: executionPermissions });
  return {
    schema: 'verification-preflight/v1',
    scope: 'local_route_capability_only',
    status,
    route,
    policy: { mode: policy.mode, reason: policy.reason },
    checks: checkResults,
    evidence: 'Capability presence only. Dependencies, sockets, runtime behavior, test results, review receipts, and external CI are unverified.',
  };
}

module.exports = { findExecutable, preflightVerification };
