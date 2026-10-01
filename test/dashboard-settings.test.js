'use strict';

// M5 settings, account and catalog routes over createDashboardApi with a real session guard and a
// fake App Server; no model calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { createDashboardApi } = require('../src/dashboard-api');
const { createDashboardAuth } = require('../src/dashboard-auth');
const { makeSettingsResolver } = require('../src/dashboard-settings-api');
const { createModelCatalog } = require('../src/model-catalog');
const { createAccountHealth } = require('../src/account-health');
const { createSettingsStore } = require('../src/settings-store');
const { migrateProductSchema } = require('../src/product-migrations');
const { loadLegacyPack, loadRolePack } = require('../src/role-pack');
const { makeFakeAppServer } = require('./fixtures/fake-app-server');

async function canBind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

let seq = 0;
const cmd = () => `st-${process.pid}-${String(++seq).padStart(6, '0')}`;

async function boot({ models, account, rateLimits } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-settings-'));
  const db = new Database(':memory:');
  await migrateProductSchema({ db });
  const appServer = makeFakeAppServer({ models, account, rateLimits });
  appServer.appServerVersion = '0.159.0';
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  const now = () => clock;
  const modelCatalog = createModelCatalog({ appServer, now });
  const accountHealth = createAccountHealth({ appServer, now });
  const activePack = loadRolePack();
  const legacyPack = loadLegacyPack();
  const settingsStore = createSettingsStore({ db, catalog: modelCatalog, now });
  let port = 0;
  const auth = createDashboardAuth({ db, getPort: () => port });
  const projection = { listCards: () => ({ cards: [] }) };
  const events = { health: () => ({}), lastSequence: () => 0, record: () => 1 };
  const api = createDashboardApi({
    projection, events, workspace, projectId: 'prj_test', auth, activePack, legacyPack, modelCatalog, accountHealth, settingsStore,
  });
  const app = express();
  app.use('/api/dashboard/v1', auth.sessionRouter());
  app.use('/api/dashboard/v1', auth.requireSession, api);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/api/dashboard/v1`;
  const { code } = auth.issuePairingCode();
  const paired = await fetch(`${base}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code }),
  });
  assert.equal(paired.status, 204);
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  const call = (method, p, body, { withCookie = true, withOrigin = true, raw = false } = {}) => fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(withCookie ? { Cookie: cookie } : {}),
      ...(withOrigin && method !== 'GET' ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
  });
  return {
    call, activePack, legacyPack, appServer, settingsStore, modelCatalog,
    tick: (ms) => { clock += ms; },
    close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })),
  };
}

const COORD = 'dlv-project-manager';
const putBody = (over = {}) => ({
  commandId: cmd(), expectedRevisionId: null, model: 'gpt-6-luna', effort: 'high', serviceTier: 'fast', ...over,
});

test('dashboard settings API', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }

  await suite.test('models: catalog status and normalized entries', async () => {
    const h = await boot();
    try {
      const body = await (await h.call('GET', '/models')).json();
      assert.equal(body.catalog.state, 'ok');
      assert.equal(body.catalog.error, null);
      assert.deepEqual(body.models.map((m) => m.model), ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']);
      const luna = body.models.find((m) => m.model === 'gpt-6-luna');
      assert.deepEqual(luna.efforts, ['low', 'medium', 'high', 'xhigh']);
      assert.deepEqual(luna.serviceTiers.map((t) => t.id), ['fast']);
      const refreshed = await h.call('POST', '/models/refresh', {});
      assert.equal(refreshed.status, 200);
      assert.equal((await refreshed.json()).models.length, 3);
    } finally { await h.close(); }
  });

  await suite.test('models: unavailable catalog reports state without failing the GET', async () => {
    const h = await boot({ models: new Error('app server down') });
    try {
      const res = await h.call('GET', '/models');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.catalog.state, 'unavailable');
      assert.equal(body.catalog.error.code, 'catalog_unavailable');
      assert.deepEqual(body.models, []);
      const save = await h.call('PUT', `/settings/roles/${COORD}`, putBody());
      assert.equal(save.status, 503);
      const err = (await save.json()).error;
      assert.equal(err.code, 'catalog_unavailable');
      assert.ok(err.requestId);
      const roles = await (await h.call('GET', '/settings/roles')).json();
      assert.ok(roles.roles.every((r) => r.valid === false && r.errors[0].field === 'catalog'));
    } finally { await h.close(); }
  });

  await suite.test('account: connected, requires_auth, unsupported_account', async () => {
    const connected = await boot({
      account: { account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' } },
      rateLimits: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: null }, ordinaryUsageAllowed: true },
    });
    try {
      const body = await (await connected.call('GET', '/account')).json();
      assert.equal(body.status, 'connected');
      assert.deepEqual(body.account, { type: 'chatgpt', planType: 'pro', email: 'dev@example.com' });
      assert.equal(body.rateLimits.primary.usedPercent, 12);
      assert.equal(body.rateLimits.secondary, null);
      assert.equal(body.rateLimits.ordinaryUsageAllowed, true);
      assert.equal(body.appServerVersion, '0.159.0');
      assert.ok(body.checkedAt);
    } finally { await connected.close(); }
    const anon = await boot({ account: { account: null, requiresOpenaiAuth: true } });
    try {
      const body = await (await anon.call('GET', '/account')).json();
      assert.equal(body.status, 'requires_auth');
      assert.equal(body.account, null);
    } finally { await anon.close(); }
    const apiKey = await boot({ account: { account: { type: 'apiKey' } } });
    try {
      const body = await (await apiKey.call('GET', '/account')).json();
      assert.equal(body.status, 'unsupported_account');
      assert.equal(body.account.type, 'apiKey');
      assert.equal(body.account.email, null);
    } finally { await apiKey.close(); }
    const down = await boot({ account: new Error('boom') });
    try {
      assert.equal((await (await down.call('GET', '/account')).json()).status, 'unavailable');
    } finally { await down.close(); }
  });

  await suite.test('account refresh bypasses the cache but is throttled to one load per 10 s', async () => {
    const h = await boot({ account: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' } } });
    try {
      let reads = 0;
      const original = h.appServer.getAccount;
      h.appServer.getAccount = async () => { reads += 1; return original(); };
      await h.call('GET', '/account');
      assert.equal(reads, 1);
      await h.call('GET', '/account');
      assert.equal(reads, 1, 'cached');
      h.tick(5_000);
      await h.call('POST', '/account/refresh', {});
      assert.equal(reads, 1, 'forced refresh within 10 s is throttled');
      h.tick(6_000);
      const res = await h.call('POST', '/account/refresh', {});
      assert.equal(res.status, 200);
      assert.equal(reads, 2);
    } finally { await h.close(); }
  });

  await suite.test('GET /settings/roles lists coordinator, specialists and repair profiles', async () => {
    const h = await boot();
    try {
      const body = await (await h.call('GET', '/settings/roles')).json();
      assert.deepEqual(body.pack, { packId: h.activePack.packId, version: h.activePack.version });
      const kinds = new Set(body.roles.map((r) => r.kind));
      assert.deepEqual([...kinds].sort(), ['coordinator', 'repair', 'specialist']);
      const expected = 1 + h.activePack.roles.length + h.activePack.repairProfiles.size;
      assert.equal(body.roles.length, expected);
      const coord = body.roles.find((r) => r.roleRuntimeId === COORD);
      assert.equal(coord.kind, 'coordinator');
      assert.equal(coord.current, null);
      assert.equal(coord.effective.source, 'profile');
      assert.deepEqual(coord.effective, { ...coord.profile, source: 'profile' });
      assert.ok(coord.publicId);
      const repair = body.roles.find((r) => r.kind === 'repair');
      assert.equal(repair.publicId, null);
    } finally { await h.close(); }
  });

  await suite.test('save -> effective saved -> history -> replay', async () => {
    const h = await boot();
    try {
      const body = putBody({ serviceTier: 'default' });
      const first = await h.call('PUT', `/settings/roles/${COORD}`, body);
      assert.equal(first.status, 201);
      const saved = await first.json();
      assert.equal(saved.replayed, false);
      assert.equal(saved.revision.serviceTier, null, "'default' is normalized to null");
      assert.equal(saved.revision.model, 'gpt-6-luna');

      const roles = await (await h.call('GET', '/settings/roles')).json();
      const coord = roles.roles.find((r) => r.roleRuntimeId === COORD);
      assert.equal(coord.current.settingsRevisionId, saved.revision.settingsRevisionId);
      assert.equal(coord.effective.source, 'saved');
      assert.equal(coord.effective.model, 'gpt-6-luna');
      assert.equal(coord.valid, true);
      assert.notEqual(coord.profile.model, undefined);

      const replay = await h.call('PUT', `/settings/roles/${COORD}`, body);
      assert.equal(replay.status, 200);
      const again = await replay.json();
      assert.equal(again.replayed, true);
      assert.equal(again.revision.settingsRevisionId, saved.revision.settingsRevisionId);

      const conflict = await h.call('PUT', `/settings/roles/${COORD}`, { ...body, effort: 'low' });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error.code, 'conflict');

      const next = await h.call('PUT', `/settings/roles/${COORD}`, putBody({
        expectedRevisionId: saved.revision.settingsRevisionId, model: 'gpt-6-sol', effort: 'xhigh', serviceTier: null,
      }));
      assert.equal(next.status, 201);
      const history = await (await h.call('GET', `/settings/roles/${COORD}/history`)).json();
      assert.equal(history.roleRuntimeId, COORD);
      assert.equal(history.revisions.length, 2);
      assert.equal(history.revisions[0].model, 'gpt-6-sol');
      assert.equal(history.revisions[0].supersedesId, saved.revision.settingsRevisionId);
      assert.equal(history.currentRevisionId, history.revisions[0].settingsRevisionId);
    } finally { await h.close(); }
  });

  await suite.test('stale expectedRevisionId is 409 stale_version with the current id', async () => {
    const h = await boot();
    try {
      const first = await (await h.call('PUT', `/settings/roles/${COORD}`, putBody())).json();
      const stale = await h.call('PUT', `/settings/roles/${COORD}`, putBody({ expectedRevisionId: null, model: 'gpt-6-sol', serviceTier: null }));
      assert.equal(stale.status, 409);
      const err = (await stale.json()).error;
      assert.equal(err.code, 'stale_version');
      assert.equal(err.details.currentRevisionId, first.revision.settingsRevisionId);
    } finally { await h.close(); }
  });

  await suite.test('invalid model, effort, tier and body are 400 with details', async () => {
    const h = await boot();
    try {
      const put = (over) => h.call('PUT', `/settings/roles/${COORD}`, putBody(over));
      const check = async (res, field) => {
        assert.equal(res.status, 400);
        const err = (await res.json()).error;
        assert.equal(err.code, 'invalid_request');
        assert.ok(err.details.some((d) => d.field === field), JSON.stringify(err.details));
      };
      await check(await put({ model: 'gpt-nonexistent' }), 'model');
      await check(await put({ effort: 'minimal' }), 'effort');
      await check(await put({ model: 'gpt-6-sol', serviceTier: 'fast' }), 'serviceTier');
      await check(await put({ extra: 1 }), 'extra');
      await check(await put({ packId: 'x' }), 'packId');
      await check(await put({ commandId: 'x' }), 'commandId');
      const notObject = await h.call('PUT', `/settings/roles/${COORD}`, [1]);
      assert.equal(notObject.status, 400);
      const roles = await (await h.call('GET', '/settings/roles')).json();
      assert.equal(roles.roles.find((r) => r.roleRuntimeId === COORD).current, null);
    } finally { await h.close(); }
  });

  await suite.test('unknown role is 404 on save, reset and history', async () => {
    const h = await boot();
    try {
      assert.equal((await h.call('PUT', '/settings/roles/dlv-nope', putBody())).status, 404);
      assert.equal((await h.call('DELETE', '/settings/roles/dlv-nope', { commandId: cmd(), expectedRevisionId: null })).status, 404);
      assert.equal((await h.call('GET', '/settings/roles/dlv-nope/history')).status, 404);
    } finally { await h.close(); }
  });

  await suite.test('legacy lead is configurable under its own pack', async () => {
    const h = await boot();
    try {
      const id = h.legacyPack.coordinator.runtimeId;
      const res = await h.call('PUT', `/settings/roles/${id}`, putBody({ model: 'gpt-6-sol', serviceTier: null }));
      assert.equal(res.status, 201);
      assert.equal((await res.json()).revision.packId, h.legacyPack.packId);
      const resolver = makeSettingsResolver({ settingsStore: h.settingsStore });
      assert.equal(resolver(h.legacyPack.packId, id, h.legacyPack.coordinator.role).settingsSource, 'saved');
    } finally { await h.close(); }
  });

  await suite.test('reset returns to the profile, keeps history, replays and rejects stale', async () => {
    const h = await boot();
    try {
      const saved = await (await h.call('PUT', `/settings/roles/${COORD}`, putBody())).json();
      const id = saved.revision.settingsRevisionId;
      const stale = await h.call('DELETE', `/settings/roles/${COORD}`, { commandId: cmd(), expectedRevisionId: 'rs_nope' });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).error.code, 'stale_version');
      const body = { commandId: cmd(), expectedRevisionId: id };
      const reset = await h.call('DELETE', `/settings/roles/${COORD}`, body);
      assert.equal(reset.status, 200);
      assert.deepEqual(await reset.json(), { reset: true, resetRevisionId: id, replayed: false });
      assert.equal((await (await h.call('DELETE', `/settings/roles/${COORD}`, body)).json()).replayed, true);
      const roles = await (await h.call('GET', '/settings/roles')).json();
      const coord = roles.roles.find((r) => r.roleRuntimeId === COORD);
      assert.equal(coord.current, null);
      assert.equal(coord.effective.source, 'profile');
      const history = await (await h.call('GET', `/settings/roles/${COORD}/history`)).json();
      assert.equal(history.revisions.length, 1);
      assert.equal(history.currentRevisionId, null);
      const nothing = await h.call('DELETE', `/settings/roles/${COORD}`, { commandId: cmd(), expectedRevisionId: null });
      assert.equal(nothing.status, 409);
      assert.equal((await nothing.json()).error.code, 'invalid_state');
    } finally { await h.close(); }
  });

  await suite.test('a saved default whose model left the catalog is flagged invalid', async () => {
    const h = await boot();
    try {
      await h.call('PUT', `/settings/roles/${COORD}`, putBody());
      h.appServer.listModels = async () => [{
        id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'gpt-6-sol', hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [],
      }];
      await h.modelCatalog.refresh();
      const roles = await (await h.call('GET', '/settings/roles')).json();
      const coord = roles.roles.find((r) => r.roleRuntimeId === COORD);
      assert.equal(coord.effective.source, 'saved');
      assert.equal(coord.valid, false);
      assert.ok(coord.errors.some((e) => e.field === 'model'));
    } finally { await h.close(); }
  });

  await suite.test('settings resolver feeds the M4 /roles endpoint', async () => {
    const h = await boot();
    try {
      // The dashboard API wires makeSettingsResolver itself when a settings store is present.
      await h.call('PUT', `/settings/roles/${COORD}`, putBody());
      const roles = await (await h.call('GET', '/roles')).json();
      const coord = roles.roles.find((r) => r.runtimeId === COORD);
      assert.equal(coord.model, 'gpt-6-luna');
      assert.equal(coord.effort, 'high');
      assert.equal(coord.serviceTier, 'fast');
      assert.equal(coord.settingsSource, 'saved');
      const other = roles.roles.find((r) => r.runtimeId !== COORD && r.pack === h.activePack.packId);
      assert.equal(other.settingsSource, 'profile');
    } finally { await h.close(); }
  });

  await suite.test('mutations require an allowed Origin; reads need a session', async () => {
    const h = await boot();
    try {
      const calls = [
        ['PUT', `/settings/roles/${COORD}`, putBody()],
        ['DELETE', `/settings/roles/${COORD}`, { commandId: cmd(), expectedRevisionId: null }],
        ['POST', '/models/refresh', {}],
        ['POST', '/account/refresh', {}],
      ];
      for (const [method, p, body] of calls) {
        const res = await h.call(method, p, body, { withOrigin: false });
        assert.equal(res.status, 403, `${method} ${p}`);
      }
      for (const p of ['/models', '/account', '/settings/roles', `/settings/roles/${COORD}/history`]) {
        const res = await h.call('GET', p, undefined, { withCookie: false });
        assert.equal(res.status, 401, p);
      }
      for (const [method, p, body] of calls) {
        const res = await h.call(method, p, body, { withCookie: false });
        assert.equal(res.status, 401, `${method} ${p}`);
      }
      const roles = await (await h.call('GET', '/settings/roles')).json();
      assert.equal(roles.roles.find((r) => r.roleRuntimeId === COORD).current, null);
    } finally { await h.close(); }
  });

  await suite.test('malformed JSON is a 400 invalid_request', async () => {
    const h = await boot();
    try {
      const res = await h.call('PUT', `/settings/roles/${COORD}`, '{"commandId":', { raw: true });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'invalid_request');
    } finally { await h.close(); }
  });
});
