'use strict';

// Project rules routes over createDashboardApi with a real session guard; no model calls.

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
const { createModelCatalog } = require('../src/model-catalog');
const { createAccountHealth } = require('../src/account-health');
const { createSettingsStore } = require('../src/settings-store');
const { createRoleRulesStore } = require('../src/role-rules-store');
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
const cmd = () => `rr-${process.pid}-${String(++seq).padStart(6, '0')}`;

async function boot({ withRules = true } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-rules-'));
  const db = new Database(':memory:');
  await migrateProductSchema({ db });
  const appServer = makeFakeAppServer({});
  appServer.appServerVersion = '0.159.0';
  const now = () => Date.parse('2026-09-30T10:00:00.000Z');
  const modelCatalog = createModelCatalog({ appServer, now });
  const accountHealth = createAccountHealth({ appServer, now });
  const activePack = loadRolePack();
  const legacyPack = loadLegacyPack();
  const settingsStore = createSettingsStore({ db, catalog: modelCatalog, now });
  const roleRulesStore = withRules ? createRoleRulesStore({ db, projectId: 'prj_test', now }) : undefined;
  let port = 0;
  const auth = createDashboardAuth({ db, getPort: () => port });
  const events = { health: () => ({}), lastSequence: () => 0, record: () => 1 };
  const api = createDashboardApi({
    projection: { listCards: () => ({ cards: [] }) }, events, workspace, projectId: 'prj_test', auth, activePack, legacyPack,
    modelCatalog, accountHealth, settingsStore, roleRulesStore,
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
  const call = (method, p, body, { withOrigin = true } = {}) => fetch(`${base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Cookie: cookie,
      ...(withOrigin && method !== 'GET' ? { Origin: origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { call, activePack, roleRulesStore, close: () => new Promise((resolve) => server.close(() => { db.close(); resolve(); })) };
}

test('role rules API', async (suite) => {
  if (!(await canBind())) {
    suite.skip('loopback binding is not permitted in this environment');
    return;
  }
  const ROLE = loadRolePack().coordinator.runtimeId;
  const url = (role = ROLE, rest = '') => `/settings/roles/${role}/rules${rest}`;

  await suite.test('GET starts empty with limits; POST/PUT/DELETE walk the revision chain', async () => {
    const h = await boot();
    try {
      const empty = await (await h.call('GET', url())).json();
      assert.equal(empty.packId, h.activePack.packId);
      assert.equal(empty.roleRuntimeId, ROLE);
      assert.equal(empty.currentRevisionId, null);
      assert.deepEqual(empty.rules, []);
      assert.deepEqual(empty.limits, { maxRuleChars: 2000, maxRules: 20, maxTotalChars: 8000 });
      assert.deepEqual(empty.history, []);

      const created = await h.call('POST', url(), { commandId: cmd(), text: 'Prefer small diffs', expectedRevisionId: null });
      assert.equal(created.status, 201);
      const c = await created.json();
      assert.equal(c.replayed, false);
      const ruleId = c.revision.rules[0].ruleId;
      assert.match(ruleId, /^rl_/);

      const edited = await h.call('PUT', url(ROLE, `/${ruleId}`), { commandId: cmd(), text: 'Prefer tiny diffs', expectedRevisionId: c.revision.rulesRevisionId });
      assert.equal(edited.status, 200);
      const e = await edited.json();
      assert.deepEqual(e.revision.rules, [{ ruleId, text: 'Prefer tiny diffs' }]);

      const removed = await h.call('DELETE', url(ROLE, `/${ruleId}`), { commandId: cmd(), expectedRevisionId: e.revision.rulesRevisionId });
      assert.equal(removed.status, 200);
      const r = await removed.json();
      assert.deepEqual(r.revision.rules, []);

      const after = await (await h.call('GET', url())).json();
      assert.equal(after.currentRevisionId, r.revision.rulesRevisionId);
      assert.deepEqual(after.history.map((x) => [x.changeKind, x.ruleCount]), [['remove', 0], ['edit', 1], ['add', 1]]);
      assert.equal(JSON.stringify(after.history).includes('tiny'), false);
    } finally { await h.close(); }
  });

  await suite.test('replay returns 200 with replayed true; changed payload is a 409 conflict', async () => {
    const h = await boot();
    try {
      const body = { commandId: cmd(), text: 'one', expectedRevisionId: null };
      assert.equal((await h.call('POST', url(), body)).status, 201);
      const again = await h.call('POST', url(), body);
      assert.equal(again.status, 200);
      assert.equal((await again.json()).replayed, true);
      const clash = await h.call('POST', url(), { ...body, text: 'two' });
      assert.equal(clash.status, 409);
      assert.equal((await clash.json()).error.code, 'conflict');
    } finally { await h.close(); }
  });

  await suite.test('stale expectedRevisionId is 409 stale_version with currentRevisionId', async () => {
    const h = await boot();
    try {
      const first = await (await h.call('POST', url(), { commandId: cmd(), text: 'one', expectedRevisionId: null })).json();
      const stale = await h.call('POST', url(), { commandId: cmd(), text: 'two', expectedRevisionId: null });
      assert.equal(stale.status, 409);
      const err = (await stale.json()).error;
      assert.equal(err.code, 'stale_version');
      assert.deepEqual(err.details, { currentRevisionId: first.revision.rulesRevisionId });
    } finally { await h.close(); }
  });

  await suite.test('validation, unknown rule and unknown role', async () => {
    const h = await boot();
    try {
      const bad = await h.call('POST', url(), { commandId: cmd(), text: '   ', expectedRevisionId: null });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.details[0].field, 'text');
      const long = await h.call('POST', url(), { commandId: cmd(), text: 'x'.repeat(2001), expectedRevisionId: null });
      assert.equal(long.status, 400);
      const missingExpected = await h.call('POST', url(), { commandId: cmd(), text: 'ok' });
      assert.equal(missingExpected.status, 400);
      const noRule = await h.call('PUT', url(ROLE, '/rl_missing'), { commandId: cmd(), text: 'x', expectedRevisionId: null });
      assert.equal(noRule.status, 404);
      const seeded = await (await h.call('POST', url(), { commandId: cmd(), text: 'one', expectedRevisionId: null })).json();
      const noRule2 = await h.call('DELETE', url(ROLE, '/rl_missing'), { commandId: cmd(), expectedRevisionId: seeded.revision.rulesRevisionId });
      assert.equal(noRule2.status, 404);
      assert.equal((await h.call('GET', url('ghost-role'))).status, 404);
      assert.equal((await h.call('POST', url('ghost-role'), { commandId: cmd(), text: 'x', expectedRevisionId: null })).status, 404);
    } finally { await h.close(); }
  });

  await suite.test('packId and roleRuntimeId in the body are rejected', async () => {
    const h = await boot();
    try {
      for (const key of ['packId', 'roleRuntimeId']) {
        const res = await h.call('POST', url(), { commandId: cmd(), text: 'x', expectedRevisionId: null, [key]: 'other' });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.details[0].field, key);
      }
      const extra = await h.call('POST', url(), { commandId: cmd(), text: 'x', expectedRevisionId: null, tools: ['shell'] });
      assert.equal(extra.status, 400);
    } finally { await h.close(); }
  });

  await suite.test('mutations require a same-origin request', async () => {
    const h = await boot();
    try {
      const seeded = await (await h.call('POST', url(), { commandId: cmd(), text: 'one', expectedRevisionId: null })).json();
      const id = seeded.revision.rules[0].ruleId;
      const noOrigin = { withOrigin: false };
      assert.equal((await h.call('POST', url(), { commandId: cmd(), text: 'x', expectedRevisionId: seeded.revision.rulesRevisionId }, noOrigin)).status, 403);
      assert.equal((await h.call('PUT', url(ROLE, `/${id}`), { commandId: cmd(), text: 'x', expectedRevisionId: seeded.revision.rulesRevisionId }, noOrigin)).status, 403);
      assert.equal((await h.call('DELETE', url(ROLE, `/${id}`), { commandId: cmd(), expectedRevisionId: seeded.revision.rulesRevisionId }, noOrigin)).status, 403);
      assert.equal(h.roleRulesStore.currentFor(h.activePack.packId, ROLE).rules.length, 1);
    } finally { await h.close(); }
  });

  await suite.test('GET /settings/roles carries rules count and revision per role', async () => {
    const h = await boot();
    try {
      const before = await (await h.call('GET', '/settings/roles')).json();
      assert.ok(before.roles.every((r) => r.rules.count === 0 && r.rules.rulesRevisionId === null));
      const made = await (await h.call('POST', url(), { commandId: cmd(), text: 'one', expectedRevisionId: null })).json();
      await h.call('POST', url(), { commandId: cmd(), text: 'two', expectedRevisionId: made.revision.rulesRevisionId });
      const after = await (await h.call('GET', '/settings/roles')).json();
      const mine = after.roles.find((r) => r.roleRuntimeId === ROLE);
      assert.equal(mine.rules.count, 2);
      assert.equal(mine.rules.rulesRevisionId, h.roleRulesStore.currentFor(h.activePack.packId, ROLE).rulesRevisionId);
      assert.ok(after.roles.filter((r) => r.roleRuntimeId !== ROLE).every((r) => r.rules.count === 0));
    } finally { await h.close(); }
  });

  await suite.test('without a rules store the routes are not mounted', async () => {
    const h = await boot({ withRules: false });
    try {
      const roles = await (await h.call('GET', '/settings/roles')).json();
      assert.ok(roles.roles.every((r) => !('rules' in r)));
      assert.notEqual((await h.call('GET', url())).status, 200);
    } finally { await h.close(); }
  });
});
