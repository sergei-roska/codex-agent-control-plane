'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { LauncherRuntime, DEFAULT_LAUNCHER_PORT } = require('./launcher-runtime');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function parseHost(value) {
  if (typeof value !== 'string' || value.length > 255) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? Number(parsed.port) : null;
    if (!LOOPBACK.has(hostname) || (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))) return null;
    return { hostname, port };
  } catch (_) { return null; }
}

function createToken() { return crypto.randomBytes(32).toString('base64url'); }

function safeEqual(expected, supplied) {
  if (typeof supplied !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function launcherTokenMatches(expected, supplied) { return safeEqual(expected, supplied); }

function launcherOriginAllowed(req, launcherPort) {
  const host = parseHost(req.get('host'));
  if (!host || host.port !== launcherPort) return false;
  const originHeader = req.get('origin');
  if (!originHeader || originHeader === 'null' || originHeader.length > 512) return false;
  let origin;
  try { origin = new URL(originHeader); } catch (_) { return false; }
  if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
  const originHost = origin.hostname.toLowerCase();
  if (!LOOPBACK.has(originHost) || originHost !== host.hostname) return false;
  if (origin.port === String(launcherPort)) return true;
  if (origin.port !== '') return false;
  if (req.get('sec-fetch-site') !== 'same-origin') return false;
  const referer = req.get('referer');
  if (!referer || referer.length > 2048) return false;
  try {
    const ref = new URL(referer);
    return ref.protocol === 'http:' && !ref.username && !ref.password && ref.origin === `http://${host.hostname}:${launcherPort}`;
  } catch (_) { return false; }
}

function createBrowserOpener({ platform = process.platform, spawnImpl = spawn } = {}) {
  return (url) => {
    const command = platform === 'darwin' ? ['open', [url]]
      : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
    try {
      const child = spawnImpl(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once?.('error', () => {});
      child.unref?.();
    } catch (_) { /* A printed local URL remains available if automatic open fails. */ }
  };
}

function startLauncher({
  port = Number(process.env.LAUNCHER_PORT || DEFAULT_LAUNCHER_PORT),
  host = '127.0.0.1',
  runtime = new LauncherRuntime(),
  runtimeOptions,
  staticDir = path.resolve(__dirname, '..', 'web', 'launcher'),
  openBrowser = createBrowserOpener(),
  listenImpl = (app, listenPort, listenHost, callback) => app.listen(listenPort, listenHost, callback),
  token = createToken(),
} = {}) {
  if (runtimeOptions) runtime = new LauncherRuntime(runtimeOptions);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Launcher port must be from 1 to 65535.');
  const app = express();
  const origin = `http://${host}:${port}`;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const parsedHost = parseHost(req.get('host'));
    if (!parsedHost || parsedHost.port !== port) return res.status(403).json({ error: { message: 'Local launcher host is not allowed.' } });
    return next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  const sendIndex = (req, res) => {
    let html;
    try { html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8'); }
    catch (_) { return res.status(503).type('text/plain').send('Launcher UI files are not available.'); }
    if (!html.includes('__LAUNCHER_TOKEN__')) return res.status(500).type('text/plain').send('Launcher UI is missing its token placeholder.');
    return res.type('html').send(html.replaceAll('__LAUNCHER_TOKEN__', token));
  };
  app.get('/', sendIndex);
  app.get('/launcher/:asset', (req, res) => {
    if (!['styles.css', 'app.js'].includes(req.params.asset)) return res.status(404).end();
    return res.sendFile(path.join(staticDir, req.params.asset), { dotfiles: 'deny' }, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).end();
    });
  });
  app.get('/api/launcher/status', (req, res) => res.json(runtime.snapshot()));
  const authorizeMutation = (req, res, next) => {
    if (!launcherOriginAllowed(req, port)) return res.status(403).json({ error: { message: 'Launcher request origin is not allowed.' } });
    if (!launcherTokenMatches(token, req.get('x-launcher-token'))) return res.status(403).json({ error: { message: 'Launcher request token is invalid.' } });
    return next();
  };
  const respond = (handler) => async (req, res) => {
    try { return res.json(await handler(req)); }
    catch (error) {
      const message = String(error?.message || 'Launcher request failed.').replace(/(pair=)[A-Za-z0-9_-]+/gi, '$1[redacted]').slice(0, 500);
      return res.status(409).json({ error: { message } });
    }
  };
  app.post('/api/launcher/start', authorizeMutation, respond((req) => runtime.start({ projectPath: req.body?.projectPath, port: req.body?.port })));
  app.post('/api/launcher/stop', authorizeMutation, respond(() => runtime.stop()));
  app.post('/api/launcher/open', authorizeMutation, respond(() => runtime.openPairing()));
  app.use((req, res) => res.status(404).json({ error: { message: 'Not found.' } }));

  let httpServer;
  let listenFailure = null;
  const onListen = (error) => {
    if (error) { listenFailure = error; return; }
    const actualPort = httpServer.address().port;
    const url = `http://${host}:${actualPort}/`;
    process.stdout.write(`Launcher ready: ${url}\n`);
    try { openBrowser(url); } catch (_) { /* URL already printed. */ }
  };
  httpServer = listenImpl(app, port, host, onListen);
  httpServer.on('error', (error) => { listenFailure = error; });
  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      await runtime.close();
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    })();
    return closing;
  };
  return { app, httpServer, runtime, token, origin, close, get listenError() { return listenFailure; } };
}

module.exports = { startLauncher, createBrowserOpener, launcherOriginAllowed, launcherTokenMatches, parseHost };
