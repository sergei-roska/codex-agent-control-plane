'use strict';

const MAX_TIMER_MS = 2_147_483_647;

const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Parses a reset hint (epoch seconds, epoch ms, numeric string, or ISO string) into epoch ms, or null. */
function parseResetsAt(value) {
  if (value === null || value === undefined || value === '') return null;
  let number = null;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) number = Number(value);
  if (number !== null) {
    if (!Number.isFinite(number) || number <= 0) return null;
    return number < 1e12 ? number * 1000 : number;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * True when the account may use the given models again. Recovery is never inferred from
 * percentages or reset times: only ordinaryUsageAllowed and rateLimitReachedType count.
 */
function isBudgetAvailable(response, models) {
  if (!response || typeof response !== 'object') return false;
  const wanted = new Set(models || []);
  const snapshots = [];
  if (response.rateLimits && typeof response.rateLimits === 'object') snapshots.push(response.rateLimits);
  const byId = response.rateLimitsByLimitId;
  if (byId && typeof byId === 'object') {
    for (const snapshot of Object.values(byId)) {
      if (!snapshot || typeof snapshot !== 'object') continue;
      const slug = snapshot.normalModelSlug;
      if (slug === null || slug === undefined || wanted.has(slug)) snapshots.push(snapshot);
    }
  }
  if (response.ordinaryUsageAllowed !== true && response.ordinaryUsageAllowed !== null && response.ordinaryUsageAllowed !== undefined) return false;
  if (snapshots.some((snapshot) => snapshot.rateLimitReachedType !== null && snapshot.rateLimitReachedType !== undefined)) return false;
  if (response.ordinaryUsageAllowed === true) return true;
  // Unavailable verdict: accept only an explicit set of snapshots that all say "not reached".
  return snapshots.length > 0;
}

/** Earliest future reset (epoch ms) found anywhere in a rate-limit response, or null. */
function earliestResetMs(response, now) {
  let best = null;
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    const ms = parseResetsAt(value.resetsAt);
    if (ms !== null && ms > now && (best === null || ms < best)) best = ms;
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(response, 0);
  return best;
}

const PROFILE_CACHE_MS = 60_000;

function createBudgetWatcher({
  listPausedRuns,
  readRateLimits,
  resumeRun,
  models = [],
  clock = REAL_CLOCK,
  intervalMs = 300_000,
  marginMs = 60_000,
  minRetryMs = 600_000,
  maxBackoffMs = 3_600_000,
  onState,
  // Optional automatic account switching: { profiles, switchTo(name|null), readProfileLimits(home|null), canSwitch?(runId) }.
  accounts = null,
} = {}) {
  const c = { ...REAL_CLOCK, ...clock };
  const entries = new Map();
  // Survives forget() so that a quick re-pause after an automatic resume can be detected.
  const history = new Map();
  let started = false;
  let stopped = false;

  function emit(runId, state, extra) {
    try { onState?.(runId, state, extra); } catch (_) { /* observers must not break the watcher */ }
  }

  function clearEntryTimer(entry) {
    if (entry?.timer) {
      c.clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function schedule(runId, entry, delayMs) {
    clearEntryTimer(entry);
    const delay = Math.min(Math.max(0, delayMs), MAX_TIMER_MS);
    entry.nextCheckAt = c.now() + delay;
    entry.timer = c.setTimeout(() => { entry.timer = null; check(runId, entry); }, delay);
    entry.timer?.unref?.();
    emit(runId, 'scheduled', { nextCheckAt: entry.nextCheckAt });
  }

  function recheckDelay(runId) {
    return Math.max(intervalMs, history.get(runId)?.backoffMs || 0);
  }

  // Short-lived per-account limit cache: several paused runs must not spawn a server each per check.
  const profileCache = new Map();

  async function readProfile(home) {
    const key = home || '';
    const cached = profileCache.get(key);
    if (cached && c.now() - cached.at < PROFILE_CACHE_MS) return cached.response;
    let response = null;
    try { response = await accounts.readProfileLimits(home); } catch (_) { response = null; }
    profileCache.set(key, { at: c.now(), response });
    return response;
  }

  /**
   * Looks for another account with budget (profiles in order, then the system account) and switches to
   * the first one. Returns { switched, earliestReset } where earliestReset is the soonest known reset.
   */
  async function switchToAvailable(runId, entry) {
    const result = { switched: false, earliestReset: null };
    let state;
    try { state = accounts.profiles.read(); } catch (_) { return result; }
    if (!state?.autoSwitch) return result;
    if (accounts.canSwitch && !(await accounts.canSwitch(runId))) return result;
    if (stopped || entries.get(runId) !== entry) return result;
    const from = state.active;
    const candidates = state.profiles.filter((profile) => profile.name !== from)
      .map((profile) => ({ name: profile.name, home: profile.home }));
    if (from !== null) candidates.push({ name: null, home: null });
    for (const candidate of candidates) {
      const response = await readProfile(candidate.home);
      if (stopped || entries.get(runId) !== entry) return result;
      if (isBudgetAvailable(response, models)) {
        try {
          accounts.profiles.setActive(candidate.name);
          await accounts.switchTo(candidate.name);
        } catch (_) {
          return result;
        }
        const record = history.get(runId) || { backoffMs: 0 };
        record.lastSwitch = { from, to: candidate.name, at: c.now() };
        history.set(runId, record);
        result.switched = true;
        return result;
      }
      const reset = earliestResetMs(response, c.now());
      if (reset !== null && (result.earliestReset === null || reset < result.earliestReset)) result.earliestReset = reset;
    }
    return result;
  }

  async function check(runId, entry) {
    if (stopped || entries.get(runId) !== entry) return;
    entry.lastCheckAt = c.now();
    let response = null;
    try { response = await readRateLimits(); } catch (_) { response = null; }
    if (stopped || entries.get(runId) !== entry) return;
    if (!isBudgetAvailable(response, models)) {
      let delay = recheckDelay(runId);
      if (accounts) {
        const outcome = await switchToAvailable(runId, entry);
        if (stopped || entries.get(runId) !== entry) return;
        if (!outcome.switched) {
          let reset = earliestResetMs(response, c.now());
          if (outcome.earliestReset !== null && (reset === null || outcome.earliestReset < reset)) reset = outcome.earliestReset;
          if (reset !== null) delay = Math.min(delay, reset + marginMs - c.now());
          schedule(runId, entry, delay);
          return;
        }
      } else {
        schedule(runId, entry, delay);
        return;
      }
    }
    // Recorded before the send: the resume itself makes the server call forget(runId).
    const record = history.get(runId) || { backoffMs: 0 };
    const previousResumedAt = record.resumedAt;
    record.resumedAt = c.now();
    history.set(runId, record);
    let outcome;
    try { outcome = await resumeRun(runId); } catch (_) { outcome = undefined; }
    if (outcome === undefined || outcome === false) record.resumedAt = previousResumedAt;
    if (stopped) return;
    if (outcome === undefined) {
      // The resume failed; keep waiting and try again later.
      if (entries.get(runId) === entry) schedule(runId, entry, recheckDelay(runId));
      return;
    }
    if (entries.get(runId) === entry) entries.delete(runId);
    emit(runId, outcome === false ? 'skipped' : 'resumed');
  }

  function notePause(runId, pause) {
    if (stopped || !runId) return;
    if (pause && pause.kind && pause.kind !== 'waiting_for_budget') return;
    const existing = entries.get(runId);
    if (existing) clearEntryTimer(existing);
    const now = c.now();
    const record = history.get(runId);
    if (record?.resumedAt !== undefined) {
      if (now - record.resumedAt < minRetryMs) {
        record.backoffMs = Math.min(maxBackoffMs, (record.backoffMs || intervalMs) * 2);
      } else {
        record.backoffMs = 0;
      }
      record.resumedAt = undefined;
    }
    const entry = { pause: pause || null, timer: null, nextCheckAt: null, lastCheckAt: null };
    entries.set(runId, entry);
    const resetsAtMs = parseResetsAt(pause?.resetsAt);
    const base = resetsAtMs !== null && resetsAtMs > now ? resetsAtMs + marginMs - now : intervalMs;
    schedule(runId, entry, Math.max(base, record?.backoffMs || 0));
  }

  function forget(runId, { dropHistory = false } = {}) {
    const entry = entries.get(runId);
    if (entry) {
      clearEntryTimer(entry);
      entries.delete(runId);
      emit(runId, 'forgotten');
    }
    if (dropHistory) history.delete(runId);
  }

  async function start() {
    if (started) return;
    started = true;
    stopped = false;
    let paused = [];
    try { paused = (await listPausedRuns?.()) || []; } catch (_) { paused = []; }
    if (stopped) return;
    for (const item of paused) notePause(item.runId, item.pause);
  }

  function stop() {
    stopped = true;
    started = false;
    for (const entry of entries.values()) clearEntryTimer(entry);
    entries.clear();
  }

  function accountsAutoSwitch() {
    if (!accounts) return false;
    try { return accounts.profiles.read().autoSwitch === true; } catch (_) { return false; }
  }

  function status(runId) {
    const entry = entries.get(runId);
    if (!entry) return null;
    return {
      state: 'waiting',
      nextCheckAt: entry.nextCheckAt,
      lastCheckAt: entry.lastCheckAt,
      backoffMs: history.get(runId)?.backoffMs || 0,
      autoSwitch: accountsAutoSwitch(),
      lastSwitch: history.get(runId)?.lastSwitch || null,
    };
  }

  return { start, stop, notePause, forget, status };
}

module.exports = { createBudgetWatcher, isBudgetAvailable, parseResetsAt };
