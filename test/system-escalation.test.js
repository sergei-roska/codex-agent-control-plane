'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskState } = require('@a2a-js/sdk');
const { LeadOrchestrator } = require('../src/lead-orchestrator');
const { InMemoryDispatchJournal } = require('../src/durable-store');
const { WORKER_REPORT_CONTRACT } = require('../src/contracts');
const { createSystemRepairClient, SYSTEM_REPAIR_CHECKS } = require('../src/system-repair-client');

const RUN_ID = 'system-escalation-run';
const systemDecision = JSON.stringify({
  action: 'request_system_repair', assignments: [], final: '', resolutions: [],
  humanInput: null, goalAchieved: null, acceptanceChecks: null, records: [],
  systemInput: {
    incidentId: 'system-client-routing', question: 'Repair the hosting control plane.',
    evidence: ['The durable system request identity is preserved.'], relatedDecisionIds: [],
  },
});
const finishDecision = JSON.stringify({
  action: 'finish', assignments: [], final: 'The requested system repair is complete.',
  resolutions: [], humanInput: null, goalAchieved: true, acceptanceChecks: null,
  records: [], systemInput: null,
});
const report = JSON.stringify({
  outcome: 'completed', summary: 'A diagnostic system repair result.',
  filesChanged: [], filesInspected: ['src/lead-graph.js'],
  checks: SYSTEM_REPAIR_CHECKS.map((command) => ({ command, result: 'passed', detail: 'Passed.' })),
  risks: [], scopeExpansion: [], decisionRequest: null,
});

function serviceFactory({ taskStatus = TaskState.TASK_STATE_COMPLETED } = {}) {
  const calls = { cardUrls: [], sends: [], gets: [], lists: [], cancels: [] };
  const clientFactory = {
    async createFromAgentCard(card) {
      return {
        async getAgentCard() { return card; },
        async sendMessage(params, options) {
          calls.sends.push({ params, options });
          return { task: {
            id: 'system-task', contextId: params.message.contextId,
            status: { state: taskStatus },
            artifacts: [{
              parts: [{ content: { $case: 'text', value: report } }],
              metadata: {
                contract: WORKER_REPORT_CONTRACT,
                boundary: { results: [{ result: 'PASS' }] },
                writerExecution: { state: 'released', lane: { state: 'integrated' }, delta: { known: true, changedPaths: [], changedPathCount: 0 } },
              },
            }],
          } };
        },
        async getTask(params, options) {
          calls.gets.push({ params, options });
          return { id: 'system-task', status: { state: taskStatus }, artifacts: [] };
        },
        async listTasks(params, options) { calls.lists.push({ params, options }); return { tasks: [] }; },
        async cancelTask(params, options) { calls.cancels.push({ params, options }); return { id: params.id, status: { state: TaskState.TASK_STATE_CANCELED } }; },
      };
    },
  };
  clientFactory.calls = calls;
  return { calls, clientFactory };
}

function harness({ taskStatus, pauseBefore = false, pauseDuring = false, unavailableAttempts = 0 } = {}) {
  const turns = [];
  let orchestrator;
  const appServer = {
    async run(args) {
      turns.push(args);
      if (pauseBefore && turns.length === 1) orchestrator.requestPause(RUN_ID);
      return { threadId: 'lead-thread', status: 'completed', text: turns.length === 1 ? systemDecision : finishDecision };
    },
  };
  const service = serviceFactory({ taskStatus });
  let repairCalls = 0;
  const systemRepair = createSystemRepairClient({
    endpoint: 'http://127.0.0.1:8080/agents/chuck-norris',
    authToken: 'system-specific-token',
    journal: new InMemoryDispatchJournal(),
    pollIntervalMs: 0, cancelTimeoutMs: 0,
    clientFactory: service.clientFactory,
    fetchImpl: async (url) => {
      service.calls.cardUrls.push(url);
      return { ok: true, url, async json() { return url.endsWith('/runtime')
        ? { schema: 'system-agent-runtime-identity/v1', pid: 301, moduleLoadedAt: 'system-boot-1', sourceHashes: {}, profileHashes: {}, uncapturedSourceFiles: [], loadedUncapturedSourceFiles: [] }
        : { supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: 'http://127.0.0.1:8080/agents/chuck-norris' }], capabilities: { extensions: [] } }; } };
    },
  });
  const roles = new Map([['orch-explorer', {
    name: 'orch-explorer', description: 'Read-only explorer', model: 'test', effort: 'high',
    sandbox: 'read-only', instructions: 'Inspect only.',
  }]]);
  orchestrator = new LeadOrchestrator({
    appServer, roles, workspace: '/tmp/system-escalation-project',
    baseUrl: 'http://127.0.0.1:4040', clientFactory: { async createFromUrl() { throw new Error('project role client must not be used'); } },
    repairSystem: async (request, context) => {
      repairCalls += 1;
      if (repairCalls <= unavailableAttempts) return { status: 'unavailable', reason: 'service_temporarily_unavailable' };
      if (pauseDuring) context.onEvent?.({ type: 'test_pause_during_system_repair' });
      return systemRepair(request, context);
    },
    systemAgentAvailable: true,
    pollIntervalMs: 0,
  });
  return { orchestrator, service, turns, get repairCalls() { return repairCalls; } };
}

test('A2A system repair is a separate evidence channel and never receives a project workspace', async () => {
  const h = harness();
  const events = [];
  const result = await h.orchestrator.run({
    runId: RUN_ID, goal: 'Fix a demonstrated hosting control-plane defect.',
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.assignments, []);
  assert.equal(result.acceptance.disposition, 'not_required');
  assert.equal(h.service.calls.cardUrls[0], 'http://127.0.0.1:8080/agents/chuck-norris/agent-card.json');
  assert.equal(h.service.calls.sends.length, 1);
  const sent = h.service.calls.sends[0];
  assert.equal(sent.options.serviceParameters.authorization, 'Bearer system-specific-token');
  assert.equal(sent.params.message.metadata.systemRequest, true);
  assert.equal(sent.params.message.parts[0].content.value.includes('/tmp/system-escalation-project'), false);
  assert.ok(JSON.stringify(h.turns[0].input).includes('Separate system repair service available: yes.'));
  assert.ok(JSON.stringify(h.turns[1].input).includes('Prior system repair results'));
  assert.ok(JSON.stringify(h.turns[1].input).includes('diagnostic evidence only; never acceptance credit'));
  assert.equal(events.some((event) => event.type === 'assignment' && event.role === 'chuck-norris'), false);
});

test('owner pause before system dispatch prevents submission and preserves the repair request', async () => {
  const h = harness({ pauseBefore: true });
  const result = await h.orchestrator.run({ runId: RUN_ID, goal: 'Fix a demonstrated controller defect.' });
  assert.equal(result.status, 'input_required');
  assert.equal(result.pause.kind, 'owner_pause');
  assert.equal(h.service.calls.sends.length, 0);
  const snapshot = await h.orchestrator._snapshot(RUN_ID);
  assert.equal(snapshot.values.systemRequest.requestId, RUN_ID + ':system:1');
});

test('owner pause during an unresolved repair keeps the request and truthful technical evidence', async () => {
  const h = harness({ taskStatus: TaskState.TASK_STATE_INPUT_REQUIRED });
  const controller = new AbortController();
  const result = await h.orchestrator.run({
    runId: RUN_ID, goal: 'Fix a demonstrated controller defect.',
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'system_repair_submitted') h.orchestrator.requestPause(RUN_ID);
    },
  });
  assert.equal(result.status, 'input_required');
  assert.equal(result.pause.kind, 'owner_pause');
  const snapshot = await h.orchestrator._snapshot(RUN_ID);
  assert.equal(snapshot.values.systemRequest.status, 'blocked');
  assert.equal(snapshot.values.systemResults.at(-1).status, 'blocked');
  assert.equal(h.service.calls.sends.length, 1);
});


test('owner stop during system submission parks truthfully with unknown effects', async () => {
  const h = harness();
  const controller = new AbortController();
  const result = await h.orchestrator.run({
    runId: RUN_ID, goal: 'Fix a demonstrated controller defect.',
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'system_repair_submitted') {
        controller.abort(Object.assign(new Error('owner stop'), { ownerStop: true }));
      }
    },
  });
  assert.equal(result.status, 'input_required');
  assert.equal(result.pause.kind, 'system_repair');
  assert.match(result.pause.message, /effects are unconfirmed/i);
  const snapshot = await h.orchestrator._snapshot(RUN_ID);
  assert.equal(snapshot.values.systemRequest.status, 'unknown');
  assert.equal(snapshot.values.systemResults.at(-1).result.reason, 'cancellation_unconfirmed');
  assert.equal(result.text.includes('all active A2A tasks were confirmed stopped'), false);
});

test('manual technical rechecks remain available after repeated outages with one durable request identity', async () => {
  const h = harness({ unavailableAttempts: 7 });
  let result = await h.orchestrator.run({ runId: RUN_ID, goal: 'Fix a demonstrated hosting control-plane defect.' });
  assert.equal(result.pause.kind, 'system_repair');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    result = await h.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Check the same repair request again.' } });
    assert.equal(result.pause?.kind, 'system_repair', JSON.stringify({ result, calls: h.repairCalls, request: (await h.orchestrator._snapshot(RUN_ID)).values.systemRequest }));
  }
  result = await h.orchestrator.resume({ runId: RUN_ID, input: { answer: 'Check the same repair request again.' } });
  assert.equal(result.status, 'completed');
  assert.equal(h.repairCalls, 8);
  assert.equal(h.service.calls.sends.length, 1);
  assert.equal(h.service.calls.sends[0].params.message.metadata.requestId, RUN_ID + ':system:1');
});
