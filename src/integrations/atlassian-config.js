'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CALLBACK_PATH = '/api/dashboard/v1/integrations/atlassian/callback';
const CONFIG_ERROR = 'Atlassian configuration is invalid';

class AtlassianConfigError extends Error {
  constructor() {
    super(CONFIG_ERROR);
    this.name = 'AtlassianConfigError';
    this.code = 'configuration_invalid';
  }
}

function fail() { throw new AtlassianConfigError(); }
function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function privateFile(filePath, workspace) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) fail();
  const target = path.resolve(filePath);
  if (within(workspace, target)) fail();
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch { fail(); }
    if (stat.isSymbolicLink()) fail();
    if (current === target && (!stat.isFile() || typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) fail();
  }
  return boundedRead(target, 4096, true);
}

function boundedRead(filePath, maxBytes, ownerOnly) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes || (ownerOnly && (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600))) fail();
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > maxBytes) fail();
    return buffer.subarray(0, bytes);
  } catch (error) {
    if (error instanceof AtlassianConfigError) throw error;
    fail();
  } finally { if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { fail(); } } }
}

function parseEncryptionKey(buffer) {
  const text = buffer.toString('utf8').trim();
  let key;
  if (/^[a-fA-F0-9]{64}$/.test(text)) key = Buffer.from(text, 'hex');
  else if (/^[A-Za-z0-9_-]{43}=?$/.test(text)) key = Buffer.from(text.replace(/=+$/, ''), 'base64url');
  else fail();
  if (key.length !== 32) fail();
  return key;
}

function loadAtlassianConfig({ workspace, configPath = process.env.CODEX_ATLASSIAN_CONFIG, port } = {}) {
  if (!configPath) return null;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || !Number.isInteger(port) || port < 1 || port > 65535) fail();
  let root;
  try { root = fs.realpathSync(workspace); } catch { fail(); }
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) fail();
  const configFile = path.resolve(configPath);
  if (within(root, configFile)) fail();
  const config = (() => {
    try {
      if (within(root, configFile)) fail();
      let current = path.parse(configFile).root;
      for (const part of configFile.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) fail();
      }
      return JSON.parse(boundedRead(configFile, 16 * 1024, false).toString('utf8'));
    } catch (error) { if (error instanceof AtlassianConfigError) throw error; fail(); }
  })();
  const fields = ['clientId', 'redirectUri', 'tokenStorePath', 'clientSecretFile', 'encryptionKeyFile'];
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((key) => !fields.includes(key)) ||
      fields.some((key) => typeof config[key] !== 'string' || !config[key] || config[key].length > 4096)) fail();
  const secretPath = path.resolve(config.clientSecretFile);
  const keyPath = path.resolve(config.encryptionKeyFile);
  const tokenPath = path.resolve(config.tokenStorePath);
  if (!path.isAbsolute(config.clientSecretFile) || !path.isAbsolute(config.encryptionKeyFile) || !path.isAbsolute(config.tokenStorePath) ||
      within(root, secretPath) || within(root, keyPath) || within(root, tokenPath) ||
      new Set([configFile, secretPath, keyPath, tokenPath]).size !== 4) fail();
  let callback;
  try { callback = new URL(config.redirectUri); } catch { fail(); }
  if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(callback.hostname) ||
      callback.port !== String(port) || callback.pathname !== CALLBACK_PATH || callback.search || callback.hash || callback.username || callback.password) fail();
  const secret = privateFile(secretPath, root).toString('utf8').replace(/\r?\n$/, '');
  if (!secret || secret.length > 4096 || /[\u0000-\u001f\u007f]/.test(secret)) fail();
  const key = parseEncryptionKey(privateFile(keyPath, root));
  return Object.freeze({
    clientId: config.clientId,
    redirectUri: callback.toString(),
    callbackOrigin: callback.origin,
    tokenStorePath: tokenPath,
    resolveClientSecret: async () => secret,
    resolveEncryptionKey: async () => Buffer.from(key),
  });
}

module.exports = { AtlassianConfigError, CALLBACK_PATH, loadAtlassianConfig };
