'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TaskState } = require('@a2a-js/sdk');
const { ClientFactory } = require('@a2a-js/sdk/client');
const { InMemoryDispatchJournal, deterministicContextId } = require('../src/durable-store');
const { WORKER_REPORT_CONTRACT } = require('../src/contracts');
const { createSystemRepairClient, SYSTEM_REPAIR_CHECKS, SYSTEM_REPAIR_SCOPE, restartResult, validateAgentCard } = require('../src/system-repair-client');
const crypto = require('node:crypto');

const endpoint = 'http://127.0.0.1:8080/agents/chuck-norris';
const request = {
  incidentId: 'control-plane-incident',
  question: 'Preserve writable submission identity after restart',
  evidence: ['src/lead-graph.js: request ID changes during retry'],
  relatedDecisionIds: ['run:r1:a0'],
  projectContext: {
    goal: 'Diagnose controller identity loss',
    projectChecks: [{ id: 'target-check', argv: ['./target-project-test'] }],
    openDecisions: [{ id: 'run:r1:a0', role: 'builder', question: 'Is the repair ready?' }],
  },
};

function report(overrides = {}) {
  return {
    outcome: 'completed',
    summary: 'Repaired the durable dispatch key.',
    filesChanged: ['docs/repair.md'],
    filesInspected: ['src/durable-store.js'],
    checks: SYSTEM_REPAIR_CHECKS.map((command) => ({ command, result: 'passed', detail: 'Passed in the controller workspace.' })),
    risks: [],
    scopeExpansion: [],
    decisionRequest: null,
    ...overrides,
  };
}

function task({ reportValue = report(), metadata = {}, status = TaskState.TASK_STATE_COMPLETED } = {}) {
  return {
    id: 'system-task-1',
    contextId: 'system-context-1',
    status: { state: status },
    artifacts: [{
      parts: [{ content: { $case: 'text', value: JSON.stringify(reportValue) } }],
      metadata: {
        contract: WORKER_REPORT_CONTRACT,
        boundary: { results: [{ result: 'PASS' }] },
        writerExecution: {
          state: 'released',
          lane: { state: 'integrated' },
          delta: { known: true, changedPaths: ['docs/repair.md'], changedPathCount: 1 },
        },
        ...metadata,
      },
    }],
  };
}

function stubFactory({ terminalTask = task(), sendImpl, createImpl } = {}) {
  const calls = { cardUrls: [], sends: [], lists: [], gets: [], cancels: [] };
  const tasks = new Map();
  const value = {
    calls,
    tasks,
    factory: {
      async createFromAgentCard(card) {
        if (createImpl) return createImpl(card, calls);
        return {
          async getAgentCard() { return card; },
          async sendMessage(params, options) {
            calls.sends.push({ params, options });
            const message = params.message;
            const created = { ...terminalTask, contextId: message.contextId, id: 'task-' + calls.sends.length };
            tasks.set(message.contextId, created);
            if (sendImpl) return sendImpl({ params, options, created, calls, tasks });
            return { task: created };
          },
          async listTasks(params, options) {
            calls.lists.push({ params, options });
            const found = tasks.get(params.contextId);
            return { tasks: found ? [found] : [] };
          },
          async getTask(params, options) {
            calls.gets.push({ params, options });
            const found = [...tasks.values()].find((entry) => entry.id === params.id);
            if (!found) throw new Error('not found');
            return found;
          },
          async cancelTask(params, options) {
            calls.cancels.push({ params, options });
            return { ...terminalTask, id: params.id, status: { state: TaskState.TASK_STATE_CANCELED } };
          },
        };
      },
    },
  };
  value.factory.calls = calls;
  return value;
}

function client(factory, journal = new InMemoryDispatchJournal(), overrides = {}) {
  const fetchImpl = overrides.fetchImpl || (async (url) => {
    factory.calls.cardUrls.push(url);
    return { ok: true, url, async json() { return url.endsWith('/runtime')
      ? { schema: 'system-agent-runtime-identity/v1', pid: 300, moduleLoadedAt: 'system-boot-1', sourceHashes: {}, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: ['launcher.js'] }
      : { supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: endpoint }], capabilities: { extensions: [] } }; } };
  });
  return {
    journal,
    repair: createSystemRepairClient({ endpoint, authToken: 'system-token', journal, pollIntervalMs: 0, cancelTimeoutMs: 0, clientFactory: factory, ...overrides, fetchImpl }),
  };
}

test('system client validates loopback route and rejects credentials and unrelated paths', () => {
  const journal = new InMemoryDispatchJournal();
  const factory = stubFactory().factory;
  for (const value of [
    'https://example.com/agents/chuck-norris',
    'http://user:pass@127.0.0.1/agents/chuck-norris',
    'http://127.0.0.1/agents/other',
    'http://127.0.0.1/agents/chuck-norris?token=x',
  ]) {
    assert.throws(() => createSystemRepairClient({ endpoint: value, authToken: 'x', journal, clientFactory: factory }), /loopback/);
  }
});


test('client rejects an agent card that redirects bearer RPC to another endpoint', async () => {
  const service = stubFactory();
  const { repair, journal } = client(service.factory, new InMemoryDispatchJournal(), {
    fetchImpl: async (url) => ({
      ok: true, url,
      async json() { return { supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: 'http://127.0.0.1:9090/agents/chuck-norris' }], capabilities: { extensions: [] } }; },
    }),
  });
  const result = await repair(request, { runId: 'run-card-redirect', requestId: 'r1' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /JSONRPC interface/);
  assert.equal(journal.listByRun('run-card-redirect').length, 0);
  assert.equal(service.calls.sends.length, 0);
});

test('sanitized card makes the real SDK select only the configured endpoint', async () => {
  const attackerUrl = 'http://127.0.0.1:9090/agents/attacker';
  const card = {
    name: 'system repair',
    supportedInterfaces: [
      { protocolBinding: 'JSONRPC', protocolVersion: '0.3', url: endpoint },
      { protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: attackerUrl },
    ],
  };
  const factory = new ClientFactory();
  const unsafeClient = await factory.createFromAgentCard(card);
  assert.equal(unsafeClient.transport.endpoint, attackerUrl);
  const sanitized = validateAgentCard(card, new URL(endpoint), endpoint + '/agent-card.json');
  assert.deepEqual(sanitized.supportedInterfaces, [card.supportedInterfaces[0]]);
  const safeClient = await factory.createFromAgentCard(sanitized);
  assert.equal(safeClient.transport.endpoint, endpoint);
  assert.equal((await safeClient.getAgentCard()).supportedInterfaces.length, 1);
});

test('client sends bounded scoped evidence with bearer auth and accepts only released integrated repair evidence', async () => {
  const service = stubFactory();
  const { repair, journal } = client(service.factory);
  const result = await repair(request, { runId: 'run-1', requestId: 'run-1:system:1', workspace: '/private/project', contextId: 'caller-context' });
  assert.equal(result.status, 'completed');
  assert.equal(service.calls.cardUrls[0], 'http://127.0.0.1:8080/agents/chuck-norris/agent-card.json');
  const sent = service.calls.sends[0];
  assert.equal(sent.options.serviceParameters.authorization, 'Bearer system-token');
  const payload = JSON.parse(sent.params.message.parts[0].content.value);
  assert.equal(payload.protocol, 'system-repair-request/v1');
  assert.deepEqual(payload.serviceScope, SYSTEM_REPAIR_SCOPE);
  assert.deepEqual(payload.serviceChecks, SYSTEM_REPAIR_CHECKS);
  assert.equal(payload.request.incidentId, request.incidentId);
  assert.equal(payload.projectContext.openDecisions[0].id, 'run:r1:a0');
  assert.ok(payload.projectContext.projectChecks.length === 1);
  assert.equal(JSON.stringify(payload).includes('/private/project'), false);
  assert.equal(sent.params.message.contextId, service.tasks.keys().next().value);
  assert.equal(journal.listByRun('run-1')[0].role, 'chuck-norris');
  assert.equal(journal.listByRun('run-1')[0].sandbox, 'workspace-write');
  assert.equal(journal.listByRun('run-1')[0].state, 'finished');
});

test('completed JavaScript repairs require runtime-generation proof and failed checks block success', async () => {
  const runtimeTask = task({ metadata: {
    writerExecution: {
      state: 'released', lane: { state: 'integrated' },
      delta: { known: true, changedPaths: ['src/lead-graph.js'], changedPathCount: 1 },
    },
    systemSourceManifest: { schema: 'system-source-manifest/v1', known: true, files: [{ path: 'src/lead-graph.js', sha256: 'a'.repeat(64) }] },
  } });
  const runtime = stubFactory({ terminalTask: runtimeTask });
  const journal = new InMemoryDispatchJournal();
  const { repair } = client(runtime.factory, journal);
  const oldIdentity = { schema: 'system-agent-runtime-identity/v1', pid: 101, moduleLoadedAt: 'boot-old', sourceHashes: { 'src/lead-graph.js': 'b'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] };
  const first = await repair(request, { runId: 'run-runtime', requestId: 'r1', requesterRuntimeIdentity: oldIdentity });
  assert.equal(first.status, 'restart_required');
  assert.equal((await repair(request, { runId: 'run-runtime', requestId: 'r1', requesterRuntimeIdentity: oldIdentity })).status, 'restart_required');
  const restarted = await repair(request, { runId: 'run-runtime', requestId: 'r1', requesterRuntimeIdentity: {
    schema: 'system-agent-runtime-identity/v1', pid: 102, moduleLoadedAt: 'boot-new', sourceHashes: { 'src/lead-graph.js': 'a'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [],
  } });
  assert.equal(restarted.status, 'completed');
  assert.equal(restarted.runtimeReloadVerified, true);

  const failed = stubFactory({ terminalTask: task({ reportValue: report({
    checks: [{ command: SYSTEM_REPAIR_CHECKS[0], result: 'passed', detail: 'ok' }, { command: SYSTEM_REPAIR_CHECKS[1], result: 'not_run', detail: 'not run' }],
  }) }) });
  assert.equal((await client(failed.factory).repair(request, { runId: 'run-failed', requestId: 'r1' })).reason, 'repair_check_not_passed');

  const unknownLane = stubFactory({ terminalTask: task({ metadata: {
    writerExecution: {
      state: 'released', lane: { state: 'unknown' },
      delta: { known: true, changedPaths: ['docs/repair.md'], changedPathCount: 1 },
    },
  } }) });
  const unknown = await client(unknownLane.factory).repair(request, { runId: 'run-lane', requestId: 'r1' });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reason, 'writer_execution_not_authoritatively_released');
});



test('test and launcher UI JavaScript changes do not require a server runtime reload', async () => {
  for (const file of ['test/controller.test.js', 'launcher-ui/app.js', 'docs/readme.js']) {
    const runtimeTask = task({ reportValue: report({ filesChanged: [file] }), metadata: {
      writerExecution: { state: 'released', lane: { state: 'integrated' }, delta: { known: true, changedPaths: [file], changedPathCount: 1 } },
    } });
    assert.equal((await client(stubFactory({ terminalTask: runtimeTask }).factory)
      .repair(request, { runId: 'reload-exclude-' + file, requestId: 'r1' })).status, 'completed');
  }
});

test('profile reload proof requires a changed service card identity matching integrated source hash', async () => {
  const profilePath = 'profiles/system/chuck-norris.toml';
  const profileTask = task({ reportValue: report({ filesChanged: [profilePath] }), metadata: {
    writerExecution: {
      state: 'released', lane: { state: 'integrated' },
      delta: { known: true, changedPaths: [profilePath], changedPathCount: 1 },
    },
    systemSourceManifest: { schema: 'system-source-manifest/v1', known: true, files: [{ path: profilePath, sha256: 'c'.repeat(64) }] },
  } });
  const service = stubFactory({ terminalTask: profileTask });
  let runtimeFetches = 0;
  const fetchImpl = async (url) => {
    service.calls.cardUrls.push(url);
    return {
      ok: true, url,
      async json() {
        if (url.endsWith('/runtime')) {
          runtimeFetches += 1;
          const sha = runtimeFetches === 1 ? 'b'.repeat(64) : 'c'.repeat(64);
          return {
            schema: 'system-agent-runtime-identity/v1', pid: 401 + runtimeFetches,
            moduleLoadedAt: 'system-boot-' + runtimeFetches, sourceHashes: {}, profileHashes: { [profilePath]: sha },
            uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [],
          };
        }
        return { supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: endpoint }], capabilities: { extensions: [] } };
      },
    };
  };
  const journal = new InMemoryDispatchJournal();
  const { repair } = client(service.factory, journal, { fetchImpl });
  const identity = { pid: 200, moduleLoadedAt: 'same-project-server-generation' };
  assert.equal((await repair(request, { runId: 'run-profile', requestId: 'r1', requesterRuntimeIdentity: identity })).status, 'restart_required');
  const resumed = await repair(request, { runId: 'run-profile', requestId: 'r1', requesterRuntimeIdentity: identity });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.runtimeReloadVerified, true);
});

test('ambiguous submitting replay discovers by deterministic context and never sends twice', async () => {
  const journal = new InMemoryDispatchJournal();
  const runId = 'run-replay';
  const requestId = 'stable-request';
  const hash = crypto.createHash('sha256').update(runId).update('\0').update(requestId).digest('hex');
  const attemptId = 'system:' + hash + ':t1';
  const contextId = deterministicContextId(attemptId);
  journal.recordSubmitting({
    attemptId, runId, assignmentId: 'system:' + hash, role: 'chuck-norris',
    sandbox: 'workspace-write', contextId, objectiveSha256: hash,
  });
  const service = stubFactory();
  const { repair } = client(service.factory, journal);
  const result = await repair(request, { runId, requestId });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'ambiguous_writable_submission_not_resent');
  assert.equal(service.calls.sends.length, 0);
  assert.equal(service.calls.lists.length, 1);
  assert.equal(journal.get(attemptId).state, 'submitting');
});

test('request IDs are namespaced by run and failed card discovery can be retried without journal poison', async () => {
  let createCount = 0;
  const service = stubFactory();
  const journal = new InMemoryDispatchJournal();
  const wrappedFactory = service.factory;
  const fetchImpl = async (url) => {
    createCount += 1;
    service.calls.cardUrls.push(url);
    if (createCount === 1) throw new Error('service unavailable');
    return { ok: true, url, async json() { return url.endsWith('/runtime')
      ? { schema: 'system-agent-runtime-identity/v1', pid: 300, moduleLoadedAt: 'system-boot-1', sourceHashes: {}, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: ['launcher.js'] }
      : { supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: endpoint }], capabilities: { extensions: [] } }; } };
  };
  const { repair } = client(wrappedFactory, journal, { fetchImpl });
  const first = await repair(request, { runId: 'project-a', requestId: 'same' });
  assert.equal(first.status, 'unavailable');
  assert.equal(journal.listByRun('project-a').length, 0);
  assert.equal((await repair(request, { runId: 'project-b', requestId: 'same' })).status, 'completed');
  assert.equal((await repair(request, { runId: 'project-a', requestId: 'same' })).status, 'completed');
  assert.equal(journal.listByRun('project-a')[0].attemptId === journal.listByRun('project-b')[0].attemptId, false);
});

test('aborted send attempts cancellation and returns unknown effects', async () => {
  const service = stubFactory({ sendImpl: ({ options }) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }) });
  const { repair } = client(service.factory, new InMemoryDispatchJournal(), { cancelTimeoutMs: 200 });
  const controller = new AbortController();
  const pending = repair(request, { runId: 'run-abort', requestId: 'abort-1', signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.equal(result.status, 'unknown');
  assert.ok(['canceled_with_unknown_effects', 'cancellation_unconfirmed'].includes(result.reason));
  assert.equal(service.calls.sends.length, 1);
  assert.ok(service.calls.cancels.length > 0);
});

test('shared runtime modules need matching fresh hashes in every process that loaded them', () => {
  const file = 'src/shared-runtime.js';
  const manifest = { schema: 'system-source-manifest/v1', known: true, files: [{ path: file, sha256: 'c'.repeat(64) }] };
  const result = {
    status: 'restart_required', delta: { changedPaths: [file] }, systemSourceManifest: manifest,
    runtimeIdentityAtSubmit: {
      requester: { generation: '10:r1', sourceHashes: { [file]: 'a'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] },
      service: { generation: '20:s1', sourceHashes: { [file]: 'a'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] },
    },
  };
  const requesterOnly = restartResult(result, {
    requesterRuntimeIdentity: { pid: 11, moduleLoadedAt: 'r2', sourceHashes: { [file]: 'c'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] },
    serviceRuntimeIdentity: { schema: 'system-agent-runtime-identity/v1', pid: 20, moduleLoadedAt: 's1', sourceHashes: { [file]: 'a'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] },
  });
  assert.equal(requesterOnly.status, 'restart_required');
  const serviceOnly = restartResult(result, {
    requesterRuntimeIdentity: { pid: 10, moduleLoadedAt: 'r1', sourceHashes: { [file]: 'a'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] },
    serviceRuntimeIdentity: { schema: 'system-agent-runtime-identity/v1', pid: 21, moduleLoadedAt: 's2', sourceHashes: { [file]: 'c'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] },
  });
  assert.equal(serviceOnly.status, 'restart_required');
  const both = restartResult(result, {
    requesterRuntimeIdentity: { pid: 11, moduleLoadedAt: 'r2', sourceHashes: { [file]: 'c'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] },
    serviceRuntimeIdentity: { schema: 'system-agent-runtime-identity/v1', pid: 21, moduleLoadedAt: 's2', sourceHashes: { [file]: 'c'.repeat(64) }, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] },
  });
  assert.equal(both.status, 'completed');
  assert.equal(both.runtimeReloadVerified, true);
});
