'use strict';

const crypto = require('node:crypto');

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const REQUIRED_SCOPES = Object.freeze(['read:jira-work', 'read:page:confluence', 'offline_access']);
const MAX_BODY_BYTES = 1024 * 1024;
const SAFE_ERROR_CODES = new Set(['request_timeout', 'redirect_rejected', 'unbounded_response_body', 'response_too_large',
  'upstream_request_failed', 'invalid_upstream_response', 'invalid_token_response', 'unexpected_scope',
  'required_scope_missing', 'credential_store_failed', 'invalid_saved_credentials', 'reconnect_required',
  'connection_changed', 'invalid_authorization_state', 'too_many_pending_authorizations', 'client_configuration_error',
  'invalid_resource_response', 'invalid_grant', 'credential_refresh_failed', 'invalid_clock']);

class AtlassianOAuthError extends Error {
  constructor(code, message = 'Atlassian authorization failed') {
    super(message);
    this.name = 'AtlassianOAuthError';
    this.code = code;
  }
}

function safeError(code) { return new AtlassianOAuthError(code); }
function safeCode(error, fallback = 'upstream_request_failed') {
  return error instanceof AtlassianOAuthError && SAFE_ERROR_CODES.has(error.code) ? error.code : fallback;
}
function noHeaderControls(value) { return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value); }

function callbackIsAllowed(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('A registered callback URL is required'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw new TypeError('Callback URL must use HTTPS or explicit loopback HTTP');
  }
  return url.toString();
}

function requiredString(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096; }
function parseScopes(value) {
  if (Array.isArray(value)) return value.every((scope) => typeof scope === 'string') ? value : null;
  if (typeof value === 'string') return value.trim() ? value.trim().split(/\s+/) : null;
  return null;
}

function awaitWithSignal(value, signal, timeoutMs, timeoutCode = 'request_timeout') {
  if (signal?.aborted) return Promise.reject(safeError(timeoutCode));
  let timer;
  let abort;
  const guards = [];
  if (Number.isFinite(timeoutMs)) guards.push(new Promise((_, reject) => {
    timer = setTimeout(() => reject(safeError(timeoutCode)), timeoutMs);
  }));
  if (signal) guards.push(new Promise((_, reject) => {
    abort = () => reject(safeError(timeoutCode));
    signal.addEventListener('abort', abort, { once: true });
  }));
  const operation = Promise.resolve(value);
  return (guards.length ? Promise.race([operation, ...guards]) : operation).finally(() => {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  });
}

async function readBounded(response, maxBytes = MAX_BODY_BYTES, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw safeError('unbounded_response_body');
  }
  const chunks = [];
  let size = 0;
  const abortRead = () => { reader.cancel().catch(() => {}); };
  if (signal?.aborted) abortRead();
  signal?.addEventListener('abort', abortRead, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw safeError('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { signal?.removeEventListener('abort', abortRead); reader.releaseLock?.(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function requestJson(fetchImpl, url, options, timeoutMs, maxBytes = MAX_BODY_BYTES, { signal, recognizeInvalidGrant = false } = {}) {
  if (signal?.aborted) throw safeError('request_timeout');
  const controller = new AbortController();
  const abortExternal = () => controller.abort();
  signal?.addEventListener('abort', abortExternal, { once: true });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(safeError('request_timeout')); }, timeoutMs);
  });
  try {
    const request = (async () => {
      if (signal?.aborted) throw safeError('request_timeout');
      const response = await fetchImpl(url, { ...options, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw safeError('redirect_rejected');
      const body = await readBounded(response, maxBytes, controller.signal);
      if (!response.ok) {
        if (recognizeInvalidGrant && [400, 401].includes(response.status)) {
          try { if (JSON.parse(body)?.error === 'invalid_grant') throw safeError('invalid_grant'); } catch (error) {
            if (safeCode(error) === 'invalid_grant') throw error;
          }
        }
        throw safeError('upstream_request_failed');
      }
      try { return JSON.parse(body); } catch { throw safeError('invalid_upstream_response'); }
    })();
    return await Promise.race([request, deadline]);
  } catch (error) {
    if (error instanceof AtlassianOAuthError) throw safeError(safeCode(error));
    if (controller.signal.aborted) throw safeError('request_timeout');
    throw safeError('upstream_request_failed');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abortExternal); }
}

function validateTokens(value, requestedScopes = REQUIRED_SCOPES, now = Date.now) {
  if (!value || typeof value !== 'object' || !requiredString(value.access_token) || !noHeaderControls(value.access_token) ||
      !requiredString(value.refresh_token) || !noHeaderControls(value.refresh_token) || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 31 * 24 * 60 * 60 ||
      (value.token_type && (typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer'))) throw safeError('invalid_token_response');
  const scopes = parseScopes(value.scope);
  if (!scopes || scopes.some((scope) => !/^[a-z0-9:_-]{1,128}$/.test(scope))) throw safeError('invalid_token_response');
  if (scopes.some((scope) => !requestedScopes.includes(scope))) throw safeError('unexpected_scope');
  if (requestedScopes.some((scope) => !scopes.includes(scope))) throw safeError('required_scope_missing');
  const expiryBase = now();
  if (!Number.isFinite(expiryBase) || !Number.isFinite(expiryBase + value.expires_in * 1000)) throw safeError('invalid_clock');
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: expiryBase + value.expires_in * 1000,
    scopes,
  };
}

function createAtlassianOAuthClient(options = {}) {
  const { clientId, redirectUri, tokenStore, resolveClientSecret, fetchImpl = globalThis.fetch } = options;
  const callback = callbackIsAllowed(redirectUri);
  if (!requiredString(clientId) || !tokenStore || typeof tokenStore.read !== 'function' ||
      typeof tokenStore.write !== 'function' || typeof tokenStore.clear !== 'function' ||
      typeof resolveClientSecret !== 'function' || typeof fetchImpl !== 'function') {
    throw new TypeError('clientId, callback, injected tokenStore, client secret resolver, and fetch are required');
  }
  const now = options.now || (() => Date.now());
  for (const [name, value] of Object.entries({ timeoutMs: options.timeoutMs ?? 10000, stateTtlMs: options.stateTtlMs ?? 300000, maxPendingStates: options.maxPendingStates ?? 32 })) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) throw new TypeError(`Invalid ${name}`);
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 10000, 100), 60000);
  const stateTtlMs = Math.min(Math.max(options.stateTtlMs ?? 300000, 1000), 900000);
  const maxPendingStates = Math.min(Math.max(options.maxPendingStates ?? 32, 1), 256);
  const pending = new Map();
  let generation = 0;
  let refreshPromise = null;
  let persistTail = Promise.resolve();
  let inMemoryTokens = null;
  let pendingRotated = null;
  let reconnectRequired = false;
  let generationController = new AbortController();

  function clockNow() {
    const value = now();
    if (!Number.isFinite(value)) throw safeError('invalid_clock');
    return value;
  }

  function advanceGeneration() {
    generation += 1;
    generationController.abort();
    generationController = new AbortController();
    refreshPromise = null;
    return generation;
  }

  function combinedSignal(expectedGeneration, externalSignal) {
    if (generation !== expectedGeneration) throw safeError('connection_changed');
    const controller = new AbortController();
    const sources = [generationController.signal, externalSignal].filter(Boolean);
    const abort = () => controller.abort();
    for (const source of sources) {
      if (source.aborted) abort();
      else source.addEventListener('abort', abort, { once: true });
    }
    return { signal: controller.signal, dispose() { for (const source of sources) source.removeEventListener('abort', abort); } };
  }

  function enqueuePersist(action) {
    const result = persistTail.then(action, action);
    persistTail = result.catch(() => {});
    return result;
  }
  async function storeForGeneration(tokens, expectedGeneration) {
    return enqueuePersist(async () => {
      if (generation !== expectedGeneration) throw safeError('connection_changed');
      try { await tokenStore.write({ ...tokens, scopes: [...tokens.scopes] }); }
      catch { throw safeError('credential_store_failed'); }
      if (generation !== expectedGeneration) throw safeError('connection_changed');
      inMemoryTokens = tokens;
    });
  }
  async function exchange(form, expectedGeneration, externalSignal) {
    const combined = combinedSignal(expectedGeneration, externalSignal);
    let clientSecret;
    try {
      try { clientSecret = await awaitWithSignal(resolveClientSecret(), combined.signal, timeoutMs); }
      catch (error) { if (safeCode(error, '') === 'request_timeout') throw error; throw safeError('client_configuration_error'); }
      if (typeof clientSecret !== 'string' || !clientSecret) throw safeError('client_configuration_error');
      if (combined.signal.aborted || generation !== expectedGeneration) throw safeError('connection_changed');
      let payload;
      try {
        payload = await requestJson(fetchImpl, TOKEN_URL, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ ...form, client_id: clientId, client_secret: clientSecret, redirect_uri: callback }),
        }, timeoutMs, MAX_BODY_BYTES, { signal: combined.signal, recognizeInvalidGrant: form.grant_type === 'refresh_token' });
      } catch (error) {
        if (generation !== expectedGeneration) throw safeError('connection_changed');
        throw error;
      }
      if (generation !== expectedGeneration) throw safeError('connection_changed');
      return validateTokens(payload, REQUIRED_SCOPES, clockNow);
    } finally { combined.dispose(); }
  }

  async function loadTokens(signal) {
    if (reconnectRequired) return null;
    if (inMemoryTokens) return inMemoryTokens;
    const readGeneration = generation;
    let saved;
    try { saved = await awaitWithSignal(tokenStore.read(), signal, timeoutMs); } catch (error) {
      if (safeCode(error, '') === 'request_timeout') throw error;
      throw safeError('credential_store_failed');
    }
    if (signal?.aborted) throw safeError('request_timeout');
    if (!saved) return null;
    if (generation !== readGeneration || reconnectRequired) return null;
    if (!requiredString(saved.accessToken) || !noHeaderControls(saved.accessToken) || !requiredString(saved.refreshToken) || !noHeaderControls(saved.refreshToken) ||
        !Number.isFinite(saved.expiresAt) || saved.expiresAt < 0) {
      throw safeError('invalid_saved_credentials');
    }
    const scopes = parseScopes(saved.scopes);
    if (!scopes || scopes.some((scope) => !/^[a-z0-9:_-]{1,128}$/.test(scope) || !REQUIRED_SCOPES.includes(scope)) ||
        REQUIRED_SCOPES.some((scope) => !scopes.includes(scope)) || new Set(scopes).size !== scopes.length) {
      throw safeError('invalid_saved_credentials');
    }
    inMemoryTokens = { ...saved, scopes: [...new Set(scopes)] };
    return inMemoryTokens;
  }

  async function getAccessToken({ signal } = {}) {
    const startedAt = generation;
    const tokens = await loadTokens(signal);
    if (signal?.aborted) throw safeError('request_timeout');
    if (!tokens || generation !== startedAt || reconnectRequired) throw safeError('reconnect_required');
    if (tokens.expiresAt > clockNow() + 60000) return tokens.accessToken;
    if (!refreshPromise || refreshPromise.generation !== startedAt) {
      const promise = (async () => {
        const current = await loadTokens(signal);
        if (!current || generation !== startedAt || reconnectRequired || signal?.aborted) throw safeError(signal?.aborted ? 'request_timeout' : 'reconnect_required');
        if (pendingRotated?.generation === startedAt) {
          const candidate = pendingRotated.tokens;
          try { await storeForGeneration(candidate, startedAt); }
          catch (error) { throw safeError(safeCode(error, 'credential_store_failed')); }
          pendingRotated = null;
          return candidate.accessToken;
        }
        try {
          const candidate = await exchange({ grant_type: 'refresh_token', refresh_token: current.refreshToken }, startedAt, signal);
          if (generation !== startedAt || signal?.aborted) throw safeError(signal?.aborted ? 'request_timeout' : 'connection_changed');
          try { await storeForGeneration(candidate, startedAt); }
          catch (error) {
            if (generation === startedAt && !reconnectRequired) pendingRotated = { generation: startedAt, tokens: candidate };
            throw error;
          }
          return candidate.accessToken;
        } catch (error) {
          if (generation !== startedAt) throw safeError('reconnect_required');
          if (safeCode(error, '') === 'invalid_grant') {
            const revokedGeneration = advanceGeneration();
            reconnectRequired = true;
            inMemoryTokens = null;
            pendingRotated = null;
            try { await enqueuePersist(async () => { try { await tokenStore.clear(); } catch { throw safeError('credential_store_failed'); } }); }
            catch { /* The reconnect guard prevents stale reads if durable clearing fails. */ }
            if (generation !== revokedGeneration) throw safeError('reconnect_required');
            throw safeError('reconnect_required');
          }
          if (safeCode(error, '') === 'credential_store_failed') throw safeError('credential_store_failed');
          throw safeError('credential_refresh_failed');
        }
        if (generation !== startedAt || reconnectRequired) throw safeError('reconnect_required');
      })();
      refreshPromise = { generation: startedAt, promise };
      promise.finally(() => { if (refreshPromise?.promise === promise) refreshPromise = null; }).catch(() => {});
    }
    return refreshPromise.promise;
  }

  return Object.freeze({
    async beginAuthorization({ sessionId } = {}) {
      if (!requiredString(sessionId)) throw new TypeError('A session ID is required');
      for (const [state, entry] of pending) if (entry.expiresAt <= clockNow()) pending.delete(state);
      if (pending.size >= maxPendingStates) throw safeError('too_many_pending_authorizations');
      const state = crypto.randomBytes(32).toString('base64url');
      pending.set(state, { sessionId, expiresAt: clockNow() + stateTtlMs });
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({ audience: 'api.atlassian.com', client_id: clientId,
        scope: REQUIRED_SCOPES.join(' '), redirect_uri: callback, state, response_type: 'code',
        prompt: 'consent' }).toString();
      return { authorizationUrl: url.toString(), state };
    },
    cancelAuthorization(options = {}) {
      if (!options || typeof options !== 'object') return { canceled: false };
      let sessionId;
      let state;
      try { ({ sessionId, state } = options); } catch { return { canceled: false }; }
      if (!requiredString(sessionId) || !requiredString(state)) return { canceled: false };
      const entry = pending.get(state);
      if (!entry || entry.sessionId !== sessionId) return { canceled: false };
      pending.delete(state);
      return { canceled: true };
    },
    async completeAuthorization({ sessionId, state, code } = {}) {
      const entry = typeof state === 'string' ? pending.get(state) : null;
      if (entry) pending.delete(state); // Every callback attempt consumes its one-use state.
      if (!entry || !requiredString(sessionId) || entry.sessionId !== sessionId || entry.expiresAt <= now() || !requiredString(code)) {
        throw safeError('invalid_authorization_state');
      }
      const expectedGeneration = advanceGeneration();
      reconnectRequired = true;
      inMemoryTokens = null;
      pendingRotated = null;
      await storeForGeneration(await exchange({ grant_type: 'authorization_code', code }, expectedGeneration), expectedGeneration);
      if (generation !== expectedGeneration) throw safeError('connection_changed');
      reconnectRequired = false;
      return { connected: true };
    },
    getAccessToken,
    getConnectionRevision() { return generation; },
    async getResources({ signal } = {}) {
      const startedAt = generation;
      const token = await getAccessToken({ signal });
      if (signal?.aborted) throw safeError('request_timeout');
      if (generation !== startedAt || reconnectRequired) throw safeError('connection_changed');
      const combined = combinedSignal(startedAt, signal);
      let result;
      try { result = await requestJson(fetchImpl, RESOURCES_URL, {
        method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      }, timeoutMs, MAX_BODY_BYTES, { signal: combined.signal }); }
      finally { combined.dispose(); }
      if (generation !== startedAt || reconnectRequired || signal?.aborted) throw safeError(signal?.aborted ? 'request_timeout' : 'connection_changed');
      if (!Array.isArray(result) || result.some((resource) => !resource || typeof resource.id !== 'string' ||
        typeof resource.url !== 'string' || !Array.isArray(resource.scopes))) throw safeError('invalid_resource_response');
      return result.map((resource) => ({ id: resource.id, url: resource.url, name: String(resource.name || ''), scopes: [...new Set(resource.scopes.filter((s) => typeof s === 'string'))] }));
    },
    async getHealth() {
      try {
        const tokens = await loadTokens();
        if (reconnectRequired) throw safeError('reconnect_required');
        return { connected: Boolean(tokens), expiresAt: tokens ? tokens.expiresAt : null,
          scopes: tokens ? [...tokens.scopes] : [], pendingAuthorizations: pending.size };
      } catch {
        return { connected: false, expiresAt: null, scopes: [], pendingAuthorizations: pending.size };
      }
    },
    async disconnect() {
      advanceGeneration();
      reconnectRequired = true;
      inMemoryTokens = null;
      pendingRotated = null;
      for (const [state, item] of pending) if (item) pending.delete(state);
      try { await enqueuePersist(() => tokenStore.clear()); } catch { throw safeError('credential_store_failed'); }
      return { disconnected: true };
    },
  });
}

module.exports = { AUTHORIZE_URL, TOKEN_URL, RESOURCES_URL, REQUIRED_SCOPES, AtlassianOAuthError, createAtlassianOAuthClient };
