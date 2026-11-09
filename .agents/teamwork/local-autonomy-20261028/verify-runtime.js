'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexAppServer } = require('../../../src/codex-app-server');

async function main() {
  const reportPath = path.join(__dirname, 'runtime-applied.json');
  const applied = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const registry = JSON.parse(fs.readFileSync('.runtime/projects.json', 'utf8'));
  const project = registry.projects.find((entry) => entry.id === applied.projectId);
  const settings = JSON.parse(fs.readFileSync(`.runtime/projects/${project.id}/project-settings.json`, 'utf8'));
  assert.equal(settings.executionPermissions, 'full-access');
  const environment = Object.fromEntries(fs.readFileSync(`/proc/${applied.projectPid}/environ`).toString().split('\0').filter(Boolean).map((entry) => {
    const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)];
  }));
  const accountsDirectory = environment.CODEX_A2A_ACCOUNTS_DIR || path.join(os.homedir(), '.codex-a2a', 'accounts');
  const accounts = JSON.parse(fs.readFileSync(path.join(accountsDirectory, 'profiles.json'), 'utf8'));
  const home = accounts.profiles.find((entry) => entry.name === accounts.active)?.home || environment.CODEX_HOME || path.join(os.homedir(), '.codex');
  const server = new CodexAppServer({ codexHome: home });
  const originalRequest = server._request.bind(server);
  const wire = [];
  server._request = async (method, params, options) => {
    if (method === 'thread/start' || method === 'command/exec') {
      wire.push({ method, permissions: params.permissions || null, permissionProfile: params.permissionProfile || null, sandbox: params.sandbox || null, sandboxPolicy: params.sandboxPolicy?.type || null, approvalPolicy: params.approvalPolicy || null });
    }
    return originalRequest(method, params, options);
  };
  try {
    await server.start();
    const policy = await server.resolveExecutionPermissions(project.path, settings.executionPermissions, { fresh: true });
    assert.equal(policy.mode, 'full-access');
    assert.equal(policy.writerProfile, ':danger-full-access');
    assert.equal(policy.approvalPolicy, 'never');
    for (const id of ['coordinator', 'explorer', 'engineer', 'verifier']) {
      const thread = await server.prepareThread({ role: { id, name: id, sandbox: ['coordinator', 'explorer'].includes(id) ? 'read-only' : 'workspace-write', instructions: 'Local execution permission probe; do not run a model turn.', tools: { mcpServers: [], skills: false } }, cwd: project.path, permissionWorkspace: project.path, executionPermissions: 'full-access', ephemeral: true });
      assert.equal(thread.permissionMode, 'full-access');
    }
    const python = 'import pathlib,tempfile,uuid; root=pathlib.Path(tempfile.mkdtemp(prefix="harness-full-access-")); marker=root/"probe"; marker.write_text("ok"); marker.unlink(); root.rmdir(); cache=pathlib.Path.home()/".cache"/"uv"; cache.mkdir(parents=True,exist_ok=True); probe=cache/("harness-permission-probe-"+uuid.uuid4().hex); probe.write_text("ok"); probe.unlink(); print("tmp_and_uv_cache_writable")';
    const command = await server.execCommand({ command: ['python3', '-c', python], cwd: project.path, permissionProfile: policy.writerProfile, timeoutMs: 10000 });
    assert.equal(command.exitCode, 0, String(command.stderr).slice(0, 400));
    assert.match(command.stdout, /tmp_and_uv_cache_writable/);
    assert.equal(wire.filter((entry) => entry.method === 'thread/start').length, 4);
    assert.ok(wire.filter((entry) => entry.method === 'thread/start').every((entry) => entry.permissions === ':danger-full-access' && entry.approvalPolicy === 'never'));
    assert.ok(wire.some((entry) => entry.method === 'command/exec' && entry.permissionProfile === ':danger-full-access'));
    const result = { projectId: project.id, appServerVersion: server.getVersion(), executionPermissions: settings.executionPermissions, rolePreparation: ['coordinator', 'explorer', 'engineer', 'verifier'], approvalPolicy: 'never', command: { exitCode: 0, tmpWritable: true, uvCacheWritable: true }, wire, modelTurnsInvoked: 0 };
    fs.writeFileSync(path.join(__dirname, 'runtime-permissions-verified.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { await server.close(); }
}

main().catch((error) => { process.stderr.write(JSON.stringify({ name: error.name, code: error.code || null, message: error.message }) + '\n'); process.exitCode = 1; });
