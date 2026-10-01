'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { migrateProductSchema } = require('../src/product-migrations');
const { createSettingsStore } = require('../src/settings-store');
const { createModelCatalog } = require('../src/model-catalog');
const { EventJournal } = require('../src/event-journal');
const { makeFakeAppServer } = require('./fixtures/fake-app-server');

async function setup({ models, roleExists } = {}) {
  const db = new Database(':memory:');
  await migrateProductSchema({ db });
  const appServer = makeFakeAppServer({ models });
  const catalog = createModelCatalog({ appServer, now: () => Date.now() });
  const recorded = [];
  const events = { record: (type, info) => { recorded.push({ type, ...info }); return 1; } };
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  let n = 0;
  const store = createSettingsStore({
    db, catalog, events, roleExists,
    now: () => new Date((clock += 1000)),
    randomId: (prefix) => `${prefix}${++n}`,
  });
  return { db, store, recorded, appServer, catalog };
}

let seq = 0;
const cmd = () => `cmd-${String(++seq).padStart(6, '0')}`;
const save = (over = {}) => ({
  commandId: cmd(), packId: 'dlv', roleRuntimeId: 'dlv-builder', model: 'gpt-6-sol', effort: 'high',
  serviceTier: null, expectedRevisionId: null, ...over,
});

test('save creates a revision, sets current and emits an id-only event', async () => {
  const { store, recorded } = await setup();
  const result = await store.saveRoleDefault(save({ model: 'gpt-6-luna', serviceTier: 'default' }));
  assert.equal(result.replayed, false);
  assert.equal(result.revision.settingsRevisionId, 'rs_1');
  assert.equal(result.revision.serviceTier, null);
  assert.equal(result.revision.supersedesId, null);
  assert.equal(result.revision.actor, 'operator');
  assert.deepEqual(store.currentFor('dlv', 'dlv-builder'), result.revision);
  assert.equal(store.currentFor('dlv', 'other'), null);
  assert.deepEqual(recorded, [{ type: 'role_default_saved', namespace: 'dlv', role: 'dlv-builder', causationId: 'rs_1', payload: {} }]);
});

test('replay returns the stored result without a second revision or event', async () => {
  const { store, recorded } = await setup();
  const body = save();
  const first = await store.saveRoleDefault(body);
  const again = await store.saveRoleDefault({ ...body });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.revision, first.revision);
  assert.equal(store.history('dlv', 'dlv-builder').length, 1);
  assert.equal(recorded.length, 1);
});

test('replay works even when the catalog later becomes unavailable', async () => {
  const { store, appServer, catalog } = await setup();
  const body = save();
  await store.saveRoleDefault(body);
  appServer.listModels = async () => { throw new Error('down'); };
  await catalog.refresh();
  assert.equal((await store.saveRoleDefault({ ...body })).replayed, true);
});

test('the same commandId with a different payload conflicts', async () => {
  const { store } = await setup();
  const body = save();
  await store.saveRoleDefault(body);
  await assert.rejects(store.saveRoleDefault({ ...body, effort: 'low' }), (e) => e.code === 'conflict' && e.status === 409);
});

test('optimistic concurrency: stale expectedRevisionId is rejected', async () => {
  const { store } = await setup();
  const first = await store.saveRoleDefault(save());
  await assert.rejects(store.saveRoleDefault(save()), (e) => e.code === 'stale_version' && e.details.currentRevisionId === first.revision.settingsRevisionId);
  const second = await store.saveRoleDefault(save({ effort: 'low', expectedRevisionId: first.revision.settingsRevisionId }));
  assert.equal(second.revision.supersedesId, first.revision.settingsRevisionId);
  await assert.rejects(store.saveRoleDefault(save({ expectedRevisionId: first.revision.settingsRevisionId })), (e) => e.code === 'stale_version');
  assert.equal(store.currentFor('dlv', 'dlv-builder').effort, 'low');
});

test('history lists every revision newest first', async () => {
  const { store } = await setup();
  const a = await store.saveRoleDefault(save());
  const b = await store.saveRoleDefault(save({ effort: 'low', expectedRevisionId: a.revision.settingsRevisionId }));
  assert.deepEqual(store.history('dlv', 'dlv-builder').map((r) => r.settingsRevisionId), [b.revision.settingsRevisionId, a.revision.settingsRevisionId]);
  assert.deepEqual(store.history('dlv', 'nobody'), []);
});

test('invalid selections are rejected with field errors and nothing is stored', async () => {
  const { store } = await setup();
  await assert.rejects(store.saveRoleDefault(save({ model: 'gpt-9' })),
    (e) => e.code === 'invalid_request' && e.details[0].field === 'model');
  await assert.rejects(store.saveRoleDefault(save({ effort: 'extreme' })), (e) => e.details[0].field === 'effort');
  await assert.rejects(store.saveRoleDefault(save({ serviceTier: 'fast' })), (e) => e.details[0].field === 'serviceTier');
  assert.deepEqual(store.history('dlv', 'dlv-builder'), []);
});

test('envelope shape errors', async () => {
  const { store } = await setup();
  await assert.rejects(store.saveRoleDefault({ ...save(), commandId: 'x' }), (e) => e.code === 'invalid_request');
  await assert.rejects(store.saveRoleDefault({ ...save(), bogus: 1 }), (e) => e.code === 'invalid_request');
  const noExpected = save();
  delete noExpected.expectedRevisionId;
  await assert.rejects(store.saveRoleDefault(noExpected), (e) => e.details[0].field === 'expectedRevisionId');
  await assert.rejects(store.saveRoleDefault(save({ packId: '' })), (e) => e.details[0].field === 'packId');
});

test('catalog unavailable fails closed with 503', async () => {
  const { store } = await setup({ models: new Error('down') });
  await assert.rejects(store.saveRoleDefault(save()), (e) => e.code === 'catalog_unavailable' && e.status === 503);
});

test('unknown role is not found (constructor and per-call predicates)', async () => {
  const known = (pack, role) => pack === 'dlv' && role === 'dlv-builder';
  const { store } = await setup({ roleExists: known });
  await assert.rejects(store.saveRoleDefault(save({ roleRuntimeId: 'ghost' })), (e) => e.code === 'not_found');
  await store.saveRoleDefault(save());
  await assert.rejects(store.saveRoleDefault(save({ expectedRevisionId: 'x', roleRuntimeId: 'ghost2' }), { roleExists: () => false }), (e) => e.code === 'not_found');
});

test('reset drops the pointer, keeps history and emits an event', async () => {
  const { store, recorded } = await setup();
  const a = await store.saveRoleDefault(save());
  const id = a.revision.settingsRevisionId;
  const body = { commandId: cmd(), packId: 'dlv', roleRuntimeId: 'dlv-builder', expectedRevisionId: id };
  const result = store.resetRoleDefault(body);
  assert.deepEqual(result, { reset: true, resetRevisionId: id, replayed: false });
  assert.equal(store.currentFor('dlv', 'dlv-builder'), null);
  assert.equal(store.history('dlv', 'dlv-builder').length, 1);
  assert.equal(store.resetRoleDefault({ ...body }).replayed, true);
  assert.deepEqual(recorded.map((e) => e.type), ['role_default_saved', 'role_default_reset']);
  assert.equal(recorded[1].causationId, id);
  // A save after reset starts from null and supersedes nothing.
  const again = await store.saveRoleDefault(save({ effort: 'low' }));
  assert.equal(again.revision.supersedesId, null);
  assert.equal(store.history('dlv', 'dlv-builder').length, 2);
});

test('reset with a stale revision or nothing saved fails', async () => {
  const { store } = await setup();
  const base = { packId: 'dlv', roleRuntimeId: 'dlv-builder' };
  assert.throws(() => store.resetRoleDefault({ ...base, commandId: cmd(), expectedRevisionId: null }), (e) => e.code === 'invalid_state');
  await store.saveRoleDefault(save());
  assert.throws(() => store.resetRoleDefault({ ...base, commandId: cmd(), expectedRevisionId: 'rs_nope' }), (e) => e.code === 'stale_version');
});

test('effectiveDefault reports saved or profile source', async () => {
  const { store } = await setup();
  const profile = { model: 'gpt-6-sol', effort: 'medium' };
  assert.deepEqual(store.effectiveDefault('dlv', 'dlv-builder', profile),
    { model: 'gpt-6-sol', effort: 'medium', serviceTier: null, source: 'profile', settingsRevisionId: null });
  const saved = await store.saveRoleDefault(save({ model: 'gpt-6-luna', effort: 'xhigh', serviceTier: 'fast' }));
  assert.deepEqual(store.effectiveDefault('dlv', 'dlv-builder', profile), {
    model: 'gpt-6-luna', effort: 'xhigh', serviceTier: 'fast', source: 'saved', settingsRevisionId: saved.revision.settingsRevisionId,
  });
  assert.equal(store.effectiveDefault('dlv', 'elsewhere', { ...profile, serviceTier: 'fast' }).serviceTier, 'fast');
});

test('the new event types are accepted by the real journal', () => {
  const db = new Database(':memory:');
  const journal = new EventJournal({ db });
  journal.ensureSchema();
  assert.ok(journal.record('role_default_saved', { namespace: 'dlv', role: 'r', causationId: 'rs_1', payload: {} }));
  assert.ok(journal.record('role_default_reset', { namespace: 'dlv', role: 'r', causationId: 'rs_1', payload: {} }));
});
