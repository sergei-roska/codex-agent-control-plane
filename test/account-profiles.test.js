'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountProfiles } = require('../src/account-profiles');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-accounts-'));
  const defaultHome = path.join(base, 'default');
  fs.mkdirSync(path.join(defaultHome, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(defaultHome, 'config.toml'), 'x = 1\n');
  fs.writeFileSync(path.join(defaultHome, 'AGENTS.md'), 'agents\n');
  fs.writeFileSync(path.join(defaultHome, 'auth.json'), '{"secret":true}');
  const accountsDir = path.join(base, 'accounts');
  const profiles = createAccountProfiles({ accountsDir, codexDefaultHome: defaultHome });
  return { base, defaultHome, accountsDir, profiles };
}

test('missing or invalid file gives the default state', (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const empty = { version: 1, active: null, autoSwitch: false, profiles: [] };
  assert.deepEqual(profiles.read(), empty);
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.writeFileSync(path.join(accountsDir, 'profiles.json'), '{not json');
  assert.deepEqual(profiles.read(), empty);
  fs.writeFileSync(path.join(accountsDir, 'profiles.json'), JSON.stringify({ version: 2, profiles: [] }));
  assert.deepEqual(profiles.read(), empty);
  assert.equal(profiles.activeHome(), null);
});

test('write is atomic with private modes and leaves no temp files', (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  profiles.write({ version: 1, active: null, autoSwitch: true, profiles: [] });
  assert.equal(fs.statSync(accountsDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(accountsDir, 'profiles.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(accountsDir), ['profiles.json']);
  assert.equal(profiles.read().autoSwitch, true);
});

test('ensureProfileHome links only existing shared entries and never auth.json', (t) => {
  const { base, defaultHome, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = profiles.ensureProfileHome('work');
  assert.equal(home, path.join(accountsDir, 'work'));
  assert.deepEqual(fs.readdirSync(home).sort(), ['AGENTS.md', 'config.toml', 'hooks']);
  assert.equal(fs.readlinkSync(path.join(home, 'config.toml')), path.join(defaultHome, 'config.toml'));
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
  profiles.ensureProfileHome('work');
});

test('validateName accepts [a-z0-9-]{1,32} only', () => {
  const { validateName } = createAccountProfiles({ accountsDir: os.tmpdir() });
  assert.equal(validateName('a1-b'), true);
  assert.equal(validateName('a'.repeat(32)), true);
  for (const bad of ['', 'A', 'a_b', 'a b', '../x', 'a'.repeat(33), null, 5]) assert.equal(validateName(bad), false);
  assert.throws(() => createAccountProfiles({ accountsDir: os.tmpdir() }).addProfile({ name: '../x' }), TypeError);
});

test('add, activate, auto-switch, activeHome and remove', (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const one = profiles.addProfile({ name: 'one', email: 'a@x.test', planType: 'plus' });
  profiles.addProfile({ name: 'two' });
  assert.throws(() => profiles.addProfile({ name: 'one' }), /already exists/);
  assert.equal(profiles.activeHome(), null);
  profiles.setActive('one');
  assert.equal(profiles.activeHome(), one.home);
  assert.throws(() => profiles.setActive('nope'), /unknown profile/);
  profiles.setAutoSwitch(true);
  assert.equal(profiles.read().autoSwitch, true);
  assert.equal(profiles.read().profiles[0].email, 'a@x.test');
  assert.equal(profiles.removeProfile('one'), true);
  assert.equal(fs.existsSync(one.home), false);
  assert.equal(profiles.read().active, null);
  assert.equal(profiles.activeHome(), null);
  assert.equal(profiles.removeProfile('one'), false);
  profiles.setActive(null);
  assert.equal(fs.existsSync(path.join(accountsDir, 'two')), true);
});

test('remove refuses a home outside the accounts directory', (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  profiles.write({ version: 1, active: null, autoSwitch: false, profiles: [{ name: 'evil', home: outside, email: null, planType: null, addedAt: null }] });
  assert.throws(() => profiles.removeProfile('evil'), /outside the accounts directory/);
  assert.equal(fs.existsSync(outside), true);
  assert.equal(fs.existsSync(accountsDir), true);
});
