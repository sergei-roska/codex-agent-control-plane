'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createModelCatalog } = require('../src/model-catalog');
const { makeFakeAppServer, defaultModels } = require('./fixtures/fake-app-server');

function clock(start = 1_000_000) {
  const state = { at: start };
  const now = () => state.at;
  now.advance = (ms) => { state.at += ms; };
  return now;
}

function counting(models) {
  const app = makeFakeAppServer({ models });
  let calls = 0;
  const original = app.listModels;
  app.listModels = async () => { calls += 1; return original.call(app); };
  app.calls = () => calls;
  return app;
}

test('normalizes entries and hides hidden or malformed models', async () => {
  const raw = [...defaultModels(), { id: 'gpt-hidden', model: 'gpt-hidden', hidden: true }, { nothing: true }];
  const catalog = createModelCatalog({ appServer: makeFakeAppServer({ models: raw }), now: clock() });
  const list = await catalog.list();
  assert.deepEqual(list.map((m) => m.model), ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']);
  const luna = catalog.find('gpt-6-luna');
  assert.deepEqual(luna.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(luna.serviceTiers, [{ id: 'fast', name: 'Fast', description: 'Faster responses' }]);
  assert.equal(luna.defaultEffort, 'medium');
  assert.equal(luna.defaultServiceTier, null);
  assert.equal(luna.upgrade, null);
  assert.equal(catalog.find('gpt-6-sol').isDefault, true);
  assert.equal(catalog.find('nope'), null);
  assert.equal(catalog.status().state, 'ok');
});

test('caches for the ttl and refresh forces a reload', async () => {
  const app = counting();
  const now = clock();
  const catalog = createModelCatalog({ appServer: app, now, ttlMs: 5 * 60 * 1000 });
  await catalog.list();
  await catalog.list();
  assert.equal(app.calls(), 1);
  now.advance(5 * 60 * 1000 - 1);
  await catalog.list();
  assert.equal(app.calls(), 1);
  now.advance(2);
  await catalog.list();
  assert.equal(app.calls(), 2);
  await catalog.refresh();
  assert.equal(app.calls(), 3);
});

test('concurrent loads share one request', async () => {
  const app = counting();
  const catalog = createModelCatalog({ appServer: app, now: clock() });
  await Promise.all([catalog.list(), catalog.list(), catalog.refresh()]);
  assert.equal(app.calls(), 1);
});

test('unavailable catalog fails closed and recovers on refresh', async () => {
  const app = makeFakeAppServer({ models: new Error('spawn codex ENOENT') });
  const catalog = createModelCatalog({ appServer: app, now: clock() });
  assert.deepEqual(await catalog.list(), []);
  const status = catalog.status();
  assert.equal(status.state, 'unavailable');
  assert.equal(status.error.code, 'catalog_unavailable');
  assert.match(status.error.message, /ENOENT/);
  const verdict = await catalog.validateSelection({ model: 'gpt-6-sol', effort: 'high', serviceTier: null });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'catalog_unavailable');
  assert.equal(verdict.errors.length, 1);
  app.listModels = async () => defaultModels();
  await catalog.refresh();
  assert.equal(catalog.status().state, 'ok');
  assert.equal((await catalog.validateSelection({ model: 'gpt-6-sol', effort: 'high' })).ok, true);
});

test('a failed refresh after success drops the cache (fail closed)', async () => {
  const app = makeFakeAppServer();
  const catalog = createModelCatalog({ appServer: app, now: clock() });
  await catalog.list();
  app.listModels = async () => { throw new Error('boom'); };
  await catalog.refresh();
  assert.equal(catalog.find('gpt-6-sol'), null);
  assert.equal((await catalog.validateSelection({ model: 'gpt-6-sol', effort: 'high' })).code, 'catalog_unavailable');
});

test('status before any load is unavailable', () => {
  const catalog = createModelCatalog({ appServer: makeFakeAppServer(), now: clock() });
  assert.deepEqual(catalog.status(), { state: 'unavailable', fetchedAt: null, error: { code: 'catalog_unavailable', message: 'model catalog has not been loaded' } });
});

test('validateSelection accepts valid selections and normalizes the default tier', async () => {
  const catalog = createModelCatalog({ appServer: makeFakeAppServer(), now: clock() });
  assert.deepEqual(await catalog.validateSelection({ model: 'gpt-6-luna', effort: 'xhigh', serviceTier: 'fast' }),
    { ok: true, errors: [], selection: { model: 'gpt-6-luna', effort: 'xhigh', serviceTier: 'fast' } });
  for (const tier of [undefined, null, 'default']) {
    const verdict = await catalog.validateSelection({ model: 'gpt-6-sol', effort: 'low', serviceTier: tier });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.selection.serviceTier, null);
  }
  assert.equal((await catalog.validateSelection({ model: 'gpt-6.1-sol', effort: 'medium' })).ok, true);
});

test('validateSelection reports every error with its field', async () => {
  const catalog = createModelCatalog({ appServer: makeFakeAppServer(), now: clock() });
  const check = async (sel) => (await catalog.validateSelection(sel)).errors.map((e) => e.field);
  assert.deepEqual(await check({}), ['model', 'effort']);
  assert.deepEqual(await check(null), ['model', 'effort']);
  assert.deepEqual(await check({ model: 'gpt-9', effort: 'high' }), ['model']);
  assert.deepEqual(await check({ model: 'gpt-6-sol', effort: 'extreme' }), ['effort']);
  assert.deepEqual(await check({ model: 'gpt-6-sol', effort: 'high', serviceTier: 'fast' }), ['serviceTier']);
  assert.deepEqual(await check({ model: 'gpt-6-luna', effort: 'high', serviceTier: 'turbo' }), ['serviceTier']);
  assert.deepEqual(await check({ model: 'gpt-6-luna', effort: 'high', serviceTier: 7 }), ['serviceTier']);
  assert.deepEqual(await check({ model: 'gpt-9', effort: 'zzz', serviceTier: 'fast' }), ['model']);
  const bad = await catalog.validateSelection({ model: 'gpt-6-sol', effort: 'extreme' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /extreme/);
});

test('a selection the runtime cannot pin is rejected even when the catalog lists the model', async () => {
  const raw = [...defaultModels(), { id: 'GPT-Upper', model: 'GPT-Upper', hidden: false, supportedReasoningEfforts: ['high'], serviceTiers: [] }];
  const catalog = createModelCatalog({ appServer: makeFakeAppServer({ models: raw }), now: clock() });
  const verdict = await catalog.validateSelection({ model: 'GPT-Upper', effort: 'high', serviceTier: null });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors[0].field, 'model');
  assert.match(verdict.errors[0].message, /cannot be pinned/);
});

test('an unavailable catalog result is cached for 10 seconds', async () => {
  const app = counting(new Error('model/list down'));
  const now = clock();
  const catalog = createModelCatalog({ appServer: app, now });
  for (let i = 0; i < 3; i += 1) {
    const verdict = await catalog.validateSelection({ model: 'gpt-6-sol', effort: 'high' });
    assert.equal(verdict.code, 'catalog_unavailable');
  }
  assert.equal(app.calls(), 1);
  now.advance(10 * 1000 - 1);
  await catalog.validateSelection({ model: 'gpt-6-sol', effort: 'high' });
  assert.equal(app.calls(), 1);
  now.advance(2);
  await catalog.validateSelection({ model: 'gpt-6-sol', effort: 'high' });
  assert.equal(app.calls(), 2);
});
