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
  app.post('/api/dashboard/v1/tickets', auth.hostGuard, auth.originGuard, (req, res) => res.status(204).end());
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
  assert.equal(ping.headers['referrer-policy'], 'same-origin');
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
  const port = h.server.address().port;
  const code = h.auth.issuePairingCode().code;
  const missing = await h.request('POST', '/api/dashboard/v1/session', { origin: null, body: { code } });
  assert.equal(missing.status, 403);
  assert.equal(missing.json.error.code, 'forbidden');
  assert.match(missing.json.error.message, /received: missing/);
  assert.match(missing.json.error.message, new RegExp(`expected: http://127\\.0\\.0\\.1:${port} or http://localhost:${port}`));

  const opaque = await h.request('POST', '/api/dashboard/v1/session', { origin: 'null', body: { code } });
  assert.equal(opaque.status, 403);
  assert.match(opaque.json.error.message, /received: null/);

  const foreign = await h.request('POST', '/api/dashboard/v1/session', {
    origin: 'http://user:password@evil.example/private?token=secret#fragment', body: { code },
  });
  assert.equal(foreign.status, 403);
  assert.match(foreign.json.error.message, /received: http:\/\/evil\.example;/);
  assert.ok(!/user|password|private|token|secret|fragment/.test(foreign.json.error.message));

  const oversized = await h.request('POST', '/api/dashboard/v1/session', { origin: `http://${'x'.repeat(9000)}`, body: { code } });
  assert.equal(oversized.status, 403);
  assert.match(oversized.json.error.message, /received: unparseable/);
  assert.ok(oversized.json.error.message.length < 300);
  assert.equal((await h.login(code)).res.status, 204);
});

test('portless Origin requires matching same-origin fetch metadata and Referer', async (t) => {
  const h = await harness(); t.after(h.close);
  const port = h.server.address().port;
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const host = `${hostname}:${port}`;
    const code = h.auth.issuePairingCode().code;
    const headers = { 'sec-fetch-site': 'same-origin', referer: `http://${host}/dashboard/` };
    const login = await h.request('POST', '/api/dashboard/v1/session', {
      host, origin: `http://${hostname}`, headers, body: { code },
    });
    assert.equal(login.status, 204, hostname);

    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const deletion = await h.request('DELETE', '/api/dashboard/v1/session', {
      host, origin: `http://${hostname}`, headers: { ...headers, cookie },
    });
    assert.equal(deletion.status, 204, `${hostname} DELETE`);

    const ticketMutation = await h.request('POST', '/api/dashboard/v1/tickets', {
      host, origin: `http://${hostname}`, headers,
    });
    assert.equal(ticketMutation.status, 204, `${hostname} ticket mutation`);
  }
});

test('portless Origin rejects incomplete or mismatched same-origin evidence', async (t) => {
  const h = await harness(); t.after(h.close);
  const port = h.server.address().port;
  const code = h.auth.issuePairingCode().code;
  const origin = 'http://127.0.0.1';
  const referer = `http://127.0.0.1:${port}/dashboard/`;
  const otherPort = port === 65535 ? port - 1 : port + 1;
  const attempts = [
    { name: 'missing fetch metadata', headers: { referer } },
    { name: 'cross-site', headers: { referer, 'sec-fetch-site': 'cross-site' } },
    { name: 'same-site', headers: { referer, 'sec-fetch-site': 'same-site' } },
    { name: 'none', headers: { referer, 'sec-fetch-site': 'none' } },
    { name: 'missing Referer', headers: { 'sec-fetch-site': 'same-origin' } },
    { name: 'malformed Referer', headers: { referer: '/dashboard/', 'sec-fetch-site': 'same-origin' } },
    { name: 'foreign Referer', headers: { referer: 'http://evil.example/path', 'sec-fetch-site': 'same-origin' } },
    { name: 'different-port Referer', headers: { referer: 'http://127.0.0.1:3001/dashboard/', 'sec-fetch-site': 'same-origin' } },
    { name: 'credentialed Referer', headers: { referer: `http://user:pass@127.0.0.1:${port}/dashboard/`, 'sec-fetch-site': 'same-origin' } },
    { name: 'oversized Referer', headers: { referer: `http://127.0.0.1:${port}/${'x'.repeat(3000)}`, 'sec-fetch-site': 'same-origin' } },
    { name: 'malformed fetch metadata', headers: { referer, 'sec-fetch-site': 'same-origin, cross-site' } },
    { name: 'cross-host Origin', host: `localhost:${port}`, origin: 'http://127.0.0.1', headers: { referer: `http://localhost:${port}/dashboard/`, 'sec-fetch-site': 'same-origin' } },
    { name: 'explicit foreign port', origin: `http://127.0.0.1:${otherPort}`, headers: { referer, 'sec-fetch-site': 'same-origin' } },
  ];
  for (const attempt of attempts) {
    const response = await h.request('POST', '/api/dashboard/v1/session', {
      host: attempt.host, origin: attempt.origin || origin, headers: attempt.headers, body: { code },
    });
    assert.equal(response.status, 403, attempt.name);
    assert.equal(response.json.error.code, 'forbidden', attempt.name);
  }
  const diagnostic = await h.request('POST', '/api/dashboard/v1/session', {
    origin, headers: { referer: `http://user:secret@evil.example/path?token=secret`, 'sec-fetch-site': 'other-value' }, body: { code },
  });
  assert.match(diagnostic.json.error.message, /referer: http:\/\/evil\.example/);
  assert.match(diagnostic.json.error.message, /sec-fetch-site: other/);
  assert.ok(!/user|secret|token|path/.test(diagnostic.json.error.message));
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
