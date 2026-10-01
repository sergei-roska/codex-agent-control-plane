'use strict';

// Model catalog over the installed Codex App Server (model/list). Fails closed: when the catalog
// cannot be read, every selection is rejected with code catalog_unavailable.

const { normalizeEffectiveSettings } = require('./contracts');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 1000;

function toMs(value) {
  const raw = typeof value === 'function' ? value() : value;
  if (raw instanceof Date) return raw.getTime();
  return Number.isFinite(raw) ? raw : Date.now();
}

const str = (value, fallback = null) => (typeof value === 'string' && value ? value : fallback);

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || raw.hidden === true) return null;
  const model = str(raw.model) || str(raw.id);
  if (!model) return null;
  const efforts = [];
  for (const item of Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts : []) {
    const id = typeof item === 'string' ? item : str(item?.reasoningEffort);
    if (id && !efforts.includes(id)) efforts.push(id);
  }
  const serviceTiers = [];
  for (const item of Array.isArray(raw.serviceTiers) ? raw.serviceTiers : []) {
    const id = str(item?.id);
    if (id && !serviceTiers.some((tier) => tier.id === id)) {
      serviceTiers.push({ id, name: str(item.name, id), description: str(item.description, '') });
    }
  }
  return {
    model,
    displayName: str(raw.displayName, model),
    description: str(raw.description, ''),
    isDefault: raw.isDefault === true,
    efforts,
    defaultEffort: str(raw.defaultReasoningEffort),
    serviceTiers,
    defaultServiceTier: str(raw.defaultServiceTier),
    upgrade: str(raw.upgrade),
  };
}

function createModelCatalog({ appServer, now, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!appServer || typeof appServer.listModels !== 'function') throw new TypeError('createModelCatalog requires appServer.listModels');
  let entries = [];
  let fetchedAtMs = null;
  let state = 'unavailable';
  let error = { code: 'catalog_unavailable', message: 'model catalog has not been loaded' };
  let inflight = null;

  const isFresh = () => {
    if (fetchedAtMs === null) return false;
    return toMs(now) - fetchedAtMs < (state === 'ok' ? ttlMs : Math.min(ttlMs, FAILURE_TTL_MS));
  };

  async function load() {
    try {
      const raw = await appServer.listModels();
      const seen = new Set();
      const next = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        const entry = normalizeEntry(item);
        if (entry && !seen.has(entry.model)) { seen.add(entry.model); next.push(entry); }
      }
      entries = next;
      state = 'ok';
      error = null;
    } catch (cause) {
      entries = [];
      state = 'unavailable';
      error = { code: 'catalog_unavailable', message: String(cause?.message || cause).slice(0, 300) };
    }
    fetchedAtMs = toMs(now);
  }

  async function refresh() {
    if (!inflight) inflight = load().finally(() => { inflight = null; });
    await inflight;
    return entries.map((entry) => ({ ...entry }));
  }

  async function list() {
    if (!isFresh()) await refresh();
    return entries.map((entry) => ({ ...entry }));
  }

  function status() {
    return { state, fetchedAt: fetchedAtMs === null ? null : new Date(fetchedAtMs).toISOString(), error: error ? { ...error } : null };
  }

  function find(model) {
    const entry = entries.find((candidate) => candidate.model === model);
    return entry ? { ...entry } : null;
  }

  // Ensures the catalog is loaded, then validates. Returns { ok, errors, selection?, code? }.
  async function validateSelection(selection) {
    await list();
    if (state !== 'ok') {
      return { ok: false, code: 'catalog_unavailable', errors: [{ field: 'catalog', message: error?.message || 'model catalog is unavailable' }] };
    }
    const errors = [];
    const sel = selection && typeof selection === 'object' ? selection : {};
    const entry = typeof sel.model === 'string' && sel.model ? find(sel.model) : null;
    if (typeof sel.model !== 'string' || !sel.model) errors.push({ field: 'model', message: 'model is required' });
    else if (!entry) errors.push({ field: 'model', message: `model "${sel.model}" is not in the catalog` });
    if (typeof sel.effort !== 'string' || !sel.effort) errors.push({ field: 'effort', message: 'effort is required' });
    else if (entry && !entry.efforts.includes(sel.effort)) {
      errors.push({ field: 'effort', message: `effort "${sel.effort}" is not supported by ${entry.model}` });
    }
    let serviceTier = null;
    if (sel.serviceTier !== undefined && sel.serviceTier !== null && sel.serviceTier !== 'default') {
      if (typeof sel.serviceTier !== 'string' || !sel.serviceTier) {
        errors.push({ field: 'serviceTier', message: 'serviceTier must be a string or null' });
      } else if (entry && !entry.serviceTiers.some((tier) => tier.id === sel.serviceTier)) {
        errors.push({ field: 'serviceTier', message: `service tier "${sel.serviceTier}" is not supported by ${entry.model}` });
      } else {
        serviceTier = sel.serviceTier;
      }
    }
    if (errors.length === 0 && !normalizeEffectiveSettings({ model: sel.model, effort: sel.effort, serviceTier })) {
      errors.push({ field: 'model', message: 'selection cannot be pinned (model, effort or serviceTier format is not accepted by the runtime)' });
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, errors: [], selection: { model: sel.model, effort: sel.effort, serviceTier } };
  }

  return { list, refresh, status, find, validateSelection };
}

module.exports = { createModelCatalog, normalizeEntry };
