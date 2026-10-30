'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { nativeSandboxPolicy } = require('./execution-permissions');

const capabilities = new WeakMap();

function canonicalExisting(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try { return fs.realpathSync(value); } catch (_) { return null; }
}

function nativeWorkspaceWriteBinding(permissionMode, workspace) {
  const canonicalWorkspace = canonicalExisting(workspace);
  if (!canonicalWorkspace || permissionMode?.mode !== 'inherit' || permissionMode.profileApi !== false
    || permissionMode.sandboxMode !== 'workspace-write'
    || permissionMode.writerProfile) return null;
  const explicitWritableRoots = Array.isArray(permissionMode.sandboxWorkspaceWrite?.writable_roots)
    ? permissionMode.sandboxWorkspaceWrite.writable_roots
      .filter((root, index, roots) => typeof root === 'string' && path.isAbsolute(root) && roots.indexOf(root) === index)
    : [];
  return {
    workspace: canonicalWorkspace,
    sandboxPolicy: nativeSandboxPolicy(canonicalWorkspace, 'workspace-write', permissionMode.sandboxWorkspaceWrite),
    explicitWritableRoots,
    approvalPolicy: permissionMode.approvalPolicy ?? null,
    approvalsReviewer: permissionMode.approvalsReviewer ?? null,
  };
}

function createLaneExecutionCapability({ laneId, workspace, lanePath, binding, isCurrent } = {}) {
  const canonicalWorkspace = canonicalExisting(workspace);
  const canonicalLane = canonicalExisting(lanePath);
  if (typeof laneId !== 'string' || !laneId || !canonicalWorkspace || !canonicalLane
    || canonicalWorkspace !== binding?.workspace || typeof isCurrent !== 'function' || isCurrent() !== true) {
    throw new TypeError('A current admitted native lane is required');
  }
  const capability = Object.freeze(Object.create(null));
  capabilities.set(capability, { laneId, workspace: canonicalWorkspace, lanePath: canonicalLane, binding, isCurrent });
  return capability;
}

function isLaneExecutionCapability(value) {
  return Boolean(value && typeof value === 'object' && capabilities.has(value));
}

function resolveLaneExecutionPolicy(capability, { cwd, permissionWorkspace, permissionMode, verifierIpcNetworkAccess = false } = {}) {
  const record = capabilities.get(capability);
  if (!record) throw new TypeError('A host-owned lane execution capability is required');
  const canonicalCwd = canonicalExisting(cwd);
  const canonicalWorkspace = canonicalExisting(permissionWorkspace);
  if (!canonicalCwd || !canonicalWorkspace || cwd !== canonicalCwd || permissionWorkspace !== canonicalWorkspace
    || canonicalCwd !== record.lanePath || canonicalWorkspace !== record.workspace || record.isCurrent() !== true) {
    throw new Error('Native lane execution identity is no longer current');
  }
  const currentBinding = nativeWorkspaceWriteBinding(permissionMode, canonicalWorkspace);
  if (!currentBinding || JSON.stringify(currentBinding) !== JSON.stringify(record.binding)) {
    throw new Error('Native workspace-write policy changed after lane admission');
  }
  const sandboxPolicy = { ...currentBinding.sandboxPolicy, writableRoots: [record.lanePath, ...currentBinding.explicitWritableRoots] };
  if (verifierIpcNetworkAccess) sandboxPolicy.networkAccess = true;
  return {
    sandboxPolicy,
    approvalSettings: {
      approvalPolicy: permissionMode.approvalPolicy,
      approvalsReviewer: permissionMode.approvalsReviewer,
    },
  };
}

module.exports = { nativeWorkspaceWriteBinding, createLaneExecutionCapability, isLaneExecutionCapability, resolveLaneExecutionPolicy };
