'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { createDashboardAuth, cookieName } = require('../src/dashboard-auth');

async function harness({ db = new Database(':memory:'), clock = { t: 1_000_000 }, random } = {}) {
  let port = 0;
  const auth = createDashboardAuth({ db, getPort: () => port, now: () => clock.t, ...(random ? { random } : {}) });
  const app = express();
  app.use(auth.securityHeaders);
  app.use('/api/dashboard/v1', auth.noStore, auth.sessionRouter());
  app.get('/api/dashboard/v1/ping', auth.hostGuard, auth.noStore, auth.requireSession, (req, res) => res.json({ ok: true }));
  app.post('/api/dashboard/v1/pairing-codes', auth.pairingCodeHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
  function request(method, path, { headers = {}, body, host, origin = `http://127.0.0.1:${port}` } = {}) {
    return new Promise((resolve, reject) => {
      const h = { host: host || `127.0.0.1:${port}`, ...headers };
      if (method !== 'GET' && origin) h.origin = origin;
      let payload;
      if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
      const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  async function login(code) {
    const res = await request('POST', '/api/dashboard/v1/session', { body: { code } });
    const cookie = (res.headers['set-cookie'] || [])[0];
    return { res, cookie: cookie && cookie.split(';')[0] };
  }
  return { auth, db, clock, server, request, login, close: () => new Promise((r) => server.close(r)) };
}

test('pairing code is single use and sets a hardened cookie', async (t) => {
  const h = await harness(); t.after(h.close);
  const { code } = h.auth.issuePairingCode();
  const first = await h.login(code);
  assert.equal(first.res.status, 204);
  const setCookie = first.res.headers['set-cookie'][0];
  assert.ok(setCookie.startsWith(`${cookieName(h.server.address().port)}=`));
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=604800']) assert.ok(setCookie.includes(attr), attr);
  assert.ok(!/secure/i.test(setCookie));
  assert.equal((await h.login(code)).res.status, 401);
  const ping = await h.request('GET', '/api/dashboard/v1/ping', { headers: { cookie: first.cookie } });
  assert.equal(ping.status, 200);
  assert.equal(ping.headers['cache-control'], 'no-store');
  assert.match(ping.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(ping.headers['x-content-type-options'], 'nosniff');
});

test('requests without a valid session get 401 with the error shape', async (t) => {
  const h = await harness(); t.after(h.close);
  const res = await h.request('GET', '/api/dashboard/v1/ping');
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'unauthorized');
  assert.ok(res.json.error.requestId);
  assert.equal((await h.request('GET', '/api/dashboard/v1/ping', { headers: { cookie: `${cookieName(h.server.address().port)}=bogus` } })).status, 401);
});

test('pairing code expires after 10 minutes', async (t) => {
  const h = await harness(); t.after(h.close);
  const { code, expiresAt } = h.auth.issuePairingCode();
  assert.equal(expiresAt, h.clock.t + 600000);
  h.clock.t += 600001;
  const { res } = await h.login(code);
  assert.equal(res.status, 401);
  assert.ok(!res.text.includes(code));
});

test('only 5 outstanding codes; the oldest is evicted', async (t) => {
  const h = await harness(); t.after(h.close);
  const codes = Array.from({ length: 6 }, () => h.auth.issuePairingCode().code);
  assert.equal((await h.login(codes[0])).res.status, 401);
  assert.equal((await h.login(codes[5])).res.status, 204);
  assert.equal((await h.login(codes[1])).res.status, 204);
});

test('session survives a restart and expires after 7 days', async (t) => {
  const h = await harness(); t.after(h.close);
  const { cookie: first } = await h.login(h.auth.issuePairingCode().code);
  const h2 = await harness({ db: h.db, clock: h.clock }); t.after(h2.close);
  // The restarted server may listen on another port, so the cookie name follows it.
  const cookie = `${cookieName(h2.server.address().port)}=${first.split('=')[1]}`;
  assert.equal((await h2.request('GET', '/api/dashboard/v1/ping', { headers: { cookie } })).status, 200);
  h.clock.t += 7 * 24 * 3600 * 1000 + 1;
  assert.equal((await h2.request('GET', '/api/dashboard/v1/ping', { headers: { cookie } })).status, 401);
  h2.auth.ensureSchema();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM dashboard_sessions').get().n, 0);
});

test('bad Host is rejected, localhost is accepted', async (t) => {
  const h = await harness(); t.after(h.close);
  const port = h.server.address().port;
  const bad = await h.request('GET', '/api/dashboard/v1/ping', { host: `evil.example:${port}` });
  assert.equal(bad.status, 403);
  assert.equal(bad.json.error.code, 'forbidden');
  const code = h.auth.issuePairingCode().code;
  const res = await h.request('POST', '/api/dashboard/v1/session', { host: `evil.example:${port}`, body: { code } });
  assert.equal(res.status, 403);
  const ok = await h.request('POST', '/api/dashboard/v1/session', { host: `localhost:${port}`, origin: `http://localhost:${port}`, body: { code } });
  assert.equal(ok.status, 204);
});

test('missing or foreign Origin on POST is rejected', async (t) => {
  const h = await harness(); t.after(h.close);
  const code = h.auth.issuePairingCode().code;
  assert.equal((await h.request('POST', '/api/dashboard/v1/session', { origin: null, body: { code } })).status, 403);
  assert.equal((await h.request('POST', '/api/dashboard/v1/session', { origin: 'http://evil.example', body: { code } })).status, 403);
  assert.equal((await h.login(code)).res.status, 204);
});

test('invalid bodies give invalid_request', async (t) => {
  const h = await harness(); t.after(h.close);
  const res = await h.request('POST', '/api/dashboard/v1/session', { body: { nope: 1 } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid_request');
});

test('session exchange is rate limited to 10 attempts per rolling minute', async (t) => {
  const h = await harness(); t.after(h.close);
  for (let i = 0; i < 10; i += 1) assert.equal((await h.login('wrong')).res.status, 401);
  const limited = await h.login(h.auth.issuePairingCode().code);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.res.json.error.code, 'rate_limited');
  h.clock.t += 60001;
  assert.equal((await h.login(h.auth.issuePairingCode().code)).res.status, 204);
});

test('DELETE revokes the current session and clears the cookie', async (t) => {
  const h = await harness(); t.after(h.close);
  const { cookie } = await h.login(h.auth.issuePairingCode().code);
  const del = await h.request('DELETE', '/api/dashboard/v1/session', { headers: { cookie } });
  assert.equal(del.status, 204);
  assert.match(del.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await h.request('GET', '/api/dashboard/v1/ping', { headers: { cookie } })).status, 401);
  assert.equal((await h.request('DELETE', '/api/dashboard/v1/session')).status, 401);
});

test('only hashes are stored, never raw tokens', async (t) => {
  const h = await harness(); t.after(h.close);
  const { cookie } = await h.login(h.auth.issuePairingCode().code);
  const token = cookie.split('=')[1];
  const rows = h.db.prepare('SELECT * FROM dashboard_sessions').all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(token));
  assert.equal(rows[0].session_hash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('pairing handler returns code, expiry and url', async (t) => {
  const h = await harness(); t.after(h.close);
  const res = await h.request('POST', '/api/dashboard/v1/pairing-codes');
  assert.equal(res.status, 200);
  const port = h.server.address().port;
  assert.equal(res.json.url, `http://127.0.0.1:${port}/dashboard/#pair=${res.json.code}`);
  assert.equal((await h.login(res.json.code)).res.status, 204);
});

test('a session cookie minted for another port is rejected', async (t) => {
  const h = await harness(); t.after(h.close);
  const { cookie } = await h.login(h.auth.issuePairingCode().code);
  const port = h.server.address().port;
  const token = cookie.split('=')[1];
  assert.equal((await h.request('GET', '/api/dashboard/v1/ping', { headers: { cookie } })).status, 200);
  const foreign = `${cookieName(port + 1)}=${token}`;
  assert.equal((await h.request('GET', '/api/dashboard/v1/ping', { headers: { cookie: foreign } })).status, 401);
  assert.equal((await h.request('GET', '/api/dashboard/v1/ping', { headers: { cookie: `cacp_session=${token}` } })).status, 401);
});
