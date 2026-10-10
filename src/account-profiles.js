'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const SHARED_ENTRIES = ['config.toml', 'AGENTS.md', 'hooks.json', 'hooks', 'rules'];
const FILE_NAME = 'profiles.json';

function defaultState() {
  return { version: 1, active: null, autoSwitch: false, profiles: [] };
}

function validateName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

function normalizeProfile(raw, accountsDir) {
  if (!raw || typeof raw !== 'object' || !validateName(raw.name)) return null;
  return {
    name: raw.name,
    home: typeof raw.home === 'string' && raw.home ? raw.home : path.join(accountsDir, raw.name),
    email: typeof raw.email === 'string' ? raw.email : null,
    planType: typeof raw.planType === 'string' ? raw.planType : null,
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : null,
  };
}

function createAccountProfiles({
  accountsDir = process.env.CODEX_A2A_ACCOUNTS_DIR || path.join(os.homedir(), '.codex-a2a', 'accounts'),
  codexDefaultHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
} = {}) {
  const root = path.resolve(accountsDir);
  const filePath = path.join(root, FILE_NAME);

  function read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return defaultState();
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.profiles)) return defaultState();
    const profiles = parsed.profiles.map((entry) => normalizeProfile(entry, root)).filter(Boolean);
    const active = typeof parsed.active === 'string' && profiles.some((profile) => profile.name === parsed.active) ? parsed.active : null;
    return { version: 1, active, autoSwitch: parsed.autoSwitch === true, profiles };
  }

  function write(state) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const temp = path.join(root, `.${FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, filePath);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch (_) { /* best effort */ }
      throw error;
    }
    return state;
  }

  function profileDir(name) {
    if (!validateName(name)) throw new TypeError('invalid profile name');
    return path.join(root, name);
  }

  function ensureProfileHome(name) {
    const dir = profileDir(name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const entry of SHARED_ENTRIES) {
      const source = path.join(codexDefaultHome, entry);
      if (!fs.existsSync(source)) continue;
      const link = path.join(dir, entry);
      try {
        fs.lstatSync(link);
        continue;
      } catch (_) { /* absent: create it */ }
      fs.symlinkSync(source, link);
    }
    return dir;
  }

  function addProfile({ name, email = null, planType = null } = {}) {
    if (!validateName(name)) throw new TypeError('profile name must match [a-z0-9-]{1,32}');
    const state = read();
    if (state.profiles.some((profile) => profile.name === name)) throw new Error(`profile already exists: ${name}`);
    const home = ensureProfileHome(name);
    const profile = { name, home, email, planType, addedAt: new Date().toISOString() };
    state.profiles.push(profile);
    write(state);
    return profile;
  }

  function removeProfile(name) {
    const dir = profileDir(name);
    const state = read();
    const entry = state.profiles.find((profile) => profile.name === name);
    if (!entry) return false;
    const target = path.resolve(entry.home);
    if (path.dirname(target) !== root || target !== path.resolve(dir)) {
      throw new Error(`refusing to remove a profile home outside the accounts directory: ${name}`);
    }
    state.profiles = state.profiles.filter((profile) => profile.name !== name);
    if (state.active === name) state.active = null;
    write(state);
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  }

  function setActive(name) {
    const state = read();
    if (name !== null && !state.profiles.some((profile) => profile.name === name)) throw new Error(`unknown profile: ${name}`);
    state.active = name;
    write(state);
    return state;
  }

  function setAutoSwitch(enabled) {
    const state = read();
    state.autoSwitch = enabled === true;
    write(state);
    return state;
  }

  function activeHome() {
    const state = read();
    if (!state.active) return null;
    return state.profiles.find((profile) => profile.name === state.active)?.home ?? null;
  }

  return {
    accountsDir: root, filePath, codexDefaultHome,
    read, write, ensureProfileHome, addProfile, removeProfile, setActive, setAutoSwitch, activeHome, validateName,
  };
}

module.exports = { createAccountProfiles, validateName, defaultState };
