'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { createLauncherApp } = require('../src/launcher-app');
const { createAccountProfiles } = require('../src/account-profiles');
const { defaultConnectorCatalog } = require('../src/connector-catalog');
const { createConnectorService, connectorConfigArgs, mapState } = require('../src/connector-status');

const NAMES = ['harness-atlassian', 'harness-figma', 'harness-context7', 'harness-gtm'];

let tmp;
let http;
let base;
let app;
let servers;
let authByName;
let startFails;
let loginUrl;

class FakeAppServer {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.closed = false;
    this.calls = [];
    servers.push(this);
  }

  async mcpServerAuthStatus(name) {
    this.calls.push(['status', name]);
    if (startFails) throw new Error('spawn codex ENOENT');
    return authByName[name] ? [{ name, ...authByName[name] }] : [];
  }

  async mcpOauthLoginStart(name, params) {
    this.calls.push(['login', name, params]);
    if (startFails) throw new Error('spawn codex ENOENT');
    return { authorizationUrl: loginUrl, loginId: 'login-1' };
  }

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

async function api(method, url) {
  const res = await fetch(base + url, { method });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-status-'));
  servers = [];
  authByName = {};
  startFails = false;
  loginUrl = 'https://auth.example.com/authorize?client_id=x';
  app = createLauncherApp({
    projects: { list: () => [], get: () => null },
    readAuthToken: () => 'tok',
    createAppServer: (opts) => new FakeAppServer(opts),
    accountProfiles: createAccountProfiles({ accountsDir: path.join(tmp, 'accounts'), codexDefaultHome: path.join(tmp, 'default-home') }),
  });
  await new Promise((resolve) => { http = app.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + http.address().port;
});

afterEach(async () => {
  await app.closeAccountLogins();
  http.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/connectors', () => {
  it('returns the four connectors in catalog order with titles', async () => {
    const { status, body } = await api('GET', '/api/connectors');
    assert.equal(status, 200);
    assert.deepEqual(body.connectors.map((c) => c.name), NAMES);
    assert.deepEqual(body.connectors.map((c) => c.title), ['Confluence and Jira', 'Figma', 'Context7', 'Google Tag Manager']);
    for (const c of body.connectors) {
      assert.equal(typeof c.purpose, 'string');
      assert.equal(typeof c.dataSensitivity, 'string');
      assert.equal(typeof c.toolsVerified, 'boolean');
    }
    assert.equal(servers.length, 1);
    assert.equal(servers[0].closed, true);
  });

  it('maps app-server auth evidence to a state and never invents signed_in', async () => {
    authByName = {
      'harness-atlassian': { authStatus: 'oAuth', runtimeStatus: 'connected' },
      'harness-figma': { authStatus: 'notLoggedIn', runtimeStatus: null },
      'harness-context7': { authStatus: 'unsupported', runtimeStatus: null },
      'harness-gtm': { authStatus: 'notLoggedIn', runtimeStatus: null, tools: {}, toolsError: 'Auth required' },
    };
    const { body } = await api('GET', '/api/connectors');
    const byName = Object.fromEntries(body.connectors.map((c) => [c.name, c]));
    assert.equal(byName['harness-atlassian'].state, 'signed_in');
    assert.equal(byName['harness-figma'].state, 'needs_sign_in');
    assert.equal(byName['harness-context7'].state, 'unknown');
    assert.match(byName['harness-context7'].detail, /unsupported/);
    assert.equal(byName['harness-gtm'].state, 'needs_sign_in');
  });

  it('reports every state unknown, with a reason, when the app-server fails', async () => {
    startFails = true;
    const { status, body } = await api('GET', '/api/connectors');
    assert.equal(status, 200);
    assert.equal(body.connectors.length, 4);
    for (const c of body.connectors) {
      assert.equal(c.state, 'unknown');
      assert.match(c.detail, /spawn codex ENOENT/);
    }
  });
});

describe('POST /api/connectors/:name/sign-in', () => {
  it('returns the https authUrl for a known connector and keeps the app-server alive', async () => {
    const { status, body } = await api('POST', '/api/connectors/harness-figma/sign-in');
    assert.equal(status, 200);
    assert.deepEqual(body, { authUrl: 'https://auth.example.com/authorize?client_id=x' });
    assert.equal(servers.length, 1);
    assert.equal(servers[0].calls[0][1], 'harness-figma');
    assert.equal(servers[0].closed, false);
    servers[0].emit('mcpServer/oauthLogin/completed', { name: 'harness-figma', success: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(servers[0].closed, true);
  });

  it('ignores a completion notice for another connector', async () => {
    await api('POST', '/api/connectors/harness-figma/sign-in');
    servers[0].emit('mcpServer/oauthLogin/completed', { name: 'harness-gtm', success: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(servers[0].closed, false);
  });

  it('replaces a pending sign-in of the same connector', async () => {
    await api('POST', '/api/connectors/harness-figma/sign-in');
    await api('POST', '/api/connectors/harness-figma/sign-in');
    assert.equal(servers.length, 2);
    assert.equal(servers[0].closed, true);
    assert.equal(servers[1].closed, false);
  });

  it('answers 404 for an unknown name and starts nothing', async () => {
    const { status, body } = await api('POST', '/api/connectors/harness-other/sign-in');
    assert.equal(status, 404);
    assert.match(body.error, /Unknown connector/);
    assert.equal(servers.length, 0);
  });

  it('rejects a non-https authUrl with 502 and closes the app-server', async () => {
    for (const bad of ['http://auth.example.com/x', 'javascript:alert(1)', 'not a url', undefined]) {
      loginUrl = bad;
      const { status, body } = await api('POST', '/api/connectors/harness-context7/sign-in');
      assert.equal(status, 502);
      assert.match(body.error, /https/);
    }
    assert.ok(servers.every((s) => s.closed));
  });

  it('answers 502 when the app-server fails', async () => {
    startFails = true;
    const { status, body } = await api('POST', '/api/connectors/harness-gtm/sign-in');
    assert.equal(status, 502);
    assert.match(body.error, /spawn codex ENOENT/);
    assert.equal(servers[0].closed, true);
  });

  it('does not start a sign-in on a status read', async () => {
    await api('GET', '/api/connectors');
    assert.ok(servers.every((s) => s.calls.every(([kind]) => kind === 'status')));
  });
});

describe('connector service internals', () => {
  it('passes the catalog urls to each app-server child as config overrides', () => {
    const args = connectorConfigArgs(defaultConnectorCatalog().servers);
    assert.ok(args.includes('mcp_servers.harness-figma.url="https://mcp.figma.com/mcp"'));
    assert.ok(args.includes('mcp_servers.harness-gtm.enabled=true'));
    assert.equal(args.filter((a) => a === '-c').length, 8);
  });

  it('wraps spawn so the overrides follow the app-server arguments', async () => {
    const created = [];
    const spawned = [];
    const service = createConnectorService({
      createAppServer: (o) => { created.push(o); return new FakeAppServer(o); },
      spawnImpl: (command, args) => { spawned.push([command, args]); return null; },
    });
    await service.list();
    created[0].spawnImpl('codex', ['app-server', '--listen', 'stdio://'], {});
    const [command, args] = spawned[0];
    assert.equal(command, 'codex');
    assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
    assert.equal(args.length, 3 + 16);
  });

  describe('list cache', () => {
    function counting() {
      const created = [];
      let clock = 1000;
      const service = createConnectorService({
        createAppServer: (o) => { const s = new FakeAppServer(o); created.push(s); return s; },
        now: () => clock,
      });
      return { service, created, advance: (ms) => { clock += ms; } };
    }

    it('shares one probe between concurrent list() calls', async () => {
      const { service, created } = counting();
      const [a, b] = await Promise.all([service.list(), service.list()]);
      assert.equal(created.length, 1);
      assert.deepEqual(a, b);
    });

    it('serves a second list() within 5 s from the cache', async () => {
      const { service, created, advance } = counting();
      await service.list();
      advance(4999);
      await service.list();
      assert.equal(created.length, 1);
    });

    it('probes again after 5 s', async () => {
      const { service, created, advance } = counting();
      await service.list();
      advance(5000);
      await service.list();
      assert.equal(created.length, 2);
    });

    it('a completion notification clears the cache', async () => {
      const { service, created } = counting();
      await service.signIn('harness-figma');
      await service.list();
      assert.equal(created.length, 2);
      created[0].emit('mcpServer/oauthLogin/completed', { name: 'harness-gtm', success: true });
      await service.list();
      assert.equal(created.length, 3);
      await service.close();
    });

    it('starting a sign-in clears the cache', async () => {
      const { service, created } = counting();
      await service.list();
      await service.signIn('harness-figma');
      await service.list();
      assert.equal(created.length, 3);
      await service.close();
    });

    it('does not cache a probe that was invalidated while in flight', async () => {
      const { service, created } = counting();
      const pending = service.list();
      await service.signIn('harness-figma');
      await pending;
      await service.list();
      assert.equal(created.length, 3);
      await service.close();
    });
  });

  describe('sign-in serialization and shutdown', () => {
    function tracked(gate) {
      const created = [];
      let peak = 0;
      const live = () => created.filter((s) => !s.closed).length;
      const service = createConnectorService({
        createAppServer: (o) => {
          const s = new FakeAppServer(o);
          const start = s.mcpOauthLoginStart.bind(s);
          s.mcpOauthLoginStart = async (...args) => {
            peak = Math.max(peak, live());
            if (gate) await gate.promise;
            return start(...args);
          };
          created.push(s);
          peak = Math.max(peak, live());
          return s;
        },
      });
      return { service, created, live, peak: () => peak };
    }
    const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

    it('keeps at most one live app-server for 5 concurrent sign-ins of one name', async () => {
      const gate = deferred();
      const { service, created, live, peak } = tracked(gate);
      const calls = Array.from({ length: 5 }, () => service.signIn('harness-figma'));
      setTimeout(gate.resolve, 5);
      const results = await Promise.all(calls);
      assert.equal(results.length, 5);
      assert.equal(created.length, 5);
      assert.equal(peak(), 1);
      assert.equal(live(), 1);
      await service.close();
      assert.equal(live(), 0);
    });

    it('leaves no live app-server after close(), also when close() runs during a sign-in', async () => {
      const gate = deferred();
      const { service, live } = tracked(gate);
      const pending = service.signIn('harness-figma');
      const other = service.signIn('harness-gtm');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(live(), 2);
      const closing = service.close();
      gate.resolve();
      await closing;
      await Promise.allSettled([pending, other]);
      assert.equal(live(), 0);
    });

    it('rejects a sign-in after close() started and spawns nothing', async () => {
      const { service, created } = tracked();
      const closing = service.close();
      await assert.rejects(service.signIn('harness-figma'), (err) => err.status === 503);
      await closing;
      assert.equal(created.length, 0);
    });

    it('rejects a queued sign-in that has not started when close() begins', async () => {
      const gate = deferred();
      const { service, created, live } = tracked(gate);
      const first = service.signIn('harness-figma');
      const second = service.signIn('harness-figma');
      second.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
      const closing = service.close();
      gate.resolve();
      await closing;
      await first;
      await assert.rejects(second, (err) => err.status === 503);
      assert.equal(created.length, 1);
      assert.equal(live(), 0);
    });
  });

  describe('mapState with live-shaped entries', () => {
    const tool = (name) => ({ name, inputSchema: {}, annotations: { readOnlyHint: true } });

    it('no entry is unknown with the existing detail', () => {
      assert.deepEqual(mapState(undefined), { state: 'unknown', detail: 'App-server did not report this server' });
    });

    it('authenticationRequired is needs_sign_in even with oAuth on record', () => {
      assert.equal(mapState({ authStatus: 'oAuth', runtimeStatus: 'authenticationRequired', tools: {}, toolsError: null }).state, 'needs_sign_in');
    });

    it('notLoggedIn without tools (Figma, GTM) is needs_sign_in', () => {
      const entry = { name: 'harness-figma', authStatus: 'notLoggedIn', runtimeStatus: null, tools: {}, toolsError: 'Auth required' };
      assert.equal(mapState(entry).state, 'needs_sign_in');
      assert.equal(mapState({ ...entry, tools: undefined }).state, 'needs_sign_in');
    });

    it('oAuth or bearerToken is signed_in (Atlassian)', () => {
      const tools = { getJiraIssue: tool('getJiraIssue'), searchConfluence: tool('searchConfluence') };
      assert.equal(mapState({ name: 'harness-atlassian', authStatus: 'oAuth', runtimeStatus: null, tools, toolsError: null }).state, 'signed_in');
      assert.equal(mapState({ authStatus: 'bearerToken', runtimeStatus: null, tools: {}, toolsError: null }).state, 'signed_in');
    });

    it('oAuth with an Auth required toolsError is needs_sign_in, not signed_in', () => {
      const tools = { getJiraIssue: tool('getJiraIssue') };
      const entry = { authStatus: 'oAuth', runtimeStatus: null, tools: {}, toolsError: 'MCP startup failed: Auth required' };
      assert.equal(mapState(entry).state, 'needs_sign_in');
      assert.equal(mapState({ ...entry, authStatus: 'bearerToken', toolsError: 'auth REQUIRED' }).state, 'needs_sign_in');
      assert.equal(mapState({ ...entry, tools, toolsError: 'Auth required' }).state, 'needs_sign_in');
      assert.equal(mapState({ ...entry, runtimeStatus: 'authenticationRequired', toolsError: 'other' }).state, 'needs_sign_in');
    });

    it('oAuth with another toolsError is unknown with the error in the detail', () => {
      const result = mapState({ authStatus: 'oAuth', runtimeStatus: null, tools: {}, toolsError: 'MCP startup failed: timeout' });
      assert.equal(result.state, 'unknown');
      assert.match(result.detail, /timeout/);
    });

    it('tools without error and no sign-in on record is available (Context7)', () => {
      const entry = {
        name: 'harness-context7',
        authStatus: 'notLoggedIn',
        runtimeStatus: null,
        tools: { 'resolve-library-id': tool('resolve-library-id'), 'query-docs': tool('query-docs') },
        toolsError: null,
      };
      assert.equal(mapState(entry).state, 'available');
      assert.equal(mapState({ ...entry, authStatus: 'unsupported' }).state, 'available');
      assert.equal(mapState({ ...entry, authStatus: 'unknown' }).state, 'available');
    });

    it('anything else is unknown with a detail', () => {
      const unsupported = mapState({ authStatus: 'unsupported', runtimeStatus: null, tools: {}, toolsError: null });
      assert.equal(unsupported.state, 'unknown');
      assert.match(unsupported.detail, /unsupported/);
      const broken = mapState({ authStatus: 'unknown', runtimeStatus: null, tools: { x: tool('x') }, toolsError: 'handshake failed' });
      assert.equal(broken.state, 'unknown');
      assert.match(broken.detail, /handshake failed/);
    });
  });
});
