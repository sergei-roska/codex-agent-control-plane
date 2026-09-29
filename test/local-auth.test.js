'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateAuthToken, readAuthToken, createAuthMiddleware } = require('../src/local-auth');

test('creates a persistent local token with private directory and file permissions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-a2a-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, '.runtime', 'a2a-token');
  const token = loadOrCreateAuthToken({ filePath: tokenFile });
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(loadOrCreateAuthToken({ filePath: tokenFile }), token);
  assert.equal(readAuthToken({ filePath: tokenFile }), token);
  assert.equal(fs.statSync(path.dirname(tokenFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
});

test('bearer middleware accepts the exact token and rejects missing or incorrect tokens', () => {
  const middleware = createAuthMiddleware('a'.repeat(43));
  const accepted = { nextCalled: false };
  middleware({ headers: { authorization: `Bearer ${'a'.repeat(43)}` } }, {}, () => { accepted.nextCalled = true; });
  assert.equal(accepted.nextCalled, true);

  const publicCard = { nextCalled: false };
  middleware({ path: '/agents/orch-builder/agent-card.json', headers: {} }, {}, () => { publicCard.nextCalled = true; });
  assert.equal(publicCard.nextCalled, true);

  for (const authorization of ['', `Bearer ${'b'.repeat(43)}`, 'Basic dXNlcjpwYXNz']) {
    const response = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      set(name, value) { this.header = [name, value]; return this; },
    };
    middleware({ headers: { authorization } }, response, () => assert.fail('Unauthorized request passed through'));
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.header, ['WWW-Authenticate', 'Bearer']);
    assert.deepEqual(response.body, { error: 'Unauthorized' });
  }
});
