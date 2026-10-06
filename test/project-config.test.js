'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProjectConfig, renderCommitMessage, defaultProjectConfigPath, DEFAULT_CONFIG } = require('../src/project-config');

function write(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcfg-'));
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}
const load = (obj) => loadProjectConfig({ filePath: write(obj) });
const check = (id = 'unit') => ({ id, argv: ['npm', 'test'] });

test('missing file yields defaults with no checks', () => {
  const cfg = loadProjectConfig({ filePath: path.join(os.tmpdir(), 'nope-none', 'project.json') });
  assert.equal(cfg.source, 'defaults');
  assert.equal(cfg.baseRef, 'main');
  assert.deepEqual(cfg.checks, []);
  assert.deepEqual(cfg.branchPrefixes, { feature: 'feature/', bugfix: 'fix/', docs: 'docs/' });
  assert.match(cfg.revision, /^[0-9a-f]{64}$/);
  assert.equal(loadProjectConfig({}).revision, cfg.revision);
});

test('valid file: revision is sha256 of bytes, check defaults applied', () => {
  const text = JSON.stringify({ baseRef: 'develop', checks: [{ ...check(), description: 'Unit' }] });
  const cfg = loadProjectConfig({ filePath: write(text) });
  assert.equal(cfg.source, 'file');
  assert.equal(cfg.revision, crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(cfg.baseRef, 'develop');
  assert.deepEqual(cfg.checks, [{ id: 'unit', argv: ['npm', 'test'], timeoutMs: 600000, description: 'Unit' }]);
});

test('unknown keys rejected at every level', () => {
  assert.throws(() => load({ extra: 1 }), /unknown field/);
  assert.throws(() => load({ branchPrefixes: { other: 'x/' } }), /unknown field/);
  assert.throws(() => load({ checks: [{ ...check(), extra: 1 }] }), /unknown field/);
});

test('baseRef boundaries', () => {
  assert.throws(() => load({ baseRef: '' }), /baseRef/);
  assert.throws(() => load({ baseRef: '   ' }), /baseRef/);
  assert.equal(load({ baseRef: 'a'.repeat(200) }).baseRef.length, 200);
  assert.throws(() => load({ baseRef: 'a'.repeat(201) }), /baseRef/);
});

test('branch prefix rules', () => {
  assert.equal(load({ branchPrefixes: { feature: 'feat-' } }).branchPrefixes.feature, 'feat-');
  assert.throws(() => load({ branchPrefixes: { feature: 'feat' } }), /branchPrefixes/);
  assert.throws(() => load({ branchPrefixes: { feature: 'Feat/' } }), /branchPrefixes/);
  assert.throws(() => load({ branchPrefixes: { feature: '/feat/' } }), /branchPrefixes/);
  assert.throws(() => load({ branchPrefixes: { feature: `${'a'.repeat(31)}/` } }), /branchPrefixes/);
  assert.equal(load({ branchPrefixes: { feature: `${'a'.repeat(30)}/` } }).branchPrefixes.feature.length, 31);
});

test('checks: limits, uniqueness, description, acceptance rules reused', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => check(`c${i}`));
  assert.equal(load({ checks: many(20) }).checks.length, 20);
  assert.throws(() => load({ checks: many(21) }), /more than 20/);
  assert.throws(() => load({ checks: [check('a'), check('a')] }), /duplicated/);
  assert.throws(() => load({ checks: [check('a'), ...many(9).map((c) => ({ ...c, id: `x${c.id}` })), check('a')] }), /duplicated/);
  assert.throws(() => load({ checks: [{ ...check(), description: 'd'.repeat(201) }] }), /description/);
  assert.equal(load({ checks: [{ ...check(), description: 'd'.repeat(200) }] }).checks[0].description.length, 200);
  assert.throws(() => load({ checks: [{ id: 'bad id', argv: ['x'] }] }), /id/);
  assert.throws(() => load({ checks: [{ id: 'a', argv: [] }] }), /argv/);
  assert.throws(() => load({ checks: [{ id: 'a', argv: ['x'], timeoutMs: 1800001 }] }), /timeoutMs/);
});

test('invalid JSON and non-object rejected', () => {
  assert.throws(() => load('{nope'), /not valid JSON/);
  assert.throws(() => load('[]'), /must be an object/);
});

test('defaultProjectConfigPath', () => {
  assert.equal(defaultProjectConfigPath('/var/state/s.json', {}), '/var/state/project.json');
  assert.equal(defaultProjectConfigPath('/var/state/s.json', { CODEX_PROJECT_CONFIG: '/x/p.json' }), '/x/p.json');
});

test('rolePack defaults to delivery, accepts legacy-orch, is strict and changes the revision', () => {
  const defaults = loadProjectConfig({ filePath: path.join(os.tmpdir(), 'nope-none', 'project.json') });
  assert.equal(defaults.rolePack, 'delivery');
  assert.equal(load({}).rolePack, 'delivery');
  assert.equal(load({ rolePack: 'delivery' }).rolePack, 'delivery');
  assert.equal(load({ rolePack: 'legacy-orch' }).rolePack, 'legacy-orch');
  assert.notEqual(load({ rolePack: 'legacy-orch' }).revision, load({ rolePack: 'delivery' }).revision);
  for (const bad of ['orch', 'Delivery', '', null, 1, ['delivery']]) {
    assert.throws(() => load({ rolePack: bad }), /rolePack must be one of/, JSON.stringify(bad));
  }
});

test('delivery.remotes defaults to origin, validates names and count, and changes the revision', () => {
  const defaults = loadProjectConfig({ filePath: path.join(os.tmpdir(), 'nope-none', 'project.json') });
  assert.deepEqual(defaults.delivery, { remotes: ['origin'] });
  assert.deepEqual(load({}).delivery, { remotes: ['origin'] });
  assert.deepEqual(load({ delivery: { remotes: ['origin', 'up.stream_1'] } }).delivery.remotes, ['origin', 'up.stream_1']);
  assert.equal(load({ delivery: { remotes: Array.from({ length: 10 }, (_, i) => `r${i}`) } }).delivery.remotes.length, 10);
  assert.equal(load({ delivery: { remotes: ['a'.repeat(100)] } }).delivery.remotes[0].length, 100);
  assert.notEqual(load({ delivery: { remotes: ['origin', 'mirror'] } }).revision, load({}).revision);
  assert.throws(() => load({ delivery: { remotes: [] } }), /delivery.remotes/);
  assert.throws(() => load({ delivery: { remotes: Array.from({ length: 11 }, (_, i) => `r${i}`) } }), /delivery.remotes/);
  assert.throws(() => load({ delivery: { remotes: 'origin' } }), /delivery.remotes/);
  assert.throws(() => load({ delivery: { remotes: ['bad name'] } }), /delivery.remotes entries/);
  assert.throws(() => load({ delivery: { remotes: ['a'.repeat(101)] } }), /delivery.remotes entries/);
  assert.throws(() => load({ delivery: { remotes: [1] } }), /delivery.remotes entries/);
  for (const bad of ['-x', '--upload-pack=evil', '.hidden', '_x']) {
    assert.throws(() => load({ delivery: { remotes: [bad] } }), /delivery.remotes entries/, bad);
  }
  assert.throws(() => load({ delivery: { other: 1 } }), /unknown field/);
  assert.throws(() => load({ delivery: [] }), /delivery must be an object/);
});

test('adaptiveRoute is absent from the defaults and when off, kept for shadow and on, and strict', () => {
  const defaults = loadProjectConfig({ filePath: path.join(os.tmpdir(), 'nope-none', 'project.json') });
  assert.equal('adaptiveRoute' in defaults, false);
  assert.equal('adaptiveRoute' in DEFAULT_CONFIG, false);
  const omitted = load({});
  const off = load({ adaptiveRoute: 'off' });
  assert.equal('adaptiveRoute' in off, false);
  const { revision: offRevision, ...offRest } = off;
  const { revision: omittedRevision, ...omittedRest } = omitted;
  assert.deepEqual(offRest, omittedRest);
  assert.equal(load({ adaptiveRoute: 'shadow' }).adaptiveRoute, 'shadow');
  assert.equal(load({ adaptiveRoute: 'on' }).adaptiveRoute, 'on');
  assert.throws(() => load({ adaptiveRoute: 'maybe' }), /adaptiveRoute must be one of/);
  assert.throws(() => load({ adaptiveRoute: true }), /adaptiveRoute must be one of/);
});

test('delivery.commitMessageTemplate: optional, strict, rendered with key or title only', () => {
  assert.equal('commitMessageTemplate' in load({}).delivery, false);
  assert.equal(load({ delivery: { commitMessageTemplate: '[{key}] {title}' } }).delivery.commitMessageTemplate, '[{key}] {title}');
  assert.equal(renderCommitMessage(undefined, { key: 'CDB-364', title: 'cdb_programme_archive strict comparison' }),
    'CDB-364: cdb_programme_archive strict comparison');
  assert.equal(renderCommitMessage('{key}: {title}', { title: 'Fix it' }), 'Fix it');
  assert.equal(renderCommitMessage('{key} - {title}', { title: 'Fix it' }), 'Fix it');
  assert.equal(renderCommitMessage('fix({key}): {title}', { key: 'CDB-1', title: 'a\nb  c' }), 'fix(CDB-1): a b c');
  assert.equal(renderCommitMessage('{title}', { key: 'CDB-1', title: 'x'.repeat(3000) }).length, 2000);
  for (const bad of ['{key}: only', '{title} {other}', '{title}\nx', '{title}\r', '', 5, 'x{title}'.padEnd(201, 'x')]) {
    assert.throws(() => load({ delivery: { commitMessageTemplate: bad } }), /commitMessageTemplate/, String(bad));
  }
});
