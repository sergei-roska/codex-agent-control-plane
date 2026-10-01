'use strict';

const { AtlassianOAuthError } = require('./atlassian-oauth');

const MAX_BODY_BYTES = 1024 * 1024;
const REQUIRED_SCOPE = Object.freeze({ jira: 'read:jira-work', confluence: 'read:page:confluence' });

function fail(code) { return new AtlassianOAuthError(code, 'Atlassian read request failed'); }
const SAFE_AUTH_CODES = new Set(['request_timeout', 'redirect_rejected', 'unbounded_response_body', 'response_too_large',
  'upstream_request_failed', 'invalid_upstream_response', 'invalid_resource_response', 'reconnect_required',
  'connection_changed', 'credential_store_failed', 'invalid_saved_credentials', 'invalid_token_response',
  'unexpected_scope', 'required_scope_missing', 'client_configuration_error', 'credential_refresh_failed', 'unauthorized']);
function authFailure(error) {
  return fail(error instanceof AtlassianOAuthError && SAFE_AUTH_CODES.has(error.code) ? error.code : 'authorization_unavailable');
}
function safeHeaderValue(value) { return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value); }
function validId(value) { return (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) || (Number.isSafeInteger(value) && value > 0); }
function validIssue(value) {
  return validId(value) || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,9}-[1-9]\d{0,8}$/.test(value));
}
function siteUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('Invalid configured Atlassian site'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new TypeError('Configured Atlassian site must be an HTTPS site origin');
  }
  return parsed.origin;
}

async function readJson(response, limit, signal) {
  if (response.status >= 300 && response.status < 400) throw fail('redirect_rejected');
  const reader = response.body?.getReader?.();
  let body;
  if (!reader) throw fail('unbounded_response_body');
  else {
    const parts = [];
    let bytes = 0;
    const abort = () => { reader.cancel().catch(() => {}); };
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > limit) { await reader.cancel().catch(() => {}); throw fail('response_too_large'); }
        parts.push(Buffer.from(part.value));
      }
    } finally { signal.removeEventListener('abort', abort); reader.releaseLock?.(); }
    body = Buffer.concat(parts).toString('utf8');
  }
  if (response.status === 401) { const error = fail('reconnect_required'); error.credentialRejected = true; throw error; } // a 401 means the token itself was refused.
  if (!response.ok) throw fail(response.status === 403 ? 'unauthorized' : 'upstream_request_failed'); // 403 is per-document access.
  try { return JSON.parse(body); } catch { throw fail('invalid_upstream_response'); }
}

function createAtlassianReadClient({ oauth, sites, fetchImpl = globalThis.fetch, timeoutMs = 10000, maxResponseBytes = MAX_BODY_BYTES } = {}) {
  if (!oauth || typeof oauth.getAccessToken !== 'function' || typeof oauth.getResources !== 'function' ||
      !Array.isArray(sites) || typeof fetchImpl !== 'function') throw new TypeError('OAuth client, configured sites, and fetch are required');
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(maxResponseBytes) || !Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new TypeError('Invalid request limits');
  const configured = new Map();
  for (const site of sites) {
    if (!site || typeof site.originId !== 'string' || !site.originId || !['jira', 'confluence'].includes(site.sourceKind) ||
        typeof site.cloudId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(site.cloudId)) throw new TypeError('Invalid configured Atlassian site');
    const normalized = { ...site, baseUrl: siteUrl(site.baseUrl) };
    if (configured.has(site.originId)) throw new TypeError('Duplicate configured origin ID');
    configured.set(site.originId, normalized);
  }
  const responseLimit = Math.min(Math.max(maxResponseBytes, 1024), MAX_BODY_BYTES);
  const timeout = Math.min(Math.max(timeoutMs, 100), 60000);

  async function request(originId, path) {
    const site = configured.get(originId);
    if (!site) throw fail('unknown_origin');
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail('request_timeout')); }, timeout);
    });
    const startedRevision = typeof oauth.getConnectionRevision === 'function' ? oauth.getConnectionRevision() : null;
    const ensureCurrent = () => {
      if (controller.signal.aborted) throw fail('request_timeout');
      if (startedRevision !== null && oauth.getConnectionRevision() !== startedRevision) throw fail('connection_changed');
    };
    const awaitStage = async (operation) => Promise.race([Promise.resolve().then(operation), deadline]);
    try {
      let resources;
      try {
        ensureCurrent();
        resources = await awaitStage(() => oauth.getResources({ signal: controller.signal })); // fresh discovery is required for every read.
        ensureCurrent();
      } catch (error) { throw error instanceof AtlassianOAuthError ? authFailure(error) : fail(controller.signal.aborted ? 'request_timeout' : 'authorization_unavailable'); }
      if (!Array.isArray(resources)) throw fail('invalid_resource_response');
      const matching = resources.filter((resource) => resource.id === site.cloudId && typeof resource.url === 'string' &&
        (() => { try { const url = new URL(resource.url); return !url.username && !url.password && !url.search && !url.hash &&
          url.origin === site.baseUrl && url.pathname.replace(/\/$/, '') === ''; } catch { return false; } })());
      const mergedScopes = new Set(matching.flatMap((resource) => Array.isArray(resource.scopes) ? resource.scopes : []));
      if (!matching.length) throw fail('site_not_authorized');
      if (!mergedScopes.has(REQUIRED_SCOPE[site.sourceKind])) throw fail('scope_not_authorized');

      let token;
      try {
        ensureCurrent();
        token = await awaitStage(() => oauth.getAccessToken({ signal: controller.signal }));
        ensureCurrent();
      } catch (error) { throw error instanceof AtlassianOAuthError ? authFailure(error) : fail(controller.signal.aborted ? 'request_timeout' : 'authorization_unavailable'); }
      if (!safeHeaderValue(token)) throw fail('authorization_unavailable');
      const productPath = site.sourceKind === 'jira' ? 'rest/api/3' : 'wiki/api/v2';
      const url = `https://api.atlassian.com/ex/${site.sourceKind}/${encodeURIComponent(site.cloudId)}/${productPath}${path}`;
      const operation = (async () => {
        ensureCurrent();
        const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
        ensureCurrent();
        const value = await readJson(response, responseLimit, controller.signal);
        ensureCurrent();
        return value;
      })();
      try { return await Promise.race([operation, deadline]); }
      catch (error) {
        if (error?.credentialRejected) { try { oauth.markReconnectRequired?.({ revision: startedRevision }); } catch { /* the credential error below still propagates */ } }
        if (error instanceof AtlassianOAuthError) throw authFailure(error);
        throw fail(controller.signal.aborted ? 'request_timeout' : 'upstream_request_failed'); }
    } finally { clearTimeout(timer); }
  }

  function issue(originId, issueIdOrKey) {
    const site = configured.get(originId);
    if (!site || site.sourceKind !== 'jira' || !validIssue(issueIdOrKey)) throw fail('invalid_issue_reference');
    return request(originId, `/issue/${encodeURIComponent(String(issueIdOrKey))}`);
  }
  return Object.freeze({
    getIssue({ originId, issueIdOrKey } = {}) { return issue(originId, issueIdOrKey); },
    getComments({ originId, issueIdOrKey, startAt = 0, maxResults = 50 } = {}) {
      const site = configured.get(originId);
      if (!site || site.sourceKind !== 'jira' || !validIssue(issueIdOrKey) || !Number.isSafeInteger(startAt) || startAt < 0 ||
          !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) throw fail('invalid_comment_query');
      const query = new URLSearchParams({ startAt: String(startAt), maxResults: String(maxResults) });
      return request(originId, `/issue/${encodeURIComponent(String(issueIdOrKey))}/comment?${query}`);
    },
    getRemoteLinks({ originId, issueIdOrKey } = {}) {
      const site = configured.get(originId);
      if (!site || site.sourceKind !== 'jira' || !validIssue(issueIdOrKey)) throw fail('invalid_issue_reference');
      return request(originId, `/issue/${encodeURIComponent(String(issueIdOrKey))}/remotelink`);
    },
    getPage({ originId, pageId } = {}) {
      const site = configured.get(originId);
      if (!site || site.sourceKind !== 'confluence' || !validId(pageId)) throw fail('invalid_page_reference');
      return request(originId, `/pages/${encodeURIComponent(String(pageId))}?body-format=atlas_doc_format`);
    },
  });
}

module.exports = { createAtlassianReadClient };
