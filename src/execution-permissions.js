'use strict';

const fs = require('node:fs');
const path = require('node:path');

const READ_ONLY_PROFILE = ':read-only';
const WORKSPACE_PROFILE = ':workspace';
const DANGER_FULL_ACCESS_PROFILE = ':danger-full-access';

function nativeSandboxPolicy(workspace, mode, settings = null) {
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  const writableRoots = [workspace, ...(Array.isArray(settings?.writable_roots) ? settings.writable_roots : [])]
    .filter((root, index, roots) => typeof root === 'string' && path.isAbsolute(root) && roots.indexOf(root) === index);
  return {
    type: 'workspaceWrite',
    writableRoots,
    networkAccess: settings?.network_access === true,
    excludeTmpdirEnvVar: settings?.exclude_tmpdir_env_var === true,
    excludeSlashTmp: settings?.exclude_slash_tmp === true,
  };
}

function withVerifierIpcNetworkAccess(policy) {
  if (policy?.type !== 'workspaceWrite') return policy;
  return { ...policy, networkAccess: true };
}

function scopedVerifierSandboxPolicy(scratchRoot) {
  if (typeof scratchRoot !== 'string' || !path.isAbsolute(scratchRoot)) throw new TypeError('A canonical verifier scratch root is required');
  return {
    type: 'workspaceWrite',
    writableRoots: [scratchRoot],
    networkAccess: true,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

function canonicalPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try { return fs.realpathSync(value); } catch (_) { return path.resolve(value); }
}

function projectTrust(config, cwd) {
  const canonicalCwd = canonicalPath(cwd);
  if (!canonicalCwd || !config?.projects || typeof config.projects !== 'object') return null;
  const matches = [];
  for (const [configuredPath, project] of Object.entries(config.projects)) {
    const canonicalProject = canonicalPath(configuredPath);
    if (!canonicalProject || !project || typeof project !== 'object') continue;
    const relative = path.relative(canonicalProject, canonicalCwd);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      matches.push({ root: canonicalProject, trust: project.trust_level });
    }
  }
  matches.sort((a, b) => b.root.length - a.root.length);
  return matches[0]?.trust === 'trusted' ? 'trusted' : matches[0] ? 'untrusted' : null;
}

function profilesById(response) {
  if (!Array.isArray(response?.data)) return null;
  return new Map(response.data.filter((entry) => typeof entry?.id === 'string').map((entry) => [entry.id, entry]));
}

async function readPermissionContext(appServer, cwd) {
  if ((typeof appServer?.readConfig !== 'function' && typeof appServer?._request !== 'function') || typeof cwd !== 'string') return null;
  try {
    await appServer.start?.();
    const [configResponse, profileResponse] = await Promise.all([
      typeof appServer.readConfig === 'function' ? appServer.readConfig(cwd) : appServer._request('config/read', { cwd, includeLayers: false }),
      appServer._request('permissionProfile/list', { cwd }),
    ]);
    const config = configResponse?.config || configResponse;
    const profiles = profilesById(profileResponse);
    if (!config || !profiles) return null;
    const trust = projectTrust(config, cwd)
      || (configResponse?.workspaceTrust === 'trusted' ? 'trusted' : configResponse?.workspaceTrust === 'untrusted' ? 'untrusted' : null);
    const modern = typeof config.default_permissions === 'string'
      || (config.permissions && typeof config.permissions === 'object')
      || config.sandbox_mode == null;
    const configuredProfileId = modern ? (config.default_permissions || ':workspace') : null;
    const configuredProfile = modern ? profiles.get(configuredProfileId) : null;
    const profileReady = profiles.get(READ_ONLY_PROFILE)?.allowed === true
      && (!modern || configuredProfile?.allowed === true);
    const legacySandboxReady = ['read-only', 'workspace-write', 'danger-full-access'].includes(config.sandbox_mode);
    return {
      trusted: trust === 'trusted',
      available: trust === 'trusted' && profileReady && (modern || legacySandboxReady),
      profileApi: true,
      modern,
      configuredProfile: configuredProfileId,
      approvalPolicy: config.approval_policy ?? null,
      approvalsReviewer: config.approvals_reviewer ?? null,
      sandboxMode: config.sandbox_mode ?? null,
      sandboxWorkspaceWrite: config.sandbox_workspace_write && typeof config.sandbox_workspace_write === 'object'
        ? { ...config.sandbox_workspace_write }
        : null,
      profileReady,
      workspaceProfileReady: profiles.get(WORKSPACE_PROFILE)?.allowed === true,
      profiles,
    };
  } catch (_) {
    return null;
  }
}

async function resolveExecutionPermissions(appServer, cwd, requested = 'inherit') {
  if (requested === 'strict') {
    return {
      mode: 'strict',
      profileApi: false,
      reason: 'strict_setting',
    };
  }
  const context = await readPermissionContext(appServer, cwd);
  if (requested === 'full-access') {
    if (!context?.trusted) {
      return { mode: 'denied', profileApi: true, reason: 'full_access_permission_context_unavailable' };
    }
    if (context.profiles?.get(DANGER_FULL_ACCESS_PROFILE)?.allowed !== true) {
      return { mode: 'denied', profileApi: true, reason: 'full_access_profile_not_allowed' };
    }
    return {
      mode: 'full-access', profileApi: true, writerProfile: DANGER_FULL_ACCESS_PROFILE,
      approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: context.sandboxMode,
      reason: null,
    };
  }
  if (!context?.available) {
    return {
      mode: 'strict',
      profileApi: false,
      reason: 'native_policy_unavailable',
    };
  }
  return {
    mode: 'inherit',
    profileApi: context.modern,
    readOnlyProfile: READ_ONLY_PROFILE,
    writerProfile: context.modern ? context.configuredProfile : null,
    approvalPolicy: context.approvalPolicy,
    approvalsReviewer: context.approvalsReviewer,
    sandboxMode: context.sandboxMode,
    sandboxWorkspaceWrite: context.sandboxWorkspaceWrite,
    reason: null,
  };
}

module.exports = {
  READ_ONLY_PROFILE,
  WORKSPACE_PROFILE,
  DANGER_FULL_ACCESS_PROFILE,
  projectTrust,
  readPermissionContext,
  resolveExecutionPermissions,
  nativeSandboxPolicy,
  withVerifierIpcNetworkAccess,
  scopedVerifierSandboxPolicy,
};
