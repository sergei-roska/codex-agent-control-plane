'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOAuthHandoff } = require('../src/integrations/oauth-handoff');
const { createAtlassianOAuthClient, REQUIRED_SCOPES, TOKEN_URL } = require('../src/integrations/atlassian-oauth');

function stateFrom(begun) { return new URL(begun.authorizationUrl).searchParams.get('state'); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeFakeOAuth({ revision = false, complete } = {}) {
  let counter = 0;
  const pending = new Map();
  const calls = { begins: [], completes: [], cancels: [], disconnects: 0 };
  const oauth = {
    async beginAuthorization({ sessionId }) {
      calls.begins.push(sessionId);
      counter += 1;
      const state = Buffer.alloc(32, counter).toString('base64url');
      pending.set(state, sessionId);
      return { state, authorizationUrl: `https://auth.atlassian.com/authorize?state=${state}` };
    },
    async completeAuthorization(args) {
      calls.completes.push(args);
      if (pending.get(args.state) === args.sessionId) pending.delete(args.state);
      if (complete) return complete(args);
      return { connected: true };
    },
    cancelAuthorization({ sessionId, state } = {}) {
      const canceled = pending.get(state) === sessionId;
      if (canceled) pending.delete(state);
      calls.cancels.push({ sessionId, state, canceled });
      return { canceled };
    },
    async disconnect() { calls.disconnects += 1; pending.clear(); },
  };
  if (revision) oauth.getConnectionRevision = () => revision.value;
  return { oauth, calls, pending };
}

async function begun(handoff, sessionId = 'session-A') {
  const value = await handoff.begin({ sessionId });
  return { value, state: stateFrom(value) };
}

test('callback receipt stores code in memory and returns only an opaque one-use handle', async () => {
  const { oauth, calls } = makeFakeOAuth();
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff);
  const result = handoff.receiveCallback({ state: start.state, code: 'sensitive-code' });
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'handle']);
  assert.match(result.handle, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(result).includes('sensitive-code'), false);
  assert.equal(calls.completes.length, 0);
  assert.equal(calls.cancels.length, 0);
  const completed = await handoff.complete({ sessionId: 'session-A', handle: result.handle });
  assert.deepEqual(completed, { connected: true });
  assert.deepEqual(calls.completes[0], { sessionId: 'session-A', state: start.state, code: 'sensitive-code' });
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: result.handle }), { code: 'invalid_oauth_handoff' });
});

test('callback and completion are bound to the initiating session', async () => {
  const { oauth, calls } = makeFakeOAuth();
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff, 'session-A');
  const callback = handoff.receiveCallback({ state: start.state, code: 'code-A' });
  await assert.rejects(handoff.complete({ sessionId: 'session-B', handle: callback.handle }), { code: 'invalid_oauth_handoff' });
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: callback.handle }), { code: 'invalid_oauth_handoff' });
  assert.equal(calls.completes.length, 0);
  assert.equal(calls.cancels.length, 1);
  assert.throws(() => handoff.receiveCallback({ state: start.state, code: 'code-A' }), { code: 'invalid_oauth_handoff' });
});

test('denial and malformed callback query values are consumed and safely rejected', async () => {
  const { oauth, calls } = makeFakeOAuth();
  const handoff = createOAuthHandoff({ oauth });
  const denied = await begun(handoff);
  assert.throws(() => handoff.receiveCallback({ state: denied.state, error: 'access_denied', error_description: 'token=secret' }),
    (error) => error.code === 'authorization_denied' && !error.message.includes('secret'));
  assert.throws(() => handoff.receiveCallback({ state: denied.state, code: 'code' }), { code: 'invalid_oauth_handoff' });

  const malformed = [
    { state: [denied.state], code: 'x' }, { state: denied.state, code: ['x'] },
    { state: denied.state, code: 'x\r\nSet-Cookie:secret' }, { state: denied.state, error: ['access_denied'] },
    { state: ` ${denied.state}`, code: 'x' }, null, [],
  ];
  for (const value of malformed) {
    assert.throws(() => handoff.receiveCallback(value), (error) => error.code === 'invalid_oauth_handoff' && !/secret|Set-Cookie|upstream/i.test(error.message));
  }
  assert.equal(calls.completes.length, 0);
  assert.equal(calls.cancels.length, 1);
  const badQuery = await begun(handoff);
  assert.throws(() => handoff.receiveCallback({ state: badQuery.state, code: ['bad'] }), { code: 'invalid_oauth_handoff' });
  assert.equal(calls.cancels.length, 2);
});

test('states and handles expire on access without timers', async () => {
  let time = 1000;
  const { oauth, pending } = makeFakeOAuth();
  const handoff = createOAuthHandoff({ oauth, now: () => time, ttlMs: 100 });
  const start = await begun(handoff);
  assert.equal(start.value.expiresAt, 1100);
  time = 1100;
  assert.throws(() => handoff.receiveCallback({ state: start.state, code: 'code' }), { code: 'invalid_oauth_handoff' });
  assert.equal(pending.has(start.state), false);
  assert.equal(oauth.cancelAuthorization({ sessionId: 'session-A', state: start.state }).canceled, false);
  time = 2000;
  const second = await begun(handoff);
  const callback = handoff.receiveCallback({ state: second.state, code: 'code' });
  time = callback.expiresAt;
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: callback.handle }), { code: 'invalid_oauth_handoff' });
  assert.equal(pending.has(stateFrom(second.value)), false);
  assert.equal(oauth.cancelAuthorization({ sessionId: 'session-A', state: stateFrom(second.value) }).canceled, false);
});

test('combined flow cap applies to pending states, handles, and in-flight begin calls', async () => {
  const gate = deferred();
  const { oauth } = makeFakeOAuth();
  const original = oauth.beginAuthorization;
  let hold = true;
  oauth.beginAuthorization = async (args) => { if (hold) await gate.promise; return original(args); };
  const handoff = createOAuthHandoff({ oauth, maxPending: 1 });
  const first = handoff.begin({ sessionId: 'one' });
  await assert.rejects(handoff.begin({ sessionId: 'two' }), { code: 'oauth_handoff_capacity' });
  hold = false;
  gate.resolve();
  const start = await first;
  const callback = handoff.receiveCallback({ state: stateFrom(start), code: 'code' });
  await assert.rejects(handoff.begin({ sessionId: 'two' }), { code: 'oauth_handoff_capacity' });
  await handoff.complete({ sessionId: 'one', handle: callback.handle });
  await handoff.begin({ sessionId: 'two' });
});

test('failed revision inspection releases its begin reservation and slow begin cannot return expired state', async () => {
  let shouldThrow = true;
  let time = 1000;
  const { oauth } = makeFakeOAuth();
  oauth.getConnectionRevision = () => { if (shouldThrow) throw new Error('private revision detail'); return 0; };
  const handoff = createOAuthHandoff({ oauth, now: () => time, ttlMs: 100, maxPending: 1 });
  await assert.rejects(handoff.begin({ sessionId: 'one' }),
    (error) => error.code === 'invalid_oauth_handoff' && !error.message.includes('private'));
  shouldThrow = false;
  const gate = deferred();
  const original = oauth.beginAuthorization;
  oauth.beginAuthorization = async (args) => { await gate.promise; return original(args); };
  const pending = handoff.begin({ sessionId: 'one' });
  time = 1100;
  gate.resolve();
  await assert.rejects(pending, { code: 'invalid_oauth_handoff' });
  const next = await handoff.begin({ sessionId: 'two' });
  assert.equal(next.expiresAt, 1200);
});

test('a begin response arriving after clear cancels the new adapter state', async () => {
  const gate = deferred();
  const { oauth, pending } = makeFakeOAuth();
  const original = oauth.beginAuthorization;
  oauth.beginAuthorization = async (args) => { await gate.promise; return original(args); };
  const handoff = createOAuthHandoff({ oauth });
  const inFlight = handoff.begin({ sessionId: 'session-A' });
  handoff.clear();
  gate.resolve();
  await assert.rejects(inFlight, { code: 'invalid_oauth_handoff' });
  assert.equal(pending.size, 0);
});

test('faulty asynchronous cancellation is redacted and its rejection is observed', async () => {
  const { oauth } = makeFakeOAuth();
  oauth.cancelAuthorization = () => Promise.reject(new Error('private cancellation detail'));
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff);
  assert.throws(() => handoff.clear(), (error) => error.code === 'oauth_handoff_failed' && !error.message.includes('private'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('disconnect invalidates flows before calling OAuth and prevents obsolete completion success', async () => {
  const gate = deferred();
  const { oauth, calls } = makeFakeOAuth({ complete: () => gate.promise });
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff);
  const callback = handoff.receiveCallback({ state: start.state, code: 'code' });
  const running = handoff.complete({ sessionId: 'session-A', handle: callback.handle });
  await Promise.resolve();
  await handoff.disconnect({ sessionId: 'session-A' });
  assert.equal(calls.disconnects, 1);
  gate.resolve({ connected: true });
  await assert.rejects(running, { code: 'invalid_oauth_handoff' });
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: callback.handle }), { code: 'invalid_oauth_handoff' });
});

test('clear and external account changes invalidate pending states and callback handles', async () => {
  const revision = { value: 0 };
  const { oauth, pending } = makeFakeOAuth({ revision });
  const handoff = createOAuthHandoff({ oauth });
  const first = await begun(handoff);
  handoff.clear();
  assert.equal(pending.has(first.state), false);
  assert.throws(() => handoff.receiveCallback({ state: first.state, code: 'code' }), { code: 'invalid_oauth_handoff' });
  const second = await begun(handoff);
  const callback = handoff.receiveCallback({ state: second.state, code: 'code' });
  revision.value += 1;
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: callback.handle }), { code: 'invalid_oauth_handoff' });
  assert.equal(pending.has(second.state), false);
});

test('OAuth revision must advance once for its own exchange and remain stable until completion returns', async () => {
  const revision = { value: 0 };
  const exchange = deferred();
  const { oauth } = makeFakeOAuth({ revision, complete: async () => { revision.value += 1; await exchange.promise; return { connected: true }; } });
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff);
  const callback = handoff.receiveCallback({ state: start.state, code: 'code' });
  const running = handoff.complete({ sessionId: 'session-A', handle: callback.handle });
  await Promise.resolve();
  revision.value += 1;
  exchange.resolve();
  await assert.rejects(running, { code: 'invalid_oauth_handoff' });
});

test('completion failures are redacted and consume their handles', async () => {
  const { oauth } = makeFakeOAuth({ complete: async () => { throw new Error('response body code=secret token=private'); } });
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff);
  const callback = handoff.receiveCallback({ state: start.state, code: 'code=private' });
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: callback.handle }),
    (error) => error.code === 'oauth_handoff_failed' && !/secret|private|response body/i.test(error.message));
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: callback.handle }), { code: 'invalid_oauth_handoff' });
});

test('new handoff factory instances do not accept handles from a previous process lifetime', async () => {
  const first = makeFakeOAuth();
  const oldHandoff = createOAuthHandoff({ oauth: first.oauth });
  const start = await begun(oldHandoff);
  const callback = oldHandoff.receiveCallback({ state: start.state, code: 'code' });
  const second = makeFakeOAuth();
  const restarted = createOAuthHandoff({ oauth: second.oauth });
  await assert.rejects(restarted.complete({ sessionId: 'session-A', handle: callback.handle }), { code: 'invalid_oauth_handoff' });
});

test('actual Atlassian OAuth adapter exchanges only after authenticated handoff completion', async () => {
  const fetches = [];
  let saved = null;
  const oauth = createAtlassianOAuthClient({ clientId: 'client-id', redirectUri: 'https://orchestrator.example/oauth/callback',
    tokenStore: { async read() { return saved; }, async write(value) { saved = value; }, async clear() { saved = null; } },
    resolveClientSecret: async () => 'client-secret',
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      const bytes = Buffer.from(JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600,
        token_type: 'Bearer', scope: REQUIRED_SCOPES.join(' ') }));
      return { ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    } });
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff);
  const callback = handoff.receiveCallback({ state: start.state, code: 'authorization-code-secret' });
  assert.deepEqual(fetches, []);
  assert.equal(JSON.stringify(callback).includes('authorization-code-secret'), false);
  const result = await handoff.complete({ sessionId: 'session-A', handle: callback.handle });
  assert.deepEqual(result, { connected: true });
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, TOKEN_URL);
  assert.equal(JSON.parse(fetches[0].init.body).code, 'authorization-code-secret');
  assert.equal(JSON.stringify(result).includes('access-secret'), false);
  assert.equal(JSON.stringify(result).includes('authorization-code-secret'), false);
});

test('actual adapter cancels denied, malformed, expired, cleared, and wrong-session flows', async () => {
  let time = 10000;
  let fetches = 0;
  let saved = null;
  const oauth = createAtlassianOAuthClient({ clientId: 'client-id', redirectUri: 'https://orchestrator.example/oauth/callback',
    tokenStore: { async read() { return saved; }, async write(value) { saved = value; }, async clear() { saved = null; } },
    resolveClientSecret: async () => 'client-secret', now: () => time, stateTtlMs: 300000,
    fetchImpl: async () => { fetches += 1; throw new Error('unexpected network request'); } });
  const handoff = createOAuthHandoff({ oauth, now: () => time, ttlMs: 50, maxPending: 1 });

  for (let i = 0; i < 40; i += 1) {
    const denial = await begun(handoff, `denied-${i}`);
    assert.throws(() => handoff.receiveCallback({ state: denial.state, error: 'access_denied' }), { code: 'authorization_denied' });
    const malformed = await begun(handoff, `malformed-${i}`);
    assert.throws(() => handoff.receiveCallback({ state: malformed.state, code: ['invalid'] }), { code: 'invalid_oauth_handoff' });
  }
  assert.equal((await oauth.getHealth()).pendingAuthorizations, 0);

  const expired = await begun(handoff);
  const expiredHandle = handoff.receiveCallback({ state: expired.state, code: 'opaque' });
  time = expiredHandle.expiresAt;
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: expiredHandle.handle }), { code: 'invalid_oauth_handoff' });
  assert.equal((await oauth.getHealth()).pendingAuthorizations, 0);

  const cleared = await begun(handoff);
  handoff.clear();
  assert.equal((await oauth.getHealth()).pendingAuthorizations, 0);
  assert.throws(() => handoff.receiveCallback({ state: cleared.state, code: 'opaque' }), { code: 'invalid_oauth_handoff' });

  const wrongSession = await begun(handoff, 'owner-session');
  const wrongHandle = handoff.receiveCallback({ state: wrongSession.state, code: 'opaque' });
  await assert.rejects(handoff.complete({ sessionId: 'other-session', handle: wrongHandle.handle }), { code: 'invalid_oauth_handoff' });
  assert.equal((await oauth.getHealth()).pendingAuthorizations, 0);
  assert.equal(fetches, 0);
});

test('OAuth completion revision guard accepts its own single generation advance', async () => {
  let saved = null;
  const oauth = createAtlassianOAuthClient({ clientId: 'client-id', redirectUri: 'https://orchestrator.example/oauth/callback',
    tokenStore: { async read() { return saved; }, async write(value) { saved = value; }, async clear() { saved = null; } },
    resolveClientSecret: async () => 'client-secret', fetchImpl: async () => {
      const bytes = Buffer.from(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600,
        token_type: 'Bearer', scope: REQUIRED_SCOPES.join(' ') }));
      return { ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    } });
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff);
  const callback = handoff.receiveCallback({ state: start.state, code: 'code' });
  assert.deepEqual(await handoff.complete({ sessionId: 'session-A', handle: callback.handle }), { connected: true });
  assert.equal((await oauth.getHealth()).connected, true);
});

test('an immediate revision race safely observes a rejected OAuth completion promise', async () => {
  const revision = { value: 0 };
  const { oauth } = makeFakeOAuth({ revision, complete: () => {
    revision.value += 2;
    return Promise.reject(new Error('upstream body code=must-not-leak'));
  } });
  const handoff = createOAuthHandoff({ oauth });
  const start = await begun(handoff);
  const callback = handoff.receiveCallback({ state: start.state, code: 'code' });
  await assert.rejects(handoff.complete({ sessionId: 'session-A', handle: callback.handle }),
    (error) => error.code === 'invalid_oauth_handoff' && !error.message.includes('must-not-leak'));
  await new Promise((resolve) => setImmediate(resolve));
});
