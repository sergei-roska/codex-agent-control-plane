'use strict';

// Account health over the installed Codex App Server (ChatGPT OAuth account only). Cached briefly;
// forced refreshes are rate limited. Never throws: failures map to status "unavailable".

const CACHE_MS = 30_000;
const MIN_FORCE_MS = 10_000;
const APP_SERVER_TIMEOUT_MS = 10_000;

// Bounds an App Server call; a call that never answers maps to the unavailable status.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('app server timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toMs(value) {
  const raw = typeof value === 'function' ? value() : value;
  if (raw instanceof Date) return raw.getTime();
  return Number.isFinite(raw) ? raw : Date.now();
}

function pickWindow(window) {
  if (!window || typeof window !== 'object') return null;
  return {
    usedPercent: window.usedPercent ?? null,
    windowDurationMins: window.windowDurationMins ?? null,
    resetsAt: window.resetsAt ?? null,
  };
}

function shapeRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const limits = raw.rateLimits && typeof raw.rateLimits === 'object' ? raw.rateLimits : raw;
  return {
    primary: pickWindow(limits.primary),
    secondary: pickWindow(limits.secondary),
    ordinaryUsageAllowed: typeof raw.ordinaryUsageAllowed === 'boolean' ? raw.ordinaryUsageAllowed : null,
  };
}

function createAccountHealth({ appServer, now, timeoutMs = APP_SERVER_TIMEOUT_MS } = {}) {
  if (!appServer || typeof appServer.getAccount !== 'function') throw new TypeError('createAccountHealth requires appServer.getAccount');
  let cached = null;
  let cachedAtMs = null;
  let lastLoadMs = null;
  let inflight = null;

  async function load() {
    const startedMs = toMs(now);
    let result;
    try {
      const read = await withTimeout(Promise.resolve().then(() => appServer.getAccount()), timeoutMs);
      const account = read?.account && typeof read.account === 'object' ? read.account : null;
      const version = appServer.appServerVersion ?? null;
      if (!account) {
        result = { status: 'requires_auth', account: null, rateLimits: null };
      } else if (account.type !== 'chatgpt') {
        result = { status: 'unsupported_account', account: { type: account.type ?? null, planType: null, email: null }, rateLimits: null };
      } else {
        let rateLimits = null;
        if (typeof appServer.readRateLimits === 'function') {
          try { rateLimits = shapeRateLimits(await withTimeout(Promise.resolve().then(() => appServer.readRateLimits()), timeoutMs)); } catch (_) { rateLimits = null; }
        }
        result = {
          status: 'connected',
          account: { type: 'chatgpt', planType: account.planType ?? null, email: account.email ?? null },
          rateLimits,
        };
      }
      result.appServerVersion = version;
    } catch (_) {
      result = { status: 'unavailable', account: null, rateLimits: null, appServerVersion: appServer.appServerVersion ?? null };
    }
    result.checkedAt = new Date(toMs(now)).toISOString();
    cached = result;
    cachedAtMs = toMs(now);
    lastLoadMs = startedMs;
    return result;
  }

  async function get({ force = false } = {}) {
    const at = toMs(now);
    if (cached) {
      const age = at - cachedAtMs;
      if (!force && age < CACHE_MS) return { ...cached };
      if (force && at - lastLoadMs < MIN_FORCE_MS) return { ...cached };
    }
    if (!inflight) inflight = load().finally(() => { inflight = null; });
    return { ...(await inflight) };
  }

  // Drops the cached state and the force rate limit so the next read re-asks the (recycled) app server.
  function invalidate() {
    cached = null;
    cachedAtMs = null;
    lastLoadMs = null;
  }

  return { get, invalidate };
}

module.exports = { createAccountHealth };
