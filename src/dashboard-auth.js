'use strict';

const crypto = require('node:crypto');
const express = require('express');

const COOKIE_PREFIX = 'cacp_session_';

// Per-port name so instances on different loopback ports do not share (cookies ignore ports).
const cookieName = (port) => `${COOKIE_PREFIX}${port}`;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_CODES = 5;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
  + "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; "
  + "base-uri 'none'; form-action 'self'";

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function sendError(res, status, code, message, random) {
  res.status(status).json({ error: { code, message, requestId: random(6).toString('hex') } });
}

function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

function createDashboardAuth({ db, getPort, now = () => Date.now(), random = crypto.randomBytes } = {}) {
  if (!db) throw new TypeError('createDashboardAuth requires a db');
  if (typeof getPort !== 'function') throw new TypeError('createDashboardAuth requires getPort');

  // Outstanding pairing codes: sha256 hex -> expiresAt (ms). Map keeps insertion order (oldest first).
  const pairingCodes = new Map();
  let attempts = [];

  function fail(res, status, code, message) {
    sendError(res, status, code, message, random);
  }

  function ensureSchema() {
    db.exec(`CREATE TABLE IF NOT EXISTS dashboard_sessions (
      session_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`);
    db.prepare('DELETE FROM dashboard_sessions WHERE expires_at <= ?').run(new Date(now()).toISOString());
  }

  function purgeCodes() {
    const current = now();
    for (const [hash, expiresAt] of pairingCodes) if (expiresAt <= current) pairingCodes.delete(hash);
  }

  function issuePairingCode() {
    purgeCodes();
    const code = random(32).toString('base64url');
    const expiresAt = now() + PAIRING_TTL_MS;
    pairingCodes.set(sha256(code).toString('hex'), expiresAt);
    while (pairingCodes.size > MAX_PAIRING_CODES) pairingCodes.delete(pairingCodes.keys().next().value);
    return { code, expiresAt };
  }

  function pairingUrl(code) {
    return `http://127.0.0.1:${getPort()}/dashboard/#pair=${code}`;
  }

  function consumeCode(code) {
    purgeCodes();
    if (typeof code !== 'string' || !TOKEN_PATTERN.test(code)) return false;
    const hash = sha256(code).toString('hex');
    if (!pairingCodes.has(hash)) return false;
    pairingCodes.delete(hash);
    return true;
  }

  function hostGuard(req, res, next) {
    const port = getPort();
    const host = req.headers.host;
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return next();
    return fail(res, 403, 'forbidden', 'Host not allowed');
  }

  function originGuard(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const port = getPort();
    const origin = req.headers.origin;
    if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return next();
    return fail(res, 403, 'forbidden', 'Origin not allowed');
  }

  function sessionFromRequest(req) {
    const token = parseCookies(req.headers.cookie)[cookieName(getPort())];
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const hash = sha256(token).toString('hex');
    const row = db.prepare('SELECT session_hash, expires_at FROM dashboard_sessions WHERE session_hash = ?').get(hash);
    if (!row || Date.parse(row.expires_at) <= now()) return null;
    return { hash };
  }

  function requireSession(req, res, next) {
    const session = sessionFromRequest(req);
    if (!session) return fail(res, 401, 'unauthorized', 'Dashboard session required');
    db.prepare('UPDATE dashboard_sessions SET last_seen_at = ? WHERE session_hash = ?')
      .run(new Date(now()).toISOString(), session.hash);
    req.dashboardSession = session;
    return next();
  }

  function rateLimited() {
    const current = now();
    attempts = attempts.filter((at) => current - at < RATE_LIMIT_WINDOW_MS);
    if (attempts.length >= RATE_LIMIT_ATTEMPTS) return true;
    attempts.push(current);
    return false;
  }

  function cookieHeader(value, maxAgeSeconds) {
    return `${cookieName(getPort())}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  function sessionRouter() {
    const router = express.Router();
    router.use(hostGuard, originGuard);
    router.use(express.json({ limit: '1kb' }));

    router.post('/session', (req, res) => {
      if (rateLimited()) return fail(res, 429, 'rate_limited', 'Too many attempts');
      const code = req.body && typeof req.body === 'object' ? req.body.code : undefined;
      if (typeof code !== 'string') return fail(res, 400, 'invalid_request', 'A pairing code is required');
      if (!consumeCode(code)) return fail(res, 401, 'unauthorized', 'Invalid or expired pairing code');
      const token = random(32).toString('base64url');
      const created = now();
      db.prepare('INSERT INTO dashboard_sessions (session_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(sha256(token).toString('hex'), new Date(created).toISOString(),
          new Date(created + SESSION_TTL_MS).toISOString(), new Date(created).toISOString());
      res.set('Set-Cookie', cookieHeader(token, SESSION_TTL_MS / 1000));
      return res.status(204).end();
    });

    router.delete('/session', requireSession, (req, res) => {
      db.prepare('DELETE FROM dashboard_sessions WHERE session_hash = ?').run(req.dashboardSession.hash);
      res.set('Set-Cookie', cookieHeader('', 0));
      return res.status(204).end();
    });

    // Malformed or oversized JSON bodies: generic error, never echo the body.
    router.use((error, req, res, next) => {
      if (res.headersSent) return next(error);
      return fail(res, 400, 'invalid_request', 'Invalid request body');
    });
    return router;
  }

  // Mount behind the existing A2A bearer middleware (and hostGuard/originGuard), never the session cookie.
  function pairingCodeHandler(req, res) {
    const { code, expiresAt } = issuePairingCode();
    res.json({ code, expiresAt, url: pairingUrl(code) });
  }

  function securityHeaders(req, res, next) {
    res.set('Content-Security-Policy', CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  }

  function noStore(req, res, next) {
    res.set('Cache-Control', 'no-store');
    next();
  }

  ensureSchema();

  return {
    ensureSchema, issuePairingCode, pairingUrl, hostGuard, originGuard, requireSession,
    sessionRouter, pairingCodeHandler, securityHeaders, noStore,
  };
}

module.exports = { createDashboardAuth, cookieName, CSP };
