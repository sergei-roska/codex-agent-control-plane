'use strict';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60_000;
const ELIGIBLE_FAILURES = new Set(['rpc_timeout', 'turn_timeout', 'supervisor_exhausted', 'closed', 'service_unavailable']);

function errorInfo(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth <= 5; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) break;
    seen.add(current);
    const info = current.codexError?.codexErrorInfo ?? current.rpcData?.codexErrorInfo;
    if (info !== undefined && info !== null) return info;
    current = current.cause;
  }
  return null;
}

function classifyTransientFailure(error) {
  const info = errorInfo(error);
  if (info === 'usageLimitExceeded' || info === 'quotaExceeded') return { category: 'quota', eligible: false };
  if (info === 'rateLimitExceeded') return { category: 'rate_limit', eligible: true };
  if (error?.failureClass === 'usage_limit') return { category: 'quota', eligible: false };
  if (info === 'unauthorized' || info === 'invalidApiKey' || info === 'authenticationFailed') return { category: 'auth', eligible: false };
  if (info === 'badRequest' || info === 'invalidRequest' || info === 'invalidConfiguration') return { category: 'configuration', eligible: false };
  if (info && typeof info === 'object') {
    const variants = Object.values(info).filter((item) => item && typeof item === 'object');
    if (variants.some((item) => item.httpStatusCode === 401 || item.httpStatusCode === 403)) return { category: 'auth', eligible: false };
    // Untyped HTTP 429 historically enters budget recovery; preserve it unless the provider names rateLimitExceeded.
    if (variants.some((item) => item.httpStatusCode === 429)) return { category: 'quota', eligible: false };
    if (variants.some((item) => [408, 500, 502, 503, 504].includes(item.httpStatusCode))) return { category: 'service', eligible: true };
  }
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/^Selected model is at capacity(?:\. Please try a different model\.)?$/i.test(message.trim())) return { category: 'capacity', eligible: true };
  if (ELIGIBLE_FAILURES.has(error?.failureClass)) return { category: 'transport', eligible: true };
  if (error?.statusCode === 401 || error?.statusCode === 403) return { category: 'auth', eligible: false };
  if (error?.statusCode === 429) return { category: 'rate_limit', eligible: true };
  if ([408, 500, 502, 503, 504].includes(error?.statusCode)) return { category: 'service', eligible: true };
  return { category: 'unknown', eligible: false };
}

function createTransientRecoveryStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS transient_recovery (
    run_id TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER,
    category TEXT NOT NULL,
    cause TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const select = db.prepare('SELECT * FROM transient_recovery WHERE run_id = ?');
  const list = db.prepare('SELECT * FROM transient_recovery ORDER BY next_attempt_at, run_id');
  const upsert = db.prepare(`INSERT INTO transient_recovery
    (run_id, attempts, next_attempt_at, category, cause, checkpoint_id, state, updated_at)
    VALUES (@runId, @attempts, @nextAttemptAt, @category, @cause, @checkpointId, @state, @updatedAt)
    ON CONFLICT(run_id) DO UPDATE SET attempts=excluded.attempts, next_attempt_at=excluded.next_attempt_at,
      category=excluded.category, cause=excluded.cause, checkpoint_id=excluded.checkpoint_id,
      state=excluded.state, updated_at=excluded.updated_at`);
  const remove = db.prepare('DELETE FROM transient_recovery WHERE run_id = ?');
  return {
    get: (runId) => select.get(runId) || null,
    list: () => list.all(),
    put(record) {
      return upsert.run({
        runId: record.runId ?? record.run_id,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt ?? record.next_attempt_at ?? null,
        category: record.category,
        cause: record.cause,
        checkpointId: record.checkpointId ?? record.checkpoint_id,
        state: record.state,
        updatedAt: record.updatedAt ?? record.updated_at,
      });
    },
    delete: (runId) => remove.run(runId),
  };
}

function createTransientRecovery({ store, clock = { now: Date.now, setTimeout, clearTimeout }, random = Math.random,
  maxAttempts = MAX_ATTEMPTS, baseDelayMs = BASE_DELAY_MS, maxDelayMs = MAX_DELAY_MS, resumeRun, canResume, onState }) {
  const timers = new Map();
  const inflight = new Set();
  const attempts = new Set();
  const controllers = new Map();
  const writes = new Set();
  let stopped = false;
  const now = () => clock.now();
  function clearTimer(runId) {
    const timer = timers.get(runId);
    if (timer) clock.clearTimeout(timer);
    timers.delete(runId);
  }
  function notify(record) {
    if (typeof onState !== 'function') return;
    try {
      const pending = Promise.resolve(onState(record.run_id, record));
      writes.add(pending);
      pending.then(() => writes.delete(pending), () => writes.delete(pending));
    } catch (_) { /* status projection must not break recovery */ }
  }
  function backoff(attempt) {
    const ceiling = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
    return Math.floor(ceiling * (0.5 + Math.max(0, Math.min(0.999999, random()))));
  }
  function schedule(record) {
    clearTimer(record.run_id);
    if (record.state !== 'waiting' || record.attempts >= maxAttempts) return;
    const delay = Math.max(0, record.next_attempt_at - now());
    const timer = clock.setTimeout(() => { timers.delete(record.run_id); attempt(record.run_id).catch(() => {}); }, delay);
    timer?.unref?.();
    timers.set(record.run_id, timer);
  }
  function attempt(runId) {
    if (stopped || inflight.has(runId)) return Promise.resolve(false);
    const pending = runAttempt(runId);
    attempts.add(pending);
    pending.then(() => attempts.delete(pending), () => attempts.delete(pending));
    return pending;
  }
  async function runAttempt(runId) {
    if (stopped || inflight.has(runId)) return false;
    if (timers.has(runId)) clearTimer(runId);
    const record = store.get(runId);
    if (!record || record.state !== 'waiting') return false;
    inflight.add(runId);
    const controller = new AbortController();
    controllers.set(runId, controller);
    try {
    let allowed = false;
    try { allowed = await canResume(runId, record); } catch (_) { allowed = false; }
    if (stopped) return false;
    const current = store.get(runId);
    if (!current || current.state !== 'waiting' || current.attempts !== record.attempts
      || current.checkpoint_id !== record.checkpoint_id) return false;
    if (!allowed) {
      store.put({ ...record, state: 'manual', next_attempt_at: null, updated_at: now() });
      notify(store.get(runId));
      return false;
    }
    const next = { ...record, state: 'dispatched', updated_at: now() };
    store.put(next);
    notify(store.get(runId));
    try {
      const outcome = await resumeRun(runId, record, controller.signal);
      if (outcome === false) {
        retryDispatch(next);
      }
      return outcome !== false;
    } catch (_) {
      retryDispatch(next);
      return false;
    }
    } finally {
      if (controllers.get(runId) === controller) controllers.delete(runId);
      inflight.delete(runId);
    }
  }
  function retryDispatch(record) {
    const current = store.get(record.run_id);
    if (stopped || !current || current.state !== 'dispatched' || current.attempts !== record.attempts
      || current.checkpoint_id !== record.checkpoint_id) return;
    const attempts = record.attempts + 1;
    const exhausted = attempts >= maxAttempts;
    const updated = {
      ...record,
      attempts,
      state: exhausted ? 'exhausted' : 'waiting',
      next_attempt_at: exhausted ? null : now() + backoff(attempts),
      updated_at: now(),
    };
    store.put(updated);
    notify(store.get(record.run_id));
    if (!exhausted) schedule(store.get(record.run_id));
  }
  function failure(runId, { category, cause, checkpointId, enabled = true }) {
    const prior = store.get(runId);
    const attempts = (prior?.attempts || 0) + 1;
    const exhausted = attempts >= maxAttempts;
    const nextAttemptAt = enabled && !exhausted ? now() + backoff(attempts) : null;
    const record = {
      runId, run_id: runId, attempts,
      nextAttemptAt,
      next_attempt_at: nextAttemptAt,
      category, cause: String(cause || '').slice(0, 500), checkpointId, checkpoint_id: checkpointId,
      state: exhausted ? 'exhausted' : enabled ? 'waiting' : 'manual', updatedAt: now(), updated_at: now(),
    };
    store.put(record);
    clearTimer(runId);
    notify(store.get(runId));
    if (!exhausted) schedule(store.get(runId));
    return store.get(runId);
  }
  function start() {
    stopped = false;
    for (let record of store.list()) {
      if (record.state === 'dispatched') {
        record = { ...record, state: 'waiting', next_attempt_at: now(), updated_at: now() };
        store.put(record);
        notify(store.get(record.run_id));
      }
      schedule(record);
    }
  }
  function forget(runId) { clearTimer(runId); store.delete(runId); }
  function markRunning(runId) {
    clearTimer(runId);
    const record = store.get(runId);
    if (record) {
      store.put({ ...record, state: 'dispatched', updated_at: now() });
      notify(store.get(runId));
    }
  }
  function pause(runId) {
    clearTimer(runId);
    const record = store.get(runId);
    if (!record || !['waiting', 'dispatched'].includes(record.state)) return false;
    store.put({ ...record, state: 'owner_paused', next_attempt_at: null, updated_at: now() });
    controllers.get(runId)?.abort();
    notify(store.get(runId));
    return true;
  }
  function cancelPauseRequest(runId) {
    const record = store.get(runId);
    if (!record || record.state !== 'owner_paused') return false;
    const updated = { ...record, state: 'waiting', next_attempt_at: now(), updated_at: now() };
    store.put(updated);
    notify(store.get(runId));
    schedule(store.get(runId));
    return true;
  }
  function pausedRuns() { return store.list().filter((record) => ['waiting', 'dispatched', 'owner_paused'].includes(record.state)); }
  function status(runId) { return stopped ? null : store.get(runId); }
  function acceptAutomatic(runId, { attempt: expectedAttempt, checkpointId } = {}) {
    if (stopped) return false;
    const record = store.get(runId);
    return record?.state === 'dispatched'
      && Number.isSafeInteger(expectedAttempt) && expectedAttempt === record.attempts
      && typeof checkpointId === 'string' && checkpointId === record.checkpoint_id;
  }
  function stop() {
    stopped = true;
    for (const runId of timers.keys()) clearTimer(runId);
    for (const controller of controllers.values()) controller.abort();
  }
  async function drain() {
    while (attempts.size || writes.size) {
      await Promise.allSettled([...attempts, ...writes]);
    }
  }
  return { start, stop, failure, forget, markRunning, pause, cancelPauseRequest, pausedRuns, status, acceptAutomatic, attempt, drain };
}

module.exports = { classifyTransientFailure, createTransientRecoveryStore, createTransientRecovery, MAX_ATTEMPTS };
