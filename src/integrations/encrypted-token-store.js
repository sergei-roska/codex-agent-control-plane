'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');

const VERSION = 1;
const PURPOSE = 'codex-atlassian-oauth-token-store';
const MAX_PLAINTEXT_BYTES = 16 * 1024;
const MAX_ENVELOPE_BYTES = 32 * 1024;
const TOKEN_STORE_ERROR = 'Encrypted token storage failed';
const DURABILITY_ERROR = 'Encrypted token storage durability is uncertain';
const TOKEN_RE = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const SCOPE_RE = /^[a-z0-9:_-]{1,128}$/;
const REQUIRED_SCOPES = Object.freeze(['read:jira-work', 'read:page:confluence', 'offline_access']);

class EncryptedTokenStoreError extends Error {
  constructor(code = 'credential_store_failed', message = TOKEN_STORE_ERROR) {
    super(message);
    this.name = 'EncryptedTokenStoreError';
    this.code = code;
  }
}

function fail() { throw new EncryptedTokenStoreError(); }
function durabilityUncertain() { throw new EncryptedTokenStoreError('credential_store_durability_uncertain', DURABILITY_ERROR); }

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.accessToken !== 'string' || !TOKEN_RE.test(value.accessToken) ||
      typeof value.refreshToken !== 'string' || !TOKEN_RE.test(value.refreshToken) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0 ||
      !Array.isArray(value.scopes) || value.scopes.length !== REQUIRED_SCOPES.length ||
      !value.scopes.every((scope) => typeof scope === 'string' && SCOPE_RE.test(scope)) ||
      new Set(value.scopes).size !== value.scopes.length ||
      REQUIRED_SCOPES.some((scope) => !value.scopes.includes(scope))) fail();
  const record = {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    scopes: [...value.scopes],
  };
  const encoded = Buffer.from(JSON.stringify(record), 'utf8');
  if (encoded.length > MAX_PLAINTEXT_BYTES) fail();
  return { record, encoded };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function rejectSymlinkComponents(absolutePath) {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail();
  }
}

function ownerUid() {
  if (typeof process.getuid !== 'function') fail();
  return process.getuid();
}

async function validatePaths(filePath, workspaceRoot, createParent) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) ||
      typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) fail();
  const target = path.resolve(filePath);
  const workspace = await fs.realpath(workspaceRoot);
  await rejectSymlinkComponents(workspace);
  const workspaceStat = await fs.stat(workspace);
  if (!workspaceStat.isDirectory()) fail();
  const parent = path.dirname(target);
  if (isWithin(workspace, target) || isWithin(workspace, parent)) fail();
  try { await fs.lstat(parent); }
  catch (error) {
    if (!error || error.code !== 'ENOENT') fail();
    const ancestor = path.dirname(parent);
    await rejectSymlinkComponents(ancestor);
    const ancestorStat = await fs.stat(ancestor);
    if (!ancestorStat.isDirectory()) fail();
    if (!createParent) return { target, parent, uid: ownerUid(), parentMissing: true };
    try { await fs.mkdir(parent, { mode: 0o700 }); }
    catch (mkdirError) { if (!mkdirError || mkdirError.code !== 'EEXIST') fail(); }
  }
  await rejectSymlinkComponents(parent);
  const parentStat = await fs.stat(parent);
  const uid = ownerUid();
  if (!workspaceStat.isDirectory() || !parentStat.isDirectory() || parentStat.uid !== uid ||
      (parentStat.mode & 0o777) !== 0o700) fail();
  const realParent = await fs.realpath(parent);
  if (realParent !== parent) fail();
  return { target, parent, uid };
}

function associatedData(bindingId, version) {
  return Buffer.from(`${PURPOSE}\0${version}\0${bindingId}`, 'utf8');
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      envelope.version !== VERSION || envelope.algorithm !== 'A256GCM' ||
      typeof envelope.iv !== 'string' || !/^[a-f0-9]{24}$/.test(envelope.iv) ||
      typeof envelope.tag !== 'string' || !/^[a-f0-9]{32}$/.test(envelope.tag) ||
      typeof envelope.ciphertext !== 'string' || !/^(?:[a-f0-9]{2}){1,32768}$/.test(envelope.ciphertext)) fail();
}

function createEncryptedTokenStore({ filePath, workspaceRoot, bindingId, resolveEncryptionKey } = {}) {
  if (typeof bindingId !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(bindingId) ||
      typeof resolveEncryptionKey !== 'function') throw new TypeError('Invalid encrypted token store configuration');
  const queueState = { tail: Promise.resolve() };

  function serialize(action) {
    const safeAction = async () => {
      try { return await action(); }
      catch (error) {
        if (error instanceof EncryptedTokenStoreError) throw error;
        fail();
      }
    };
    const result = queueState.tail.then(safeAction, safeAction);
    queueState.tail = result.catch(() => {});
    return result;
  }

  async function key() {
    let value;
    try { value = await resolveEncryptionKey(); } catch { fail(); }
    if (!Buffer.isBuffer(value) || value.length !== 32) fail();
    return value;
  }

  async function checkedTarget(allowMissing = false, createParent = false) {
    const paths = await validatePaths(filePath, workspaceRoot, createParent);
    if (paths.parentMissing) return { ...paths, exists: false };
    let stat;
    try { stat = await fs.lstat(paths.target); }
    catch (error) {
      if (allowMissing && error && error.code === 'ENOENT') return { ...paths, exists: false };
      fail();
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== paths.uid || (stat.mode & 0o777) !== 0o600) fail();
    return { ...paths, exists: true };
  }

  async function read() {
    return serialize(async () => {
      const target = await checkedTarget(true);
      if (!target.exists) return null;
      let handle;
      try {
        const noFollow = constants.O_NOFOLLOW || 0;
        handle = await fs.open(target.target, constants.O_RDONLY | noFollow);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.uid !== target.uid || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_ENVELOPE_BYTES) fail();
        const buffer = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > MAX_ENVELOPE_BYTES) fail();
        const parsed = JSON.parse(buffer.subarray(0, offset).toString('utf8'));
        validateEnvelope(parsed);
        const secret = await key();
        const decipher = crypto.createDecipheriv('aes-256-gcm', secret, Buffer.from(parsed.iv, 'hex'));
        decipher.setAAD(associatedData(bindingId, parsed.version));
        decipher.setAuthTag(Buffer.from(parsed.tag, 'hex'));
        const plain = Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'hex')), decipher.final()]);
        if (plain.length > MAX_PLAINTEXT_BYTES) fail();
        const value = JSON.parse(plain.toString('utf8'));
        return validateRecord(value).record;
      } catch { fail(); }
      finally { if (handle) await handle.close().catch(() => {}); }
    });
  }

  async function write(value) {
    return serialize(async () => {
      const { encoded } = validateRecord(value);
      const target = await checkedTarget(true, true);
      const secret = await key();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
      cipher.setAAD(associatedData(bindingId, VERSION));
      const ciphertext = Buffer.concat([cipher.update(encoded), cipher.final()]);
      const envelope = Buffer.from(JSON.stringify({
        version: VERSION,
        algorithm: 'A256GCM',
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        ciphertext: ciphertext.toString('hex'),
      }), 'utf8');
      if (envelope.length > MAX_ENVELOPE_BYTES) fail();
      const tempPath = path.join(target.parent, `.oauth-token-${process.pid}-${crypto.randomBytes(16).toString('hex')}.tmp`);
      let handle;
      let renamed = false;
      try {
        handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        const tempStat = await handle.stat();
        if (!tempStat.isFile() || tempStat.uid !== target.uid || (tempStat.mode & 0o777) !== 0o600) fail();
        await handle.writeFile(envelope);
        await handle.sync();
        await handle.close();
        handle = null;
        // Recheck the destination immediately before the atomic replacement.
        const current = await checkedTarget(true);
        if (current.target !== target.target || current.parent !== target.parent) fail();
        await fs.rename(tempPath, target.target);
        renamed = true;
        const directory = await fs.open(target.parent, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {
        if (renamed) durabilityUncertain();
        fail();
      }
      finally {
        if (handle) await handle.close().catch(() => {});
        if (!renamed) await fs.unlink(tempPath).catch(() => {});
      }
      return undefined;
    });
  }

  async function clear() {
    return serialize(async () => {
      const target = await checkedTarget(true);
      if (!target.exists) return;
      let removed = false;
      try {
        await fs.unlink(target.target);
        removed = true;
        const directory = await fs.open(target.parent, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
        try { await directory.sync(); } finally { await directory.close(); }
      } catch {
        if (removed) durabilityUncertain();
        fail();
      }
    });
  }

  return Object.freeze({ read, write, clear });
}

module.exports = { createEncryptedTokenStore };
