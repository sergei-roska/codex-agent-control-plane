'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');
const { createLauncherApp } = require('../src/launcher-app');

const PROJECT = 'aaaaaaaaaa';
let root; let database; let settings; let backend; let backendPort; let launcher; let base; let serverCalls; let control; let projectStatus; let controlFailureStatus;

async function api(method, url, body) {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function status(overrides = {}) {
  return { engine: 'concurrent-v1', runId: 'run-1', projectId: PROJECT, sessionId: 'session-1', objectiveId: 'objective-1',
    revisions: { planRevision: 3, goalRevision: 2, controlRevision: 4, ownerGeneration: 1 }, inbox: [], pending: [], disposition: 'executing', ...overrides };
}

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-owner-delivery-'));
  database = path.join(root, 'state.sqlite'); settings = path.join(root, 'project-settings.json');
  const db = new Database(database);
  db.exec(`CREATE TABLE concurrent_delivery_runs(project_id TEXT, run_id TEXT, objective_id TEXT, session_id TEXT, PRIMARY KEY(project_id,run_id));
    INSERT INTO concurrent_delivery_runs VALUES('${PROJECT}','run-1','objective-1','session-1');`);
  db.close();
  backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      serverCalls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      if (controlFailureStatus && req.method === 'GET') { res.statusCode = controlFailureStatus; res.end('{}'); return; }
      if (req.method === 'POST' && control.postStatus) { res.statusCode = control.postStatus; res.end('{}'); return; }
      res.statusCode = req.url.endsWith('/steer') ? 200 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.method === 'POST' ? control.ack : control.status));
    });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve)); backendPort = backend.address().port;
});

test.after(() => {
  if (launcher) launcher.close();
  if (backend) backend.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test.beforeEach(async () => {
  serverCalls = [];
  projectStatus = 'running';
  controlFailureStatus = 0;
  control = { status: status(), ack: { ...status(), messageId: 'message-1', state: 'received', acknowledged: true }, postStatus: 0 };
  if (launcher) launcher.close();
  const projects = {
    get: () => ({ id: PROJECT, path: root, status: projectStatus }),
    baseUrl: () => 'http://127.0.0.1:' + backendPort,
    stateDbPath: () => database,
    projectSettingsPath: () => settings,
  };
  const app = createLauncherApp({ projects, readAuthToken: () => 'owner-token', openTasksDb: (file, options) => new Database(file, options) });
  await new Promise(resolve => { launcher = app.listen(0, '127.0.0.1', resolve); }); base = 'http://127.0.0.1:' + launcher.address().port;
});

test('GET resolves only the exact readonly run mapping and checks server scope', async () => {
  const db = new Database(database, { readonly: true });
  const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(); db.close();
  const response = await api('GET', `/api/projects/${PROJECT}/delivery/control?objectiveId=objective-1&sessionId=session-1`);
  assert.equal(response.status, 200); assert.equal(response.body.runId, 'run-1');
  assert.deepEqual(serverCalls.map(call => [call.method, call.url, call.authorization]), [['GET', '/control/delivery/run-1', 'Bearer owner-token']]);
  const wrong = await api('GET', `/api/projects/${PROJECT}/delivery/control?objectiveId=objective-1&sessionId=session-other`);
  assert.deepEqual(wrong.body, { available: false, reason: 'concurrent_run_unavailable' });
  assert.equal(serverCalls.length, 1);
  control.status = status({ objectiveId: 'foreign-objective' });
  const mismatch = await api('GET', `/api/projects/${PROJECT}/delivery/control?objectiveId=objective-1&sessionId=session-1`);
  assert.equal(mismatch.status, 502);
  controlFailureStatus = 404;
  const oldBackend = await api('GET', `/api/projects/${PROJECT}/delivery/control?objectiveId=objective-1&sessionId=session-1`);
  assert.deepEqual(oldBackend.body, { available: false, reason: 'owner_control_unavailable' });
  const after = new Database(database, { readonly: true });
  assert.deepEqual(after.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), schema); after.close();
});

test('POST validates scope, forwards stale revisions for durable replay, and validates the acknowledgement', async () => {
  const body = { runId: 'run-1', projectId: PROJECT, sessionId: 'session-1', objectiveId: 'objective-1', messageId: 'message-1', text: 'Please focus on the API.',
    expectedPlanRevision: 3, expectedGoalRevision: 2, expectedControlRevision: 4 };
  control.ack.messageId = 'message-1';
  const staleDuplicate = { ...body, expectedPlanRevision: 2 };
  const replay = await api('POST', `/api/projects/${PROJECT}/delivery/steer`, staleDuplicate);
  assert.equal(replay.status, 200);
  assert.deepEqual(serverCalls.slice(0, 2).map(call => call.method), ['GET', 'POST']);
  assert.deepEqual(serverCalls[1].body, staleDuplicate);
  control.postStatus = 409;
  const staleNew = await api('POST', `/api/projects/${PROJECT}/delivery/steer`, { ...body, messageId: 'new-stale', expectedPlanRevision: 2 });
  assert.equal(staleNew.status, 409);
  control.postStatus = 0;
  const foreign = await api('POST', `/api/projects/${PROJECT}/delivery/steer`, { ...body, runId: 'run-other' });
  assert.equal(foreign.status, 409);
  const extra = await api('POST', `/api/projects/${PROJECT}/delivery/steer`, { ...body, extra: true }); assert.equal(extra.status, 400);
  assert.equal((await api('POST', `/api/projects/${PROJECT}/delivery/steer`, body)).status, 200);
  assert.deepEqual(serverCalls.slice(-2).map(call => [call.method, call.url]), [
    ['GET', '/control/delivery/run-1'], ['POST', '/control/delivery/run-1/steer'],
  ]);
  assert.deepEqual(serverCalls.at(-1).body, body); assert.equal(serverCalls.at(-1).authorization, 'Bearer owner-token');
  for (const badAck of [
    { ...control.ack, messageId: 'other' }, { ...control.ack, acknowledged: false },
    { ...control.ack, state: 'unknown' }, { ...control.ack, objectiveId: 'other' },
  ]) {
    control.ack = badAck;
    assert.equal((await api('POST', `/api/projects/${PROJECT}/delivery/steer`, body)).status, 502);
  }
  assert.equal((await api('POST', `/api/projects/${PROJECT}/delivery/steer`, { ...body, text: 'x'.repeat(2001) })).status, 400);
});

test('settings endpoint preserves valid owner fields, rejects invalid files and locks changes while running', async () => {
  const original = { version: 1, executionPermissions: 'strict', ownerChecks: ['npm test'], deliveryEngine: 'legacy' };
  projectStatus = 'stopped';
  fs.writeFileSync(settings, JSON.stringify(original), { mode: 0o600 });
  let response = await api('GET', `/api/projects/${PROJECT}/delivery-engine`);
  assert.deepEqual(response.body, { deliveryEngine: 'legacy', running: false, stopped: true });
  response = await api('PUT', `/api/projects/${PROJECT}/delivery-engine`, { deliveryEngine: 'concurrent-v1' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { ...original, deliveryEngine: 'concurrent-v1', updatedAt: JSON.parse(fs.readFileSync(settings, 'utf8')).updatedAt });
  assert.equal(fs.statSync(settings).mode & 0o777, 0o600);
  fs.writeFileSync(settings, '{ broken');
  response = await api('PUT', `/api/projects/${PROJECT}/delivery-engine`, { deliveryEngine: 'legacy' });
  assert.equal(response.status, 409); assert.equal(fs.readFileSync(settings, 'utf8'), '{ broken');
  fs.writeFileSync(settings, JSON.stringify(original));
  let runningState = 'starting';
  const projects = { get: () => ({ id: PROJECT, status: runningState }), baseUrl: () => 'http://127.0.0.1:' + backendPort,
    stateDbPath: () => database, projectSettingsPath: () => settings };
  launcher.close(); const app = createLauncherApp({ projects, readAuthToken: () => 'owner-token', openTasksDb: (file, options) => new Database(file, options) });
  await new Promise(resolve => { launcher = app.listen(0, '127.0.0.1', resolve); }); base = 'http://127.0.0.1:' + launcher.address().port;
  for (const state of ['starting', 'running', 'unknown']) {
    runningState = state;
    response = await api('PUT', `/api/projects/${PROJECT}/delivery-engine`, { deliveryEngine: 'concurrent-v1' });
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original);
  }
});
