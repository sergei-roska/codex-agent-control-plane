'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TOKEN_FILE = path.resolve(__dirname, '..', '.runtime', 'a2a-token');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function tokenPath(filePath = process.env.CODEX_A2A_TOKEN_FILE || DEFAULT_TOKEN_FILE) {
  return path.resolve(filePath);
}

function validateToken(token, filePath) {
  if (!TOKEN_PATTERN.test(token)) throw new Error(`Invalid local A2A token file: ${filePath}`);
  return token;
}

function readAuthToken({ filePath } = {}) {
  const target = tokenPath(filePath);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Local A2A token path must be a regular file: ${target}`);
  if ((stat.mode & 0o777) !== 0o600) fs.chmodSync(target, 0o600);
  return validateToken(fs.readFileSync(target, 'utf8').trim(), target);
}

function loadOrCreateAuthToken({ filePath } = {}) {
  const target = tokenPath(filePath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Local A2A token directory must be a real directory: ${directory}`);
  }
  if ((directoryStat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);

  try {
    const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      const token = crypto.randomBytes(32).toString('base64url');
      fs.writeFileSync(descriptor, token, 'utf8');
      fs.fsyncSync(descriptor);
      return token;
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw error;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readAuthToken({ filePath: target });
  }
}

function createAuthMiddleware(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new TypeError('A valid local A2A token is required');
  const expected = crypto.createHash('sha256').update(token, 'utf8').digest();
  return function requireLocalBearer(req, res, next) {
    if (typeof req.path === 'string' && req.path.endsWith('/agent-card.json')) return next();
    const header = req.get?.('authorization') || req.headers?.authorization || '';
    const match = typeof header === 'string' ? header.match(/^Bearer ([A-Za-z0-9_-]{1,256})$/i) : null;
    const supplied = match ? match[1] : '';
    const received = crypto.createHash('sha256').update(supplied, 'utf8').digest();
    if (crypto.timingSafeEqual(expected, received)) return next();
    res.set?.('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'Unauthorized' });
  };
}

module.exports = { DEFAULT_TOKEN_FILE, tokenPath, readAuthToken, loadOrCreateAuthToken, createAuthMiddleware };
