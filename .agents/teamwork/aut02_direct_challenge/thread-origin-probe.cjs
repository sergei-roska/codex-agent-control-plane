'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { ServerCallContext, UnauthenticatedUser } = require('@a2a-js/sdk/server');
const { registerRoleAgents } = require('../../../src/a2a-role-service');
const { InMemoryStagingLog } = require('../../../src/staging-log');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aut02-thread-origin-'));
const target = path.join(root, 'scope.txt');
fs.writeFileSync(target, 'candidate A');
const calls = [];
const roles = new Map([['auditor', { name: 'auditor', description: 'Checks scoped changes.', instructions: 'Review only.', model: 'test', effort: 'low', sandbox: 'read-only' }]]);
const review = { kind: 'risk_change', checkpointId: 'checkpoint-1', reason: 'Review current candidate.', paths: ['scope.txt'], evidenceIds: ['evidence-1'], prerequisiteFor: [] };
const request = { objective: 'Review current candidate.', allowedFiles: [], inputs: ['a'], evidence: ['b'], acceptanceCriteria: ['c'], checks: ['d'], stopConditions: ['e'], review };
const report = JSON.stringify({ outcome: 'completed', summary: 'VERDICT: pass', filesChanged: [], filesInspected: ['scope.txt'], checks: [{ command: 'inspect', result: 'passed', detail: 'Reviewed.' }], risks: [], scopeExpansion: [], decisionRequest: null });
const appServer = { getCodexHome() { return null; }, async run(options) { const contextSeen = options.threadId === 'thread-1' ? 'candidate A' : options.threadId === 'thread-2' ? 'candidate B' : fs.readFileSync(target, 'utf8'); calls.push({ threadId: options.threadId || null, input: options.input, contextSeen }); return { threadId: options.threadId || `thread-${calls.length}`, turnId: `turn-${calls.length}`, status: 'completed', text: JSON.stringify({ ...JSON.parse(report), summary: `VERDICT: pass\nContext ${contextSeen}` }) }; } };
const app = express();
const agents = registerRoleAgents(app, { roles, appServer, workspace: root, baseUrl: 'http://127.0.0.1:7777', stagingLog: new InMemoryStagingLog() });
const context = new ServerCallContext({ user: new UnauthenticatedUser() });
async function send(attemptId, continuation, runId = 'run-1') {
  const input = { ...request, ...(continuation ? { continuation } : {}) };
  const result = await agents.get('auditor').handler.sendMessage({ message: { messageId: `msg-${attemptId}`, role: 1, parts: [{ content: { $case: 'text', value: JSON.stringify(input) } }], metadata: { runId, assignmentId: `assignment-${attemptId}`, attemptId } }, configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false } }, context);
  return { state: result.status.state, review: result.artifacts?.[0]?.metadata?.review || result.status.message?.metadata?.review, continuation: result.artifacts?.[0]?.metadata?.continuation, boundary: result.status.message?.metadata?.boundary };
}
(async () => {
  try {
    const a = await send('attempt-a');
    assert.equal(a.state, 3);
    assert.equal(a.review.accepted, true);
    fs.writeFileSync(target, 'candidate B');
    const b = await send('attempt-b');
    assert.equal(b.state, 3);
    assert.equal(b.review.accepted, true);
    const forged = await send('attempt-forged', { ofAttemptId: 'attempt-b', threadId: a.continuation.threadId, laneId: null, codexHome: null });
    console.log(JSON.stringify({ a, b, forged, calls: calls.map((c) => ({ threadId: c.threadId, contextSeen: c.contextSeen, input: c.input })) }, null, 2));
    assert.equal(calls.length, 3);
    assert.equal(calls[2].threadId, a.continuation.threadId);
    assert.equal(calls[2].contextSeen, 'candidate A');
    assert.equal(forged.state, 4, 'mismatched origin thread must be rejected before App Server execution');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
