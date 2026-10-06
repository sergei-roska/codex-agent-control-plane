'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { migrateProductSchema, MIGRATIONS } = require('../src/product-migrations');
const { EventJournal } = require('../src/event-journal');
const { createRoleRulesStore, MAX_RULE_CHARS, MAX_RULES, MAX_TOTAL_CHARS } = require('../src/role-rules-store');

async function setup({ roleExists, projectId = 'prj_a', db: shared, idBase = 0 } = {}) {
  const db = shared || new Database(':memory:');
  if (!shared) await migrateProductSchema({ db });
  const recorded = [];
  const events = { record: (type, info) => { recorded.push({ type, ...info }); return 1; } };
  let clock = Date.parse('2026-09-30T10:00:00.000Z');
  let n = idBase;
  const store = createRoleRulesStore({
    db, projectId, events, roleExists,
    now: () => new Date((clock += 1000)),
    randomId: (prefix) => `${prefix}${++n}`,
  });
  return { db, store, recorded };
}

let seq = 0;
const cmd = () => `cmd-${String(++seq).padStart(6, '0')}`;
const base = (over = {}) => ({ commandId: cmd(), packId: 'dlv', roleRuntimeId: 'dlv-builder', expectedRevisionId: null, ...over });
const add = (text, over = {}) => base({ text, ...over });

test('migration 7 applies on a v6 database and keeps existing data', async () => {
  const db = new Database(':memory:');
  await migrateProductSchema({ db });
  db.exec('DROP TABLE role_rules_revisions; DROP TABLE role_rules_current; DELETE FROM product_schema_migrations WHERE version = 7');
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'role_rules_current'").get().n, 0);
  const result = await migrateProductSchema({ db });
  assert.deepEqual([result.fromVersion, result.toVersion], [6, 7]);
  assert.equal(MIGRATIONS[MIGRATIONS.length - 1].name, 'role_rules');
  assert.deepEqual(db.prepare('PRAGMA table_info(role_rules_current)').all().map((c) => c.name),
    ['project_id', 'pack_id', 'role_runtime_id', 'rules_revision_id']);
  assert.equal(db.prepare('PRAGMA table_info(role_rules_revisions)').all().length, 11);
});

test('empty -> add -> edit -> add -> remove-last keeps stable ids and full history', async () => {
  const { store, recorded } = await setup();
  assert.equal(store.currentFor('dlv', 'dlv-builder'), null);
  assert.equal(store.effectiveRules('dlv', 'dlv-builder'), null);
  const a = store.addRule(add('Use tabs'));
  assert.equal(a.replayed, false);
  assert.equal(a.revision.rulesRevisionId, 'rr_2');
  assert.deepEqual(a.revision.rules, [{ ruleId: 'rl_1', text: 'Use tabs' }]);
  assert.equal(a.revision.changeKind, 'add');
  assert.equal(a.revision.changeRuleId, 'rl_1');
  assert.equal(a.revision.supersedesId, null);
  const e = store.editRule(base({ ruleId: 'rl_1', text: 'Use spaces', expectedRevisionId: 'rr_2' }));
  assert.deepEqual(e.revision.rules, [{ ruleId: 'rl_1', text: 'Use spaces' }]);
  assert.equal(e.revision.supersedesId, 'rr_2');
  const b = store.addRule(add('Run lint', { expectedRevisionId: e.revision.rulesRevisionId }));
  assert.deepEqual(b.revision.rules.map((r) => r.text), ['Use spaces', 'Run lint']);
  const r1 = store.removeRule(base({ ruleId: 'rl_1', expectedRevisionId: b.revision.rulesRevisionId }));
  assert.deepEqual(r1.revision.rules.map((r) => r.text), ['Run lint']);
  const r2 = store.removeRule(base({ ruleId: b.revision.rules[1].ruleId, expectedRevisionId: r1.revision.rulesRevisionId }));
  assert.deepEqual(r2.revision.rules, []);
  assert.equal(store.effectiveRules('dlv', 'dlv-builder'), null);
  assert.equal(store.currentFor('dlv', 'dlv-builder').rulesRevisionId, r2.revision.rulesRevisionId);
  const hist = store.history('dlv', 'dlv-builder');
  assert.deepEqual(hist.map((h) => [h.changeKind, h.ruleCount]), [['remove', 0], ['remove', 1], ['add', 2], ['edit', 1], ['add', 1]]);
  assert.deepEqual(Object.keys(hist[0]).sort(), ['actor', 'changeKind', 'changeRuleId', 'createdAt', 'ruleCount', 'rulesRevisionId']);
  assert.equal(store.history('dlv', 'dlv-builder', { limit: 2 }).length, 2);
  assert.deepEqual(recorded.map((r) => r.type).slice(0, 3), ['role_rule_added', 'role_rule_edited', 'role_rule_added']);
  assert.ok(recorded.every((r) => JSON.stringify(r.payload) === '{}' && !JSON.stringify(r).includes('Use spaces')));
});

test('effectiveRules returns plain strings of the current revision', async () => {
  const { store } = await setup();
  const a = store.addRule(add('one'));
  store.addRule(add('two', { expectedRevisionId: a.revision.rulesRevisionId }));
  const eff = store.effectiveRules('dlv', 'dlv-builder');
  assert.deepEqual(eff.rules, ['one', 'two']);
  assert.equal(eff.rulesRevisionId, store.currentFor('dlv', 'dlv-builder').rulesRevisionId);
  assert.equal(store.effectiveRules('dlv', 'other'), null);
});

test('stale expectedRevisionId raises stale_version with the current id', async () => {
  const { store } = await setup();
  const a = store.addRule(add('one'));
  assert.throws(() => store.addRule(add('two')), (e) => e.code === 'stale_version' && e.details.currentRevisionId === a.revision.rulesRevisionId);
  assert.throws(() => store.addRule(add('two', { expectedRevisionId: 'rr_nope' })), (e) => e.code === 'stale_version');
  assert.throws(() => store.removeRule(base({ ruleId: 'rl_1', expectedRevisionId: null })), (e) => e.code === 'stale_version');
});

test('commandId replay returns the same revision; different payload conflicts', async () => {
  const { store, recorded } = await setup();
  const body = add('one');
  const first = store.addRule(body);
  const again = store.addRule({ ...body });
  assert.equal(again.replayed, true);
  assert.equal(again.revision.rulesRevisionId, first.revision.rulesRevisionId);
  assert.equal(store.history('dlv', 'dlv-builder').length, 1);
  assert.equal(recorded.length, 1);
  assert.throws(() => store.addRule({ ...body, text: 'different' }), (e) => e.code === 'conflict');
});

test('unknown ruleId is not_found; unknown role is not_found', async () => {
  const { store } = await setup({ roleExists: (p, r) => p === 'dlv' && r === 'dlv-builder' });
  const a = store.addRule(add('one'));
  const exp = a.revision.rulesRevisionId;
  assert.throws(() => store.editRule(base({ ruleId: 'rl_zzz', text: 'x', expectedRevisionId: exp })), (e) => e.code === 'not_found');
  assert.throws(() => store.removeRule(base({ ruleId: 'rl_zzz', expectedRevisionId: exp })), (e) => e.code === 'not_found');
  assert.throws(() => store.addRule(add('x', { roleRuntimeId: 'ghost' })), (e) => e.code === 'not_found');
  assert.throws(() => store.addRule(add('x', { packId: 'other' })), (e) => e.code === 'not_found');
  assert.equal(store.history('dlv', 'dlv-builder').length, 1);
});

test('validation: text rules, limits and unknown fields', async () => {
  const { store } = await setup();
  const invalid = (fn, field) => assert.throws(fn, (e) => e.code === 'invalid_request' && e.details.some((d) => d.field === field));
  invalid(() => store.addRule(add('')), 'text');
  invalid(() => store.addRule(add('   \n\t ')), 'text');
  invalid(() => store.addRule(add(42)), 'text');
  invalid(() => store.addRule(add('x'.repeat(MAX_RULE_CHARS + 1))), 'text');
  invalid(() => store.addRule(add('bad\u0000char')), 'text');
  invalid(() => store.addRule(add('bell\u0007')), 'text');
  invalid(() => store.addRule(add('esc\u001b[0m')), 'text');
  invalid(() => store.addRule(add('x', { tools: ['shell'] })), 'tools');
  invalid(() => store.addRule(add('x', { packId: 'bad pack' })), 'packId');
  invalid(() => store.addRule(add('x', { expectedRevisionId: undefined })), 'expectedRevisionId');
  invalid(() => store.addRule({ ...add('x'), commandId: 'short' }), 'commandId');
  assert.equal(store.history('dlv', 'dlv-builder').length, 0);
  const ok = store.addRule(add(`  ${'x'.repeat(MAX_RULE_CHARS)}  `));
  assert.equal(ok.revision.rules[0].text.length, MAX_RULE_CHARS);
  const crlf = store.addRule(add('a\r\nb\tc', { expectedRevisionId: ok.revision.rulesRevisionId }));
  assert.equal(crlf.revision.rules[1].text, 'a\nb\tc');
});

test('validation: rule count and total text caps', async () => {
  const { store } = await setup();
  let exp = null;
  for (let i = 0; i < MAX_RULES; i += 1) exp = store.addRule(add(`r${i}`, { expectedRevisionId: exp })).revision.rulesRevisionId;
  assert.throws(() => store.addRule(add('one more', { expectedRevisionId: exp })), (e) => e.code === 'invalid_request' && e.details[0].field === 'rules');
  const other = await setup();
  let cur = null;
  for (let i = 0; i < 4; i += 1) cur = other.store.addRule(add('y'.repeat(MAX_RULE_CHARS), { expectedRevisionId: cur })).revision.rulesRevisionId;
  assert.equal(MAX_TOTAL_CHARS, 4 * MAX_RULE_CHARS);
  assert.throws(() => other.store.addRule(add('z', { expectedRevisionId: cur })), (e) => e.code === 'invalid_request');
  // Editing within the cap still works; growing past it does not.
  const first = other.store.currentFor('dlv', 'dlv-builder').rules[0].ruleId;
  assert.equal(other.store.editRule(base({ ruleId: first, text: 'short', expectedRevisionId: cur })).replayed, false);
});

test('isolation across roles, packs and projects', async () => {
  const { db, store } = await setup();
  store.addRule(add('builder rule'));
  assert.equal(store.currentFor('dlv', 'dlv-reviewer'), null);
  assert.equal(store.effectiveRules('dlv', 'dlv-reviewer'), null);
  assert.equal(store.currentFor('legacy', 'dlv-builder'), null);
  assert.deepEqual(store.history('dlv', 'dlv-reviewer'), []);
  const rev = store.addRule(add('reviewer rule', { roleRuntimeId: 'dlv-reviewer' }));
  assert.deepEqual(rev.revision.rules.map((r) => r.text), ['reviewer rule']);
  assert.deepEqual(store.effectiveRules('dlv', 'dlv-builder').rules, ['builder rule']);
  const { store: otherProject } = await setup({ db, projectId: 'prj_b', idBase: 1000 });
  assert.equal(otherProject.currentFor('dlv', 'dlv-builder'), null);
  assert.equal(otherProject.effectiveRules('dlv', 'dlv-builder'), null);
  assert.equal(otherProject.addRule(add('b rule')).revision.supersedesId, null);
  assert.deepEqual(store.effectiveRules('dlv', 'dlv-builder').rules, ['builder rule']);
});

test('the three rule events are recorded by the real journal without rule text', async () => {
  const db = new Database(':memory:');
  await migrateProductSchema({ db });
  const journal = new EventJournal({ db });
  journal.ensureSchema();
  const store = createRoleRulesStore({ db, projectId: 'prj_a', events: journal });
  const a = store.addRule(add('secret-rule-text'));
  const e = store.editRule(base({ ruleId: a.revision.rules[0].ruleId, text: 'secret-edited-text', expectedRevisionId: a.revision.rulesRevisionId }));
  store.removeRule(base({ ruleId: a.revision.rules[0].ruleId, expectedRevisionId: e.revision.rulesRevisionId }));
  const rows = db.prepare("SELECT * FROM runtime_events WHERE type LIKE 'role_rule_%' ORDER BY rowid").all();
  assert.deepEqual(rows.map((r) => r.type), ['role_rule_added', 'role_rule_edited', 'role_rule_removed']);
  assert.ok(rows.every((r) => !JSON.stringify(r).includes('secret-')));
});
