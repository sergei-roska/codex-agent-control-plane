'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const { createAuthMiddleware } = require('../src/local-auth');
const { DeliveryEngineRouter } = require('../src/delivery-engine-router');
const { registerDeliveryHostControls } = require('../src/delivery-host-controls');

const TOKEN = 'A'.repeat(43);
const PROJECT = '0123456789';

async function fixture(t, { engineName = 'concurrent-v1' } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  let resolveRun;
  const heldTurn = new Promise((resolve) => { resolveRun = resolve; });
  const accepted = new Map();
  let steerCalls = 0;
  let runCalls = 0;
  const currentRevisions = { planRevision: 3, goalRevision: 2, controlRevision: 4 };
  const concurrentEngine = {
    run: () => { runCalls += 1; return heldTurn; },
    resume: async () => ({ status: 'completed' }),
    controlStatus(runId) {
      const mapping = router.mapping(runId);
      if (!mapping || mapping.engine !== 'concurrent-v1') return null;
      return { engine: 'concurrent-v1', runId, projectId: PROJECT, sessionId: mapping.sessionId,
        objectiveId: mapping.objectiveId, revisions: { ...currentRevisions },
        inbox: [], pending: [], disposition: 'running' };
    },
    async steer(body) {
      steerCalls += 1;
      if (accepted.has(body.messageId)) {
        const prior = accepted.get(body.messageId);
        if (JSON.stringify(prior.body) !== JSON.stringify(body)) throw Object.assign(new Error('conflict'), { code: 'message_id_conflict' });
        return { ...prior.ack, duplicate: true };
      }
      if (body.expectedPlanRevision !== currentRevisions.planRevision
        || body.expectedGoalRevision !== currentRevisions.goalRevision
        || body.expectedControlRevision !== currentRevisions.controlRevision) {
        throw Object.assign(new Error('stale'), { code: 'steer_revision_stale' });
      }
      const ack = { messageId: body.messageId, state: 'received', acknowledged: true,
        engine: 'concurrent-v1', runId: body.runId, projectId: body.projectId,
        sessionId: body.sessionId, objectiveId: body.objectiveId };
      accepted.set(body.messageId, { body: structuredClone(body), ack });
      return ack;
    },
  };
  const legacyEngine = { run: async () => ({ status: 'completed' }), resume: async () => ({ status: 'completed' }) };
  const router = new DeliveryEngineRouter({ db, projectId: PROJECT, defaultEngine: engineName, legacyEngine, concurrentEngine });
  const app = express();
  registerDeliveryHostControls(app, { authMiddleware: createAuthMiddleware(TOKEN), router });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    resolveRun({ status: 'completed' });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, url, body, authenticated = true) => {
    const response = await fetch(`${base}${url}`, { method, headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(authenticated ? { authorization: `Bearer ${TOKEN}` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { router, request, currentRevisions, get steerCalls() { return steerCalls; }, get runCalls() { return runCalls; } };
}

test('authenticated controls use persisted router scope and return durable immediate acknowledgements', async (t) => {
  const fx = await fixture(t);
  const running = fx.router.run({ runId: 'run-control-1', goal: 'goal' });
  const mapping = fx.router.mapping('run-control-1');
  assert.equal(mapping.engine, 'concurrent-v1');
  const control = await fx.request('GET', '/control/delivery/run-control-1');
  assert.equal(control.status, 200);
  assert.equal(control.body.objectiveId, mapping.objectiveId);
  const body = { runId: mapping.runId, projectId: PROJECT, sessionId: mapping.sessionId,
    objectiveId: mapping.objectiveId, messageId: 'message-1', text: 'Please inspect this path.',
    expectedPlanRevision: 3, expectedGoalRevision: 2, expectedControlRevision: 4 };
  const first = await fx.request('POST', '/control/delivery/run-control-1/steer', body);
  assert.equal(first.status, 200);
  assert.equal(first.body.state, 'received');
  assert.equal(first.body.acknowledged, true);
  assert.equal(fx.steerCalls, 1);
  Object.assign(fx.currentRevisions, { planRevision: 4, goalRevision: 2, controlRevision: 5 });
  const duplicate = await fx.request('POST', '/control/delivery/run-control-1/steer', body);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(fx.steerCalls, 2);
  const staleNew = await fx.request('POST', '/control/delivery/run-control-1/steer', { ...body, messageId: 'message-2' });
  assert.equal(staleNew.status, 409);
  const changedReplay = await fx.request('POST', '/control/delivery/run-control-1/steer', { ...body, text: 'changed' });
  assert.equal(changedReplay.status, 409);
  assert.equal(fx.router.mapping('run-control-1').engine, 'concurrent-v1');
  assert.equal(fx.runCalls, 1);
  void running;
});

test('control routes authenticate before revealing mapped state', async (t) => {
  const fx = await fixture(t);
  void fx.router.run({ runId: 'run-secret', goal: 'goal' });
  assert.deepEqual(await fx.request('GET', '/control/delivery/run-secret', undefined, false),
    { status: 401, body: { error: 'Unauthorized' } });
});

test('controls fail closed for unknown, legacy, and mismatched scopes', async (t) => {
  const fx = await fixture(t);
  fx.router.defaultEngine = 'legacy';
  await fx.router.run({ runId: 'legacy-run', goal: 'legacy' });
  fx.router.defaultEngine = 'concurrent-v1';
  assert.deepEqual(await fx.request('GET', '/control/delivery/missing-run'),
    { status: 404, body: { error: 'delivery_run_not_found' } });
  const body = { runId: 'legacy-run', projectId: PROJECT, sessionId: 'session', objectiveId: 'objective',
    messageId: 'message', text: 'Steer', expectedPlanRevision: 3, expectedGoalRevision: 2, expectedControlRevision: 4 };
  assert.deepEqual(await fx.request('POST', '/control/delivery/legacy-run/steer', body),
    { status: 503, body: { error: 'delivery_engine_unsupported' } });
  void fx.router.run({ runId: 'concurrent-run', goal: 'current' });
  const scoped = { ...body, runId: 'concurrent-run', ...((mapping) => ({ sessionId: mapping.sessionId, objectiveId: mapping.objectiveId }))(fx.router.mapping('concurrent-run')) };
  assert.equal((await fx.request('POST', '/control/delivery/concurrent-run/steer', { ...scoped, objectiveId: 'wrong-objective' })).status, 409);
  assert.equal((await fx.request('POST', '/control/delivery/concurrent-run/steer', { ...scoped, expectedPlanRevision: 9 })).status, 409);
  assert.equal((await fx.request('POST', '/control/delivery/concurrent-run/steer', { ...scoped, extra: true })).status, 400);
  assert.equal((await fx.request('POST', '/control/delivery/concurrent-run/steer', { ...scoped, expectedGoalRevision: Number.MAX_SAFE_INTEGER + 1 })).status, 400);
});
