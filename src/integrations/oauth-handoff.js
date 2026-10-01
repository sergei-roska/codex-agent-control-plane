'use strict';

const crypto = require('node:crypto');

const MAX_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 32;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CODE_LENGTH = 4096;
const SAFE_MESSAGES = Object.freeze({
  invalid_oauth_handoff: 'The authorization handoff is invalid or expired.',
  authorization_denied: 'Authorization was denied.',
  oauth_handoff_capacity: 'Too many authorization handoffs are active.',
  oauth_handoff_failed: 'Authorization could not be completed.',
});

class OAuthHandoffError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.oauth_handoff_failed);
    this.name = 'OAuthHandoffError';
    this.code = SAFE_MESSAGES[code] ? code : 'oauth_handoff_failed';
  }
}

function fail(code = 'invalid_oauth_handoff') {
  return new OAuthHandoffError(code);
}

function hasControls(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createOAuthHandoff({ oauth, now = () => Date.now(), ttlMs = MAX_TTL_MS, maxPending = MAX_PENDING } = {}) {
  if (!oauth || typeof oauth.beginAuthorization !== 'function' || typeof oauth.completeAuthorization !== 'function' ||
      typeof oauth.cancelAuthorization !== 'function' || typeof oauth.disconnect !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS ||
      !Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError('A valid OAuth client, clock, TTL, and pending limit are required');
  }

  const capacity = Math.min(maxPending, MAX_PENDING);
  const states = new Map();
  const handles = new Map();
  const beginning = new Set();
  const completing = new Set();
  let generation = 0;

  function clock() {
    let value;
    try { value = now(); } catch { throw fail(); }
    if (!Number.isSafeInteger(value) || value < 0) throw fail();
    return value;
  }

  function revision() {
    if (typeof oauth.getConnectionRevision !== 'function') return null;
    try {
      const value = oauth.getConnectionRevision();
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('bad revision');
      return value;
    } catch { throw fail(); }
  }

  function prune(at = clock()) {
    const expired = [];
    for (const [state, entry] of states) if (entry.expiresAt <= at) {
      states.delete(state);
      expired.push(entry);
    }
    for (const [handle, entry] of handles) if (entry.expiresAt <= at) {
      handles.delete(handle);
      expired.push(entry);
    }
    cancelEntries(expired);
  }

  function cancelEntry(entry) {
    let result;
    try { result = oauth.cancelAuthorization({ sessionId: entry.sessionId, state: entry.state }); }
    catch { throw fail('oauth_handoff_failed'); }
    try {
      if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw fail('oauth_handoff_failed');
      }
      if (!isRecord(result) || typeof result.canceled !== 'boolean') throw fail('oauth_handoff_failed');
      return result.canceled;
    } catch (error) {
      if (error instanceof OAuthHandoffError) throw error;
      throw fail('oauth_handoff_failed');
    }
  }

  function cancelEntries(entries) {
    let failed = false;
    for (const entry of entries) {
      try { cancelEntry(entry); } catch { failed = true; }
    }
    if (failed) throw fail('oauth_handoff_failed');
  }

  function reserveCapacity(at) {
    prune(at);
    if (states.size + handles.size + beginning.size + completing.size >= capacity) {
      throw fail('oauth_handoff_capacity');
    }
  }

  function validSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 512 && !hasControls(sessionId);
  }

  function invalidate() {
    generation += 1;
    const entries = [...states.values(), ...handles.values()];
    states.clear();
    handles.clear();
    beginning.clear();
    completing.clear();
    cancelEntries(entries);
  }

  async function begin(input = {}) {
    const at = clock();
    if (!isRecord(input) || !validSession(input.sessionId)) throw fail();
    reserveCapacity(at);
    const operation = Symbol('begin');
    beginning.add(operation);
    const operationGeneration = generation;
    let startingRevision = null;
    let result = null;
    let stateStored = false;
    try {
      startingRevision = revision();
      result = await oauth.beginAuthorization({ sessionId: input.sessionId });
      if (operationGeneration !== generation || (startingRevision !== null && revision() !== startingRevision)) throw fail();
      if (!isRecord(result) || typeof result.state !== 'string' || !STATE_PATTERN.test(result.state) ||
          typeof result.authorizationUrl !== 'string' || result.authorizationUrl.length > 8192 || hasControls(result.authorizationUrl)) throw fail();
      let url;
      try { url = new URL(result.authorizationUrl); } catch { throw fail(); }
      if (url.protocol !== 'https:' || url.hostname !== 'auth.atlassian.com' || url.pathname !== '/authorize' ||
          url.username || url.password || url.hash || url.searchParams.get('state') !== result.state) throw fail();
      const expiresAt = at + ttlMs;
      if (!Number.isSafeInteger(expiresAt)) throw fail();
      const finishedAt = clock();
      prune(finishedAt);
      if (finishedAt >= expiresAt) throw fail();
      if (states.has(result.state)) throw fail();
      states.set(result.state, { state: result.state, sessionId: input.sessionId, expiresAt, revision: startingRevision, generation: operationGeneration });
      stateStored = true;
      return { authorizationUrl: result.authorizationUrl, expiresAt };
    } catch (error) {
      if (!stateStored && isRecord(result) && typeof result.state === 'string' && STATE_PATTERN.test(result.state)) {
        try { cancelEntry({ state: result.state, sessionId: input.sessionId }); }
        catch { throw fail('oauth_handoff_failed'); }
      }
      if (error instanceof OAuthHandoffError) throw error;
      throw fail('oauth_handoff_failed');
    } finally {
      beginning.delete(operation);
    }
  }

  function receiveCallback(input = {}) {
    const at = clock();
    if (!isRecord(input)) throw fail();
    prune(at);
    const state = input.state;
    if (typeof state !== 'string' || !STATE_PATTERN.test(state)) throw fail();
    const entry = states.get(state);
    if (!entry) throw fail();
    states.delete(state);
    let valid = entry.expiresAt > at && entry.generation === generation;
    if (valid && entry.revision !== null) {
      try { valid = revision() === entry.revision; } catch { valid = false; }
    }
    if (!valid) {
      cancelEntry(entry);
      throw fail();
    }
    if (Object.prototype.hasOwnProperty.call(input, 'error')) {
      const wellFormed = typeof input.error === 'string' && input.error.length <= 256 && !hasControls(input.error);
      cancelEntry(entry);
      if (!wellFormed) throw fail();
      throw fail('authorization_denied');
    }
    if (typeof input.code !== 'string' || input.code.length < 1 || input.code.length > MAX_CODE_LENGTH || hasControls(input.code)) {
      cancelEntry(entry);
      throw fail();
    }
    try { reserveCapacity(at); }
    catch (error) {
      cancelEntry(entry);
      throw error;
    }
    let handle;
    try {
      do { handle = crypto.randomBytes(32).toString('base64url'); } while (handles.has(handle));
    } catch {
      cancelEntry(entry);
      throw fail('oauth_handoff_failed');
    }
    handles.set(handle, { state, code: input.code, sessionId: entry.sessionId, expiresAt: entry.expiresAt,
      revision: entry.revision, generation: entry.generation });
    return { handle, expiresAt: entry.expiresAt };
  }

  async function complete(input = {}) {
    const at = clock();
    if (!isRecord(input) || typeof input.handle !== 'string' || !HANDLE_PATTERN.test(input.handle)) throw fail();
    prune(at);
    const entry = handles.get(input.handle);
    if (!entry) throw fail();
    handles.delete(input.handle);
    let valid = entry.expiresAt > at && validSession(input.sessionId) && entry.sessionId === input.sessionId && entry.generation === generation;
    if (valid && entry.revision !== null) {
      try { valid = revision() === entry.revision; } catch { valid = false; }
    }
    if (!valid) {
      cancelEntry(entry);
      throw fail();
    }
    const operation = Symbol('complete');
    completing.add(operation);
    const operationGeneration = generation;
    try {
      let result;
      try { result = Promise.resolve(oauth.completeAuthorization({ sessionId: entry.sessionId, state: entry.state, code: entry.code })); }
      catch { throw fail('oauth_handoff_failed'); }
      // Observe the operation immediately: a revision race can reject it before we await it.
      result.catch(() => {});
      // The adapter advances its revision exactly once when it begins a valid exchange.
      // Checking before awaiting distinguishes that transition from later account changes.
      const expectedRevision = entry.revision === null ? null : entry.revision + 1;
      if (operationGeneration !== generation || (expectedRevision !== null && revision() !== expectedRevision)) {
        throw fail();
      }
      await result;
      if (operationGeneration !== generation || (expectedRevision !== null && revision() !== expectedRevision)) {
        throw fail();
      }
      return { connected: true };
    } catch (error) {
      try { cancelEntry(entry); }
      catch { throw fail('oauth_handoff_failed'); }
      if (error instanceof OAuthHandoffError) throw error;
      throw fail('oauth_handoff_failed');
    } finally {
      completing.delete(operation);
    }
  }

  async function disconnect(input = {}) {
    if (!isRecord(input) || !validSession(input.sessionId)) throw fail();
    let failed = false;
    try { invalidate(); } catch { failed = true; }
    try { await oauth.disconnect(); } catch { failed = true; }
    if (failed) throw fail('oauth_handoff_failed');
    return { disconnected: true };
  }

  return Object.freeze({
    begin,
    receiveCallback,
    complete,
    disconnect,
    clear() { invalidate(); },
  });
}

module.exports = { OAuthHandoffError, createOAuthHandoff };
