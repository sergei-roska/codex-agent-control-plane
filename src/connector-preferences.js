'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'connector-preferences.json';

function emptyPreferences() {
  return { version: 1, disabled: [] };
}

function readConnectorPreferences(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyPreferences();
    throw error;
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid connector preferences: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !Array.isArray(value.disabled) || value.disabled.some((name) => typeof name !== 'string' || !name)) {
    throw new Error('Invalid connector preferences: expected { version: 1, disabled: string[] }');
  }
  return { version: 1, disabled: [...new Set(value.disabled)].sort() };
}

function writeConnectorPreferences(filePath, preferences) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch (_) { /* best effort */ }
    throw error;
  }
  return preferences;
}

function createConnectorPreferences({ accountsDir, filePath } = {}) {
  const resolvedPath = path.resolve(filePath || path.join(accountsDir, FILE_NAME));

  function read() {
    return readConnectorPreferences(resolvedPath);
  }

  function setEnabled(name, enabled) {
    if (typeof name !== 'string' || !name || typeof enabled !== 'boolean') {
      throw new TypeError('connector name and enabled boolean are required');
    }
    const preferences = read();
    const disabled = new Set(preferences.disabled);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    return writeConnectorPreferences(resolvedPath, { version: 1, disabled: [...disabled].sort() });
  }

  function isEnabled(name) {
    return !read().disabled.includes(name);
  }

  return { filePath: resolvedPath, read, setEnabled, isEnabled };
}

module.exports = { FILE_NAME, createConnectorPreferences, readConnectorPreferences, writeConnectorPreferences };
