'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');
const {
  ProjectSettingsError, normalizeAcceptanceScratch, validateSettingsDocument, readSettingsFile, resolveAcceptanceScratch,
} = require('../src/project-settings');

let tmp;
let file;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-settings-'));
  file = path.join(tmp, 'projects', 'p1', 'project-settings.json');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const writeRaw = (value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};

describe('normalizeAcceptanceScratch', () => {
  it('is disabled for undefined and null', () => {
    assert.equal(normalizeAcceptanceScratch(undefined), null);
    assert.equal(normalizeAcceptanceScratch(null), null);
  });

  it('accepts env names and an absolute baseDir', () => {
    assert.deepEqual(normalizeAcceptanceScratch({ env: ['TEAMWORK_TEST_SCRATCH_ROOT'] }), { env: ['TEAMWORK_TEST_SCRATCH_ROOT'] });
    assert.deepEqual(normalizeAcceptanceScratch({ env: ['_X1'], baseDir: '/var/tmp/cp-scratch' }), { env: ['_X1'], baseDir: '/var/tmp/cp-scratch' });
    assert.deepEqual(normalizeAcceptanceScratch({}), { env: [] });
  });

  it('rejects bad shapes, names, counts, and paths', () => {
    const refuse = (value, pattern) => assert.throws(() => normalizeAcceptanceScratch(value), (error) => error instanceof ProjectSettingsError && pattern.test(error.message));
    refuse([], /must be an object/);
    refuse('x', /must be an object/);
    refuse({ env: 'X' }, /must be an array/);
    refuse({ env: [1] }, /must match/);
    refuse({ env: ['lower'] }, /must match/);
    refuse({ env: ['1X'] }, /must match/);
    refuse({ env: ['A'.repeat(65)] }, /must match/);
    refuse({ env: Array.from({ length: 9 }, (_, i) => `V${i}`) }, /more than 8/);
    for (const name of ['PATH', 'HOME', 'TMPDIR', 'LD_PRELOAD', 'PYTHONPATH', 'NODE_OPTIONS', 'CODEX_HOME', 'GIT_DIR']) refuse({ env: [name] }, /reserved/);
    refuse({ env: ['X', 'X'] }, /duplicated/);
    refuse({ env: ['X'], baseDir: 'rel' }, /absolute path/);
    refuse({ env: ['X'], baseDir: '/a/../b' }, /absolute path/);
    refuse({ env: ['X'], baseDir: '' }, /absolute path/);
    refuse({ env: ['X'], baseDir: 5 }, /absolute path/);
    refuse({ env: ['X'], shell: true }, /unknown field "shell"/);
  });
});

describe('settings file', () => {
  it('missing file means everything disabled', () => {
    assert.deepEqual(readSettingsFile(file), { acceptanceScratch: null, warning: null });
  });

  it('reads a valid file and resolves the default base dir next to it', () => {
    writeRaw({ version: 1, acceptanceScratch: { env: ['TEAMWORK_TEST_SCRATCH_ROOT'] } });
    const settings = readSettingsFile(file);
    assert.equal(settings.warning, null);
    assert.deepEqual(resolveAcceptanceScratch(settings, file), { env: ['TEAMWORK_TEST_SCRATCH_ROOT'], baseDir: path.join(path.dirname(file), 'acceptance-scratch') });
    writeRaw({ version: 1, acceptanceScratch: { env: ['X'], baseDir: '/var/tmp/cp' } });
    assert.equal(resolveAcceptanceScratch(readSettingsFile(file), file).baseDir, '/var/tmp/cp');
    assert.equal(resolveAcceptanceScratch({ acceptanceScratch: null }, file), null);
  });

  it('an invalid or unreadable file enables nothing and warns', () => {
    for (const raw of ['{ nope', { version: 2 }, { version: 1, acceptanceScratch: { env: ['PATH'] } }, { version: 1, other: true }, [1]]) {
      writeRaw(raw);
      const settings = readSettingsFile(file);
      assert.equal(settings.acceptanceScratch, null);
      assert.match(settings.warning, /Project settings ignored/);
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.match(readSettingsFile(file).warning, /cannot read/);
    assert.throws(() => validateSettingsDocument({ version: 1, x: 1 }), /Unknown settings field/);
  });
});
