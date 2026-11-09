'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const { CodexAppServer } = require(path.join(root, 'src/codex-app-server'));
const { runAcceptance, validateAgentChecks } = require(path.join(root, 'src/acceptance'));
const workspace = fs.mkdtempSync(path.join(__dirname, 'native-workspace-'));
const app = new CodexAppServer({ codexHome: '/home/sr/codex-work', requestTimeoutMs: 15000 });
const git = (...args) => execFileSync('git', ['-C', workspace, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: 'pipe', encoding: 'utf8' });
(async () => {
  const evidence = { schemaVersion: 1, modelTurns: 0, managedProjectChanges: false };
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(workspace, 'check-socket.cjs'), "const net = require('node:net');\nconst server = net.createServer();\nserver.on('error', (error) => { process.stderr.write(error.code + '\\n'); process.exitCode = 1; });\nserver.listen(0, '127.0.0.1', () => server.close(() => process.stdout.write('loopback-ok\\n')));\n");
    git('add', 'check-socket.cjs');
    git('-c', 'user.name=NativeProbe', '-c', 'user.email=native-probe@example.invalid', 'commit', '-q', '-m', 'Initialize disposable probe');
    await app.start();
    const mode = await app.resolveExecutionPermissions(workspace, 'inherit');
    evidence.policy = { mode: mode.mode, writerProfile: mode.writerProfile, approvalPolicy: mode.approvalPolicy };
    if (mode.mode !== 'inherit') throw new Error('Native project policy did not inherit');
    const contract = validateAgentChecks([{ id: 'loopback', argv: ['node', 'check-socket.cjs'], timeoutMs: 10000 }], { workspace });
    const result = await runAcceptance({ workspace, runId: 'native-permission-probe', attempt: 1, contract, appServer: app, executionPermissions: 'inherit' });
    evidence.acceptance = { disposition: result.disposition, checks: result.checks.map((check) => ({ id: check.id, result: check.result, exitCode: check.exitCode, stdout: check.stdoutTail })) };
    if (result.disposition !== 'accepted') throw new Error('Inherited loopback acceptance did not pass');
    const before = git('rev-parse', 'HEAD').trim();
    const committed = await app.execCommand({ command: ['git', '-C', workspace, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=NativeProbe', '-c', 'user.email=native-probe@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Verify local Git access'], cwd: workspace, timeoutMs: 10000 });
    const after = git('rev-parse', 'HEAD').trim();
    evidence.localGit = { exitCode: committed.exitCode, commitCreated: before !== after, workspaceClean: git('status', '--porcelain').trim() === '' };
    if (committed.exitCode !== 0 || before === after) throw new Error('Native local Git operation did not complete');
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error.message;
    process.exitCode = 1;
  } finally {
    await app.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.writeFileSync(path.join(__dirname, 'native-development-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    process.stdout.write(JSON.stringify(evidence) + '\n');
  }
})();
