'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const { startServer } = require(path.join(root, 'src/server'));
const owned = fs.mkdtempSync(path.join(__dirname, 'native-startup-'));
const workspace = path.join(owned, 'workspace');
fs.mkdirSync(workspace);
const git = (...args) => execFileSync('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe' });
(async () => {
  const evidence = { schemaVersion: 1, modelTurns: 0, managedProjectChanges: false };
  let server = null;
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Disposable startup probe\n');
    git('add', 'README.md');
    git('-c', 'user.name=NativeProbe', '-c', 'user.email=native-probe@example.invalid', 'commit', '-q', '-m', 'Initialize disposable startup workspace');
    const tokenFile = path.join(owned, 'a2a-token');
    const settingsFile = path.join(owned, 'project-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, executionPermissions: 'inherit' }) + '\n');
    server = await startServer({ workspace, port: 0, stateFile: path.join(owned, 'state.sqlite'), tokenFile, projectSettingsFile: settingsFile, workspaceLockDir: path.join(owned, 'locks'), autoResume: false });
    const base = `http://${server.host}:${server.port}`;
    const response = await fetch(base + '/orchestrator/agent-card.json');
    evidence.agentCard = { status: response.status, name: (await response.json()).name };
    evidence.writerIsolation = server.writerIsolation || null;
    if (!response.ok) throw new Error('Startup did not expose the lead agent card');
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error.message;
    process.exitCode = 1;
  } finally {
    if (server) await server.close();
    fs.rmSync(owned, { recursive: true, force: true });
    fs.writeFileSync(path.join(__dirname, 'native-startup-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    process.stdout.write(JSON.stringify(evidence) + '\n');
  }
})();
