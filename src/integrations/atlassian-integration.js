'use strict';

const crypto = require('node:crypto');
const { createAtlassianOAuthClient } = require('./atlassian-oauth');
const { createAtlassianReadClient } = require('./atlassian-read-client');
const { createAtlassianSourceProvider } = require('./atlassian-source-provider');
const { createEncryptedTokenStore } = require('./encrypted-token-store');
const { createOAuthHandoff } = require('./oauth-handoff');
const { collectSourceBundle, bundleToIntakeInput, SourceRootUnavailableError } = require('./source-bundle');

const REQUIRED = Object.freeze({ jira: 'read:jira-work', confluence: 'read:page:confluence' });
const SAFE_CODES = new Set(['reconnect_required', 'credential_store_failed', 'credential_refresh_failed', 'connection_changed',
  'request_timeout', 'unauthorized', 'site_not_authorized', 'scope_not_authorized', 'source_root_unavailable',
  'command_conflict', 'invalid_request', 'stale_version', 'source_unavailable', 'not_found']);

function fail(code = 'source_unavailable') {
  const error = new Error(code === 'invalid_request' ? 'Invalid request' : 'Atlassian source operation failed');
  error.code = code;
  return error;
}
function safeError(error, fallback = 'source_unavailable') {
  const code = error?.code;
  return fail(code === 'invalid_authorization_state' ? 'invalid_state' : (code === 'stale_version' ? 'stale_version' : SAFE_CODES.has(code) ? code : fallback));
}
function validString(value, max = 256) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function validCloudId(value) { return typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value); }
function trustedResource(resource) {
  if (!resource || !validCloudId(resource.id) || !validString(resource.name, 300) || !validString(resource.url, 2048) || !Array.isArray(resource.scopes)) return null;
  let url;
  try { url = new URL(resource.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '') return null;
  const scopes = [...new Set(resource.scopes.filter((scope) => typeof scope === 'string' && /^[a-z0-9:_-]{1,128}$/.test(scope)))];
  return { id: resource.id, url: url.origin, name: resource.name.slice(0, 300), scopes };
}
function originId(cloudId, sourceKind) { return `atl-${sourceKind}-${crypto.createHash('sha256').update(cloudId).digest('hex').slice(0, 32)}`; }
function normalizeRequest(request, fields) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !fields.includes(key)) ||
      fields.some((key) => !Object.hasOwn(request, key))) throw fail('invalid_request');
}

function rootFromSource(source) {
  if (!source || typeof source !== 'object') return null;
  const root = source.root && typeof source.root === 'object' ? source.root : source;
  if (!['jira', 'confluence'].includes(root.sourceKind) || !validString(root.originId) || !validString(root.externalId)) return null;
  return { sourceKind: root.sourceKind, originId: root.originId, externalId: root.externalId };
}

function createAtlassianIntegration({ db, productStore, artifactStore, workspace, config = null, fetchImpl, now = () => Date.now(), oauth: suppliedOAuth, provider: suppliedProvider } = {}) {
  if (!db || !productStore || !artifactStore || typeof workspace !== 'string') throw new TypeError('Atlassian integration dependencies are required');
  db.exec(`CREATE TABLE IF NOT EXISTS m6_atlassian_selected_sites (
    cloud_id TEXT PRIMARY KEY,
    resource_json TEXT NOT NULL,
    selected_at TEXT NOT NULL
  )`);
  let oauth = suppliedOAuth || null;
  let handoff = null;
  const callbackOrigin = typeof config?.callbackOrigin === 'string' ? config.callbackOrigin : (() => {
    try { return config?.redirectUri ? new URL(config.redirectUri).origin : null; } catch { return null; }
  })();
  let disabledReason = null;
  if (!oauth && config) {
    if (!config || typeof config.clientId !== 'string' || typeof config.redirectUri !== 'string' ||
        typeof config.tokenStorePath !== 'string' || typeof config.resolveClientSecret !== 'function' || typeof config.resolveEncryptionKey !== 'function') {
      throw new Error('Atlassian configuration is invalid');
    }
    const bindingId = `atlassian-v1-${crypto.createHash('sha256').update(`${config.clientId}\0${config.redirectUri}\0${workspace}`).digest('hex')}`;
    const tokenStore = createEncryptedTokenStore({ filePath: config.tokenStorePath, workspaceRoot: workspace,
      bindingId, resolveEncryptionKey: config.resolveEncryptionKey });
    oauth = createAtlassianOAuthClient({ clientId: config.clientId, redirectUri: config.redirectUri,
      tokenStore, resolveClientSecret: config.resolveClientSecret, fetchImpl, now });
  }
  if (oauth) {
    handoff = createOAuthHandoff({ oauth, now });
  }
  let generation = 0;

  function selected() {
    const rows = db.prepare('SELECT resource_json FROM m6_atlassian_selected_sites ORDER BY cloud_id').all();
    return rows.map((row) => {
      try { return trustedResource(JSON.parse(row.resource_json)); } catch { return null; }
    }).filter(Boolean);
  }
  function selectedOrigins() {
    return selected().flatMap((resource) => ['jira', 'confluence'].filter((kind) => resource.scopes.includes(REQUIRED[kind])).map((sourceKind) => ({
      originId: originId(resource.id, sourceKind), sourceKind, cloudId: resource.id, baseUrl: resource.url,
    })));
  }
  function assertConfigured() { if (!oauth || !handoff) throw fail('not_configured'); }
  async function freshResources(signal) {
    assertConfigured();
    let resources;
    try { resources = await oauth.getResources({ signal }); } catch (error) { throw safeError(error, 'reconnect_required'); }
    if (!Array.isArray(resources)) throw fail('source_unavailable');
    const trusted = new Map();
    const invalid = new Set();
    for (const raw of resources) {
      const resource = trustedResource(raw);
      if (!resource || invalid.has(raw?.id)) continue;
      const previous = trusted.get(resource.id);
      if (previous && previous.url !== resource.url) { trusted.delete(resource.id); invalid.add(resource.id); continue; }
      if (previous) previous.scopes = [...new Set([...previous.scopes, ...resource.scopes])];
      else trusted.set(resource.id, resource);
    }
    return [...trusted.values()];
  }
  function current(expectedLocal, expectedConnection) {
    if (expectedLocal !== generation || (expectedConnection !== null && typeof oauth?.getConnectionRevision === 'function' && expectedConnection !== oauth.getConnectionRevision())) {
      throw fail('connection_changed');
    }
  }
  function removeArtifact(stored) { try { artifactStore.remove(stored.storageRef); } catch { /* best effort cleanup of this request's unreferenced file */ } }

  async function retrieveBundle({ expectedLocal, expectedConnection, origin, issueIdOrKey, signal }) {
    const check = () => {
      if (signal.aborted) throw fail('request_timeout');
      current(expectedLocal, expectedConnection);
    };
    const scopedFetch = typeof fetchImpl === 'function' ? (url, options = {}) => {
      check();
      const signals = [options.signal, signal].filter(Boolean);
      const combined = signals.length > 1 && typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : (signals[0] || signal);
      return fetchImpl(url, { ...options, signal: combined });
    } : undefined;
    const client = createAtlassianReadClient({ oauth, sites: selectedOrigins(), fetchImpl: scopedFetch });
    const underlying = suppliedProvider || createAtlassianSourceProvider({ client, sites: selectedOrigins() });
    const provider = { async read(ref) { check(); const doc = await underlying.read(ref); check(); return doc; } };
    const bundle = await collectSourceBundle({ provider, root: { sourceKind: 'jira', originId: origin.originId, externalId: issueIdOrKey },
      origins: selectedOrigins(), now: () => new Date(now()) });
    current(expectedLocal, expectedConnection);
    if (signal.aborted) throw fail('request_timeout');
    return bundle;
  }

  async function persistImport({ commandId, originId: sourceOrigin, issueIdOrKey }) {
    if (!validString(commandId, 128) || !/^[A-Za-z0-9_-]{8,100}$/.test(commandId) || !validString(sourceOrigin, 200) ||
        (typeof issueIdOrKey !== 'string' || !/^(?:[1-9]\d{0,19}|[A-Z][A-Z0-9_]{0,9}-[1-9]\d{0,8})$/.test(issueIdOrKey))) throw fail('invalid_request');
    const request = { originId: sourceOrigin, issueIdOrKey };
    const replay = productStore.getSourceCommandResult?.({ commandId, kind: 'source_import', request });
    if (replay) return replay;
    assertConfigured();
    const origin = selectedOrigins().find((item) => item.originId === sourceOrigin && item.sourceKind === 'jira');
    if (!origin) throw fail('site_not_authorized');
    const expectedGeneration = generation;
    const connectionRevision = oauth.getConnectionRevision?.() ?? 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let stored;
    try {
      const operation = retrieveBundle({ expectedLocal: expectedGeneration, expectedConnection: connectionRevision, origin, issueIdOrKey, signal: controller.signal });
      const timeout = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(fail('request_timeout')), { once: true }));
      const bundle = await Promise.race([operation, timeout]);
      current(expectedGeneration, connectionRevision);
      const intake = bundleToIntakeInput(bundle);
      const artifactText = intake.extractedTexts.values().next().value || '';
      stored = artifactStore.store(Buffer.from(artifactText, 'utf8'), 'source-context.txt');
      stored.extractionTruncated = Boolean(intake.artifacts[0]?.extractionTruncated);
      current(expectedGeneration, connectionRevision);
      const result = productStore.importSourceBundle({ commandId, request, bundle, artifact: stored });
      if (!result?.artifactAttached) removeArtifact(stored);
      return result;
    } catch (error) {
      if (stored) removeArtifact(stored);
      if (error instanceof SourceRootUnavailableError) throw fail('source_unavailable');
      throw safeError(error, 'source_unavailable');
    } finally { clearTimeout(timer); }
  }

  async function refresh(ticketId, { commandId, expectedVersion } = {}) {
    if (!validString(ticketId, 128) || !validString(commandId, 128) || !/^[A-Za-z0-9_-]{8,100}$/.test(commandId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw fail('invalid_request');
    const request = { ticketId, expectedVersion };
    const replay = productStore.getSourceCommandResult?.({ commandId, kind: 'source_refresh', request });
    if (replay) return replay;
    assertConfigured();
    const source = productStore.getTicketSource?.(ticketId);
    const root = rootFromSource(source);
    if (!root || root.sourceKind !== 'jira') throw fail('not_found');
    const origin = selectedOrigins().find((item) => item.originId === root.originId && item.sourceKind === 'jira');
    if (!origin) throw fail('site_not_authorized');
    const connectionRevision = oauth.getConnectionRevision?.() ?? 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let stored;
    try {
      const expectedGeneration = generation;
      const operation = retrieveBundle({ expectedLocal: expectedGeneration, expectedConnection: connectionRevision, origin, issueIdOrKey: root.externalId, signal: controller.signal });
      const timeout = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(fail('request_timeout')), { once: true }));
      const bundle = await Promise.race([operation, timeout]);
      current(expectedGeneration, connectionRevision);
      const rootUnavailable = bundle.root?.availability !== 'available';
      let intake = null;
      if (!rootUnavailable) {
        intake = bundleToIntakeInput(bundle);
        const artifactText = intake.extractedTexts.values().next().value || '';
        stored = artifactStore.store(Buffer.from(artifactText, 'utf8'), 'source-context.txt');
        stored.extractionTruncated = Boolean(intake.artifacts[0]?.extractionTruncated);
      }
      current(expectedGeneration, connectionRevision);
      const result = productStore.refreshSourceBundle(ticketId, { commandId, request, bundle, artifact: stored || null, expectedVersion });
      if (!result?.artifactAttached) removeArtifact(stored);
      return result;
    } catch (error) {
      if (stored) removeArtifact(stored);
      throw safeError(error, 'source_unavailable');
    } finally { clearTimeout(timer); }
  }

  async function health() {
    const flatSites = () => selected().flatMap((resource) => ['jira', 'confluence'].filter((kind) => resource.scopes.includes(REQUIRED[kind])).map((sourceKind) => ({
      cloudId: resource.id, name: resource.name, url: resource.url, sourceKind, originId: originId(resource.id, sourceKind),
    })));
    if (!oauth || !handoff) return { configured: false, connected: false, state: disabledReason || 'not_configured', callbackOrigin, selectedSites: flatSites(), readOnly: true };
    const info = await oauth.getHealth();
    return { configured: true, connected: Boolean(info.connected), state: info.connected ? 'connected' : (info.reconnectRequired ? 'reconnect_required' : 'disconnected'), callbackOrigin,
      selectedSites: flatSites(), readOnly: true };
  }
  return Object.freeze({
    health,
    async begin({ sessionId, origin } = {}) {
      assertConfigured();
      if (callbackOrigin && origin !== callbackOrigin) throw fail('invalid_request');
      try { return await handoff.begin({ sessionId }); } catch (error) { throw safeError(error, 'invalid_state'); }
    },
    receiveCallback(input) { assertConfigured(); try { return handoff.receiveCallback(input); } catch (error) { throw safeError(error, 'invalid_state'); } },
    async complete({ sessionId, handle } = {}) {
      assertConfigured();
      try {
        const value = await handoff.complete({ sessionId, handle });
        db.exec('DELETE FROM m6_atlassian_selected_sites');
        generation += 1;
        return value;
      } catch (error) { throw safeError(error, 'invalid_state'); }
    },
    async resources() { const resources = await freshResources(); return { resources: resources.map(({ id, url, name, scopes }) => ({ id, url, name, scopes })) }; },
    async selectSite({ cloudId } = {}) {
      if (!validCloudId(cloudId)) throw fail('invalid_request');
      const expectedLocal = generation;
      const expectedConnection = oauth?.getConnectionRevision?.() ?? null;
      const resource = (await freshResources()).find((item) => item.id === cloudId);
      current(expectedLocal, expectedConnection);
      if (!resource) throw fail('site_not_authorized');
      if (!Object.values(REQUIRED).some((scope) => resource.scopes.includes(scope))) throw fail('scope_not_authorized');
      const selectedAt = new Date(now()).toISOString();
      db.transaction(() => {
        db.prepare('DELETE FROM m6_atlassian_selected_sites').run();
        db.prepare('INSERT INTO m6_atlassian_selected_sites (cloud_id, resource_json, selected_at) VALUES (?, ?, ?)')
          .run(cloudId, JSON.stringify(resource), selectedAt);
      })();
      generation += 1;
      return { sites: (await health()).selectedSites };
    },
    async disconnect({ sessionId } = {}) {
      if (!validString(sessionId, 512)) throw fail('invalid_request');
      assertConfigured();
      db.exec('DELETE FROM m6_atlassian_selected_sites');
      generation += 1;
      try { await handoff.disconnect({ sessionId }); }
      catch { throw fail('source_unavailable'); }
      return { disconnected: true };
    },
    importIssue({ commandId, originId: sourceOrigin, issueIdOrKey } = {}) { return persistImport({ commandId, originId: sourceOrigin, issueIdOrKey }); },
    refreshTicket(ticketId, request) { return refresh(ticketId, request); },
    getTicketSource(ticketId) { return productStore.getTicketSource?.(ticketId); },
    getTicketSourceHistory(ticketId, options) { return productStore.getTicketSourceHistory?.(ticketId, options); },
    getTicketSourceSnapshot(ticketId, snapshotId) { return productStore.getTicketSourceSnapshot?.(ticketId, snapshotId); },
    clear() { try { handoff?.clear(); } catch { /* process shutdown still drops all in-memory handoff state */ } },
  });
}

module.exports = { createAtlassianIntegration, originId, trustedResource };
