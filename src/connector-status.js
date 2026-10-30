'use strict';

const { spawn, execFile } = require('node:child_process');
const { defaultConnectorCatalog } = require('./connector-catalog');

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const LOGIN_REQUEST_TIMEOUT_MS = 30_000;
const LIST_CACHE_MS = 5_000;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function shortText(value) {
  return String(value || 'unknown error').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function logoutConnector(name, { codexHome = null, server, execFileImpl = execFile } = {}) {
  if (!server || typeof server.url !== 'string') return Promise.reject(new TypeError('validated connector server config is required'));
  const overrides = connectorConfigArgs(new Map([[name, server]]));
  return new Promise((resolve, reject) => {
    execFileImpl('codex', ['mcp', 'logout', ...overrides, name], {
      ...(codexHome ? { env: { ...process.env, CODEX_HOME: codexHome } } : {}),
      shell: false,
    }, (error) => error ? reject(error) : resolve());
  });
}

// Connectors are not in the Codex config files; each app-server child gets them as -c overrides.
// The urls come from the validated catalog (https, fixed vendor hosts), so the TOML values are plain strings.
function connectorConfigArgs(servers) {
  const args = [];
  for (const [name, server] of servers) {
    args.push('-c', `mcp_servers.${name}.url=${JSON.stringify(server.url)}`, '-c', `mcp_servers.${name}.enabled=true`);
  }
  return args;
}

// Maps one app-server McpServerStatus to the state the sidebar shows. signed_in needs explicit evidence.
// Contract of list(): state is one of signed_in | needs_sign_in | available | unknown.
// available = tools were listed without an error although no sign-in is on record (for example Context7).
// The live probe reports runtimeStatus null, so a failed sign-in shows only in toolsError ("Auth required").
// Rules are checked in this order.
function mapState(entry) {
  if (!entry) return { state: 'unknown', detail: 'App-server did not report this server' };
  const { authStatus, runtimeStatus, tools, toolsError } = entry;
  const hasTools = Boolean(tools) && typeof tools === 'object' && Object.keys(tools).length > 0;
  if (toolsError) {
    if (runtimeStatus === 'authenticationRequired' || /auth required/i.test(String(toolsError))) return { state: 'needs_sign_in' };
    return { state: 'unknown', detail: `App-server tools error: ${shortText(toolsError)}` };
  }
  if (runtimeStatus === 'authenticationRequired') return { state: 'needs_sign_in' };
  if (authStatus === 'notLoggedIn' && !hasTools) return { state: 'needs_sign_in' };
  if (authStatus === 'oAuth' || authStatus === 'bearerToken') return { state: 'signed_in' };
  if (hasTools) return { state: 'available', detail: 'Reachable without sign-in' };
  return { state: 'unknown', detail: `App-server reports auth status ${shortText(authStatus)}` };
}

function createConnectorService({
  createAppServer,
  getCodexHome = () => null,
  servers = defaultConnectorCatalog().servers,
  loginTimeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  spawnImpl = spawn,
  logoutImpl = logoutConnector,
  preferences = null,
  now = Date.now,
} = {}) {
  if (typeof createAppServer !== 'function') throw new TypeError('createAppServer is required');
  const extraArgs = connectorConfigArgs(servers);
  const withConnectors = (command, args, options) => spawnImpl(command, [...args, ...extraArgs], options);
  const logins = new Map();

  const open = (extra, codexHome = getCodexHome()) => createAppServer({ cwd: process.cwd(), codexHome, spawnImpl: withConnectors, ...extra });

  // Single-flight with a short cache: the sidebar polls, and a probe can take seconds.
  let flight = null;
  let cached = null;
  let epoch = 0;
  const invalidate = () => { epoch += 1; cached = null; flight = null; };

  function list() {
    if (cached && now() - cached.at < LIST_CACHE_MS) return Promise.resolve(cached.value);
    if (flight) return flight;
    const started = epoch;
    const current = probe().then((value) => {
      if (epoch === started) cached = { at: now(), value };
      return value;
    }).finally(() => { if (flight === current) flight = null; });
    flight = current;
    return current;
  }

  async function probe() {
    const server = open({ requestTimeoutMs: STATUS_TIMEOUT_MS });
    try {
      const rows = await Promise.all([...servers.keys()].map((name) => server.mcpServerAuthStatus(name).then(
        (data) => mapState(data.find((entry) => entry && entry.name === name)),
        (err) => ({ state: 'unknown', detail: `App-server error: ${shortText(err && err.message)}` }),
      )));
      return [...servers.values()].map((item, i) => ({
        name: item.configName,
        title: item.title,
        purpose: item.purpose,
        dataSensitivity: item.dataSensitivity,
        toolsVerified: item.toolsVerified,
        enabled: preferences ? preferences.isEnabled(item.configName) : true,
        ...rows[i],
      }));
    } finally {
      await server.close().catch(() => {});
    }
  }

  // The sign-in callback lives in the app-server process, so the process stays until completion or timeout.
  async function endLogin(name) {
    const entry = logins.get(name);
    if (!entry) return;
    logins.delete(name);
    clearTimeout(entry.timer);
    entry.unsubscribe?.();
    await entry.server.close().catch(() => {});
  }

  // One sign-in per connector name at a time: a later call waits for the earlier one, including its endLogin.
  const chains = new Map();
  const inflight = new Set();
  let closing = false;

  async function startSignIn(name, codexHome = getCodexHome()) {
    if (closing) throw failure(503, 'Connector service is shutting down');
    await endLogin(name);
    if (closing) throw failure(503, 'Connector service is shutting down');
    // No await between here and logins.set: the slot is free and is taken in the same tick.
    const server = open({ requestTimeoutMs: LOGIN_REQUEST_TIMEOUT_MS }, codexHome);
    const entry = { server, timer: null, unsubscribe: null };
    logins.set(name, entry);
    entry.unsubscribe = server.onNotification('mcpServer/oauthLogin/completed', (params) => {
      invalidate();
      if (params && params.name === name && logins.get(name) === entry) endLogin(name);
    });
    try {
      const result = await server.mcpOauthLoginStart(name, { timeoutSecs: Math.ceil(loginTimeoutMs / 1000) });
      let url;
      try { url = new URL(result && result.authorizationUrl); } catch (_) { url = null; }
      if (!url || url.protocol !== 'https:') throw failure(502, 'App-server returned no https sign-in URL');
      entry.timer = setTimeout(() => { if (logins.get(name) === entry) endLogin(name); }, loginTimeoutMs);
      entry.timer.unref?.();
      return { authUrl: url.href };
    } catch (err) {
      if (logins.get(name) === entry) await endLogin(name);
      throw err.status ? err : failure(502, `App-server error: ${shortText(err && err.message)}`);
    }
  }

  function queueLogin(name, action) {
    if (typeof name !== 'string' || !servers.has(name)) return Promise.reject(failure(404, 'Unknown connector'));
    if (closing) return Promise.reject(failure(503, 'Connector service is shutting down'));
    const run = (chains.get(name) || Promise.resolve()).then(() => {
      if (closing) throw failure(503, 'Connector service is shutting down');
      return action();
    });
    const tail = run.catch(() => {});
    chains.set(name, tail);
    inflight.add(tail);
    tail.then(() => {
      inflight.delete(tail);
      if (chains.get(name) === tail) chains.delete(name);
    });
    return run;
  }

  function signIn(name) {
    if (typeof name !== 'string' || !servers.has(name)) return Promise.reject(failure(404, 'Unknown connector'));
    if (closing) return Promise.reject(failure(503, 'Connector service is shutting down'));
    invalidate();
    return queueLogin(name, () => startSignIn(name));
  }

  function setEnabled(name, enabled) {
    if (typeof name !== 'string' || !servers.has(name)) return Promise.reject(failure(404, 'Unknown connector'));
    if (typeof enabled !== 'boolean') return Promise.reject(failure(400, 'enabled must be a boolean'));
    try {
      if (preferences) preferences.setEnabled(name, enabled);
      invalidate();
      return Promise.resolve({ success: true, name, enabled });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function switchAccount(name) {
    if (typeof name !== 'string' || !servers.has(name)) return Promise.reject(failure(404, 'Unknown connector'));
    if (closing) return Promise.reject(failure(503, 'Connector service is shutting down'));
    invalidate();
    return queueLogin(name, async () => {
      const codexHome = getCodexHome();
      await endLogin(name);
      try {
        await logoutImpl(name, { codexHome, server: servers.get(name) });
      } catch (error) {
        throw failure(502, `Connector logout failed: ${shortText(error && error.message)}`);
      }
      invalidate();
      return startSignIn(name, codexHome);
    });
  }

  // Waits for sign-ins in progress, then closes every remaining login server. New sign-ins are refused.
  async function close() {
    closing = true;
    await Promise.all([...inflight]);
    await Promise.all([...logins.keys()].map(endLogin));
  }

  return { list, signIn, setEnabled, switchAccount, close };
}

module.exports = { createConnectorService, connectorConfigArgs, logoutConnector, mapState };
