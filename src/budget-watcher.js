'use strict';

const { createHash } = require('node:crypto');

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

function extractBudgetBlockers(response, { accountIdHash, provider, models } = {}) {
  if (typeof accountIdHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(accountIdHash)) {
    throw new TypeError('budget_wait_account_hash_invalid');
  }
  const validIdentity = (value) => typeof value === 'string'
    && value.length > 0 && value.length <= 128 && !/[\x00-\x20\x7f]/.test(value);
  if (!validIdentity(provider)) throw new TypeError('budget_wait_provider_invalid');
  if (!Array.isArray(models) || models.length === 0
    || models.some((model) => !validIdentity(model)) || new Set(models).size !== models.length) {
    throw new TypeError('budget_wait_models_invalid');
  }

  const byModel = new Map(models.map((model) => [model, []]));
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const snapshots = [];
    if (response.rateLimits && typeof response.rateLimits === 'object' && !Array.isArray(response.rateLimits)) {
      snapshots.push({ snapshot: response.rateLimits, sourceId: 'rate_limit', model: null });
    }
    const byId = response.rateLimitsByLimitId;
    if (byId && typeof byId === 'object' && !Array.isArray(byId)) {
      const entries = Object.entries(byId).sort(([left], [right]) => left.localeCompare(right));
      for (const [key, snapshot] of entries) {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue;
        const model = typeof snapshot.normalModelSlug === 'string' ? snapshot.normalModelSlug : null;
        const sourceId = `limit_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
        snapshots.push({ snapshot, sourceId, model });
      }
    }

    const add = (model, windowId, reasonCode, resetsAt) => {
      const parsed = parseResetsAt(resetsAt);
      const reset = parsed === null ? null : Math.trunc(parsed);
      byModel.get(model).push({ accountIdHash, provider, model, windowId, reasonCode,
        resetsAt: Number.isSafeInteger(reset) && reset >= 0 ? reset : null });
    };
    const reachedForModel = new Set();
    for (const { snapshot, sourceId, model: snapshotModel } of snapshots) {
      if (snapshotModel !== null && !byModel.has(snapshotModel)) continue;
      if (snapshot.rateLimitReachedType === null || snapshot.rateLimitReachedType === undefined
        || snapshot.rateLimitReachedType === '') continue;
      const targetModels = snapshotModel === null ? models : [snapshotModel];
      for (const model of targetModels) {
        reachedForModel.add(model);
        const windows = ['primary', 'secondary'].filter((key) => snapshot[key] && typeof snapshot[key] === 'object'
          && !Array.isArray(snapshot[key]));
        if (windows.length === 0) add(model, sourceId, 'rate_limit_reached', snapshot.resetsAt);
        else for (const key of windows) add(model, `${sourceId}_${key}`, 'rate_limit_reached', snapshot[key].resetsAt);
      }
    }
    if (response.ordinaryUsageAllowed === false) {
      for (const model of models) {
        if (!reachedForModel.has(model)) add(model, 'ordinary_usage', 'ordinary_usage_blocked', null);
      }
    }
  }

  const unique = new Map();
  for (const model of models) {
    for (const blocker of byModel.get(model)) {
      const identity = JSON.stringify([blocker.accountIdHash, blocker.provider, blocker.model, blocker.windowId]);
      if (!unique.has(identity)) unique.set(identity, blocker);
    }
  }
  return [...unique.values()];
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
const PROFILE_CHANGE_DEBOUNCE_MS = 500;

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
  // First check after a pause when automatic account switching is on, whatever the reset hint says.
  switchDelayMs = 3000,
  onState,
  // Optional account recovery: { profiles, switchTo(name|null), readProfileLimits(home|null), readProfileState(home|null),
  // canSwitch?(runId), watch?(onChange) -> unsubscribe }.
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
    // With accounts, a later auto-switch toggle is picked up within one interval, however far the reset is.
    const capped = accounts ? Math.min(delayMs, intervalMs) : delayMs;
    const delay = Math.min(Math.max(0, capped), MAX_TIMER_MS);
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

  async function readProfileState(home, fresh = false) {
    const key = home || '';
    const cached = profileCache.get(key);
    if (!fresh && cached && c.now() - cached.at < PROFILE_CACHE_MS && cached.state) return cached.state;
    let state = null;
    try {
      if (typeof accounts.readProfileState === 'function') state = await accounts.readProfileState(home);
      else state = { limits: await readProfile(home) };
    } catch (_) { state = null; }
    profileCache.set(key, { at: c.now(), response: state?.limits ?? null, state });
    return state;
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
      const accountState = typeof accounts.readProfileState === 'function'
        ? await readProfileState(candidate.home) : null;
      const response = accountState ? accountState.limits : await readProfile(candidate.home);
      if (stopped || entries.get(runId) !== entry) return result;
      if (accountState && accountState.requiresOpenaiAuth !== false) continue;
      if (isBudgetAvailable(response, models)) {
        try {
            const switched = await accounts.switchTo(candidate.name, {
              active: from,
              selectionRevision: state.selectionRevision,
            });
            if (!['switched', 'already_active'].includes(switched)) return result;
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

  async function recoverAuthentication(runId, entry) {
    let state;
    try { state = accounts.profiles.read(); } catch (_) { return false; }
    if (accounts.canSwitch && !(await accounts.canSwitch(runId))) return false;
    if (stopped || entries.get(runId) !== entry) return false;
    const active = state.active;
    const profiles = state.profiles.map((profile) => ({ name: profile.name, home: profile.home }));
    const byName = new Map(profiles.map((profile) => [profile.name, profile]));
    const candidates = [];
    candidates.push(active === null ? { name: null, home: null } : byName.get(active));
    if (state.autoSwitch) {
      for (const profile of profiles) if (profile.name !== active) candidates.push(profile);
      if (active !== null) candidates.push({ name: null, home: null });
    }
    for (const candidate of candidates.filter(Boolean)) {
      const result = await readProfileState(candidate.home, true);
      if (stopped || entries.get(runId) !== entry) return false;
      if (result?.requiresOpenaiAuth !== false || !isBudgetAvailable(result.limits, models)) continue;
      if (typeof accounts.switchTo !== 'function') return false;
      try {
        const switched = await accounts.switchTo(candidate.name, {
          active,
          selectionRevision: state.selectionRevision,
        });
        if (!['switched', 'already_active'].includes(switched)) return false;
      } catch (_) { return false; }
      let selected;
      try { selected = accounts.profiles.read(); } catch (_) { return false; }
      if (selected.active !== candidate.name) return false;
      if (candidate.name !== null
        && selected.profiles.find((profile) => profile.name === candidate.name)?.home !== candidate.home) return false;
      return true;
    }
    return false;
  }

  // One check per entry at a time: a profile-change check must not race a timer check into a double resume.
  async function check(runId, entry) {
    if (entry.checking) return;
    entry.checking = true;
    try { await runCheck(runId, entry); } finally { entry.checking = false; }
  }

  async function runCheck(runId, entry) {
    if (stopped || entries.get(runId) !== entry) return;
    entry.lastCheckAt = c.now();
    if (entry.pause?.kind === 'waiting_for_auth') {
      const recovered = accounts ? await recoverAuthentication(runId, entry) : false;
      if (stopped || entries.get(runId) !== entry) return;
      if (!recovered) { schedule(runId, entry, recheckDelay(runId)); return; }
      return resume(runId, entry);
    }
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
    // Revalidate after all awaited eligibility and account-switch work before sending.
    if (stopped || entries.get(runId) !== entry) return;
    await resume(runId, entry);
  }

  async function resume(runId, entry) {
    const record = history.get(runId) || { backoffMs: 0 };
    const previousResumedAt = record.resumedAt;
    record.resumedAt = c.now();
    history.set(runId, record);
    let outcome;
    try { outcome = await resumeRun(runId, entry.pause?.kind === 'waiting_for_auth' ? 'auth' : 'budget'); } catch (_) { outcome = undefined; }
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
    if (pause && pause.kind && !['waiting_for_budget', 'waiting_for_auth'].includes(pause.kind)) return;
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
    let base = resetsAtMs !== null && resetsAtMs > now ? resetsAtMs + marginMs - now : intervalMs;
    if (pause?.kind === 'waiting_for_auth' || accountsAutoSwitch()) base = switchDelayMs;
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

  // A profiles file change (manual Activate, auto-switch toggled) re-checks every paused run at once.
  let unwatch = null;
  let changeTimer = null;
  function onProfilesChanged() {
    if (stopped) return;
    if (changeTimer) c.clearTimeout(changeTimer);
    changeTimer = c.setTimeout(() => {
      changeTimer = null;
      if (stopped) return;
      for (const [runId, entry] of [...entries]) {
        clearEntryTimer(entry);
        check(runId, entry);
      }
    }, PROFILE_CHANGE_DEBOUNCE_MS);
    changeTimer?.unref?.();
  }

  async function start() {
    if (started) return;
    started = true;
    stopped = false;
    if (typeof accounts?.watch === 'function') {
      try { unwatch = accounts.watch(onProfilesChanged); } catch (_) { unwatch = null; }
    }
    let paused = [];
    try { paused = (await listPausedRuns?.()) || []; } catch (_) { paused = []; }
    if (stopped) return;
    for (const item of paused) notePause(item.runId, item.pause);
  }

  function stop() {
    stopped = true;
    started = false;
    if (changeTimer) { c.clearTimeout(changeTimer); changeTimer = null; }
    if (unwatch) {
      try { unwatch(); } catch (_) { /* best effort */ }
      unwatch = null;
    }
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

module.exports = { createBudgetWatcher, extractBudgetBlockers, isBudgetAvailable, parseResetsAt };
