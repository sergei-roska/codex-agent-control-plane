'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { runConfinementProbe, createLaneProbeStore } = require('../src/lane-probe');

// All repositories here are throwaway temp directories.
function sh(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-repo-')));
  sh(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.venv/\n');
  fs.mkdirSync(path.join(dir, '.venv'));
  fs.writeFileSync(path.join(dir, '.venv', 'lib.txt'), 'lib\n');
  sh(dir, 'add', 'a.txt', '.gitignore');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// Fake App Server. A write outside the lane is applied for real only when its kind is in
// `escapes` (workspace, common, admin, link); a git write only when 'commit'/'stash' is.
function fakeAppServer({ escapes = [], workspace, throwOnCall = false } = {}) {
  const calls = [];
  return {
    calls,
    getVersion: () => 'fake-1.0',
    async execCommand({ command, cwd, sandboxPolicy }) {
      calls.push({ command, cwd, sandboxPolicy });
      if (throwOnCall) throw new Error('rpc down');
      const script = command[2];
      const args = command.slice(4);
      if (script.startsWith('touch')) {
        const target = args[0];
        const realDir = fs.realpathSync(path.dirname(target));
        const real = path.join(realDir, path.basename(target));
        let kind = null;
        if (real.startsWith(`${workspace}${path.sep}.venv`)) kind = 'link';
        else if (realDir.startsWith(fs.realpathSync(cwd))) kind = 'lane';
        else if (path.basename(target).startsWith('.pw-probe')) kind = 'workspace';
        else if (target.includes(`${path.sep}worktrees${path.sep}`)) kind = 'admin';
        else kind = 'common';
        if (kind === 'lane' || escapes.includes(kind)) fs.writeFileSync(real, '');
      } else if (script.includes(' commit ') && escapes.includes('commit')) {
        sh(cwd, 'commit', '-q', '--allow-empty', '-m', 'probe');
      } else if (script.includes(' stash ') && escapes.includes('stash')) {
        sh(cwd, 'stash', 'push', '-u', '-m', 'probe');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function setup(t, options = {}) {
  const workspace = makeRepo();
  const lanesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-lanes-'));
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(lanesRoot, { recursive: true, force: true });
  });
  return { workspace, lanesRoot, appServer: fakeAppServer({ workspace, ...options }) };
}

function leftovers(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.name.includes('pw-probe')) found.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found;
}

test('all-confined probe passes, uses the lane policy, and leaves no trace', async (t) => {
  const { workspace, lanesRoot, appServer } = setup(t);
  const before = sh(workspace, 'for-each-ref') + sh(workspace, 'status', '--porcelain');
  const result = await runConfinementProbe({ appServer, workspace, lanesRoot, links: ['.venv'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.version, 'fake-1.0');
  assert.equal(result.reason, null);
  assert.deepEqual(result.checks.map((check) => check.name), [
    'control_lane_write', 'shared_workspace_write', 'git_common_dir_write', 'lane_admin_dir_write',
    'link_write:.venv', 'git_commit', 'git_stash', 'shared_state_unchanged',
  ]);
  assert.ok(result.checks.every((check) => check.escaped === false));
  assert.deepEqual(appServer.calls[0].sandboxPolicy, {
    type: 'workspaceWrite', writableRoots: [appServer.calls[0].cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  });
  assert.ok(appServer.calls.every((call) => call.cwd.startsWith(lanesRoot)));
  assert.deepEqual(leftovers(workspace), []);
  assert.deepEqual(fs.readdirSync(lanesRoot), []);
  assert.equal(sh(workspace, 'worktree', 'list').trim().split('\n').length, 1);
  assert.equal(sh(workspace, 'for-each-ref') + sh(workspace, 'status', '--porcelain'), before);
});

for (const [kind, name] of [
  ['workspace', 'shared_workspace_write'],
  ['common', 'git_common_dir_write'],
  ['admin', 'lane_admin_dir_write'],
  ['link', 'link_write:.venv'],
  ['commit', 'git_commit'],
  ['stash', 'git_stash'],
]) {
  test(`escape via ${kind} fails the probe naming ${name}`, async (t) => {
    const { workspace, lanesRoot, appServer } = setup(t, { escapes: [kind] });
    const result = await runConfinementProbe({ appServer, workspace, lanesRoot, links: ['.venv'] });
    assert.equal(result.ok, false);
    const escaped = result.checks.filter((check) => check.escaped).map((check) => check.name);
    assert.ok(escaped.includes(name), `${escaped} should include ${name}`);
    assert.ok(result.reason.includes(name), result.reason);
    assert.deepEqual(leftovers(workspace), []);
    assert.deepEqual(fs.readdirSync(lanesRoot), []);
  });
}

test('a shared workspace under a writable /tmp fails the probe', async (t) => {
  // /tmp stays writable in the lane policy, so a /tmp workspace is writable from the lane.
  const { workspace, lanesRoot, appServer } = setup(t, { escapes: ['workspace', 'common', 'admin', 'link'] });
  assert.ok(workspace.startsWith(os.tmpdir()));
  const result = await runConfinementProbe({ appServer, workspace, lanesRoot, links: ['.venv'] });
  assert.equal(result.ok, false);
  assert.ok(result.checks.find((check) => check.name === 'shared_workspace_write').escaped);
});

test('execCommand failure yields ok false with the error reason and cleans up', async (t) => {
  const { workspace, lanesRoot, appServer } = setup(t, { throwOnCall: true });
  const result = await runConfinementProbe({ appServer, workspace, lanesRoot, links: ['.venv'] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /probe_error: rpc down/);
  assert.deepEqual(fs.readdirSync(lanesRoot), []);
});

test('non-repo workspace is not eligible', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-plain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await runConfinementProbe({ appServer: fakeAppServer({ workspace: dir }), workspace: dir, lanesRoot: path.join(dir, 'lanes') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_eligible');
});

test('a sandbox that cannot write the lane fails as unusable', async (t) => {
  const { workspace, lanesRoot } = setup(t);
  const appServer = { getVersion: () => 'v', execCommand: async () => ({ exitCode: 1, stdout: '', stderr: 'denied' }) };
  const result = await runConfinementProbe({ appServer, workspace, lanesRoot, links: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sandbox_unusable');
});

test('lane probe store round-trips and upserts by version', () => {
  const db = new Database(':memory:');
  const store = createLaneProbeStore(db);
  assert.equal(store.get('1.0'), null);
  const checks = [{ name: 'x', escaped: false, detail: 'blocked' }];
  store.put({ version: '1.0', ok: true, reason: null, checks });
  const row = store.get('1.0');
  assert.equal(row.ok, true);
  assert.equal(row.reason, null);
  assert.deepEqual(row.checks, checks);
  store.put({ version: '1.0', ok: false, reason: 'escaped: x', checks });
  assert.equal(store.get('1.0').ok, false);
  assert.equal(store.get('1.0').reason, 'escaped: x');
  store.put({ version: null, ok: false, reason: 'r', checks: [] });
  assert.equal(store.get(null).reason, 'r');
  db.close();
});
