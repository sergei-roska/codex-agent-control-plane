'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const launcherPath = path.resolve(__dirname, '..', 'launcher.js');

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`launcher child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function launch(port, runtimeDir) {
  const child = spawn(process.execPath, [launcherPath], {
    cwd: path.dirname(launcherPath),
    env: { ...process.env, LAUNCHER_PORT: String(port), LAUNCHER_RUNTIME_DIR: runtimeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test('launcher exits promptly with a port hint and no ready log when binding fails', async () => {
  const occupied = net.createServer();
  const port = await listen(occupied);
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-bind-failure-'));
  try {
    const process = launch(port, runtimeDir);
    const result = await waitForExit(process.child);
    assert.notEqual(result.code, 0);
    assert.equal(result.signal, null);
    assert.match(process.stderr, new RegExp(`127\\.0\\.0\\.1:${port}.*already in use`));
    assert.match(process.stderr, /LAUNCHER_PORT/);
    assert.doesNotMatch(process.stdout, /Launcher listening at:/);
  } finally {
    await close(occupied);
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('launcher becomes ready on a free port and shuts down cleanly', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-bind-success-'));
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  let process;
  try {
    process = launch(port, runtimeDir);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('launcher did not report readiness')), 5000);
      process.child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`launcher exited before readiness (${code ?? signal})`));
      });
      const onOutput = () => {
        if (!process.stdout.includes(`Launcher listening at: http://127.0.0.1:${port}`)) return;
        clearTimeout(timer);
        process.child.stdout.removeListener('data', onOutput);
        resolve();
      };
      process.child.stdout.on('data', onOutput);
      onOutput();
    });
    process.child.kill('SIGTERM');
    const result = await waitForExit(process.child);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  } finally {
    if (process && process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
