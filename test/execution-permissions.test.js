'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { projectTrust, resolveExecutionPermissions } = require('../src/execution-permissions');

function makeConfigServer(config, { profiles, readError = null, requestError = null } = {}) {
  const entries = profiles || [
    { id: ':read-only', allowed: true },
    { id: ':workspace', allowed: true },
    { id: 'custom-writer', allowed: true },
  ];
  return {
    async start() {},
    async readConfig() {
      if (readError) throw readError;
      return { config };
    },
    async _request(method, params) {
      assert.equal(method, 'permissionProfile/list');
      assert.equal(typeof params.cwd, 'string');
      if (requestError) throw requestError;
      return { data: entries };
    },
  };
}

function makeTempTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-permissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const nested = path.join(project, 'nested');
  fs.mkdirSync(path.join(nested, 'child'), { recursive: true });
  return { root, project, nested, child: path.join(nested, 'child') };
}

test('exact, ancestor, and canonical project paths use the nearest explicit trust entry', (t) => {
  const { project, nested, child } = makeTempTree(t);
  const alias = path.join(path.dirname(project), 'nested-alias');
  fs.symlinkSync(nested, alias, 'dir');
  const config = {
    projects: {
      [project]: { trust_level: 'trusted' },
      [alias]: { trust_level: 'untrusted' },
    },
  };

  assert.equal(projectTrust(config, project), 'trusted');
  assert.equal(projectTrust(config, nested), 'untrusted');
  assert.equal(projectTrust(config, child), 'untrusted');
});

test('a path-prefix sibling does not inherit a trusted project entry', () => {
  const config = { projects: { '/workspace/project': { trust_level: 'trusted' } } };
  assert.equal(projectTrust(config, '/workspace/project-neighbor'), null);
});

test('trusted projects inherit the permitted native writer and owner approval settings', async (t) => {
  const { project } = makeTempTree(t);
  const server = makeConfigServer({
    projects: { [project]: { trust_level: 'trusted' } },
    default_permissions: 'custom-writer',
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
  });

  const resolved = await resolveExecutionPermissions(server, project);
  assert.equal(resolved.mode, 'inherit');
  assert.equal(resolved.profileApi, true);
  assert.equal(resolved.readOnlyProfile, ':read-only');
  assert.equal(resolved.writerProfile, 'custom-writer');
  assert.equal(resolved.approvalPolicy, 'on-request');
  assert.equal(resolved.approvalsReviewer, 'user');
});

test('a trusted project with omitted permission fields inherits the allowed built-in workspace profile', async (t) => {
  const { project } = makeTempTree(t);
  const server = makeConfigServer({
    projects: { [project]: { trust_level: 'trusted' } },
    approval_policy: 'on-request',
  });

  const resolved = await resolveExecutionPermissions(server, project);
  assert.equal(resolved.mode, 'inherit');
  assert.equal(resolved.profileApi, true);
  assert.equal(resolved.writerProfile, ':workspace');
  assert.equal(resolved.approvalPolicy, 'on-request');
});

test('a managed-denied writer profile or unavailable native config falls back to strict mode', async (t) => {
  const { project } = makeTempTree(t);
  const denied = makeConfigServer({
    projects: { [project]: { trust_level: 'trusted' } },
    default_permissions: 'custom-writer',
    approval_policy: 'never',
  }, { profiles: [
    { id: ':read-only', allowed: true },
    { id: ':workspace', allowed: true },
    { id: 'custom-writer', allowed: false },
  ] });
  const unavailable = makeConfigServer({}, { readError: new Error('config unavailable') });

  for (const server of [denied, unavailable]) {
    const resolved = await resolveExecutionPermissions(server, project);
    assert.equal(resolved.mode, 'strict');
    assert.equal(resolved.writerProfile, undefined);
    assert.notEqual(resolved.approvalPolicy, 'never');
  }
});

test('an explicit strict request does not inherit a permitted writable profile or approvals', async (t) => {
  const { project } = makeTempTree(t);
  const server = makeConfigServer({
    projects: { [project]: { trust_level: 'trusted' } },
    default_permissions: 'custom-writer',
    approval_policy: 'never',
    approvals_reviewer: 'user',
  });

  const resolved = await resolveExecutionPermissions(server, project, 'strict');
  assert.equal(resolved.mode, 'strict');
  assert.equal(resolved.reason, 'strict_setting');
  assert.equal(resolved.writerProfile, undefined);
  assert.equal(resolved.approvalPolicy, undefined);
  assert.equal(resolved.approvalsReviewer, undefined);
});
