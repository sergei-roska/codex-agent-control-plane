'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');
const {
  ProjectSettingsError, normalizeAcceptanceScratch, normalizeOwnerChecks, validateSettingsDocument, readSettingsFile, resolveAcceptanceScratch,
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

describe('normalizeOwnerChecks', () => {
  const refuse = (value, pattern) => assert.throws(() => normalizeOwnerChecks(value), (error) => error instanceof ProjectSettingsError && pattern.test(error.message));

  it('is disabled for undefined, null, and an empty array', () => {
    assert.equal(normalizeOwnerChecks(undefined), null);
    assert.equal(normalizeOwnerChecks(null), null);
    assert.equal(normalizeOwnerChecks([]), null);
  });

  it('accepts 1..8 command strings and trims them', () => {
    assert.deepEqual(normalizeOwnerChecks(['npm test']), ['npm test']);
    assert.deepEqual(normalizeOwnerChecks(['  uv run pytest -q  ', 'node scripts/lint.js']), ['uv run pytest -q', 'node scripts/lint.js']);
    const eight = Array.from({ length: 8 }, (_, i) => `cmd${i}`);
    assert.deepEqual(normalizeOwnerChecks(eight), eight);
  });

  it('rejects bad shapes, entries, counts, and unparsable commands', () => {
    refuse('npm test', /must be an array/);
    refuse({ 0: 'npm test' }, /must be an array/);
    refuse(5, /must be an array/);
    refuse(Array.from({ length: 9 }, (_, i) => `cmd${i}`), /more than 8/);
    refuse([''], /non-empty command string/);
    refuse(['   '], /non-empty command string/);
    refuse(['npm test', 7], /ownerChecks\[1\] must be a non-empty command string/);
    refuse([null], /non-empty command string/);
    refuse([['npm', 'test']], /non-empty command string/);
    // parses to an argv that the owner contract refuses (argument over the length limit)
    refuse([`node ${'x'.repeat(5000)}`], /not a valid check list/);
  });
});

describe('settings file', () => {
  it('missing file means everything disabled', () => {
    assert.deepEqual(readSettingsFile(file), { acceptanceScratch: null, ownerChecks: null, aut03LeadSkillEnabled: false, executionPermissions: 'inherit', deliveryEngine: 'legacy', warning: null });
  });

  it('reads a valid file and resolves the default base dir next to it', () => {
    writeRaw({ version: 1, acceptanceScratch: { env: ['TEAMWORK_TEST_SCRATCH_ROOT'] } });
    const settings = readSettingsFile(file);
    assert.equal(settings.warning, null);
    assert.equal(settings.aut03LeadSkillEnabled, false);
    assert.equal(settings.executionPermissions, 'inherit');
    assert.deepEqual(resolveAcceptanceScratch(settings, file), { env: ['TEAMWORK_TEST_SCRATCH_ROOT'], baseDir: path.join(path.dirname(file), 'acceptance-scratch') });
    writeRaw({ version: 1, acceptanceScratch: { env: ['X'], baseDir: '/var/tmp/cp' } });
    assert.equal(resolveAcceptanceScratch(readSettingsFile(file), file).baseDir, '/var/tmp/cp');
    assert.equal(resolveAcceptanceScratch({ acceptanceScratch: null }, file), null);
    writeRaw({ version: 1, aut03LeadSkillEnabled: true });
    assert.equal(readSettingsFile(file).aut03LeadSkillEnabled, true);
  });

  it('reads ownerChecks; absent, null, and [] are disabled', () => {
    writeRaw({ version: 1, ownerChecks: ['npm test', 'node scripts/lint.js'] });
    const settings = readSettingsFile(file);
    assert.equal(settings.warning, null);
    assert.deepEqual(settings.ownerChecks, ['npm test', 'node scripts/lint.js']);
    for (const doc of [{ version: 1 }, { version: 1, ownerChecks: null }, { version: 1, ownerChecks: [] }]) {
      writeRaw(doc);
      const disabled = readSettingsFile(file);
      assert.equal(disabled.warning, null);
      assert.equal(disabled.ownerChecks, null);
    }
  });

  it('defaults execution permissions to native inheritance and accepts explicit strict and full-access modes', () => {
    writeRaw({ version: 1 });
    assert.equal(readSettingsFile(file).executionPermissions, 'inherit');
    writeRaw({ version: 1, executionPermissions: 'strict' });
    assert.equal(readSettingsFile(file).executionPermissions, 'strict');
    writeRaw({ version: 1, executionPermissions: 'full-access' });
    assert.equal(readSettingsFile(file).executionPermissions, 'full-access');
    writeRaw({ version: 1, executionPermissions: 'danger-full-access' });
    const invalid = readSettingsFile(file);
    assert.equal(invalid.executionPermissions, 'strict');
    assert.match(invalid.warning, /executionPermissions/);
  });

  it('selects the concurrent engine only when explicitly configured and warns on invalid values', () => {
    writeRaw({ version: 1 });
    assert.equal(readSettingsFile(file).deliveryEngine, 'legacy');
    writeRaw({ version: 1, deliveryEngine: 'concurrent-v1' });
    assert.equal(readSettingsFile(file).deliveryEngine, 'concurrent-v1');
    writeRaw({ version: 1, deliveryEngine: 'unknown' });
    const invalid = readSettingsFile(file);
    assert.equal(invalid.deliveryEngine, 'legacy');
    assert.equal(invalid.executionPermissions, 'strict');
    assert.match(invalid.warning, /deliveryEngine/);
  });

  it('an invalid ownerChecks setting ignores the whole file and warns', () => {
    for (const ownerChecks of ['npm test', [1], [''], Array.from({ length: 9 }, (_, i) => `c${i}`), { a: 1 }]) {
      writeRaw({ version: 1, acceptanceScratch: { env: ['X'] }, ownerChecks });
      const settings = readSettingsFile(file);
      assert.equal(settings.ownerChecks, null);
      assert.equal(settings.acceptanceScratch, null);
      assert.match(settings.warning, /Project settings ignored.*ownerChecks/);
    }
    assert.throws(() => validateSettingsDocument({ version: 1, ownerChecks: [7] }), /ownerChecks\[0\]/);
  });

  it('an invalid or unreadable file enables nothing and warns', () => {
    for (const raw of ['{ nope', { version: 2 }, { version: 1, acceptanceScratch: { env: ['PATH'] } }, { version: 1, other: true }, [1], ...[null, 0, 1, 'true', {}].map((value) => ({ version: 1, aut03LeadSkillEnabled: value }))]) {
      writeRaw(raw);
      const settings = readSettingsFile(file);
      assert.equal(settings.acceptanceScratch, null);
      assert.equal(settings.aut03LeadSkillEnabled, false);
      assert.equal(settings.executionPermissions, 'strict');
      assert.match(settings.warning, /Project settings ignored/);
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    const unreadable = readSettingsFile(file);
    assert.equal(unreadable.executionPermissions, 'strict');
    assert.match(unreadable.warning, /cannot read/);
    assert.throws(() => validateSettingsDocument({ version: 1, x: 1 }), /Unknown settings field/);
  });
});

describe('module loading', () => {
  it('loads project-settings first without a circular-dependency warning and acceptance-scratch works', () => {
    const script = [
      "const settings = require('./src/project-settings.js');",
      "settings.normalizeOwnerChecks(['npm test']);",
      "const scratch = require('./src/acceptance-scratch.js');",
      "if (typeof scratch.provisionScratch !== 'function') throw new Error('provisionScratch missing');",
      "require('./src/acceptance.js');",
    ].join('\n');
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, ['--trace-warnings', '-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /circular dependency/i);
    assert.equal(result.stderr, '');
  });
});
