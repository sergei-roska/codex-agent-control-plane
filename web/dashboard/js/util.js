// --- DOM + FORMAT HELPERS (server strings are untrusted: always textContent) ---
function h(tag, opts, children) {
  const node = document.createElement(tag);
  const o = opts || {};
  if (o.class) node.className = o.class;
  if (o.text !== undefined && o.text !== null) node.textContent = String(o.text);
  if (o.title) node.title = o.title;
  if (o.attrs) Object.keys(o.attrs).forEach(k => node.setAttribute(k, o.attrs[k]));
  if (o.on) Object.keys(o.on).forEach(k => node.addEventListener(k, o.on[k]));
  (children || []).forEach(c => { if (c) node.appendChild(c); });
  return node;
}

function cssToken(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[^A-Za-z0-9_-]/g, '_');
}

function formatAbsTime(iso) {
  if (!iso) return 'unavailable';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function formatClock(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleTimeString();
}

function formatRelative(iso) {
  if (!iso) return 'unknown';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  const min = Math.round(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 48) return hr + 'h ago';
  return Math.round(hr / 24) + 'd ago';
}

function shortTaskId(card) {
  const id = card && card.runtimeTaskRef && card.runtimeTaskRef.taskId;
  return id ? String(id).slice(0, 8) : 'unknown';
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Unknown values render as "unavailable", never as 0.
function formatMaybeNumber(v) {
  return isNumber(v) ? v.toLocaleString() : 'unavailable';
}

function formatMaybeDuration(ms) {
  if (!isNumber(ms)) return 'unavailable';
  if (ms < 1000) return ms + ' ms';
  const s = ms / 1000;
  if (s < 120) return s.toFixed(1) + ' s';
  return (s / 60).toFixed(1) + ' min';
}
