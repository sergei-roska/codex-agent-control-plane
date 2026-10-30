'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, it } = require('node:test');
const { createConnectorPreferences, readConnectorPreferences } = require('../src/connector-preferences');

let tmp;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

it('defaults to enabled connectors and atomically persists reversible preferences with mode 0600', () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-preferences-'));
  const accountsDir = path.join(tmp, 'accounts');
  const preferences = createConnectorPreferences({ accountsDir });
  assert.deepEqual(preferences.read(), { version: 1, disabled: [] });
  assert.equal(preferences.isEnabled('harness-figma'), true);

  preferences.setEnabled('harness-figma', false);
  assert.deepEqual(JSON.parse(fs.readFileSync(preferences.filePath, 'utf8')), {
    version: 1,
    disabled: ['harness-figma'],
  });
  assert.equal(fs.statSync(preferences.filePath).mode & 0o777, 0o600);
  assert.equal(preferences.isEnabled('harness-figma'), false);
  assert.deepEqual(fs.readdirSync(accountsDir), ['connector-preferences.json']);

  preferences.setEnabled('harness-figma', true);
  assert.deepEqual(readConnectorPreferences(preferences.filePath), { version: 1, disabled: [] });
});

it('rejects malformed persisted preferences rather than silently enabling connectors', () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-preferences-'));
  const filePath = path.join(tmp, 'connector-preferences.json');
  fs.writeFileSync(filePath, '{broken');
  assert.throws(() => readConnectorPreferences(filePath), /Invalid connector preferences/);
  fs.writeFileSync(filePath, JSON.stringify({ version: 2, disabled: [] }));
  assert.throws(() => readConnectorPreferences(filePath), /expected \{ version: 1/);
});
