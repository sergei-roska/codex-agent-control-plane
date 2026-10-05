'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const express = require('express');
const { createBrowserOpener, launcherOriginAllowed, launcherTokenMatches, parseHost, startLauncher } = require('../src/launcher-server');

function request(headers) { return { get: (name) => headers[name.toLowerCase()] }; }

test('accepts only validated loopback host and same-origin launcher mutations', () => {
  const port = 3100;
  const valid = request({
    host: '127.0.0.1:3100',
    origin: 'http://127.0.0.1:3100',
  });
  assert.equal(launcherOriginAllowed(valid, port), true);
  assert.equal(launcherOriginAllowed(request({ host: '127.0.0.1:3200', origin: 'http://127.0.0.1:3100' }), port), false);
  assert.equal(launcherOriginAllowed(request({ host: '127.0.0.1:3100', origin: 'null' }), port), false);
  assert.equal(launcherOriginAllowed(request({ host: '127.0.0.1:3100' }), port), false);
  assert.equal(launcherOriginAllowed(request({ host: 'evil.example:3100', origin: 'http://evil.example:3100' }), port), false);
  assert.deepEqual(parseHost('127.0.0.1:3100'), { hostname: '127.0.0.1', port: 3100 });
  assert.equal(parseHost('127.0.0.1:3100.evil.example'), null);
});

test('accepts a portless loopback Origin only with matching fetch and Referer evidence', () => {
  const base = {
    host: '127.0.0.1:3100',
    origin: 'http://127.0.0.1',
    'sec-fetch-site': 'same-origin',
    referer: 'http://127.0.0.1:3100/',
  };
  assert.equal(launcherOriginAllowed(request(base), 3100), true);
  assert.equal(launcherOriginAllowed(request({ ...base, 'sec-fetch-site': 'same-site' }), 3100), false);
  assert.equal(launcherOriginAllowed(request({ ...base, referer: 'http://127.0.0.1:3101/' }), 3100), false);
  assert.equal(launcherOriginAllowed(request({ ...base, host: '127.0.0.1:3101' }), 3100), false);
});

test('requires the process token and compares it in constant time', () => {
  assert.equal(launcherTokenMatches('random-process-token', 'random-process-token'), true);
  assert.equal(launcherTokenMatches('random-process-token', 'other'), false);
  assert.equal(launcherTokenMatches('random-process-token', undefined), false);
});

function appRequest(app, { method = 'GET', url = '/', port = 3100, token, origin, body } = {}) {
  const bytes = body === undefined ? null : Buffer.from(body);
  const req = Readable.from(bytes ? [bytes] : []);
  Object.setPrototypeOf(req, express.request);
  req.app = app;
  req.method = method;
  req.url = url;
  req.originalUrl = url;
  req.baseUrl = '';
  req.headers = {
    host: `127.0.0.1:${port}`,
    ...(token ? { 'x-launcher-token': token } : {}),
    ...(origin ? { origin } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}),
  };
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
  req.aborted = false;

  const responseHeaders = new Map();
  const chunks = [];
  let finish;
  const result = new Promise((resolve) => { finish = resolve; });
  const res = Object.create(express.response);
  res.app = app;
  res.req = req;
  res.locals = Object.create(null);
  res.statusCode = 200;
  res.setHeader = (name, value) => { responseHeaders.set(String(name).toLowerCase(), value); return res; };
  res.getHeader = (name) => responseHeaders.get(String(name).toLowerCase());
  res.removeHeader = (name) => responseHeaders.delete(String(name).toLowerCase());
  res.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
  res.end = (chunk) => {
    if (chunk) chunks.push(Buffer.from(chunk));
    finish({ status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8') });
    return res;
  };
  app.handle(req, res);
  return result;
}

test('launcher HTTP API rejects missing, invalid, and foreign credentials then returns a successful start body', async () => {
  const runtime = {
    snapshot: () => ({ status: 'stopped', recentProjects: [] }),
    async start({ projectPath, port }) {
      return { status: 'running', projectPath, port, pairingUrl: `http://127.0.0.1:${port}/dashboard/#pair=${'p'.repeat(43)}` };
    },
    async stop() { return { status: 'stopped' }; },
    async openPairing() { return { pairingUrl: `http://127.0.0.1:3000/dashboard/#pair=${'o'.repeat(43)}` }; },
    async close() {},
  };
  const fakeServer = new EventEmitter();
  fakeServer.address = () => ({ port: 3100 });
  fakeServer.close = (callback) => callback();
  const launcher = startLauncher({ port: 3100, runtime, openBrowser() {}, listenImpl: () => fakeServer });
  const missing = await appRequest(launcher.app, { method: 'POST', url: '/api/launcher/start', origin: launcher.origin, body: '{"projectPath":"/tmp/project","port":3000}' });
  assert.equal(missing.status, 403);
  const invalid = await appRequest(launcher.app, { method: 'POST', url: '/api/launcher/start', origin: launcher.origin, token: 'invalid', body: '{"projectPath":"/tmp/project","port":3000}' });
  assert.equal(invalid.status, 403);
  const foreign = await appRequest(launcher.app, { method: 'POST', url: '/api/launcher/start', origin: 'http://evil.example:3100', token: launcher.token, body: '{"projectPath":"/tmp/project","port":3000}' });
  assert.equal(foreign.status, 403);
  const started = await appRequest(launcher.app, { method: 'POST', url: '/api/launcher/start', origin: launcher.origin, token: launcher.token, body: '{"projectPath":"/tmp/project","port":3000}' });
  assert.equal(started.status, 200);
  const body = JSON.parse(started.text);
  assert.equal(body.status, 'running');
  assert.equal(body.projectPath, '/tmp/project');
  assert.match(body.pairingUrl, /#pair=p{43}$/);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  await launcher.close();
});

test('browser opener passes URL as a single argv value and tolerates a missing command', () => {
  const calls = [];
  const opener = createBrowserOpener({ platform: 'linux', spawnImpl: (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('error', new Error('not installed')));
    return child;
  } });
  opener('http://127.0.0.1:3100/?a=b c');
  assert.equal(calls[0].command, 'xdg-open');
  assert.deepEqual(calls[0].args, ['http://127.0.0.1:3100/?a=b c']);
  assert.equal(calls[0].options.detached, true);
});
