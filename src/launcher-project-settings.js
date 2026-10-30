'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateSettingsDocument } = require('./project-settings');

function readOwnerSettings(file) {
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateSettingsDocument(document);
    return document;
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: 1 };
    throw new Error('Project settings are invalid and were not changed');
  }
}

function readLauncherSettings(file) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error('Launcher settings are invalid; expected version 1 and a supported defaultExecutionPermissions value');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || Object.keys(document).length !== 2
    || document.version !== 1
    || !['inherit', 'strict', 'full-access'].includes(document.defaultExecutionPermissions)) {
    throw new Error('Launcher settings are invalid; expected version 1 and a supported defaultExecutionPermissions value');
  }
  return document;
}

function writeOwnerSettings(file, next) {
  validateSettingsDocument(next);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch (_) { /* retain platform defaults when chmod is unsupported */ }
    return next;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (_) { /* rename already consumed it */ }
  }
}

function writeExecutionPermissionsDefault(file, executionPermissions) {
  if (!['inherit', 'strict', 'full-access'].includes(executionPermissions)) throw new Error('Invalid execution permissions default');
  const document = readOwnerSettings(file);
  if (Object.hasOwn(document, 'executionPermissions')) return { document, changed: false };
  const next = { ...document, executionPermissions, updatedAt: new Date().toISOString() };
  writeOwnerSettings(file, next);
  return { document: next, changed: true };
}

function writeDeliveryEngine(file, deliveryEngine) {
  if (!['legacy', 'concurrent-v1'].includes(deliveryEngine)) throw new Error('Invalid delivery engine');
  const document = readOwnerSettings(file);
  const next = { ...document, deliveryEngine, updatedAt: new Date().toISOString() };
  writeOwnerSettings(file, next);
  return next;
}

module.exports = { readOwnerSettings, readLauncherSettings, writeExecutionPermissionsDefault, writeDeliveryEngine };
