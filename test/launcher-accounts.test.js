'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { createLauncherApp } = require('../src/launcher-app');
const { createAccountProfiles } = require('../src/account-profiles');

let tmp;
let profiles;
let server;
let base;
let app;
let servers;
let limitsByHome;
let failHomes;
let loginMode;
let handshakeFailure;
let handshakeGate;
let limitsReadSequence;
let limitsReadGate;

class FakeAppServer {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.closed = false;
    this.calls = [];
    servers.push(this);
  }

  async readRateLimits() {
    this.calls.push(['readRateLimits']);
    if (failHomes.has(this.options.codexHome)) return null;
    const sequence = limitsReadSequence.get(this.options.codexHome ?? null);
    const value = sequence && sequence.length > 1 ? sequence.shift()
      : sequence?.length === 1 ? sequence[0]
        : limitsByHome.get(this.options.codexHome ?? null);
    if (limitsReadGate) await limitsReadGate(this.options.codexHome ?? null);
    return { rateLimits: value };
  }

  async startAccountUsageWindow() {
    this.calls.push(['startAccountUsageWindow']);
    if (handshakeGate) await handshakeGate(this.options.codexHome);
    if (handshakeFailure) throw new Error(handshakeFailure);
    const previous = limitsByHome.get(this.options.codexHome ?? null);
    if (previous) limitsByHome.set(this.options.codexHome ?? null, {
      primary: windowOf(1, 1_950_000_000),
      secondary: previous.secondary,
    });
  }

  async getAccount() {
    return { account: { email: `${path.basename(this.options.codexHome || 'system')}@example.com`, planType: 'plus' } };
  }

  async loginStart(params) {
    this.calls.push(['loginStart', params]);
    if (loginMode.early) {
      queueMicrotask(() => this.emit('account/login/completed', { loginId: 'login-' + servers.indexOf(this), success: true }));
    }
    if (params.type === 'chatgptDeviceCode') {
      return { type: 'chatgptDeviceCode', loginId: 'login-' + servers.indexOf(this), verificationUrl: 'https://example.com/device', userCode: 'ABCD-1234' };
    }
    return { type: 'chatgpt', loginId: 'login-' + servers.indexOf(this), authUrl: 'https://example.com/auth' };
  }

  async loginCancel(loginId) { this.calls.push(['loginCancel', loginId]); return {}; }

  async logout() { this.calls.push(['logout']); return {}; }

  async close() { this.closed = true; }

  onNotification(method, handler) {
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }

  emit(method, params) {
    const handler = this.handlers.get(method);
    if (handler) handler(params);
  }
}

const windowOf = (used, resetsAt = 1_900_000_000) => ({ usedPercent: used, windowDurationMins: 300, resetsAt });

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function until(fn) {
  for (let i = 0; i < 100; i += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

async function start(options = {}) {
  app = createLauncherApp({
    projects: { list: () => [], get: () => null },
    readAuthToken: () => 'tok',
    createAppServer: (opts) => new FakeAppServer(opts),
    accountProfiles: profiles,
    ...options,
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
}

function seedProfiles() {
  const a = profiles.addProfile({ name: 'alpha', email: 'old-a@example.com', planType: 'plus' });
  const b = profiles.addProfile({ name: 'beta' });
  limitsByHome.set(null, { primary: windowOf(10), secondary: windowOf(20) });
  limitsByHome.set(a.home, { primary: windowOf(30), secondary: windowOf(40) });
  limitsByHome.set(b.home, { primary: windowOf(50), secondary: windowOf(60) });
  return { a, b };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-accounts-'));
  profiles = createAccountProfiles({ accountsDir: path.join(tmp, 'accounts'), codexDefaultHome: path.join(tmp, 'default-home') });
  servers = [];
  limitsByHome = new Map();
  failHomes = new Set();
  loginMode = {};
  handshakeFailure = null;
  handshakeGate = null;
  limitsReadSequence = new Map();
  limitsReadGate = null;
});

afterEach(async () => {
  if (app) await app.closeAccountLogins();
  if (server) server.close();
  server = null;
  app = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/accounts', () => {
  it('lists system plus profiles and caches per profile', async () => {
    const { a } = seedProfiles();
    profiles.setActive('alpha');
    await start();
    const r = await api('GET', '/api/accounts');
    assert.equal(r.status, 200);
    assert.equal(r.body.autoSwitch, false);
    assert.equal(r.body.system.active, false);
    assert.equal(r.body.system.primary.usedPercent, 10);
    assert.deepEqual(r.body.profiles.map((p) => [p.name, p.active, p.primary.usedPercent, p.secondary.usedPercent]),
      [['alpha', true, 30, 40], ['beta', false, 50, 60]]);
    assert.equal(r.body.profiles[0].email, 'alpha@example.com');
    assert.equal(r.body.profiles[0].planType, 'plus');
    assert.equal(servers.length, 3);
    assert.ok(servers.every((s) => s.closed));
    assert.deepEqual(servers.map((s) => s.options.codexHome), [null, a.home, profiles.read().profiles[1].home]);

    await api('GET', '/api/accounts');
    assert.equal(servers.length, 3, 'second call is served from the 30 s cache');
    await api('GET', '/api/accounts?force=1');
    assert.equal(servers.length, 6, 'force bypasses the cache');
  });

  it('keeps a later forced refresh cached when the older background read completes first', async () => {
    seedProfiles();
    limitsReadSequence.set(null, [
      { primary: windowOf(10), secondary: windowOf(20) },
      { primary: windowOf(20), secondary: windowOf(40) },
    ]);
    const releases = [];
    const startedResolvers = [];
    const started = [0, 1].map((index) => new Promise((resolve) => { startedResolvers[index] = resolve; }));
    let systemReads = 0;
    limitsReadGate = async (home) => {
      if (home !== null || systemReads >= 2) return;
      const index = systemReads++;
      startedResolvers[index]();
      await new Promise((resolve) => { releases[index] = resolve; });
    };
    await start();

    const background = api('GET', '/api/accounts');
    await started[0];
    const forced = api('GET', '/api/accounts?force=1');
    await started[1];
    releases[0]();
    await background;
    releases[1]();
    const forcedResponse = await forced;
    assert.equal(forcedResponse.body.system.primary.usedPercent, 20);
    const beforeCachedRead = systemReads;
    const cached = await api('GET', '/api/accounts');
    assert.equal(cached.body.system.primary.usedPercent, 20);
    assert.equal(systemReads, beforeCachedRead, 'the follow-up GET uses the forced result from cache');
  });

  it('keeps a forced refresh cached when an older background read completes after it', async () => {
    seedProfiles();
    limitsReadSequence.set(null, [
      { primary: windowOf(10), secondary: windowOf(20) },
      { primary: windowOf(20), secondary: windowOf(40) },
    ]);
    const releases = [];
    const startedResolvers = [];
    const started = [0, 1].map((index) => new Promise((resolve) => { startedResolvers[index] = resolve; }));
    let systemReads = 0;
    limitsReadGate = async (home) => {
      if (home !== null || systemReads >= 2) return;
      const index = systemReads++;
      startedResolvers[index]();
      await new Promise((resolve) => { releases[index] = resolve; });
    };
    await start();

    const background = api('GET', '/api/accounts');
    await started[0];
    const forced = api('GET', '/api/accounts?force=1');
    await started[1];
    releases[1]();
    const forcedResponse = await forced;
    assert.equal(forcedResponse.body.system.primary.usedPercent, 20);
    releases[0]();
    await background;
    const beforeCachedRead = systemReads;
    const cached = await api('GET', '/api/accounts');
    assert.equal(cached.body.system.primary.usedPercent, 20);
    assert.equal(systemReads, beforeCachedRead, 'the older background result cannot replace the forced cache entry');
  });

  it('reports an error for a failing profile without breaking the list', async () => {
    const { b } = seedProfiles();
    failHomes.add(b.home);
    await start();
    const r = await api('GET', '/api/accounts');
    assert.equal(r.status, 200);
    assert.equal(r.body.system.active, true);
    assert.equal(r.body.profiles[0].error, null);
    assert.match(r.body.profiles[1].error, /unavailable/);
    assert.equal(r.body.profiles[1].primary, null);
  });
});

describe('add account login', () => {
  it('browser login completes via the notification and adds the profile', async () => {
    await start();
    const r = await api('POST', '/api/accounts', { name: 'work', method: 'browser' });
    assert.equal(r.status, 200);
    assert.equal(r.body.authUrl, 'https://example.com/auth');
    assert.deepEqual(servers[0].calls[0], ['loginStart', { type: 'chatgpt' }]);
    assert.equal(servers[0].options.codexHome, path.join(profiles.accountsDir, 'work'));
    assert.equal((await api('GET', `/api/accounts/login/${r.body.loginId}`)).body.status, 'pending');
    assert.equal(profiles.read().profiles.length, 0);

    servers[0].emit('account/login/completed', { loginId: r.body.loginId, success: true });
    const done = await until(async () => {
      const s = await api('GET', `/api/accounts/login/${r.body.loginId}`);
      return s.body.status === 'completed' ? s.body : null;
    });
    assert.equal(done.name, 'work');
    assert.deepEqual(profiles.read().profiles.map((p) => [p.name, p.email, p.planType]), [['work', 'work@example.com', 'plus']]);
    assert.equal(servers[0].closed, true);
  });

  it('device login returns the verification url and code', async () => {
    await start();
    const r = await api('POST', '/api/accounts', { name: 'dev', method: 'device' });
    assert.equal(r.status, 200);
    assert.equal(r.body.verificationUrl, 'https://example.com/device');
    assert.equal(r.body.userCode, 'ABCD-1234');
    assert.deepEqual(servers[0].calls[0], ['loginStart', { type: 'chatgptDeviceCode' }]);
    servers[0].emit('account/login/completed', { loginId: r.body.loginId, success: true });
    await until(async () => profiles.read().profiles.length === 1);
    assert.equal((await api('GET', `/api/accounts/login/${r.body.loginId}`)).body.status, 'completed');
  });

  it('handles a completion that arrives before the start response', async () => {
    loginMode.early = true;
    await start();
    const r = await api('POST', '/api/accounts', { name: 'fast', method: 'browser' });
    await until(async () => (await api('GET', `/api/accounts/login/${r.body.loginId}`)).body.status === 'completed');
    assert.equal(profiles.read().profiles[0].name, 'fast');
  });

  it('failed login removes the unfinished profile directory', async () => {
    await start();
    const r = await api('POST', '/api/accounts', { name: 'bad', method: 'browser' });
    assert.ok(fs.existsSync(path.join(profiles.accountsDir, 'bad')));
    servers[0].emit('account/login/completed', { loginId: r.body.loginId, success: false, error: 'denied' });
    const st = await until(async () => {
      const s = await api('GET', `/api/accounts/login/${r.body.loginId}`);
      return s.body.status === 'failed' ? s.body : null;
    });
    assert.equal(st.error, 'denied');
    assert.equal(fs.existsSync(path.join(profiles.accountsDir, 'bad')), false);
    assert.equal(profiles.read().profiles.length, 0);
    assert.equal(servers[0].closed, true);
  });

  it('expires after the timeout, cancels and cleans up', async () => {
    await start({ loginTimeoutMs: 30 });
    const r = await api('POST', '/api/accounts', { name: 'slow', method: 'browser' });
    const st = await until(async () => {
      const s = await api('GET', `/api/accounts/login/${r.body.loginId}`);
      return s.body.status === 'expired' ? s.body : null;
    });
    assert.ok(st.error);
    assert.deepEqual(servers[0].calls[1], ['loginCancel', r.body.loginId]);
    assert.equal(servers[0].closed, true);
    assert.equal(fs.existsSync(path.join(profiles.accountsDir, 'slow')), false);
  });

  it('cancel endpoint cancels a pending login', async () => {
    await start();
    const r = await api('POST', '/api/accounts', { name: 'tmp', method: 'browser' });
    const c = await api('POST', `/api/accounts/login/${r.body.loginId}/cancel`);
    assert.equal(c.body.status, 'failed');
    assert.deepEqual(servers[0].calls[1], ['loginCancel', r.body.loginId]);
    assert.equal(fs.existsSync(path.join(profiles.accountsDir, 'tmp')), false);
    assert.equal((await api('POST', '/api/accounts/login/nope/cancel')).status, 404);
    assert.equal((await api('GET', '/api/accounts/login/nope')).status, 404);
  });

  it('closeAccountLogins closes pending login servers', async () => {
    await start();
    await api('POST', '/api/accounts', { name: 'one', method: 'browser' });
    await app.closeAccountLogins();
    assert.equal(servers[0].closed, true);
    assert.equal(fs.existsSync(path.join(profiles.accountsDir, 'one')), false);
  });

  it('rejects invalid, reserved and duplicate names and bad methods', async () => {
    seedProfiles();
    await start();
    assert.equal((await api('POST', '/api/accounts', { name: 'Bad Name', method: 'browser' })).status, 400);
    assert.equal((await api('POST', '/api/accounts', { name: '../x', method: 'browser' })).status, 400);
    assert.equal((await api('POST', '/api/accounts', { name: 'system', method: 'browser' })).status, 400);
    assert.equal((await api('POST', '/api/accounts', { name: 'fine', method: 'carrier-pigeon' })).status, 400);
    assert.equal((await api('POST', '/api/accounts', { name: 'alpha', method: 'browser' })).status, 409);
    assert.equal((await api('POST', '/api/accounts', { name: 'pend', method: 'browser' })).status, 200);
    assert.equal((await api('POST', '/api/accounts', { name: 'pend', method: 'device' })).status, 409);
  });
});

describe('activate, auto-switch, delete and limits', () => {
  it('activate and auto-switch write the store', async () => {
    seedProfiles();
    await start();
    assert.equal((await api('POST', '/api/accounts/beta/activate')).status, 200);
    assert.equal(profiles.read().active, 'beta');
    assert.equal((await api('POST', '/api/accounts/nope/activate')).status, 404);
    assert.equal((await api('POST', '/api/accounts/system/activate')).status, 200);
    assert.equal(profiles.read().active, null);
    assert.equal((await api('POST', '/api/accounts/auto-switch', { enabled: true })).body.autoSwitch, true);
    assert.equal(profiles.read().autoSwitch, true);
    assert.equal((await api('POST', '/api/accounts/auto-switch', { enabled: 'yes' })).status, 400);
    assert.equal((await api('GET', '/api/accounts')).body.autoSwitch, true);
  });

  it('refuses to delete the active profile, otherwise logs out and removes', async () => {
    const { b } = seedProfiles();
    profiles.setActive('alpha');
    await start();
    assert.equal((await api('DELETE', '/api/accounts/alpha')).status, 409);
    assert.equal(profiles.read().profiles.length, 2);
    assert.equal((await api('DELETE', '/api/accounts/nope')).status, 404);
    const r = await api('DELETE', '/api/accounts/beta');
    assert.equal(r.status, 200);
    assert.deepEqual(profiles.read().profiles.map((p) => p.name), ['alpha']);
    assert.equal(fs.existsSync(b.home), false);
    const logoutServer = servers.find((s) => s.options.codexHome === b.home);
    assert.deepEqual(logoutServer.calls, [['logout']]);
    assert.equal(logoutServer.closed, true);
  });

  it('/api/limits follows the active profile', async () => {
    const { a } = seedProfiles();
    await start();
    let r = await api('GET', '/api/limits');
    assert.equal(r.body.success, true);
    assert.equal(r.body.primary.usedPercent, 10);
    assert.equal(servers.at(-1).options.codexHome, null);

    profiles.setActive('alpha');
    r = await api('GET', '/api/limits');
    assert.equal(r.body.primary.usedPercent, 30);
    assert.equal(r.body.email, 'alpha@example.com');
    assert.equal(servers.at(-1).options.codexHome, a.home);
  });
});

describe('account handshake', () => {
  it('uses the system home while a named profile is active and rejects unknown accounts', async () => {
    seedProfiles();
    profiles.setActive('alpha');
    await start();

    const response = await api('POST', '/api/accounts/system/handshake');
    assert.equal(response.status, 200);
    assert.equal(servers.at(-1).options.codexHome, null);
    const count = servers.length;
    assert.equal((await api('POST', '/api/accounts/missing/handshake')).status, 404);
    assert.equal(servers.length, count);
  });

  it('runs on the requested profile before reading and caching provider limits', async () => {
    const { a } = seedProfiles();
    profiles.setActive('beta');
    await start();

    const response = await api('POST', '/api/accounts/alpha/handshake');
    assert.equal(response.status, 200);
    assert.equal(response.body.turnStatus, 'completed');
    assert.equal(response.body.limitsRead, true);
    assert.equal(response.body.primary.usedPercent, 1);
    assert.equal(response.body.primary.resetsAt, 1_950_000_000);
    assert.equal(response.body.secondary.usedPercent, 40);
    const handshakeServer = servers.at(-1);
    assert.equal(handshakeServer.options.codexHome, a.home);
    assert.deepEqual(handshakeServer.calls.slice(0, 2), [['startAccountUsageWindow'], ['readRateLimits']]);
    assert.equal(handshakeServer.closed, true);
    const cached = await api('GET', '/api/accounts');
    assert.equal(cached.body.profiles.find((profile) => profile.name === 'alpha').primary.usedPercent, 1);
  });

  it('retries stale provider reset data briefly and returns the later provider value', async () => {
    const { a } = seedProfiles();
    const stale = { primary: windowOf(80, 1), secondary: windowOf(40) };
    const fresh = { primary: windowOf(1, 1_950_000_000), secondary: windowOf(40) };
    limitsReadSequence.set(a.home, [stale, fresh]);
    await start();

    const response = await api('POST', '/api/accounts/alpha/handshake');
    assert.equal(response.status, 200);
    assert.equal(response.body.primary.usedPercent, 1);
    assert.equal(response.body.primary.resetsAt, 1_950_000_000);
    assert.equal(servers.at(-1).calls.filter(([name]) => name === 'readRateLimits').length, 2);
  });

  it('does not let an older account refresh overwrite the fresh handshake cache', async () => {
    const { a } = seedProfiles();
    let markReadStarted;
    let releaseRead;
    const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
    const oldRead = new Promise((resolve) => { releaseRead = resolve; });
    let gated = false;
    limitsReadGate = async (home) => {
      if (home === a.home && !gated) {
        gated = true;
        markReadStarted();
        await oldRead;
      }
    };
    await start();

    const refresh = api('GET', '/api/accounts?force=1');
    await readStarted;
    const handshake = await api('POST', '/api/accounts/alpha/handshake');
    assert.equal(handshake.status, 200);
    releaseRead();
    await refresh;
    const cached = await api('GET', '/api/accounts');
    assert.equal(cached.body.profiles[0].primary.usedPercent, 1);
  });

  it('deduplicates the same account while another account can handshake independently', async () => {
    const { a, b } = seedProfiles();
    profiles.setActive('beta');
    let releaseAlpha;
    const alphaGate = new Promise((resolve) => { releaseAlpha = resolve; });
    handshakeGate = (home) => home === a.home ? alphaGate : Promise.resolve();
    await start();

    const first = api('POST', '/api/accounts/alpha/handshake');
    await until(async () => servers.some((entry) => entry.options.codexHome === a.home && entry.calls.length));
    const duplicate = api('POST', '/api/accounts/alpha/handshake');
    const independent = api('POST', '/api/accounts/beta/handshake');
    const betaResponse = await independent;
    assert.equal(betaResponse.status, 200);
    assert.equal(servers.filter((entry) => entry.options.codexHome === a.home).length, 1);
    assert.equal(servers.filter((entry) => entry.options.codexHome === b.home).length, 1);
    releaseAlpha();
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);
    assert.equal(firstResponse.status, 200);
    assert.equal(duplicateResponse.status, 200);
    assert.equal(servers.filter((entry) => entry.options.codexHome === a.home).length, 1);
    assert.ok(servers.filter((entry) => [a.home, b.home].includes(entry.options.codexHome)).every((entry) => entry.closed));
  });

  it('returns failure without inventing a reset or reading limits when the turn fails', async () => {
    const { a } = seedProfiles();
    const before = limitsByHome.get(a.home);
    handshakeFailure = 'planned turn failure';
    await start();

    const response = await api('POST', '/api/accounts/alpha/handshake');
    assert.equal(response.status, 502);
    assert.match(response.body.error, /planned turn failure/);
    assert.deepEqual(limitsByHome.get(a.home), before);
    assert.deepEqual(servers.at(-1).calls, [['startAccountUsageWindow']]);
    assert.equal(servers.at(-1).closed, true);
  });

  it('reports limits pending when provider limits remain unavailable after completion', async () => {
    const { b } = seedProfiles();
    failHomes.add(b.home);
    await start();

    const response = await api('POST', '/api/accounts/beta/handshake');
    assert.equal(response.status, 502);
    assert.match(response.body.error, /provider limits are not yet available/);
    assert.equal(servers.at(-1).closed, true);
    assert.equal((await api('GET', '/api/accounts')).body.profiles[1].primary, null);
  });
});
