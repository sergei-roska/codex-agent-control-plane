'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEncryptedTokenStore } = require('../src/integrations/encrypted-token-store');
const { createAtlassianOAuthClient, REQUIRED_SCOPES } = require('../src/integrations/atlassian-oauth');

const record = Object.freeze({
  accessToken: 'access-secret-value',
  refreshToken: 'refresh-secret-value',
  expiresAt: 1800000000000,
  scopes: ['read:jira-work', 'read:page:confluence', 'offline_access'],
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm6-token-store-'));
  const workspaceRoot = path.join(root, 'workspace');
  const privateDir = path.join(root, 'private');
  await fs.mkdir(workspaceRoot, { mode: 0o700 });
  await fs.mkdir(privateDir, { mode: 0o700 });
  await fs.chmod(privateDir, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(privateDir, 'atlassian.oauth');
  const key = crypto.randomBytes(32);
  const makeStore = (options = {}) => createEncryptedTokenStore({
    filePath: options.filePath || filePath,
    workspaceRoot: options.workspaceRoot || workspaceRoot,
    bindingId: options.bindingId || 'project:alpha',
    resolveEncryptionKey: options.resolveEncryptionKey || (async () => key),
  });
  return { root, workspaceRoot, privateDir, filePath, key, makeStore };
}

async function expectSafeFailure(promise, forbidden = []) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, 'Encrypted token storage failed');
    assert.equal(error.code, 'credential_store_failed');
    for (const text of forbidden) assert.equal(error.message.includes(text), false);
    return true;
  });
}

test('encrypted records reopen without plaintext on disk and use fresh nonces', async (t) => {
  const f = await fixture(t);
  const store = f.makeStore();
  await store.write(record);
  const firstBytes = await fs.readFile(f.filePath);
  assert.equal(firstBytes.includes(Buffer.from(record.accessToken)), false);
  assert.equal(firstBytes.includes(Buffer.from(record.refreshToken)), false);
  assert.deepEqual(await f.makeStore().read(), record);
  await store.write(record);
  const first = JSON.parse(firstBytes.toString('utf8'));
  const second = JSON.parse((await fs.readFile(f.filePath)).toString('utf8'));
  assert.notEqual(first.iv, second.iv);
  assert.equal((await fs.stat(f.privateDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(f.filePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.filePath)).uid, process.getuid());
});

test('creates only the explicitly selected private leaf directory', async (t) => {
  const f = await fixture(t);
  const privateDir = path.join(f.root, 'created-private');
  const store = f.makeStore({ filePath: path.join(privateDir, 'tokens.bin') });
  await store.write(record);
  assert.equal((await fs.stat(privateDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(privateDir)).uid, process.getuid());
  assert.deepEqual(await store.read(), record);
});

test('read and clear do not create an absent private directory', async (t) => {
  const f = await fixture(t);
  const privateDir = path.join(f.root, 'not-created');
  const store = f.makeStore({ filePath: path.join(privateDir, 'tokens.bin') });
  assert.equal(await store.read(), null);
  await store.clear();
  await assert.rejects(fs.lstat(privateDir), { code: 'ENOENT' });
});

test('wrong keys, binding IDs, and ciphertext tampering fail with redacted errors', async (t) => {
  const f = await fixture(t);
  await f.makeStore().write(record);
  const pathText = f.filePath;
  await expectSafeFailure(f.makeStore({ resolveEncryptionKey: async () => crypto.randomBytes(32) }).read(), [pathText, record.accessToken]);
  await expectSafeFailure(f.makeStore({ bindingId: 'project:other' }).read(), [record.refreshToken]);
  const envelope = JSON.parse((await fs.readFile(f.filePath)).toString('utf8'));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}00`;
  await fs.writeFile(f.filePath, JSON.stringify(envelope), { mode: 0o600 });
  await expectSafeFailure(f.makeStore().read(), [pathText, record.accessToken]);
});

test('unsafe modes, ownership configuration, and symlink paths are rejected', async (t) => {
  const f = await fixture(t);
  await f.makeStore().write(record);
  await fs.chmod(f.privateDir, 0o755);
  await expectSafeFailure(f.makeStore().read());
  await fs.chmod(f.privateDir, 0o700);
  await fs.chmod(f.filePath, 0o644);
  await expectSafeFailure(f.makeStore().read());
  await fs.unlink(f.filePath);

  const linkedParent = path.join(f.root, 'linked-private');
  await fs.symlink(f.privateDir, linkedParent);
  const linkedStore = f.makeStore({ filePath: path.join(linkedParent, 'secret') });
  await expectSafeFailure(linkedStore.write(record));
  const linkedFile = path.join(f.privateDir, 'linked.oauth');
  await fs.symlink(f.filePath, linkedFile);
  await expectSafeFailure(f.makeStore({ filePath: linkedFile }).read());
  await expectSafeFailure(f.makeStore({ filePath: path.join(f.workspaceRoot, 'inside.oauth') }).write(record));
});

test('filesystem failures from path resolution are sanitized', async (t) => {
  const f = await fixture(t);
  const missingWorkspace = path.join(f.root, 'missing-workspace');
  await expectSafeFailure(f.makeStore({ workspaceRoot: missingWorkspace }).read(), [missingWorkspace]);
});

test('oversized and malformed records are rejected without allocating unbounded reads', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.filePath, Buffer.alloc(32 * 1024 + 1, 0x41), { mode: 0o600 });
  await expectSafeFailure(f.makeStore().read());
  await fs.unlink(f.filePath);
  const badRecords = [
    { ...record, accessToken: 'bad\r\nheader' },
    { ...record, scopes: ['write:jira-work'] },
    { ...record, scopes: ['read:jira-work'] },
    { ...record, expiresAt: Infinity },
    { ...record, scopes: ['read:jira-work', 'read:jira-work'] },
  ];
  for (const bad of badRecords) await expectSafeFailure(f.makeStore().write(bad));
  await f.makeStore().write(record);
  await fs.writeFile(f.filePath, '{ malformed', { mode: 0o600 });
  await expectSafeFailure(f.makeStore().read());
});

test('failed writes preserve the previous record and redact resolver errors', async (t) => {
  const f = await fixture(t);
  const store = f.makeStore();
  await store.write(record);
  const before = await fs.readFile(f.filePath);
  const broken = f.makeStore({ resolveEncryptionKey: async () => { throw new Error('secret and path'); } });
  await expectSafeFailure(broken.write({ ...record, accessToken: 'replacement-secret' }), ['secret and path', f.filePath]);
  assert.deepEqual(await fs.readFile(f.filePath), before);
  assert.deepEqual(await store.read(), record);
});

test('operations serialize in call order and clear is idempotent', async (t) => {
  const f = await fixture(t);
  const store = f.makeStore();
  const writeFirst = store.write(record);
  const readBetween = store.read();
  const replacement = { ...record, accessToken: 'second-access-token' };
  const writeSecond = store.write(replacement);
  await Promise.all([writeFirst, readBetween, writeSecond]);
  assert.deepEqual(await store.read(), replacement);
  await store.clear();
  await store.clear();
  assert.equal(await store.read(), null);
});

test('OAuth authorization persists through the encrypted token-store contract', async (t) => {
  const f = await fixture(t);
  const tokenStore = f.makeStore();
  const fetchImpl = async () => new Response(JSON.stringify({
    access_token: record.accessToken,
    refresh_token: record.refreshToken,
    expires_in: 3600,
    token_type: 'Bearer',
    scope: REQUIRED_SCOPES.join(' '),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const oauth = createAtlassianOAuthClient({
    clientId: 'client-id',
    redirectUri: 'https://orchestrator.example/oauth/atlassian/callback',
    tokenStore,
    resolveClientSecret: async () => 'client-secret',
    fetchImpl,
    now: () => record.expiresAt - 3600 * 1000,
  });
  const { state } = await oauth.beginAuthorization({ sessionId: 'session-1' });
  const completion = await oauth.completeAuthorization({ sessionId: 'session-1', state, code: 'authorization-code' });
  assert.deepEqual(completion, { connected: true });
  assert.equal(JSON.stringify(completion).includes(record.accessToken), false);
  assert.deepEqual(await tokenStore.read(), record);
  assert.deepEqual(await oauth.getHealth(), { connected: true, expiresAt: record.expiresAt, scopes: record.scopes, pendingAuthorizations: 0 });
});
