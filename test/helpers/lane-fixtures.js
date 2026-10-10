'use strict';

// Throwaway git repositories and App Server fakes for writer-lane tests. Every repository
// lives in a fresh temp directory; nothing here touches a real repository.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function sh(dir, ...args) {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeRepo(files = {}) {
  const dir = tmp('lane-repo-');
  sh(dir, 'init', '-q');
  const all = { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b1\n', 'src/x.js': 'x\n', ...files };
  for (const [rel, content] of Object.entries(all)) write(dir, rel, content);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// path -> content for every file outside .git.
function readTree(dir, rel = '') {
  const out = {};
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const r = path.join(rel, entry.name);
    if (entry.isDirectory()) Object.assign(out, readTree(dir, r));
    else out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
  }
  return out;
}

// Fake `command/exec` for the confinement probe: a touch lands only inside the lane (cwd),
// unless `leak` lets every write through (an escaping sandbox).
function probeExec({ leak = false } = {}) {
  const calls = [];
  async function execCommand({ command, cwd }) {
    calls.push({ command, cwd });
    const script = command[2];
    const target = command[4];
    if (script.startsWith('touch') && target) {
      let dir = null;
      try { dir = fs.realpathSync(path.dirname(target)); } catch (_) { dir = null; }
      const lane = fs.realpathSync(cwd);
      if (dir && (leak || dir === lane || dir.startsWith(`${lane}${path.sep}`))) fs.writeFileSync(path.join(dir, path.basename(target)), '');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  return { calls, execCommand };
}

module.exports = { sh, tmp, write, makeRepo, readTree, probeExec };
