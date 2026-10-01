'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAccountHealth } = require('../src/account-health');
const { makeFakeAppServer } = require('./fixtures/fake-app-server');

function clock(start = Date.parse('2026-09-30T10:00:00Z')) {
  const state = { at: start };
  const now = () => state.at;
  now.advance = (ms) => { state.at += ms; };
  return now;
}

const LIMITS = {
  ordinaryUsageAllowed: true,
  rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 99, extra: 'x' }, secondary: null },
};

test('chatgpt account is connected with plan, email and rate limits', async () => {
  const app = makeFakeAppServer({ account: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro' }, requiresOpenaiAuth: true }, rateLimits: LIMITS });
  app.appServerVersion = 'codex/0.159.0';
  const health = createAccountHealth({ appServer: app, now: clock() });
  const result = await health.get();
  assert.deepEqual(result, {
    status: 'connected',
    account: { type: 'chatgpt', planType: 'pro', email: 'a@b.c' },
    rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 99 }, secondary: null, ordinaryUsageAllowed: true },
    appServerVersion: 'codex/0.159.0',
    checkedAt: '2026-09-30T10:00:00.000Z',
  });
});

test('connected without readable rate limits keeps rateLimits null', async () => {
  const app = makeFakeAppServer({ account: { account: { type: 'chatgpt' } }, rateLimits: null });
  const result = await createAccountHealth({ appServer: app, now: clock() }).get();
  assert.equal(result.status, 'connected');
  assert.equal(result.rateLimits, null);
  assert.equal(result.account.email, null);
});

test('an api key account is unsupported and exposes no limits', async () => {
  const app = makeFakeAppServer({ account: { account: { type: 'apiKey' }, requiresOpenaiAuth: false }, rateLimits: LIMITS });
  const result = await createAccountHealth({ appServer: app, now: clock() }).get();
  assert.equal(result.status, 'unsupported_account');
  assert.deepEqual(result.account, { type: 'apiKey', planType: null, email: null });
  assert.equal(result.rateLimits, null);
});

test('no account requires auth', async () => {
  const app = makeFakeAppServer({ account: { account: null, requiresOpenaiAuth: true } });
  const result = await createAccountHealth({ appServer: app, now: clock() }).get();
  assert.equal(result.status, 'requires_auth');
  assert.equal(result.account, null);
});

test('an App Server error is unavailable and never throws', async () => {
  const app = makeFakeAppServer({ account: new Error('spawn failed') });
  const result = await createAccountHealth({ appServer: app, now: clock() }).get();
  assert.equal(result.status, 'unavailable');
  assert.equal(result.account, null);
  assert.equal(result.rateLimits, null);
});

test('caches for 30 s and limits forced refresh to once per 10 s', async () => {
  const app = makeFakeAppServer({ account: { account: { type: 'chatgpt' } } });
  let reads = 0;
  const original = app.getAccount;
  app.getAccount = async () => { reads += 1; return original.call(app); };
  const now = clock();
  const health = createAccountHealth({ appServer: app, now });
  await health.get();
  now.advance(5_000);
  await health.get({ force: true });
  assert.equal(reads, 1);
  now.advance(24_000);
  await health.get();
  assert.equal(reads, 1);
  now.advance(2_000);
  const stale = await health.get();
  assert.equal(reads, 2);
  now.advance(9_999);
  await health.get({ force: true });
  assert.equal(reads, 2);
  now.advance(2);
  const forced = await health.get({ force: true });
  assert.equal(reads, 3);
  assert.notEqual(forced.checkedAt, stale.checkedAt);
});

test('concurrent gets share one read', async () => {
  const app = makeFakeAppServer({ account: { account: { type: 'chatgpt' } } });
  let reads = 0;
  const original = app.getAccount;
  app.getAccount = async () => { reads += 1; return original.call(app); };
  const health = createAccountHealth({ appServer: app, now: clock() });
  await Promise.all([health.get(), health.get({ force: true })]);
  assert.equal(reads, 1);
});
