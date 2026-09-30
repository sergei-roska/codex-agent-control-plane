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
//
// DASHBOARD_DEV_SCENARIO=delivery: the workspace becomes a tiny node project (one passing test on main)
// with a project.json check "unit"; ticket Submit drives PM Intake -> plan -> branch -> lead run -> review.
// Ticket title keywords: "[ask]" intake asks 2 questions first; "[break]" builder breaks the test;
// "[bug]" classification bugfix; otherwise a ready feature.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const {
  decision, assignment, workerReport, makeFakeAppServer, planStage, readyIntake, needsInputIntake,
} = require('../test/fixtures/fake-app-server');

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

const GOOD_SOURCE = "module.exports = () => 'hello';\nmodule.exports.farewell = () => 'bye';\n";
const BROKEN_SOURCE = "module.exports = () => 'broken';\n";
const CHECK = { id: 'unit', argv: ['node', '--test'], timeoutMs: 60000, description: 'Node built-in test runner' };

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function setupDeliveryWorkspace(workspace) {
  if (fs.existsSync(path.join(workspace, '.git'))) return;
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'test'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"tiny","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), "module.exports = () => 'hello';\n");
  fs.writeFileSync(path.join(workspace, 'test', 'tiny.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst greet = require('../src/greet');\ntest('greet', () => assert.equal(greet(), 'hello'));\n");
  git(workspace, 'init', '-q', '-b', 'main');
  git(workspace, 'config', 'user.email', 'dev@example.com');
  git(workspace, 'config', 'user.name', 'Dev Harness');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'base');
}

// Scripted Intake, lead and builder behaviour keyed on the ticket title (see header).
function deliveryFake(workspace) {
  const STAGES = [
    planStage('explore', 'orch-explorer', { required: false }),
    planStage('build', 'orch-builder', { dependencies: ['explore'], allowedFiles: ['src/greet.js'] }),
    planStage('verify', 'orch-verifier', { dependencies: ['build'], allowedFiles: ['test/tiny.test.js'] }),
    planStage('audit', 'orch-auditor', { dependencies: ['build'] }),
  ];
  let breakMode = false;
  const intake = (call, input) => {
    const title = (/^Title: (.*)$/m.exec(input) || [])[1] || '';
    if (title.includes('[ask]') && !input.includes('PRIOR Q AND A')) {
      return needsInputIntake([
        { id: 'q1', question: 'Which greeting word should be used?', why: 'It changes the returned string' },
        { id: 'q2', question: 'Should the helper be exported by name?', why: 'It changes the module shape' },
      ]);
    }
    return readyIntake({ classification: title.includes('[bug]') ? 'bugfix' : 'feature', stages: STAGES });
  };
  const lead = (call, input) => {
    const goal = (/^Title: (.*)$/m.exec(input) || [])[1] || '';
    breakMode = goal.includes('[break]');
    const eligible = ((/Next eligible stages: ([^.\n]*)\./.exec(input) || [])[1] || 'none').split(', ').filter((id) => id && id !== 'none');
    if (eligible.length === 0) return decision({ final: 'Dev harness delivery finished.' });
    const stage = STAGES.find((entry) => entry.stageId === eligible[0]);
    return decision({
      action: 'dispatch',
      assignments: [assignment(stage.roleId, { stageId: stage.stageId, allowedFiles: stage.allowedFiles })],
    });
  };
  const workerImpl = async ({ role }) => {
    if (role === 'orch-builder') {
      fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), breakMode ? BROKEN_SOURCE : GOOD_SOURCE);
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('built'), filesChanged: ['src/greet.js'] }) };
    }
    return { threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('ok')) };
  };
  return makeFakeAppServer({
    intakeScript: Array(RUNS * 4).fill(intake),
    leadScript: Array(RUNS * 12).fill(lead),
    workerImpl,
  });
}

async function main() {
  const delivery = process.env.DASHBOARD_DEV_SCENARIO === 'delivery';
  if (delivery) {
    // The approved check runs `node --test`; inherited runner context would make it skip the file and exit 0.
    delete process.env.NODE_TEST_CONTEXT;
  }
  const workspace = path.join(DEV_DIR, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  if (delivery) {
    setupDeliveryWorkspace(workspace);
  } else if (!fs.existsSync(path.join(workspace, '.git'))) {
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
  let projectConfigFile;
  if (delivery) {
    projectConfigFile = path.join(DEV_DIR, 'project.json');
    fs.writeFileSync(projectConfigFile, JSON.stringify({ baseRef: 'main', checks: [CHECK] }, null, 2));
  }
  const runtime = await startServer({
    port: Number(process.env.PORT || 3000),
    workspace,
    appServer: withTurnDelay(delivery ? deliveryFake(workspace) : makeFakeAppServer({ leadScript }), TURN_DELAY_MS),
    projectConfigFile,
    stateFile: path.join(DEV_DIR, 'state.sqlite'),
    tokenFile: path.join(DEV_DIR, 'a2a-token'),
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 50 }),
  });
  process.stdout.write(`Dashboard dev server listening at http://${runtime.host}:${runtime.port}\n`);
  const { code } = runtime.dashboardAuth.issuePairingCode();
  process.stdout.write(`Dashboard pairing URL: ${runtime.dashboardAuth.pairingUrl(code)}\n`);
  if (delivery) {
    // kill -USR2 <pid>: discard uncommitted changes and return the harness workspace to main, so the
    // next ticket passes the clean-tree preflight. Only send it while no run holds the repository.
    process.on('SIGUSR2', () => {
      try {
        git(workspace, 'reset', '--hard', '-q');
        git(workspace, 'clean', '-fdq');
        git(workspace, 'checkout', '-q', 'main');
        process.stdout.write('Dev workspace reset to clean main\n');
      } catch (error) {
        process.stderr.write(`Workspace reset failed: ${error?.message || String(error)}\n`);
      }
    });
  }
  const shutdown = () => runtime.close().finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
