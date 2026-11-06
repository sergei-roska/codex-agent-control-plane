'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) reject(new Error(`Child exited ${code ?? signal}: ${stderr || stdout}`));
      else resolve(stdout.trim());
    });
  });
}

test('missing or invalid file gives the default state', (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const empty = { version: 1, active: null, selectionRevision: 0, autoSwitch: false, profiles: [] };
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
  assert.deepEqual(fs.readdirSync(accountsDir).sort(), ['profiles.json', 'profiles.json.lockdb']);
  assert.equal(fs.statSync(path.join(accountsDir, 'profiles.json.lockdb')).mode & 0o777, 0o600);
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

test('active selection compare-and-set rejects stale revisions', (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  profiles.addProfile({ name: 'one' });
  profiles.addProfile({ name: 'two' });
  const independentStore = createAccountProfiles({ accountsDir });
  const initial = profiles.read();
  const selected = profiles.setActiveIfRevision(initial.selectionRevision, 'one');
  assert.equal(selected.active, 'one');
  assert.equal(selected.selectionRevision, initial.selectionRevision + 1);
  independentStore.setActive('two');
  assert.equal(profiles.setActiveIfRevision(selected.selectionRevision, null), null);
  assert.equal(profiles.read().active, 'two');
});

test('public write is locked and cannot reset the active selection revision', (t) => {
  const { base, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  profiles.addProfile({ name: 'one' });
  const before = profiles.read();
  profiles.write({ ...before, active: 'one' });
  const written = profiles.read();
  assert.equal(written.selectionRevision, before.selectionRevision + 1);
  assert.equal(profiles.setActiveIfRevision(before.selectionRevision, null), null);
  assert.equal(profiles.read().active, 'one');
});

test('separate processes serialize a stale CAS before a newer owner activation', async (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  profiles.addProfile({ name: 'b' });
  profiles.addProfile({ name: 'c' });
  const staleRevision = profiles.read().selectionRevision;
  const casReady = path.join(base, 'cas-ready');
  const continueCas = path.join(base, 'continue-cas');
  const ownerStarted = path.join(base, 'owner-started');
  const ownerDone = path.join(base, 'owner-done');
  const modulePath = path.resolve(__dirname, '../src/account-profiles');
  const casScript = `
    const fs = require('node:fs');
    const { createAccountProfiles } = require(${JSON.stringify(modulePath)});
    const nativeWriteFileSync = fs.writeFileSync.bind(fs);
    let paused = false;
    fs.writeFileSync = (filePath, ...args) => {
      if (!paused && String(filePath).endsWith('.tmp')) {
        paused = true;
        nativeWriteFileSync(${JSON.stringify(casReady)}, 'ready');
        while (!fs.existsSync(${JSON.stringify(continueCas)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return nativeWriteFileSync(filePath, ...args);
    };
    const profiles = createAccountProfiles({ accountsDir: ${JSON.stringify(accountsDir)} });
    const result = profiles.setActiveIfRevision(${staleRevision}, 'b');
    process.stdout.write(JSON.stringify({ active: result?.active ?? null }));
  `;
  const ownerScript = `
    const fs = require('node:fs');
    const { createAccountProfiles } = require(${JSON.stringify(modulePath)});
    fs.writeFileSync(${JSON.stringify(ownerStarted)}, 'started');
    const profiles = createAccountProfiles({ accountsDir: ${JSON.stringify(accountsDir)} });
    const result = profiles.setActive('c');
    fs.writeFileSync(${JSON.stringify(ownerDone)}, 'done');
    process.stdout.write(JSON.stringify({ active: result.active }));
  `;
  const cas = spawn(process.execPath, ['-e', casScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  let owner;
  try {
    await waitForFile(casReady);
    owner = spawn(process.execPath, ['-e', ownerScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForFile(ownerStarted);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ownerWasSerialized = !fs.existsSync(ownerDone);
    fs.writeFileSync(continueCas, 'continue');
    const [casResult, ownerResult] = await Promise.all([waitForExit(cas), waitForExit(owner)]);
    assert.equal(ownerWasSerialized, true, 'owner activation must wait for the CAS critical section');
    assert.deepEqual(JSON.parse(casResult), { active: 'b' });
    assert.deepEqual(JSON.parse(ownerResult), { active: 'c' });
    assert.equal(profiles.read().active, 'c');
  } finally {
    if (!fs.existsSync(continueCas)) fs.writeFileSync(continueCas, 'continue');
    if (cas.exitCode === null) cas.kill();
    if (owner?.exitCode === null) owner.kill();
  }
});

test('a stale CAS waits behind an owner write and is rejected after that write', async (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  profiles.addProfile({ name: 'b' });
  profiles.addProfile({ name: 'c' });
  const staleRevision = profiles.read().selectionRevision;
  const ownerReady = path.join(base, 'owner-ready');
  const continueOwner = path.join(base, 'continue-owner');
  const casStarted = path.join(base, 'cas-started');
  const modulePath = path.resolve(__dirname, '../src/account-profiles');
  const ownerScript = `
    const fs = require('node:fs');
    const { createAccountProfiles } = require(${JSON.stringify(modulePath)});
    const nativeWriteFileSync = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (filePath, ...args) => {
      if (!String(filePath).endsWith('.tmp')) return nativeWriteFileSync(filePath, ...args);
      nativeWriteFileSync(${JSON.stringify(ownerReady)}, 'ready');
      while (!fs.existsSync(${JSON.stringify(continueOwner)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return nativeWriteFileSync(filePath, ...args);
    };
    const result = createAccountProfiles({ accountsDir: ${JSON.stringify(accountsDir)} }).setActive('c');
    process.stdout.write(JSON.stringify({ active: result.active }));
  `;
  const casScript = `
    const fs = require('node:fs');
    const { createAccountProfiles } = require(${JSON.stringify(modulePath)});
    fs.writeFileSync(${JSON.stringify(casStarted)}, 'started');
    const result = createAccountProfiles({ accountsDir: ${JSON.stringify(accountsDir)} }).setActiveIfRevision(${staleRevision}, 'b');
    process.stdout.write(JSON.stringify({ active: result?.active ?? null }));
  `;
  const owner = spawn(process.execPath, ['-e', ownerScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  let cas;
  try {
    await waitForFile(ownerReady);
    cas = spawn(process.execPath, ['-e', casScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForFile(casStarted);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(continueOwner, 'continue');
    const [ownerResult, casResult] = await Promise.all([waitForExit(owner), waitForExit(cas)]);
    assert.deepEqual(JSON.parse(ownerResult), { active: 'c' });
    assert.deepEqual(JSON.parse(casResult), { active: null });
    assert.equal(profiles.read().active, 'c');
  } finally {
    if (!fs.existsSync(continueOwner)) fs.writeFileSync(continueOwner, 'continue');
    if (owner.exitCode === null) owner.kill();
    if (cas?.exitCode === null) cas.kill();
  }
});

test('the profile lock is released when its owning process exits mid-write', async (t) => {
  const { base, accountsDir, profiles } = setup();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  profiles.addProfile({ name: 'c' });
  const lockHeld = path.join(base, 'lock-held');
  const modulePath = path.resolve(__dirname, '../src/account-profiles');
  const script = `
    const fs = require('node:fs');
    const { createAccountProfiles } = require(${JSON.stringify(modulePath)});
    const nativeWriteFileSync = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (filePath, ...args) => {
      if (String(filePath).endsWith('.tmp')) {
        nativeWriteFileSync(${JSON.stringify(lockHeld)}, 'held');
        process.exit(73);
      }
      return nativeWriteFileSync(filePath, ...args);
    };
    createAccountProfiles({ accountsDir: ${JSON.stringify(accountsDir)} }).setActive('c');
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exit = new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  await waitForFile(lockHeld);
  const stopped = await exit;
  assert.equal(stopped.code, 73, stopped.stderr);
  const startedAt = Date.now();
  profiles.setActive('c');
  assert.equal(Date.now() - startedAt < 2000, true, 'the next writer should not wait for stale lock cleanup');
  assert.equal(profiles.read().active, 'c');
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
