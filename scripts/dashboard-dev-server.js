'use strict';

// Dashboard dev harness: real server + real lead orchestrator, fake Codex app server.
// State, token and workspace live under .runtime/dev/ (gitignored).
//
//   npm run dashboard:dev                      # listens on PORT (default 3000)
//
// Submit a run from another terminal (the fake lead dispatches orch-explorer, then finishes):
//   CODEX_A2A_TOKEN_FILE=.runtime/dev/a2a-token PORT=3000 npm run ask -- 'Explore the repo'
// Fresh pairing URL for the browser:
//   CODEX_A2A_TOKEN_FILE=.runtime/dev/a2a-token PORT=3000 npm run dashboard:pair

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { decision, assignment, makeFakeAppServer } = require('../test/fixtures/fake-app-server');

const DEV_DIR = process.env.DASHBOARD_DEV_DIR
  ? path.resolve(process.env.DASHBOARD_DEV_DIR)
  : path.resolve(__dirname, '..', '.runtime', 'dev');
const RUNS = Number(process.env.DASHBOARD_DEV_RUNS || 500);
// Delay per fake turn (lead and worker) so a run stays observable in the board.
const TURN_DELAY_MS = Number(process.env.DASHBOARD_DEV_TURN_DELAY_MS || 0);

function withTurnDelay(fake, delayMs) {
  if (!(delayMs > 0)) return fake;
  const run = fake.run.bind(fake);
  fake.run = async (args) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      args?.signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    return run(args);
  };
  return fake;
}

async function main() {
  const workspace = path.join(DEV_DIR, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  if (!fs.existsSync(path.join(workspace, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'README.md'), '# Dev workspace\n');
  }
  process.env.CODEX_A2A_WORKSPACE_LOCK_DIR = path.join(DEV_DIR, 'ws-lock');
  fs.mkdirSync(process.env.CODEX_A2A_WORKSPACE_LOCK_DIR, { recursive: true });

  const leadScript = [];
  for (let i = 0; i < RUNS; i += 1) {
    leadScript.push(decision({ action: 'dispatch', assignments: [assignment('orch-explorer')] }));
    leadScript.push(decision({ final: 'Dev harness run finished.' }));
  }
  const runtime = await startServer({
    port: Number(process.env.PORT || 3000),
    workspace,
    appServer: withTurnDelay(makeFakeAppServer({ leadScript }), TURN_DELAY_MS),
    stateFile: path.join(DEV_DIR, 'state.sqlite'),
    tokenFile: path.join(DEV_DIR, 'a2a-token'),
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 50 }),
  });
  process.stdout.write(`Dashboard dev server listening at http://${runtime.host}:${runtime.port}\n`);
  const { code } = runtime.dashboardAuth.issuePairingCode();
  process.stdout.write(`Dashboard pairing URL: ${runtime.dashboardAuth.pairingUrl(code)}\n`);
  const shutdown = () => runtime.close().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
