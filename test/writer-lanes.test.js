'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const express = require('express');
const Database = require('better-sqlite3');
const { ServerCallContext, UnauthenticatedUser } = require('@a2a-js/sdk/server');
const { registerRoleAgents } = require('../src/a2a-role-service');
const { WriterAdmission } = require('../src/writer-admission');
const { createActivityStore } = require('../src/activity-store');
const { createLaneProbeStore } = require('../src/lane-probe');
const { addLane, createBase } = require('../src/writer-worktree');
const {
  LaneManager, createLaneStore, selectWriterIsolation, resolveLanesRoot, laneLinks, laneRetentionHours,
} = require('../src/writer-lanes');
const { tmp, makeRepo, readTree, probeExec } = require('./helpers/lane-fixtures');
const { deterministicContextId } = require('../src/durable-store');

const writerRoles = new Map([
  ['orch-writer-a', { name: 'Writer A', description: 'Writes.', instructions: 'Implement.', model: 'test', effort: 'low', sandbox: 'workspace-write' }],
  ['orch-writer-b', { name: 'Writer B', description: 'Writes too.', instructions: 'Implement.', model: 'test', effort: 'low', sandbox: 'workspace-write' }],
]);

const report = () => JSON.stringify({
  outcome: 'completed', summary: 'done', filesChanged: [], filesInspected: [],
  checks: [], risks: [], scopeExpansion: [], decisionRequest: null,
});
const ok = () => ({ threadId: 't', turnId: 'u', status: 'completed', text: report() });
const request = (allowedFiles, extra = {}) => JSON.stringify({ objective: 'Do it', allowedFiles, ...extra });
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

async function until(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await tick(10);
  }
}

// A worktree-mode role service over a fresh repo; `run(options)` plays the agent.
function setup(t, run, { manager = {}, service = {}, version = 'v1', home } = {}) {
  const repo = makeRepo();
  const lanesRoot = tmp('lanes-');
  const db = new Database(':memory:');
  const admission = new WriterAdmission({ db, workspace: repo, settleMs: 20 });
  const appServer = { getVersion: () => version, run: (options) => run(options), ...(home !== undefined ? { getCodexHome: () => home } : {}) };
  const lanes = new LaneManager({
    db, workspace: repo, admission, appServer, mode: 'worktree', lanesRoot, links: [], probe: { version: 'v1', ok: true, reason: null }, ...manager,
  });
  const agents = registerRoleAgents(express(), {
    roles: writerRoles, appServer, workspace: repo, baseUrl: 'http://127.0.0.1:7777', admission, lanes, ...service,
  });
  const context = new ServerCallContext({ user: new UnauthenticatedUser() });
  const send = (roleId, text, { contextId, returnImmediately = false } = {}) => agents.get(roleId).handler.sendMessage({
    message: { messageId: `m-${Math.random()}`, role: 1, parts: [{ content: { $case: 'text', value: text } }], ...(contextId ? { contextId } : {}) },
    configuration: { acceptedOutputModes: ['text/plain'], returnImmediately },
  }, context);
  t.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(lanesRoot, { recursive: true, force: true });
  });
  return { repo, lanesRoot, db, admission, lanes, agents, context, send };
}

const writerOf = (task) => task.artifacts?.[0]?.metadata?.writerExecution ?? task.status?.message?.metadata?.writerExecution;

test('an integrated lane: lane cwd and policy, attested delta, removed lane, live activity and provenance', async (t) => {
  let seen = null;
  let env;
  const activityDb = new Database(':memory:');
  env = setup(t, async (options) => {
    seen = options;
    options.onTurnStart({ processIdentity: { pid: 4242, pgid: 4242, startTime: 's' }, threadId: 'thr' });
    const row = env.lanes.store.list(env.lanes.workspace)[0];
    assert.equal(row.state, 'running');
    assert.deepEqual(row.turnStart, { processIdentity: { pid: 4242, pgid: 4242, startTime: 's' }, threadId: 'thr' });
    options.onEvent?.({ method: 'item/completed', params: { item: { type: 'commandExecution', command: 'ls', exitCode: 0 } } });
    fs.writeFileSync(path.join(options.cwd, 'a.txt'), 'lane\n');
    return ok();
  }, { service: { activityStore: createActivityStore(activityDb) } });
  const before = readTree(env.repo);
  const task = await env.send('orch-writer-a', request(['a.txt']));
  assert.equal(task.status.state, 3);

  assert.ok(seen.cwd.startsWith(`${env.lanesRoot}${path.sep}`));
  assert.deepEqual(seen.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [seen.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.match(seen.input.split('\n')[0], new RegExp(`already your current working directory \\(${seen.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.match(seen.input, /Run commands without a workdir argument/);
  assert.ok(seen.input.endsWith('\n' + request(['a.txt'])), 'original input follows the prefix');

  const writer = writerOf(task);
  assert.equal(writer.executionId, `orch-writer-a:${task.id}`);
  assert.equal(writer.state, 'released');
  assert.deepEqual(writer.delta.changedPaths, ['a.txt']);
  assert.equal('effects' in writer, false);
  assert.equal(writer.lane.state, 'integrated');
  assert.equal(writer.lane.reason, null);
  assert.equal(writer.lane.path, seen.cwd);
  assert.equal(writer.lane.workspacePath, seen.cwd);
  assert.match(writer.lane.base, /^[0-9a-f]{40}$/);
  assert.deepEqual(writer.lane.attemptedPaths, ['a.txt']);
  assert.deepEqual(readTree(env.repo), { ...before, 'a.txt': 'lane\n' });
  assert.equal(fs.existsSync(seen.cwd), false);

  const meta = task.artifacts[0].metadata;
  assert.deepEqual(meta.boundary.results, []);
  assert.equal(meta.provenance.laneId, writer.lane.id);
  assert.equal(meta.provenance.workspace, env.repo);
  const row = env.lanes.store.get(writer.lane.id);
  assert.deepEqual([row.state, row.executionId, row.baseCommit], ['integrated', writer.executionId, writer.lane.base]);
  const activity = activityDb.prepare('SELECT * FROM live_activity WHERE key = ?').get(task.id);
  assert.deepEqual([activity.phase, activity.summary, activity.ended_at !== null], ['done', 'completed', true]);
});

test('two writers of one wave run concurrently, finish interleaved, and integrate one at a time', async (t) => {
  const gates = { 'orch-writer-a': deferred(), 'orch-writer-b': deferred() };
  const running = new Set();
  const env = setup(t, async (options) => {
    running.add(options.role.id);
    fs.writeFileSync(path.join(options.cwd, options.role.id === 'orch-writer-a' ? 'a.txt' : 'b.txt'), `${options.role.id}\n`);
    await gates[options.role.id].promise;
    return ok();
  });
  const before = readTree(env.repo);
  const first = env.send('orch-writer-a', request(['a.txt']), { contextId: 'lead-run' });
  const second = env.send('orch-writer-b', request(['b.txt']), { contextId: 'lead-run' });
  await until(() => running.size === 2);
  assert.equal(env.admission.holder(), null); // no admission is held during lane turns
  gates['orch-writer-b'].resolve();
  const doneB = await second;
  gates['orch-writer-a'].resolve();
  const doneA = await first;
  for (const [done, file] of [[doneA, 'a.txt'], [doneB, 'b.txt']]) {
    const writer = writerOf(done);
    assert.equal(done.status.state, 3);
    assert.equal(writer.lane.state, 'integrated');
    assert.equal(writer.state, 'released');
    // Serial integration: each attested delta holds only that writer's file.
    assert.deepEqual(writer.delta.changedPaths, [file]);
  }
  assert.deepEqual(readTree(env.repo), { ...before, 'a.txt': 'orch-writer-a\n', 'b.txt': 'orch-writer-b\n' });
});

test('a lane without changes is not integrated, claims no effects, and the attested scope passes', async (t) => {
  const env = setup(t, async () => ok());
  const task = await env.send('orch-writer-a', request(['a.txt']), { contextId: 'ctx-none' });
  assert.equal(task.status.state, 3);
  const writer = writerOf(task);
  assert.deepEqual({ ...writer, lane: undefined }, {
    executionId: null, state: null,
    delta: { known: true, headChanged: false, changedPaths: [], changedPathCount: 0, source: 'lane_collection' },
    reason: null, effects: 'none', lane: undefined,
  });
  assert.deepEqual([writer.lane.state, writer.lane.reason], ['not_integrated', 'no_changes']);
  assert.equal(fs.existsSync(writer.lane.path), true);
  assert.equal(env.admission.findAnyByContextId('ctx-none'), null);
  const results = task.artifacts[0].metadata.boundary.results;
  assert.equal(results.length, 1);
  assert.deepEqual([results[0].predicate, results[0].result, results[0].evidence], ['settle.attested_scope', 'PASS', [`writer_lanes:${writer.lane.id}`]]);
  assert.match(results[0].detail, /nothing integrated/);
});

test('a lane patch outside allowedFiles is refused whole: shared tree untouched, settle.lane_scope fails', async (t) => {
  const env = setup(t, async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'in scope\n');
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'out of scope\n');
    return ok();
  });
  const before = readTree(env.repo);
  const task = await env.send('orch-writer-a', request(['a.txt']), { contextId: 'ctx-scope' });
  assert.equal(task.status.state, 3);
  assert.deepEqual(readTree(env.repo), before);
  const writer = writerOf(task);
  assert.equal(writer.executionId, null);
  assert.equal(writer.effects, 'none');
  assert.equal(writer.lane.reason, 'lane_scope_refused');
  assert.deepEqual(writer.lane.scopeViolations, ['other.txt']);
  assert.deepEqual(writer.lane.attemptedPaths.sort(), ['a.txt', 'other.txt']);
  assert.equal(env.admission.findAnyByContextId('ctx-scope'), null);
  const results = task.artifacts[0].metadata.boundary.results;
  assert.deepEqual(results.map((r) => [r.predicate, r.result, r.code, r.boundary, r.advisory]), [
    ['settle.lane_scope', 'FAIL', 'lane_scope_refused', 'settlement', false],
    ['settle.attested_scope', 'PASS', null, 'settlement', false],
  ]);
  assert.match(results[0].detail, /other\.txt/);
  assert.equal(env.lanes.store.get(writer.lane.id).state, 'not_integrated');
});

test('an owner edit of the same lines mid-turn ends in integration_conflict with the row released', async (t) => {
  let env;
  env = setup(t, async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'lane\na2\na3\n');
    fs.writeFileSync(path.join(env.repo, 'a.txt'), 'owner\na2\na3\n');
    return ok();
  });
  const task = await env.send('orch-writer-a', request(['a.txt']));
  assert.equal(task.status.state, 3);
  const writer = writerOf(task);
  assert.equal(writer.executionId, `orch-writer-a:${task.id}`);
  assert.equal(writer.state, 'released');
  assert.equal('effects' in writer, false);
  assert.deepEqual(writer.lane.conflicts, ['a.txt']);
  assert.equal(writer.lane.reason, 'integration_conflict');
  assert.equal(writer.lane.state, 'not_integrated');
  assert.equal(fs.readFileSync(path.join(env.repo, 'a.txt'), 'utf8'), 'owner\na2\na3\n');
  assert.equal(fs.existsSync(writer.lane.path), true);
  assert.equal(env.admission.holder(), null);
  assert.equal(env.lanes.store.get(writer.lane.id).executionId, writer.executionId);
});

test('failed, interrupted, and canceled lane turns keep their lane and integrate nothing', async (t) => {
  let mode = 'failed';
  let started = null;
  const env = setup(t, ({ cwd, signal }) => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'never integrated\n');
    if (mode === 'failed') return Promise.resolve({ threadId: 't', turnId: 'u', status: 'failed', text: 'gave up' });
    if (mode === 'unknown') return Promise.reject(Object.assign(new Error('connection lost'), { outcomeUnknown: true }));
    started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  });
  const before = readTree(env.repo);

  const failed = await env.send('orch-writer-a', request(['a.txt']));
  assert.equal(failed.status.state, 4);
  let writer = writerOf(failed);
  assert.deepEqual([writer.executionId, writer.effects, writer.lane.reason], [null, 'none', 'turn_failed']);
  assert.equal(fs.existsSync(writer.lane.path), true);

  mode = 'unknown';
  const unknown = await env.send('orch-writer-a', request(['a.txt']));
  assert.equal(unknown.status.state, 4);
  assert.equal(unknown.status.message.metadata.failureKind, 'interrupted');
  writer = writerOf(unknown);
  assert.deepEqual([writer.executionId, writer.effects, writer.lane.reason], [null, 'none', 'outcome_unknown']);

  mode = 'cancel';
  const running = new Promise((resolve) => { started = resolve; });
  const created = await env.send('orch-writer-a', request(['a.txt']), { returnImmediately: true });
  await running;
  await env.agents.get('orch-writer-a').handler.cancelTask({ id: created.id }, env.context);
  await until(() => env.lanes.store.list(env.lanes.workspace).some((row) => row.taskId === created.id && row.state === 'not_integrated'));
  const row = env.lanes.store.list(env.lanes.workspace).find((entry) => entry.taskId === created.id);
  assert.equal(row.reason, 'canceled');
  assert.equal(fs.existsSync(row.path), true);

  assert.deepEqual(readTree(env.repo), before);
  assert.equal(env.admission.findAnyByContextId(failed.contextId), null);
});

test('a fenced context is refused at prepare without a lane row or a turn', async (t) => {
  let runs = 0;
  const env = setup(t, async () => { runs += 1; return ok(); });
  env.admission.fence('ctx-fenced', 'lead gave up');
  const task = await env.send('orch-writer-a', request(['a.txt']), { contextId: 'ctx-fenced' });
  assert.equal(task.status.state, 4);
  const meta = task.status.message.metadata;
  assert.deepEqual([meta.failureKind, meta.effects, meta.admission.code], ['fenced', 'none', 'fenced']);
  assert.equal(runs, 0);
  assert.deepEqual(env.lanes.store.list(env.lanes.workspace), []);
});

test('a legacy plain-text writer runs in shared mode under admission for the whole turn', async (t) => {
  let seen = null;
  let env;
  env = setup(t, async (options) => {
    seen = options;
    assert.ok(env.admission.holder());
    return ok();
  });
  const task = await env.send('orch-writer-a', 'please just do it');
  assert.equal(task.status.state, 3);
  assert.equal(seen.cwd, env.repo);
  assert.equal(seen.sandboxPolicy, undefined);
  assert.equal(seen.input, 'please just do it');
  const writer = writerOf(task);
  assert.equal(writer.state, 'released');
  assert.equal('lane' in writer, false);
  assert.deepEqual(env.lanes.store.list(env.lanes.workspace), []);
});

test('a new App Server version is re-probed once; a failing probe sends the attempt to shared mode', async (t) => {
  let probes = 0;
  let seen = null;
  const env = setup(t, async (options) => { seen = options; return ok(); }, {
    version: 'v2',
    manager: { runProbe: async () => { probes += 1; return { ok: false, version: 'v2', reason: 'escaped: shared_workspace_write', checks: [] }; } },
  });
  for (let i = 0; i < 2; i += 1) {
    const task = await env.send('orch-writer-a', request(['a.txt']));
    assert.equal(task.status.state, 3);
    assert.equal(seen.cwd, env.repo);
    assert.equal('lane' in writerOf(task), false);
  }
  assert.equal(probes, 1);
  assert.deepEqual([env.lanes.status().probe.version, env.lanes.status().probe.ok], ['v2', false]);
  assert.equal(createLaneProbeStore(env.db).get('v2').ok, false);
});

test('a stored failed probe is not reused: the next process re-probes and a pass replaces it', async (t) => {
  const repo = makeRepo();
  const stateDir = tmp('lane-state-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const stateFile = path.join(stateDir, 'state.sqlite');
  const db = new Database(':memory:');
  const leaky = probeExec({ leak: true });
  let mode = await selectWriterIsolation({ env: {}, appServer: { getVersion: () => 'v1', execCommand: leaky.execCommand }, workspace: repo, db, stateFile });
  assert.equal(mode.mode, 'shared');
  assert.equal(createLaneProbeStore(db).get('v1').ok, false);
  const exec = probeExec();
  mode = await selectWriterIsolation({ env: {}, appServer: { getVersion: () => 'v1', execCommand: exec.execCommand }, workspace: repo, db, stateFile });
  assert.deepEqual([mode.mode, mode.probe.stored], ['worktree', false]);
  assert.ok(exec.calls.length > 0);
  assert.equal(createLaneProbeStore(db).get('v1').ok, true);
});

test('after a failed re-probe a version is not probed again within the process', async (t) => {
  let probes = 0;
  let version = 'v2';
  const env = setup(t, async () => ok(), {
    manager: { runProbe: async () => { probes += 1; return { ok: false, version, reason: 'escaped: shared_workspace_write', checks: [] }; } },
  });
  env.lanes.appServer.getVersion = () => version;
  assert.equal(await env.lanes.available(), false);
  version = 'v3';
  assert.equal(await env.lanes.available(), false);
  version = 'v2';
  assert.equal(await env.lanes.available(), false);
  version = 'v3';
  assert.equal(await env.lanes.available(), false);
  assert.equal(probes, 2);
});

test('the integration records a pending turn start before spawn and the real apply identity on spawn', async (t) => {
  const atSpawn = [];
  let childPid = null;
  let env;
  env = setup(t, async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'src', 'x.js'), 'changed\n');
    return ok();
  }, {
    manager: {
      spawnFn: (...args) => {
        atSpawn.push(env.admission.holder().turnStart);
        const child = spawn(...args);
        childPid = child.pid;
        return child;
      },
    },
  });
  const task = await env.send('orch-writer-a', request(['src']));
  const writer = writerOf(task);
  assert.equal(writer.lane.state, 'integrated');
  assert.deepEqual(atSpawn, [{ processIdentity: null, threadId: null }]);
  const turnStart = env.admission.get(writer.executionId).turnStart;
  assert.equal(turnStart.processIdentity.pid, childPid);
  assert.equal(turnStart.threadId, null);
});

// ---------------------------------------------------------------- mode selection

test('mode selection: shared by setting, unsupported App Server, nested workspace, or a failing probe', async (t) => {
  const repo = makeRepo();
  const stateDir = tmp('lane-state-');
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const stateFile = path.join(stateDir, 'state.sqlite');
  const db = new Database(':memory:');
  const exec = probeExec();
  const appServer = { getVersion: () => 'v1', execCommand: exec.execCommand };

  let mode = await selectWriterIsolation({ env: { CODEX_A2A_WRITER_ISOLATION: 'shared' }, appServer, workspace: repo, db, stateFile });
  assert.deepEqual([mode.mode, mode.reason], ['shared', 'isolation_shared']);
  mode = await selectWriterIsolation({ env: {}, appServer: { getVersion: () => 'v1' }, workspace: repo, db, stateFile });
  assert.deepEqual([mode.mode, mode.reason], ['shared', 'probe_unsupported']);
  mode = await selectWriterIsolation({ env: {}, appServer, workspace: path.join(repo, 'src'), db, stateFile });
  assert.deepEqual([mode.mode, mode.reason], ['shared', 'not_work_tree_top']);
  assert.equal(exec.calls.length, 0);

  mode = await selectWriterIsolation({ env: {}, appServer, workspace: repo, db, stateFile });
  assert.deepEqual([mode.mode, mode.reason, mode.lanesRoot], ['worktree', null, path.join(stateDir, 'lanes')]);
  assert.deepEqual(mode.links, ['.venv', 'venv', 'node_modules']);
  assert.equal(mode.probe.ok, true);
  const calls = exec.calls.length;
  assert.ok(calls > 0);
  mode = await selectWriterIsolation({ env: {}, appServer, workspace: repo, db, stateFile });
  assert.deepEqual([mode.mode, mode.probe.stored, exec.calls.length], ['worktree', true, calls]);

  const leaky = probeExec({ leak: true });
  const before = readTree(repo);
  mode = await selectWriterIsolation({ env: {}, appServer: { getVersion: () => 'v-leaky', execCommand: leaky.execCommand }, workspace: repo, db, stateFile });
  assert.equal(mode.mode, 'shared');
  assert.match(mode.reason, /^probe_failed: escaped: /);
  assert.equal(createLaneProbeStore(db).get('v-leaky').ok, false);
  assert.deepEqual(readTree(repo), before);
});

test('lanes root, links, and retention settings', () => {
  const repo = makeRepo();
  try {
    const home = tmp('lane-home-');
    const inside = resolveLanesRoot({ workspace: repo, stateFile: path.join(repo, '.runtime', 'state.sqlite'), home });
    assert.match(inside, new RegExp(`^${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.cache/codex-a2a/lanes/[0-9a-f]{16}$`));
    assert.equal(resolveLanesRoot({ workspace: repo, stateFile: ':memory:', home }), inside);
    assert.equal(resolveLanesRoot({ workspace: repo, stateFile: path.join(home, 's', 'state.sqlite'), home }), path.join(home, 's', 'lanes'));
    fs.rmSync(home, { recursive: true, force: true });
    assert.deepEqual(laneLinks(' .venv, node_modules/ ,../x,/abs,,'), ['.venv', 'node_modules']);
    assert.deepEqual(laneLinks(''), []);
    assert.deepEqual([laneRetentionHours(undefined), laneRetentionHours('5'), laneRetentionHours('-1'), laneRetentionHours('x')], [72, 5, 72, 72]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- startup recovery and retention

function recoveryEnv(t) {
  const repo = makeRepo();
  const lanesRoot = tmp('lanes-');
  const db = new Database(':memory:');
  const killed = [];
  const quiescence = {
    isProcessGroupGone: () => true,
    killOrphanProcessGroup: (identity) => { killed.push(identity); return true; },
  };
  const admission = new WriterAdmission({ db, workspace: repo, settleMs: 0, quiescence });
  const lanes = new LaneManager({ db, workspace: repo, admission, mode: 'worktree', lanesRoot, links: [], quiescence });
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(lanesRoot, { recursive: true, force: true }); });
  return { repo, lanesRoot, db, admission, lanes, killed };
}

test('startup recovery: live rows are orphaned (orphan group killed), integrating rows resolve through their execution row', async (t) => {
  const env = recoveryEnv(t);
  const { lanes, admission, repo } = env;
  const prepare = async (taskId) => (await lanes.prepare({ contextId: 'ctx-r', taskId })).lane;

  lanes.store.insert({ laneId: 'L-preparing', contextId: 'ctx-r', taskId: 'tp', workspace: lanes.workspace, path: path.join(env.lanesRoot, 'L-preparing') });
  const prepared = await prepare('t-prepared');
  const running = await prepare('t-running');
  lanes.recordTurnStart(running, { processIdentity: { pid: 999999, pgid: 999999, startTime: 'x' }, threadId: 'thr' });

  // integrating, admission never acquired
  const noRow = await prepare('t-norow');
  fs.writeFileSync(path.join(noRow.path, 'a.txt'), 'x\n');
  lanes.store.update(noRow.id, { state: 'integrating' });

  // integrating, apply finished but the admission row stayed active (crash before release)
  const applied = await prepare('t-applied');
  fs.writeFileSync(path.join(applied.path, 'b.txt'), 'applied\n');
  const held = await admission.acquire({ role: 'orch-writer-a', taskId: 't-applied', contextId: 'ctx-r' });
  fs.writeFileSync(path.join(repo, 'b.txt'), 'applied\n');
  lanes.store.update(applied.id, { state: 'integrating', executionId: held.executionId });
  await admission.reconcileStale(); // active -> unresolved -> reconciled (no turn start recorded)
  assert.equal(admission.get(held.executionId).state, 'reconciled');

  // integrating, released row but the lane's paths are not in the shared tree
  const partial = await prepare('t-partial');
  fs.writeFileSync(path.join(partial.path, 'src', 'x.js'), 'lane only\n');
  const partialRow = await admission.acquire({ role: 'orch-writer-a', taskId: 't-partial', contextId: 'ctx-r' });
  admission.release(partialRow.executionId);
  lanes.store.update(partial.id, { state: 'integrating', executionId: partialRow.executionId });

  // integrating, released row found by context and task (execution_id never stored), lane already removed
  const released = await prepare('t-released');
  const releasedRow = await admission.acquire({ role: 'orch-writer-b', taskId: 't-released', contextId: 'ctx-r' });
  admission.release(releasedRow.executionId);
  lanes.store.update(released.id, { state: 'integrating' });
  fs.rmSync(released.path, { recursive: true, force: true });

  const summary = lanes.recover();
  const state = (id) => { const row = lanes.store.get(id); return [row.state, row.reason]; };
  assert.deepEqual(summary.orphaned.sort(), ['L-preparing', prepared.id, running.id].sort());
  assert.deepEqual(state('L-preparing'), ['orphaned', 'server_restart']);
  assert.deepEqual(state(prepared.id), ['orphaned', 'server_restart']);
  assert.deepEqual(state(running.id), ['orphaned', 'server_restart']);
  assert.deepEqual(env.killed, [{ pid: 999999, pgid: 999999, startTime: 'x' }]);
  assert.equal(fs.existsSync(prepared.path), true);

  assert.deepEqual(state(noRow.id), ['not_integrated', 'integration_interrupted']);
  assert.equal(lanes.store.get(noRow.id).executionId, null);
  assert.deepEqual(state(applied.id), ['integrated', null]);
  assert.equal(fs.existsSync(applied.path), false);
  assert.deepEqual(state(partial.id), ['not_integrated', 'integration_interrupted']);
  assert.equal(fs.existsSync(partial.path), true);
  assert.deepEqual(state(released.id), ['integrated', null]);
  assert.equal(lanes.store.get(released.id).executionId, releasedRow.executionId);
  assert.deepEqual(summary.integrated.sort(), [applied.id, released.id].sort());
  assert.deepEqual(summary.notIntegrated.sort(), [noRow.id, partial.id].sort());
  assert.deepEqual(summary.removed, []);
});

test('retention removes kept lanes older than the limit, only inside the lanes root', async (t) => {
  const env = recoveryEnv(t);
  const { lanes } = env;
  const kept = (await lanes.prepare({ contextId: 'c', taskId: 't1' })).lane;
  await lanes.complete({ lane: kept, integrate: false, reason: 'turn_failed' });
  const orphan = (await lanes.prepare({ contextId: 'c', taskId: 't2' })).lane;
  lanes.recover(); // prepared -> orphaned
  // A worktree outside the lanes root is never touched by retention.
  const elsewhere = tmp('lane-elsewhere-');
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const foreign = addLane({ root: env.repo, base: createBase(env.repo).commit, dir: path.join(elsewhere, 'foreign') });
  lanes.store.insert({ laneId: 'L-foreign', contextId: 'c', taskId: 't3', workspace: lanes.workspace, path: foreign.path });
  lanes.store.update('L-foreign', { state: 'not_integrated', reason: 'turn_failed' });

  let summary = lanes.recover({ retentionHours: 72 });
  assert.deepEqual(summary.removed, []);
  summary = lanes.recover({ retentionHours: 72, now: Date.now() + 73 * 3600 * 1000 });
  assert.deepEqual(summary.removed.sort(), [kept.id, orphan.id].sort());
  assert.deepEqual([lanes.store.get(kept.id).state, lanes.store.get(kept.id).reason], ['removed', 'turn_failed']);
  assert.equal(lanes.store.get(orphan.id).state, 'removed');
  assert.equal(fs.existsSync(kept.path), false);
  assert.equal(fs.existsSync(kept.adminDir), false);
  assert.equal(fs.existsSync(orphan.path), false);
  assert.equal(lanes.store.get('L-foreign').state, 'not_integrated');
  assert.equal(fs.existsSync(foreign.path), true);
});

test('the lane store keeps exactly the designed columns', () => {
  const db = new Database(':memory:');
  createLaneStore(db);
  assert.deepEqual(db.prepare('PRAGMA table_info(writer_lanes)').all().map((column) => column.name), [
    'lane_id', 'context_id', 'task_id', 'workspace', 'path', 'base_commit', 'state', 'reason',
    'turn_start_json', 'execution_id', 'created_at', 'updated_at', 'continued_from',
  ]);
});

test('one mutex per real workspace serializes work from separate managers', async (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { workspaceMutex } = require('../src/writer-lanes');
  const link = `${repo}-link`;
  fs.symlinkSync(repo, link);
  t.after(() => fs.rmSync(link, { force: true }));
  assert.equal(workspaceMutex(repo), workspaceMutex(link));
  const order = [];
  const gate = deferred();
  const first = workspaceMutex(repo).run(async () => { order.push('first-start'); await gate.promise; order.push('first-end'); });
  const second = workspaceMutex(link).run(() => { order.push('second'); });
  await tick();
  assert.deepEqual(order, ['first-start']);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

// ---------------------------------------------------------------- continuation (BUD-2)

const limitError = (threadId) => Object.assign(new Error('usage limit'), {
  codexError: { codexErrorInfo: 'usageLimitExceeded' }, execution: { threadId },
});
const OLD_CONTEXT = deterministicContextId('att-1');
const continuationOf = (task, extra = {}) => ({ ofAttemptId: 'att-1', ...task.status.message.metadata.continuation, ...extra });
const contextOfNew = deterministicContextId('att-1:c1');

// A first attempt that writes a partial file in its lane and is cut off by a usage limit.
async function limitedFirstAttempt(env, role = 'orch-writer-a') {
  const task = await env.send(role, request(['a.txt']), { contextId: OLD_CONTEXT });
  assert.equal(task.status.state, 4);
  return task;
}

test('a usage-limited lane writer reports a continuation with its thread, lane, and home', async (t) => {
  const env = setup(t, async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'partial\n');
    throw limitError('thr-1');
  }, { home: '/homes/a' });
  const task = await limitedFirstAttempt(env);
  const meta = task.status.message.metadata;
  assert.equal(meta.failureKind, 'usage_limit');
  assert.deepEqual(meta.continuation, { threadId: 'thr-1', laneId: writerOf(task).lane.id, codexHome: '/homes/a' });
  assert.equal(writerOf(task).lane.state, 'not_integrated');
});

test('a continuation adopts the old lane: same path, old row continued, partial file visible, thread resumed', async (t) => {
  const calls = [];
  let first = true;
  const env = setup(t, async (options) => {
    calls.push(options);
    if (first) {
      first = false;
      fs.writeFileSync(path.join(options.cwd, 'a.txt'), 'partial\n');
      throw limitError('thr-1');
    }
    assert.equal(fs.readFileSync(path.join(options.cwd, 'a.txt'), 'utf8'), 'partial\n');
    fs.writeFileSync(path.join(options.cwd, 'a.txt'), 'finished\n');
    return ok();
  }, { home: '/homes/a' });
  const failed = await limitedFirstAttempt(env);
  const oldLane = writerOf(failed).lane;

  const task = await env.send('orch-writer-a', request(['a.txt'], { continuation: continuationOf(failed) }), { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(calls[1].cwd, oldLane.path);
  assert.equal(calls[1].threadId, 'thr-1');
  assert.equal(calls[1].input.split('\n').slice(1).join('\n'), 'The usage limit has reset. Continue the assignment from where you stopped.');
  const lane = writerOf(task).lane;
  assert.notEqual(lane.id, oldLane.id);
  assert.equal(lane.path, oldLane.path);
  assert.equal(lane.base, oldLane.base);
  assert.equal(lane.state, 'integrated');
  assert.deepEqual(task.artifacts[0].metadata.continued, { laneAdopted: true, laneFallback: null, threadResumed: true });
  const oldRow = env.lanes.store.get(oldLane.id);
  const newRow = env.lanes.store.get(lane.id);
  assert.equal(oldRow.state, 'continued');
  assert.equal(newRow.continuedFrom, oldLane.id);
  assert.equal(newRow.contextId, contextOfNew);
  assert.equal(fs.readFileSync(path.join(env.repo, 'a.txt'), 'utf8'), 'finished\n');
});

test('a different App Server home starts a fresh thread in the adopted lane', async (t) => {
  const calls = [];
  const env = setup(t, async (options) => {
    calls.push(options);
    if (calls.length === 1) throw limitError('thr-1');
    return ok();
  }, { home: '/homes/b' });
  const failed = await limitedFirstAttempt(env);
  const task = await env.send('orch-writer-a', request(['a.txt'], { continuation: continuationOf(failed, { codexHome: '/homes/a' }) }), { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(calls[1].threadId, undefined);
  assert.equal(calls[1].cwd, writerOf(failed).lane.path);
  assert.match(calls[1].input, /cut off by a usage limit; its partial changes are already in the working directory/);
  assert.equal(JSON.parse(calls[1].input.split('\n').slice(2).join('\n')).continuation, undefined);
  assert.deepEqual(task.artifacts[0].metadata.continued, { laneAdopted: true, laneFallback: null, threadResumed: false });
});

test('a rejected thread resume falls back to a fresh thread', async (t) => {
  const calls = [];
  const env = setup(t, async (options) => {
    calls.push(options);
    if (calls.length === 1) throw limitError('thr-1');
    if (options.threadId) throw Object.assign(new Error('no rollout found for thread'), { failureClass: 'request_rejected' });
    return ok();
  }, { home: null });
  const failed = await limitedFirstAttempt(env);
  const task = await env.send('orch-writer-a', request(['a.txt'], { continuation: continuationOf(failed) }), { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].threadId, 'thr-1');
  assert.equal(calls[2].threadId, undefined);
  assert.match(calls[2].input, /cut off by a usage limit/);
  assert.equal(task.artifacts[0].metadata.continued.threadResumed, false);
});

test('adoption is refused for a wrong state or owner and falls back to a fresh lane', async (t) => {
  const calls = [];
  const env = setup(t, async (options) => {
    calls.push(options);
    if (calls.length === 1) throw limitError('thr-1');
    return ok();
  }, { home: null });
  const failed = await limitedFirstAttempt(env);
  const oldLane = writerOf(failed).lane;

  // Wrong owner: the lane belongs to another context.
  let task = await env.send('orch-writer-a', request(['a.txt'], { continuation: continuationOf(failed, { ofAttemptId: 'att-other' }) }), { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(task.artifacts[0].metadata.continued.laneFallback, 'lane_not_owned');
  assert.equal(env.lanes.store.get(oldLane.id).state, 'not_integrated');
  assert.notEqual(calls[1].cwd, oldLane.path);
  assert.equal(calls[1].threadId, undefined);
  assert.match(calls[1].input, /working copy could not be reused/);

  // Wrong state: a canceled lane is not adoptable.
  env.lanes.store.update(oldLane.id, { reason: 'canceled' });
  task = await env.send('orch-writer-a', request(['a.txt'], { continuation: continuationOf(failed) }), { contextId: deterministicContextId('att-1:c2') });
  assert.equal(task.artifacts[0].metadata.continued.laneAdopted, false);
  assert.equal(task.artifacts[0].metadata.continued.laneFallback, 'lane_state_not_integrated');
  assert.equal(env.lanes.store.get(oldLane.id).state, 'not_integrated');
  assert.equal(env.lanes.store.get(writerOf(task).lane.id).continuedFrom, null);

  // Missing row.
  task = await env.send('orch-writer-a', request(['a.txt'], { continuation: continuationOf(failed, { laneId: 'lane-nope' }) }), { contextId: deterministicContextId('att-1:c3') });
  assert.equal(task.artifacts[0].metadata.continued.laneFallback, 'lane_row_missing');
});

test('a shared writer and a read-only role continue by resuming their thread', async (t) => {
  const calls = [];
  const readers = new Map([['orch-reader', { name: 'Reader', description: 'Reads.', instructions: 'Read.', model: 'test', effort: 'low', sandbox: 'read-only' }]]);
  const env = setup(t, async (options) => {
    calls.push(options);
    if (calls.length === 1 || calls.length === 3) throw limitError('thr-shared');
    return ok();
  }, { home: null, manager: { mode: 'shared' }, service: { roles: new Map([...writerRoles, ...readers]) } });
  const failed = await limitedFirstAttempt(env);
  assert.equal(failed.status.message.metadata.continuation.laneId, null);
  const task = await env.send('orch-writer-a', request(['a.txt'], { continuation: continuationOf(failed) }), { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(calls[1].threadId, 'thr-shared');
  assert.equal(calls[1].cwd, env.repo);
  assert.equal(calls[1].input, 'The usage limit has reset. Continue the assignment from where you stopped.');
  assert.equal(writerOf(task).state, 'released');

  const readerFirst = await env.send('orch-reader', request([]), { contextId: deterministicContextId('att-r') });
  assert.equal(readerFirst.status.state, 4);
  const readerTask = await env.send('orch-reader', request([], { continuation: continuationOf(readerFirst, { ofAttemptId: 'att-r' }) }), { contextId: deterministicContextId('att-r:c1') });
  assert.equal(readerTask.status.state, 3);
  assert.equal(calls.at(-1).threadId, 'thr-shared');
});

test('retention never removes an adopted path while another row references it', async (t) => {
  const env = recoveryEnv(t);
  const { lanes } = env;
  const old = (await lanes.prepare({ contextId: 'c1', taskId: 't1' })).lane;
  await lanes.complete({ lane: old, integrate: false, reason: 'turn_failed' });
  const adopted = lanes.adopt({ contextId: 'c2', taskId: 't2', ofContextId: 'c1', laneId: old.id });
  assert.equal(adopted.lane.path, old.path);
  assert.equal(lanes.store.get(old.id).state, 'continued');
  assert.equal(lanes.store.get(adopted.lane.id).continuedFrom, old.id);
  // The adopted lane is refused for a second continuation and for a fenced context.
  assert.deepEqual(lanes.adopt({ contextId: 'c3', taskId: 't3', ofContextId: 'c1', laneId: old.id }), { fallback: 'lane_state_continued' });
  env.admission.fence('c-fenced', 'test');
  assert.equal(lanes.adopt({ contextId: 'c-fenced', taskId: 't4', ofContextId: 'c1', laneId: old.id }).refused.code, 'fenced');

  const later = (extra) => Date.now() + 73 * 3600 * 1000 + extra;
  // Both rows kept at the same path: the older one is skipped, the newer one removes the path once.
  await lanes.complete({ lane: adopted.lane, integrate: false, reason: 'turn_failed' });
  lanes.store.update(old.id, { state: 'not_integrated', reason: 'turn_failed' });
  const summary = lanes.recover({ retentionHours: 72, now: later(0) });
  assert.deepEqual(summary.removed, [adopted.lane.id]);
  assert.equal(lanes.store.get(old.id).state, 'not_integrated');
  assert.equal(fs.existsSync(old.path), false);

  // A continued row is terminal and never removed by retention.
  const second = (await lanes.prepare({ contextId: 'c5', taskId: 't5' })).lane;
  await lanes.complete({ lane: second, integrate: false, reason: 'outcome_unknown' });
  const again = lanes.adopt({ contextId: 'c6', taskId: 't6', ofContextId: 'c5', laneId: second.id });
  assert.ok(again.lane);
  const next = lanes.recover({ retentionHours: 72, now: later(0) });
  assert.deepEqual(next.removed, [again.lane.id]);
  assert.equal(lanes.store.get(second.id).state, 'continued');
});

test('a lane table created before continued_from gains the column', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE writer_lanes (
    lane_id TEXT PRIMARY KEY, context_id TEXT NOT NULL, task_id TEXT, workspace TEXT NOT NULL, path TEXT NOT NULL,
    base_commit TEXT, state TEXT NOT NULL, reason TEXT, turn_start_json TEXT, execution_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  db.prepare("INSERT INTO writer_lanes VALUES ('L1','c','t','/w','/p',NULL,'orphaned',NULL,NULL,NULL,'x','x')").run();
  const store = createLaneStore(db);
  assert.equal(store.get('L1').continuedFrom, null);
  store.insert({ laneId: 'L2', contextId: 'c', workspace: '/w', path: '/p', continuedFrom: 'L1' });
  assert.equal(store.get('L2').continuedFrom, 'L1');
  createLaneStore(db);
});

// ---------------------------------------------------------------- lead scope continuation (LL-5)

const scopeOf = (task, extra = {}) => ({ ofAttemptId: 'att-1', ...task.artifacts[0].metadata.continuation, reason: 'scope', ...extra });

test('a completed lane writer publishes thread, lane, and home as continuation metadata', async (t) => {
  const env = setup(t, async () => ok(), { home: '/homes/a' });
  const task = await env.send('orch-writer-a', request(['a.txt']), { contextId: OLD_CONTEXT });
  assert.equal(task.status.state, 3);
  assert.deepEqual(task.artifacts[0].metadata.continuation, { threadId: 't', laneId: writerOf(task).lane.id, codexHome: '/homes/a' });
});

test('a scope continuation resumes the thread with the scope note and a fresh lane after an integrated lane', async (t) => {
  const calls = [];
  const env = setup(t, async (options) => {
    calls.push(options);
    fs.writeFileSync(path.join(options.cwd, calls.length === 1 ? 'a.txt' : 'b.txt'), 'x\n');
    return ok();
  }, { home: '/homes/a' });
  const first = await env.send('orch-writer-a', request(['a.txt']), { contextId: OLD_CONTEXT });
  assert.equal(writerOf(first).lane.state, 'integrated');
  const newRequest = request(['a.txt', 'b.txt'], { continuation: scopeOf(first) });
  const task = await env.send('orch-writer-a', newRequest, { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(calls[1].threadId, 't');
  assert.notEqual(calls[1].cwd, calls[0].cwd);
  const lines = calls[1].input.split('\n');
  assert.equal(lines[1], 'The lead expanded your scope; allowedFiles is now: ["a.txt","b.txt"]. Continue the assignment from where you stopped.');
  const sent = JSON.parse(lines.slice(2).join('\n'));
  assert.deepEqual(sent.allowedFiles, ['a.txt', 'b.txt']);
  assert.equal(sent.continuation, undefined);
  assert.deepEqual(task.artifacts[0].metadata.continued, { laneAdopted: false, laneFallback: 'lane_state_integrated', threadResumed: true });
  assert.equal(fs.readFileSync(path.join(env.repo, 'b.txt'), 'utf8'), 'x\n');
});

test('a scope continuation adopts a kept lane and resumes the thread', async (t) => {
  const calls = [];
  const env = setup(t, async (options) => {
    calls.push(options);
    if (calls.length === 1) throw limitError('thr-1');
    return ok();
  }, { home: '/homes/a' });
  const failed = await limitedFirstAttempt(env);
  const oldLane = writerOf(failed).lane;
  const task = await env.send('orch-writer-a', request(['a.txt', 'b.txt'], { continuation: { ...continuationOf(failed), reason: 'scope' } }), { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(calls[1].cwd, oldLane.path);
  assert.equal(calls[1].threadId, 'thr-1');
  assert.match(calls[1].input, /The lead expanded your scope; allowedFiles is now: \["a\.txt","b\.txt"\]/);
  assert.deepEqual(task.artifacts[0].metadata.continued, { laneAdopted: true, laneFallback: null, threadResumed: true });
});

test('a scope continuation on another home starts a fresh thread with the scope note', async (t) => {
  const calls = [];
  const env = setup(t, async (options) => { calls.push(options); return ok(); }, { home: '/homes/b' });
  const first = await env.send('orch-writer-a', request(['a.txt']), { contextId: OLD_CONTEXT });
  const task = await env.send('orch-writer-a', request(['a.txt', 'b.txt'], { continuation: scopeOf(first, { codexHome: '/homes/a' }) }), { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(calls[1].threadId, undefined);
  assert.match(calls[1].input, /stopped because a needed file was outside its allowedFiles/);
  assert.equal(JSON.parse(calls[1].input.split('\n').slice(2).join('\n')).continuation, undefined);
  assert.equal(task.artifacts[0].metadata.continued.threadResumed, false);
});

test('a scope continuation with a removed lane row starts a fresh thread and lane', async (t) => {
  const calls = [];
  const env = setup(t, async (options) => { calls.push(options); return ok(); }, { home: null });
  const first = await env.send('orch-writer-a', request(['a.txt']), { contextId: OLD_CONTEXT });
  const task = await env.send('orch-writer-a', request(['a.txt', 'b.txt'], { continuation: scopeOf(first, { laneId: 'lane-nope' }) }), { contextId: contextOfNew });
  assert.equal(task.status.state, 3);
  assert.equal(calls[1].threadId, undefined);
  assert.match(calls[1].input, /working copy could not be reused/);
  assert.equal(task.artifacts[0].metadata.continued.laneFallback, 'lane_row_missing');
});

test('a failed turn publishes its thread as continuation metadata for any failure kind', async (t) => {
  const env = setup(t, async () => { throw Object.assign(new Error('boom'), { execution: { threadId: 'thr-x' } }); }, { home: '/homes/a' });
  const task = await env.send('orch-writer-a', request(['a.txt']), { contextId: OLD_CONTEXT });
  assert.equal(task.status.state, 4);
  assert.equal(task.status.message.metadata.failureKind, 'other');
  assert.equal(task.status.message.metadata.continuation.threadId, 'thr-x');
  assert.equal(task.status.message.metadata.continuation.codexHome, '/homes/a');
});
