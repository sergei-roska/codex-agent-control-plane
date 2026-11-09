'use strict';
const assert = require('node:assert/strict');
const { createLauncherApp } = require('../../../src/launcher-app');
let releaseOld;
const oldGate = new Promise((resolve) => { releaseOld = resolve; });
let resolveOldStarted;
const oldStarted = new Promise((resolve) => { resolveOldStarted = resolve; });
let releaseFresh;
const freshGate = new Promise((resolve) => { releaseFresh = resolve; });
let resolveFreshStarted;
const freshStarted = new Promise((resolve) => { resolveFreshStarted = resolve; });
let count = 0;
class FakeAppServer {
  constructor() { this.id = ++count; }
  async readRateLimits() {
    if (this.id === 1) {
      resolveOldStarted();
      await oldGate;
    } else if (this.id === 2) {
      resolveFreshStarted();
      await freshGate;
    }
    return { rateLimits: { primary: { usedPercent: this.id === 1 ? 10 : 20 } } };
  }
  async getAccount() { return { account: { email: 'fake@example.com', planType: 'plus' } }; }
  async close() {}
}
const app = createLauncherApp({
  projects: { list: () => [], get: () => null },
  readAuthToken: () => 'unused',
  createAppServer: () => new FakeAppServer(),
  accountProfiles: { read: () => ({ active: null, autoSwitch: false, profiles: [] }) },
});
async function get(base, path) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  return response.json();
}
(async () => {
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const oldRequest = get(base, '/api/accounts');
    await oldStarted;
    const forceRequest = get(base, '/api/accounts?force=1');
    await freshStarted;
    releaseOld();
    await oldRequest;
    releaseFresh();
    const forced = await forceRequest;
    assert.equal(forced.system.primary.usedPercent, 20, 'forced response is fresh');
    const cached = await get(base, '/api/accounts');
    console.log(JSON.stringify({ forced: forced.system.primary.usedPercent, cached: cached.system.primary.usedPercent, reads: count }));
    assert.equal(cached.system.primary.usedPercent, 20, 'forced GET should win the cache race');
  } finally {
    releaseOld();
    releaseFresh();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
