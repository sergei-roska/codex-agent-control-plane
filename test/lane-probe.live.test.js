'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { CodexAppServer } = require('../src/codex-app-server');
const { runConfinementProbe } = require('../src/lane-probe');

// Real App Server, no model calls. Skipped unless CODEX_A2A_LIVE_PROBE=1.
const enabled = process.env.CODEX_A2A_LIVE_PROBE === '1';
// Not under /tmp: the default workspaceWrite policy makes /tmp writable, which would mask real results.
const LIVE_BASE = process.env.CODEX_A2A_LIVE_PROBE_BASE || os.homedir();

function sh(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
}

test('live confinement probe against the installed Codex App Server', { skip: !enabled, timeout: 120000 }, async (t) => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(LIVE_BASE, 'live-probe-repo-')));
  const lanesRoot = fs.mkdtempSync(path.join(LIVE_BASE, 'live-probe-lanes-'));
  const appServer = new CodexAppServer();
  t.after(async () => {
    await appServer.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(lanesRoot, { recursive: true, force: true });
  });
  sh(workspace, 'init', '-q');
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.venv/\n');
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'tracked\n');
  sh(workspace, 'add', '.gitignore', 'tracked.txt');
  sh(workspace, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(workspace, 'untracked.txt'), 'untracked\n');
  fs.mkdirSync(path.join(workspace, '.venv'));
  fs.writeFileSync(path.join(workspace, '.venv', 'lib.txt'), 'lib\n');

  const result = await runConfinementProbe({ appServer, workspace, lanesRoot, links: ['.venv'] });
  console.log(JSON.stringify(result, null, 2));
  assert.ok(Array.isArray(result.checks));
});
