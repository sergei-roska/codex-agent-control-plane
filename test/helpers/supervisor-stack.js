'use strict';

// SUP-03 harness: a REAL CodexAppServer (fake child process, fake supervisor clock) under the real
// specialist executor, real WriterAdmission (in-memory SQLite) and, optionally, the real
// LeadOrchestrator over loopback A2A HTTP. Only the codex child process is faked.

const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const Database = require('better-sqlite3');
const { ServerCallContext, UnauthenticatedUser } = require('@a2a-js/sdk/server');
const { CodexAppServer } = require('../../src/codex-app-server');
const { registerRoleAgents } = require('../../src/a2a-role-service');
const { WriterAdmission } = require('../../src/writer-admission');
const { LeadOrchestrator } = require('../../src/lead-orchestrator');
const { DECISION_SCHEMA } = require('../../src/contracts');

const PID_BASE = 4_100_000; // above Linux pid_max: never a live process

class FakeProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.sent = [];
    this.stdout = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const message = JSON.parse(line);
          this.sent.push(message);
          const send = (response) => this.stdout.write(`${JSON.stringify(response)}\n`);
          if (message.method === 'config/read') {
            send({ id: message.id, result: { config: { mcp_servers: {} } } });
            continue;
          }
          handler(message, send);
        }
        callback();
      },
    });
  }

  kill(signal) {
    this.killed = true;
    this.exitCode = 0;
    setImmediate(() => this.emit('exit', 0, signal));
    return true;
  }
}

function fakeClock(start = 1_000_000) {
  let now = start;
  let timers = [];
  let seq = 0;
  const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    now: () => now,
    setTimeout(fn, ms) { const timer = { id: ++seq, at: now + ms, fn }; timers.push(timer); return timer; },
    clearTimeout(timer) { timers = timers.filter((candidate) => candidate !== timer); },
    pending: () => timers.length,
    flush,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await flush();
        const next = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        timers = timers.filter((timer) => timer !== next);
        now = Math.max(now, next.at);
        next.fn();
      }
      now = target;
      await flush();
    },
  };
}

const role = (name, sandbox) => ({
  name, description: `${name} agent`, model: 'gpt-test', effort: 'high', sandbox, instructions: `instr:${name}`,
});
const defaultRoles = () => new Map([
  ['orch-builder', role('orch-builder', 'workspace-write')],
  ['orch-explorer', role('orch-explorer', 'read-only')],
  ['orch-architect', role('orch-architect', 'read-only')],
  ['orch-reviewer', role('orch-reviewer', 'read-only')],
]);

const workerReport = (summary = 'done') => JSON.stringify({
  outcome: 'completed', summary, filesChanged: [], filesInspected: [], checks: [], risks: [], scopeExpansion: [], decisionRequest: null,
});

/**
 * The fake codex world shared by every generation of the child.
 * behavior[role]: 'hang' (turn/start acknowledged, never completes) or 'complete'.
 * stallThreadStart: role names whose thread/start is never answered (turn/start is never sent).
 * leadScript: decision objects (or strings) served to lead turns in order.
 */
function makeWorld({ leadScript = [], behavior = {}, stallThreadStart = [] } = {}) {
  const world = {
    behavior: { ...behavior },
    stallThreadStart: new Set(stallThreadStart),
    leadScript: [...leadScript],
    turnStarts: [], // { generation, kind, role, input, threadId }
    threadStarts: [], // { generation, role, threadId }
    leadPrompts: [],
    threadRoles: new Map(),
    threadNumber: 0,
    turnNumber: 0,
  };
  world.turnStartsOf = (generation) => world.turnStarts.filter((entry) => entry.generation === generation);
  world.handlerFor = (generation) => (request, send) => {
    const { method, id, params } = request;
    if (method === 'initialize') return send({ id, result: { userAgent: 'fake' } });
    if (method === 'initialized') return undefined;
    if (method === 'thread/start') {
      const roleName = [...(params.developerInstructions || '').matchAll(/instr:([\w-]+)/g)][0]?.[1] ?? 'lead';
      if (world.stallThreadStart.has(roleName)) return undefined;
      const threadId = `thread-${++world.threadNumber}`;
      world.threadRoles.set(threadId, roleName);
      world.threadStarts.push({ generation, role: roleName, threadId });
      return send({ id, result: { thread: { id: threadId } } });
    }
    if (method === 'turn/start') {
      const text = params.input[0].text;
      const isLead = JSON.stringify(params.outputSchema) === JSON.stringify(DECISION_SCHEMA);
      const roleName = isLead ? 'lead' : world.threadRoles.get(params.threadId) ?? 'unknown';
      world.turnStarts.push({ generation, kind: isLead ? 'lead' : 'worker', role: roleName, input: text, threadId: params.threadId });
      const turnId = `turn-${++world.turnNumber}`;
      send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      let reply = null;
      if (isLead) {
        world.leadPrompts.push(text);
        const next = world.leadScript.shift();
        reply = typeof next === 'string' ? next : JSON.stringify(next);
      } else if ((world.behavior[roleName] ?? 'complete') === 'complete') {
        reply = workerReport(`reply from ${roleName}`);
      }
      setImmediate(() => {
        send({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } });
        if (reply === null) return;
        send({ method: 'item/completed', params: { threadId: params.threadId, turnId, item: { type: 'agentMessage', text: reply } } });
        send({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turnId, status: 'completed' } } });
      });
      return undefined;
    }
    return send({ id, result: {} });
  };
  return world;
}

const esrch = () => Object.assign(new Error('no such process'), { code: 'ESRCH' });

const messageOf = (text, ids = {}) => ({
  messageId: `m-${Math.random()}`, role: 1, parts: [{ content: { $case: 'text', value: text } }], ...ids,
});
const sendParams = (text, ids) => ({
  message: messageOf(text, ids),
  configuration: { acceptedOutputModes: ['text/plain'], taskPushNotificationConfig: undefined, returnImmediately: false },
});

async function bindable() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  try {
    await once(probe, 'listening');
  } catch (_) {
    return false;
  }
  await new Promise((resolve) => probe.close(resolve));
  return true;
}

/**
 * Build the stack. options.http listens on loopback so the real LeadOrchestrator can dispatch.
 * options.app are extra CodexAppServer options (policy overrides).
 */
async function createStack(t, { leadScript, behavior, stallThreadStart, http: withHttp = false, app: appOptions = {}, roles = defaultRoles() } = {}) {
  const clock = fakeClock();
  const world = makeWorld({ leadScript, behavior, stallThreadStart });
  const children = [];
  const spawnImpl = () => {
    const generation = children.length + 1;
    const child = new FakeProcess(world.handlerFor(generation));
    child.pid = PID_BASE + generation;
    child.generation = generation;
    children.push(child);
    return child;
  };
  const appServer = new CodexAppServer({
    spawnImpl,
    clock,
    killImpl: () => { throw esrch(); },
    readProcessIdentityImpl: (pid) => ({ pid, pgid: pid, startTime: `fake-${pid}` }),
    listGroupMembersImpl: () => [],
    ...appOptions,
  });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-int-'));
  const db = new Database(':memory:');
  const quiescence = {
    gone: false, // flip to prove the old process group is gone
    isProcessGroupGone: () => quiescence.gone,
    killOrphanProcessGroup: () => false,
    listGroupMembers: () => [],
  };
  const admission = new WriterAdmission({
    db, workspace, quiescence, settleMs: 20, snapshot: () => ({ kind: 'unavailable', reason: 'test' }),
  });
  const expressApp = express();
  let server = null;
  let baseUrl = 'http://127.0.0.1:1';
  if (withHttp) {
    server = http.createServer(expressApp);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  const agents = registerRoleAgents(expressApp, {
    roles, appServer, workspace, baseUrl, admission, reconcileRetry: { intervalMs: 5, totalMs: 20 },
  });
  const orchestrator = new LeadOrchestrator({
    appServer, roles, workspace, baseUrl, pollIntervalMs: 5, admission, reconcileWaitMs: 20,
  });
  t.after(async () => {
    await appServer.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const context = new ServerCallContext({ user: new UnauthenticatedUser() });
  const stack = {
    clock, world, children, appServer, admission, quiescence, agents, orchestrator, workspace, baseUrl,
    send: (roleId, text, ids) => agents.get(roleId).handler.sendMessage(sendParams(text, ids), context),
    crash: async (signal = null) => { children.at(-1).emit('exit', 137, signal); await clock.flush(); },
    // Wait (real event loop) until `count` turn/start requests were seen in total.
    async untilTurnStarts(count) {
      for (let i = 0; i < 1000 && world.turnStarts.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      if (world.turnStarts.length < count) throw new Error(`only ${world.turnStarts.length} of ${count} turn/start requests arrived`);
      await clock.flush();
    },
    kinds: () => appServer.supervisorState().events.map((event) => event.kind),
  };
  return stack;
}

module.exports = { createStack, bindable, workerReport, role, defaultRoles };
