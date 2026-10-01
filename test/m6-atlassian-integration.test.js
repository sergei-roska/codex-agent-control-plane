'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createAtlassianIntegration } = require('../src/integrations/atlassian-integration');
const { CALLBACK_PATH, loadAtlassianConfig } = require('../src/integrations/atlassian-config');
const { CALLBACK_ROUTE, atlassianCallbackRoute } = require('../src/dashboard-atlassian-api');

function privateWrite(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-atlassian-config-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const secret = path.join(root, 'client-secret');
  const key = path.join(root, 'encryption-key');
  const token = path.join(root, 'oauth-token.json');
  const configFile = path.join(root, 'atlassian.json');
  privateWrite(secret, 'fixture-secret\n');
  privateWrite(key, `${'a'.repeat(64)}\n`);
  const config = { clientId: 'fixture-client', redirectUri: `http://127.0.0.1:4321${CALLBACK_PATH}`,
    tokenStorePath: token, clientSecretFile: secret, encryptionKeyFile: key };
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { root, workspace, secret, key, token, configFile, config };
}

test('Atlassian config loads only explicit external paths and owner-only secret material', () => {
  const ctx = setup();
  try {
    const loaded = loadAtlassianConfig({ workspace: ctx.workspace, configPath: ctx.configFile, port: 4321 });
    assert.equal(loaded.clientId, 'fixture-client');
    assert.equal(loaded.callbackOrigin, 'http://127.0.0.1:4321');
    assert.equal(loaded.redirectUri, ctx.config.redirectUri);
    return Promise.all([
      loaded.resolveClientSecret().then((secret) => assert.equal(secret, 'fixture-secret')),
      loaded.resolveEncryptionKey().then((key) => assert.deepEqual(key, Buffer.from('a'.repeat(64), 'hex'))),
    ]);
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('Atlassian config rejects secret files above the bounded read size with a redacted error', () => {
  const ctx = setup();
  try {
    privateWrite(ctx.secret, 's'.repeat(4097));
    assert.throws(() => loadAtlassianConfig({ workspace: ctx.workspace, configPath: ctx.configFile, port: 4321 }), (error) => {
      assert.equal(error.code, 'configuration_invalid');
      assert.equal(error.message, 'Atlassian configuration is invalid');
      assert.doesNotMatch(error.message, /client-secret|fixture-secret/);
      return true;
    });
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('Atlassian config rejects symbolic-link ancestors and callback ports that do not match runtime', () => {
  const ctx = setup();
  const alias = path.join(ctx.root, 'secret-alias');
  try {
    fs.symlinkSync(ctx.root, alias, 'dir');
    ctx.config.clientSecretFile = path.join(alias, path.basename(ctx.secret));
    fs.writeFileSync(ctx.configFile, JSON.stringify(ctx.config));
    assert.throws(() => loadAtlassianConfig({ workspace: ctx.workspace, configPath: ctx.configFile, port: 4321 }), { code: 'configuration_invalid' });
    ctx.config.clientSecretFile = ctx.secret;
    ctx.config.redirectUri = `http://localhost:4322${CALLBACK_PATH}`;
    fs.writeFileSync(ctx.configFile, JSON.stringify(ctx.config));
    assert.throws(() => loadAtlassianConfig({ workspace: ctx.workspace, configPath: ctx.configFile, port: 4321 }), { code: 'configuration_invalid' });
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('Atlassian config does not allow token output to overwrite a credential or config input', () => {
  const ctx = setup();
  try {
    ctx.config.tokenStorePath = path.join(path.dirname(ctx.secret), '.', path.basename(ctx.secret));
    fs.writeFileSync(ctx.configFile, JSON.stringify(ctx.config));
    assert.throws(() => loadAtlassianConfig({ workspace: ctx.workspace, configPath: ctx.configFile, port: 4321 }), { code: 'configuration_invalid' });
  } finally { fs.rmSync(ctx.root, { recursive: true, force: true }); }
});

test('callback router path composes with the shared dashboard mount exactly once', () => {
  const router = atlassianCallbackRoute({
    integration: { receiveCallback() { return { handle: 'a'.repeat(43) }; } },
    auth: { hostGuard(_req, _res, next) { next(); }, noStore(_req, _res, next) { next(); } },
  });
  assert.equal(CALLBACK_ROUTE, '/integrations/atlassian/callback');
  assert.equal(`/api/dashboard/v1${router.stack[0].route.path}`, CALLBACK_PATH);
});

test('service enforces callback host, replaces selected site atomically, and clears selection on disconnect failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-atlassian-service-'));
  const db = new Database(':memory:');
  let revision = 0;
  let connected = true;
  let failDisconnect = false;
  const resources = [
    { id: 'service-cloud-a', url: 'https://a.atlassian.net', name: 'A', scopes: ['read:jira-work', 'read:page:confluence', 'offline_access'] },
    { id: 'service-cloud-b', url: 'https://b.atlassian.net', name: 'B', scopes: ['read:jira-work', 'offline_access'] },
  ];
  const pending = new Map();
  const oauth = {
    getConnectionRevision: () => revision,
    async getHealth() { return { connected }; },
    async getResources() { return resources; },
    async getAccessToken() { return 'fixture-only-token'; },
    async beginAuthorization({ sessionId }) {
      const state = crypto.randomBytes(32).toString('base64url'); pending.set(state, sessionId);
      const url = new URL('https://auth.atlassian.com/authorize'); url.searchParams.set('state', state);
      return { state, authorizationUrl: url.toString() };
    },
    cancelAuthorization({ state, sessionId }) { const canceled = pending.get(state) === sessionId; if (canceled) pending.delete(state); return { canceled }; },
    async completeAuthorization({ state, sessionId }) { assert.equal(pending.get(state), sessionId); pending.delete(state); revision += 1; connected = true; return { connected: true }; },
    async disconnect() { revision += 1; connected = false; if (failDisconnect) throw new Error('fixture storage failure'); return { disconnected: true }; },
  };
  const service = createAtlassianIntegration({ db, productStore: {}, artifactStore: { remove() {} }, workspace: root,
    config: { callbackOrigin: 'http://127.0.0.1:4321' }, oauth });
  try {
    await assert.rejects(service.begin({ sessionId: 'session-hash', origin: 'http://localhost:4321' }), { code: 'invalid_request' });
    const started = await service.begin({ sessionId: 'session-hash', origin: 'http://127.0.0.1:4321' });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const handoff = service.receiveCallback({ state, code: 'fixture-code' });
    assert.deepEqual(await service.complete({ sessionId: 'session-hash', handle: handoff.handle }), { connected: true });
    const selectedA = await service.selectSite({ cloudId: 'service-cloud-a' });
    assert.equal(selectedA.sites.length, 2);
    const selectedB = await service.selectSite({ cloudId: 'service-cloud-b' });
    assert.deepEqual(selectedB.sites.map((site) => site.cloudId), ['service-cloud-b']);
    failDisconnect = true;
    await assert.rejects(service.disconnect({ sessionId: 'session-hash' }), { code: 'source_unavailable' });
    assert.deepEqual((await service.health()).selectedSites, []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
