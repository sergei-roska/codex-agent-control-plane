'use strict';

// Runtime egress guard and audit for every Atlassian request. Only the OAuth token POST and
// read-only GETs to the Atlassian API gateway are allowed; anything else is refused before
// the network. Only method, host, pathname and outcome are recorded: query strings, headers
// and bodies carry bearer tokens, client secrets and authorization codes.

const TOKEN_HOST = 'auth.atlassian.com';
const TOKEN_PATH = '/oauth/token';
const API_HOST = 'api.atlassian.com';
const API_GET_PREFIXES = Object.freeze(['/oauth/token/accessible-resources', '/ex/jira/', '/ex/confluence/']);

function parseAllowed(url, method) {
  let parsed;
  try { parsed = new URL(typeof url === 'string' ? url : String(url?.url ?? url)); } catch { return { parsed: null, allowed: false }; }
  const plain = parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.port === '';
  let allowed = false;
  if (plain && method === 'POST') allowed = parsed.hostname === TOKEN_HOST && parsed.pathname === TOKEN_PATH;
  else if (plain && method === 'GET') allowed = parsed.hostname === API_HOST && API_GET_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
  return { parsed, allowed };
}

function createAuditedFetch(baseFetch, { record } = {}) {
  if (typeof baseFetch !== 'function') throw new TypeError('A base fetch function is required');
  const emit = (payload) => { try { record?.(payload); } catch { /* auditing must never break a request */ } };
  return async function auditedFetch(url, init = {}) {
    const method = String(init?.method || 'GET').toUpperCase();
    const { parsed, allowed } = parseAllowed(url, method);
    const base = { method, host: parsed ? parsed.hostname : 'invalid', path: parsed ? parsed.pathname : '' };
    if (!allowed) {
      emit({ ...base, outcome: 'denied' });
      const error = new Error('Atlassian egress denied');
      error.code = 'egress_denied';
      throw error;
    }
    const started = Date.now();
    let response;
    try { response = await baseFetch(url, init); }
    catch (error) {
      emit({ ...base, outcome: 'error', errorName: error?.name || 'Error', durationMs: Date.now() - started });
      throw error;
    }
    emit({ ...base, outcome: 'sent', status: response?.status, durationMs: Date.now() - started });
    return response;
  };
}

module.exports = { createAuditedFetch };
