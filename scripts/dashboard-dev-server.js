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
// The harness also creates <DEV_DIR>/remote.git (bare) and adds it as `origin` of the workspace (idempotent).
// Ticket title keywords: "[ask]" intake asks 2 questions first; "[break]" Developer breaks the test and the
// repair executor (dlv-developer-xhigh) fixes it after the rejected acceptance; "[bug]" / "[docs]" / "[audit]"
// pick the bugfix / docs / audit preset, otherwise a ready feature. Env DASHBOARD_DEV_CATALOG_DOWN=1 fails listModels.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { startServer } = require('../src/server');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const {
  decision, assignment, workerReport, makeFakeAppServer, readyIntake, readyIntakeV2, planStage, planStageV2, needsInputIntake, defaultModels,
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
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Tiny\n');
  fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), "module.exports = () => 'hello';\n");
  fs.writeFileSync(path.join(workspace, 'test', 'tiny.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst greet = require('../src/greet');\ntest('greet', () => assert.equal(greet(), 'hello'));\n");
  git(workspace, 'init', '-q', '-b', 'main');
  git(workspace, 'config', 'user.email', 'dev@example.com');
  git(workspace, 'config', 'user.name', 'Dev Harness');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'base');
}

// Fixture remote: a bare repo inside DEV_DIR, registered as `origin` of the workspace. Idempotent.
function setupDeliveryRemote(workspace) {
  const remote = path.join(DEV_DIR, 'remote.git');
  if (!fs.existsSync(remote)) git(DEV_DIR, 'init', '-q', '--bare', remote);
  const remotes = git(workspace, 'remote').split('\n');
  if (!remotes.includes('origin')) git(workspace, 'remote', 'add', 'origin', remote);
}

// Presets (feature/bugfix/docs/audit) as scripted V2 Intake plans. Stage ids equal preset stage keys;
// roles are public ids, runtime ids are dlv-<public id>.
const PRESET_PLANS = {
  feature: [
    ['design', 'architect', []],
    ['implement', 'developer', ['design'], ['src/greet.js']],
    ['review', 'reviewer', ['implement']],
    ['qa', 'qa', ['implement'], ['test/tiny.test.js']],
  ],
  bugfix: [
    ['reproduce', 'qa', [], ['test/tiny.test.js']],
    ['implement', 'developer', ['reproduce'], ['src/greet.js']],
    ['review', 'reviewer', ['implement']],
    ['verify', 'qa', ['implement'], ['test/tiny.test.js']],
  ],
  docs: [
    ['write', 'tech-writer', [], ['README.md']],
    ['review', 'reviewer', ['write']],
  ],
  audit: [
    ['investigate', 'architect', []],
    ['synthesis', 'reviewer', ['investigate']],
  ],
};

function presetStages(presetId) {
  return PRESET_PLANS[presetId].map(([key, role, dependencies, allowedFiles = []]) => planStageV2(key, role, key, {
    dependencies, allowedFiles,
  }));
}

function classify(title) {
  if (title.includes('[bug]')) return 'bugfix';
  if (title.includes('[docs]')) return 'docs';
  if (title.includes('[audit]')) return 'audit';
  return 'feature';
}

// DASHBOARD_DEV_SCENARIO=atlassian enables an entirely local OAuth/source fixture. It never contacts Atlassian.
// DASHBOARD_DEV_ROLE_PACK=legacy-orch writes project.json rolePack and scripts the M3 orch-* delivery instead.
const ROLE_PACK = process.env.DASHBOARD_DEV_ROLE_PACK || null;
const LEGACY_STAGES = [
  planStage('explore', 'orch-explorer', { required: false }),
  planStage('build', 'orch-builder', { dependencies: ['explore'], allowedFiles: ['src/greet.js'] }),
  planStage('verify', 'orch-verifier', { dependencies: ['build'], allowedFiles: ['test/tiny.test.js'] }),
  planStage('audit', 'orch-auditor', { dependencies: ['build'] }),
];

// Scripted Intake, lead and workers keyed on the ticket title (see header).
function deliveryFake(workspace, fakeOptions = {}) {
  let breakMode = false;
  let repaired = false;
  let stages = presetStages('feature');
  const intake = (call, input) => {
    const title = (/^Title: (.*)$/m.exec(input) || [])[1] || '';
    if (title.includes('[ask]') && !input.includes('PRIOR Q AND A')) {
      return needsInputIntake([
        { id: 'q1', question: 'Which greeting word should be used?', why: 'It changes the returned string' },
        { id: 'q2', question: 'Should the helper be exported by name?', why: 'It changes the module shape' },
      ]);
    }
    if (ROLE_PACK === 'legacy-orch') return readyIntake({ classification: title.includes('[bug]') ? 'bugfix' : 'feature', stages: LEGACY_STAGES });
    const classification = classify(title);
    stages = presetStages(classification);
    return readyIntakeV2({ classification, stages, checkIds: classification === 'audit' ? [] : ['unit'] });
  };
  const lead = (call, input) => {
    const goal = (/^Title: (.*)$/m.exec(input) || [])[1] || '';
    if (ROLE_PACK === 'legacy-orch') {
      breakMode = goal.includes('[break]');
      stages = LEGACY_STAGES;
      const next = ((/Next eligible stages: ([^.\n]*)\./.exec(input) || [])[1] || 'none').split(', ').filter((id) => id && id !== 'none');
      if (next.length === 0) return decision({ final: 'Dev harness delivery finished.' });
      const legacyStage = LEGACY_STAGES.find((entry) => entry.stageId === next[0]);
      return decision({
        action: 'dispatch',
        assignments: [assignment(legacyStage.roleId, { stageId: legacyStage.stageId, allowedFiles: legacyStage.allowedFiles })],
      });
    }
    if (call === 1 || /Dispatch rounds already used: 0\//.test(input)) {
      breakMode = goal.includes('[break]');
      repaired = false;
      stages = presetStages(classify(goal));
    }
    const eligible = ((/Next eligible stages: ([^.\n]*)\./.exec(input) || [])[1] || 'none').split(', ').filter((id) => id && id !== 'none');
    if (breakMode && !repaired && input.includes('Acceptance note:')) {
      // Rejected acceptance: repair path, Developer stage retried by the repair executor.
      repaired = true;
      const stage = stages.find((entry) => entry.stageId === 'implement');
      return decision({
        action: 'dispatch',
        assignments: [assignment('dlv-developer-xhigh', { stageId: 'implement', allowedFiles: stage.allowedFiles })],
      });
    }
    if (eligible.length === 0) return decision({ final: 'Dev harness delivery finished.' });
    const stage = stages.find((entry) => entry.stageId === eligible[0]);
    return decision({
      action: 'dispatch',
      assignments: [assignment(`dlv-${stage.roleId}`, { stageId: stage.stageId, allowedFiles: stage.allowedFiles })],
    });
  };
  const workerImpl = async ({ role }) => {
    if (role === 'orch-builder') {
      fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), breakMode ? BROKEN_SOURCE : GOOD_SOURCE);
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('built'), filesChanged: ['src/greet.js'] }) };
    }
    if (role === 'dlv-developer' || role === 'dlv-developer-xhigh' || role === 'dlv-developer-sol') {
      const broken = breakMode && role === 'dlv-developer';
      fs.writeFileSync(path.join(workspace, 'src', 'greet.js'), broken ? BROKEN_SOURCE : GOOD_SOURCE);
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('implemented'), filesChanged: ['src/greet.js'] }) };
    }
    if (role === 'dlv-tech-writer') {
      fs.appendFileSync(path.join(workspace, 'README.md'), '\nGreeting helper: `greet()` returns "hello".\n');
      return { threadId: 'w', status: 'completed', text: JSON.stringify({ ...workerReport('documented'), filesChanged: ['README.md'] }) };
    }
    return { threadId: 'w', status: 'completed', text: JSON.stringify(workerReport('ok')) };
  };
  return makeFakeAppServer({
    intakeScript: Array(RUNS * 4).fill(intake),
    leadScript: Array(RUNS * 12).fill(lead),
    workerImpl,
    ...fakeOptions,
  });
}

// Default fake catalog, with gpt-6.1-sol limited to medium/high so the effort select visibly narrows.
function devModels() {
  return defaultModels().map((entry) => (entry.model === 'gpt-6.1-sol'
    ? { ...entry, supportedReasoningEfforts: entry.supportedReasoningEfforts.filter((e) => ['medium', 'high'].includes(e.reasoningEffort)) }
    : entry));
}

// Fake App Server account, rate limits and model catalog; DASHBOARD_DEV_CATALOG_DOWN=1 fails listModels.
function catalogOptions() {
  return {
    models: process.env.DASHBOARD_DEV_CATALOG_DOWN === '1' ? new Error('model catalog down (dev harness)') : devModels(),
    account: { account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' }, requiresOpenaiAuth: true },
    rateLimits: {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    },
  };
}

function atlassianFixtures() {
  const cloudId = 'dev-fixture-cloud';
  const resource = { id: cloudId, url: 'https://fixture.atlassian.net', name: 'Local Atlassian Fixture',
    scopes: ['read:jira-work', 'read:page:confluence', 'offline_access'] };
  let revision = 0;
  let connected = true;
  const states = new Map();
  const oauth = {
    getConnectionRevision: () => revision,
    async getHealth() { return { connected, scopes: connected ? [...resource.scopes] : [] }; },
    async getResources() { if (!connected) throw Object.assign(new Error('fixture disconnected'), { code: 'reconnect_required' }); return [{ ...resource, scopes: [...resource.scopes] }]; },
    async getAccessToken() { if (!connected) throw Object.assign(new Error('fixture disconnected'), { code: 'reconnect_required' }); return 'fixture-only-token'; },
    async beginAuthorization({ sessionId }) {
      const state = crypto.randomBytes(32).toString('base64url');
      states.set(state, sessionId);
      const url = new URL('https://auth.atlassian.com/authorize');
      url.searchParams.set('state', state);
      return { state, authorizationUrl: url.toString() };
    },
    cancelAuthorization({ sessionId, state }) {
      const canceled = states.get(state) === sessionId;
      if (canceled) states.delete(state);
      return { canceled };
    },
    async completeAuthorization({ sessionId, state, code }) {
      if (states.get(state) !== sessionId || code !== 'fixture-code') throw Object.assign(new Error('fixture denial'), { code: 'invalid_authorization_state' });
      states.delete(state); connected = true; revision += 1; return { connected: true };
    },
    async disconnect() { connected = false; revision += 1; return { disconnected: true }; },
  };
  const outage = process.env.DASHBOARD_DEV_ATLASSIAN_OUTAGE === '1';
  const provider = {
    async read(reference) {
      if (outage) return { ...reference, availability: 'unavailable', title: 'Fixture source unavailable', text: '', links: [] };
      if (reference.sourceKind !== 'jira' || !['DEMO-1', '10001'].includes(reference.externalId)) {
        return { ...reference, availability: 'missing', title: 'Fixture source not found', text: '', links: [] };
      }
      return { sourceKind: 'jira', originId: reference.originId, externalId: '10001', displayKey: 'DEMO-1',
        url: 'https://fixture.atlassian.net/browse/DEMO-1', sourceRevision: 'fixture-v1', title: 'Fixture import: bounded source context',
        text: 'Build a local source import with explicit provenance and an immutable fixture issue ID.', links: [], availability: 'available' };
    },
  };
  return { oauth, provider, cloudId };
}

async function main() {
  const delivery = process.env.DASHBOARD_DEV_SCENARIO === 'delivery';
  const atlassian = process.env.DASHBOARD_DEV_SCENARIO === 'atlassian' || process.env.DASHBOARD_DEV_ATLASSIAN_FIXTURES === '1'
    ? atlassianFixtures() : null;
  if (delivery) {
    // The approved check runs `node --test`; inherited runner context would make it skip the file and exit 0.
    delete process.env.NODE_TEST_CONTEXT;
  }
  const workspace = path.join(DEV_DIR, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  if (delivery) {
    setupDeliveryWorkspace(workspace);
    setupDeliveryRemote(workspace);
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
    fs.writeFileSync(projectConfigFile, JSON.stringify({ baseRef: 'main', checks: [CHECK], ...(ROLE_PACK ? { rolePack: ROLE_PACK } : {}) }, null, 2));
  }
  const runtime = await startServer({
    port: Number(process.env.PORT || 3000),
    workspace,
    appServer: withTurnDelay(delivery ? deliveryFake(workspace, catalogOptions()) : makeFakeAppServer({ leadScript }), TURN_DELAY_MS),
    projectConfigFile,
    stateFile: path.join(DEV_DIR, 'state.sqlite'),
    tokenFile: path.join(DEV_DIR, 'a2a-token'),
    ...(atlassian ? { atlassianOAuth: atlassian.oauth, atlassianProvider: atlassian.provider } : {}),
    orchestratorFactory: (options) => new LeadOrchestrator({ ...options, pollIntervalMs: 50 }),
  });
  if (atlassian) {
    await runtime.atlassianIntegration.selectSite({ cloudId: atlassian.cloudId });
    process.stdout.write(`Atlassian fixture active (${process.env.DASHBOARD_DEV_ATLASSIAN_OUTAGE === '1' ? 'source outage' : 'DEMO-1'}); no live account or token is used\n`);
  }
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
