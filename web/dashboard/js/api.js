// --- DASHBOARD API CLIENT, CONNECTION STATE, PAIRING AND POLLER ---
const API_BASE = '/api/dashboard/v1';
const POLL_INTERVAL_MS = 3000;
const POLL_BACKOFF_MS = 30000;
const POLL_BACKOFF_AFTER_FAILURES = 3;

class ApiError extends Error {
  constructor(status, code, message, requestId, details) {
    super(message);
    this.details = details === undefined ? null : details;
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId || null;
  }
}

// Connection state: connecting | connected | reconnecting | unpaired
const Conn = {
  status: 'connecting',
  lastSuccessAt: null,
  listeners: [],
  subscribe(fn) { this.listeners.push(fn); fn(this); },
  emit() { this.listeners.forEach(fn => fn(this)); },
  success() { this.status = 'connected'; this.lastSuccessAt = Date.now(); this.emit(); },
  failure() { this.status = 'reconnecting'; this.emit(); },
  unpaired(message) { this.status = 'unpaired'; this.emit(); showNotPaired(message); }
};

function buildQuery(params) {
  const usp = new URLSearchParams();
  Object.keys(params || {}).forEach(k => {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  });
  const s = usp.toString();
  return s ? '?' + s : '';
}

async function apiRequest(method, path, opts) {
  const o = opts || {};
  const init = { method, credentials: 'same-origin', signal: o.signal, headers: { Accept: 'application/json' } };
  if (o.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(o.body);
  }
  let res;
  try {
    res = await fetch(API_BASE + path + buildQuery(o.params), init);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Cannot reach the orchestrator');
  }
  let payload = null;
  try { payload = await res.json(); } catch (_) { payload = null; }
  if (!res.ok) {
    const e = payload && payload.error ? payload.error : {};
    const err = new ApiError(res.status, e.code || 'http_' + res.status,
      e.message || ('Request failed with HTTP ' + res.status), e.requestId, e.details);
    if (res.status === 401 && !o.noUnpairedPanel) Conn.unpaired();
    throw err;
  }
  return payload;
}

// Plain-text GET (candidate diff). Errors still arrive as the JSON error envelope.
async function apiGetText(path, opts) {
  const o = opts || {};
  let res;
  try {
    res = await fetch(API_BASE + path + buildQuery(o.params), {
      method: 'GET', credentials: 'same-origin', signal: o.signal, headers: { Accept: 'text/plain' }
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Cannot reach the orchestrator');
  }
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch (_) { payload = null; }
    const e = payload && payload.error ? payload.error : {};
    if (res.status === 401) Conn.unpaired();
    throw new ApiError(res.status, e.code || 'http_' + res.status,
      e.message || ('Request failed with HTTP ' + res.status), e.requestId, e.details);
  }
  return res.text();
}

function apiGet(path, opts) { return apiRequest('GET', path, opts); }
function apiPost(path, body, opts) { return apiRequest('POST', path, Object.assign({}, opts, { body })); }

// Raw-body upload with progress (fetch cannot report upload progress). Resolves with the parsed JSON.
function apiUploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE + '/artifacts');
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Cannot reach the orchestrator'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    xhr.onload = () => {
      let payload = null;
      try { payload = JSON.parse(xhr.responseText); } catch (_) { payload = null; }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(payload); return; }
      const e = payload && payload.error ? payload.error : {};
      if (xhr.status === 401) Conn.unpaired();
      reject(new ApiError(xhr.status, e.code || 'http_' + xhr.status,
        e.message || ('Upload failed with HTTP ' + xhr.status), e.requestId, e.details));
    };
    xhr.send(file);
  });
}

// --- Not-paired panel ---
function showNotPaired(message) {
  const panel = document.getElementById('not-paired-panel');
  if (!panel) return;
  const detail = document.getElementById('not-paired-detail');
  if (detail && message) detail.textContent = message;
  panel.classList.add('open');
  Poller.stop();
}

function hideNotPaired() {
  const panel = document.getElementById('not-paired-panel');
  if (panel) panel.classList.remove('open');
}

// --- Pairing: #pair=<code> in the URL fragment is exchanged for a cookie session ---
async function exchangePairingCode() {
  const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const code = params.get('pair');
  if (!code) return false;
  try {
    await apiRequest('POST', '/session', { body: { code }, noUnpairedPanel: true });
    hideNotPaired();
    return true;
  } catch (err) {
    Conn.unpaired('Pairing failed: ' + err.message + '. Request a new code.');
    return false;
  } finally {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// Pasting a pairing URL into an already-open dashboard tab only changes the fragment.
window.addEventListener('hashchange', () => {
  if (!/(^#|&)pair=/.test(location.hash || '')) return;
  const hasPendingOAuth = typeof window.pendingAtlassianOAuthHandle === 'string' && Boolean(window.pendingAtlassianOAuthHandle);
  exchangePairingCode().then(async (paired) => {
    if (hasPendingOAuth && !paired) return;
    if (hasPendingOAuth && typeof window.completePendingAtlassianOAuth === 'function') {
      const complete = await window.completePendingAtlassianOAuth();
      if (!complete) return;
    }
    location.reload();
  });
});

// --- Poller: one task at a time, stale requests aborted ---
const Poller = {
  task: null,
  timer: null,
  controller: null,
  failures: 0,
  stopped: true,

  start(task) {
    if (task) this.task = task;
    this.stopped = false;
    this.trigger();
  },

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.controller) this.controller.abort();
    this.controller = null;
  },

  intervalMs() {
    return this.failures >= POLL_BACKOFF_AFTER_FAILURES ? POLL_BACKOFF_MS : POLL_INTERVAL_MS;
  },

  schedule() {
    clearTimeout(this.timer);
    if (this.stopped || document.visibilityState !== 'visible') return;
    this.timer = setTimeout(() => this.trigger(), this.intervalMs());
  },

  // Run the task now; aborts any in-flight run (used by filter changes and modal open).
  async trigger() {
    if (this.stopped || !this.task) return;
    clearTimeout(this.timer);
    if (this.controller) this.controller.abort();
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.task(controller.signal);
      if (this.controller !== controller) return;
      this.failures = 0;
      Conn.success();
    } catch (err) {
      if (this.controller !== controller) return;
      if (err && err.name === 'AbortError') return;
      if (err instanceof ApiError && err.status === 401) return;
      this.failures += 1;
      Conn.failure();
    }
    if (this.controller === controller) this.schedule();
  }
};

document.addEventListener('visibilitychange', () => {
  if (Poller.stopped) return;
  if (document.visibilityState === 'visible') Poller.trigger();
  else clearTimeout(Poller.timer);
});
