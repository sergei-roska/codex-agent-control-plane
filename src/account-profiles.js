'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
const SHARED_ENTRIES = ['config.toml', 'AGENTS.md', 'hooks.json', 'hooks', 'rules'];
const FILE_NAME = 'profiles.json';
const PROFILE_LOCK_TIMEOUT_MS = 10_000;

function defaultState() {
  return { version: 1, active: null, selectionRevision: 0, autoSwitch: false, profiles: [] };
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
  const lockPath = `${filePath}.lockdb`;

  function readUnlocked() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return defaultState();
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.profiles)) return defaultState();
    const profiles = parsed.profiles.map((entry) => normalizeProfile(entry, root)).filter(Boolean);
    const active = typeof parsed.active === 'string' && profiles.some((profile) => profile.name === parsed.active) ? parsed.active : null;
    return {
      version: 1,
      active,
      selectionRevision: Number.isSafeInteger(parsed.selectionRevision) && parsed.selectionRevision >= 0
        ? parsed.selectionRevision : 0,
      autoSwitch: parsed.autoSwitch === true,
      profiles,
    };
  }

  function writeUnlocked(state) {
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

  function withProfileLock(callback) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    let db = null;
    let locked = false;
    try {
      db = new Database(lockPath, { timeout: PROFILE_LOCK_TIMEOUT_MS });
      if (db.readonly) throw new Error(`Account profile lock is not writable: ${lockPath}`);
      fs.chmodSync(lockPath, 0o600);
      db.pragma(`busy_timeout = ${PROFILE_LOCK_TIMEOUT_MS}`);
      db.pragma('journal_mode = DELETE');
      db.exec('CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY)');
      db.exec('BEGIN EXCLUSIVE');
      locked = true;
      db.exec('INSERT INTO holder DEFAULT VALUES');
      return callback();
    } catch (error) {
      if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
        throw new Error(`Account profile store is in use (lock: ${lockPath})`, { cause: error });
      }
      throw error;
    } finally {
      if (db) {
        if (locked) {
          try { db.exec('ROLLBACK'); } catch (_) { /* connection already closed */ }
        }
        try { db.close(); } catch (_) { /* best effort */ }
      }
    }
  }

  function read() {
    return readUnlocked();
  }

  function write(state) {
    return withProfileLock(() => {
      const current = readUnlocked();
      const currentRevision = current.selectionRevision;
      const suppliedRevision = Number.isSafeInteger(state?.selectionRevision) && state.selectionRevision >= 0
        ? state.selectionRevision : 0;
      const selectionRevision = state?.active !== current.active
        ? Math.max(currentRevision + 1, suppliedRevision)
        : Math.max(currentRevision, suppliedRevision);
      return writeUnlocked({ ...state, selectionRevision });
    });
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
    return withProfileLock(() => {
      const state = readUnlocked();
      if (state.profiles.some((profile) => profile.name === name)) throw new Error(`profile already exists: ${name}`);
      const home = ensureProfileHome(name);
      const profile = { name, home, email, planType, addedAt: new Date().toISOString() };
      state.profiles.push(profile);
      writeUnlocked(state);
      return profile;
    });
  }

  function removeProfile(name) {
    const dir = profileDir(name);
    return withProfileLock(() => {
      const state = readUnlocked();
      const entry = state.profiles.find((profile) => profile.name === name);
      if (!entry) return false;
      const target = path.resolve(entry.home);
      if (path.dirname(target) !== root || target !== path.resolve(dir)) {
        throw new Error(`refusing to remove a profile home outside the accounts directory: ${name}`);
      }
      state.profiles = state.profiles.filter((profile) => profile.name !== name);
      if (state.active === name) {
        state.active = null;
        state.selectionRevision += 1;
      }
      writeUnlocked(state);
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    });
  }

  function setActive(name) {
    return withProfileLock(() => {
      const state = readUnlocked();
      if (name !== null && !state.profiles.some((profile) => profile.name === name)) throw new Error(`unknown profile: ${name}`);
      state.active = name;
      state.selectionRevision += 1;
      writeUnlocked(state);
      return state;
    });
  }

  function setActiveIfRevision(expectedRevision, name) {
    return withProfileLock(() => {
      const state = readUnlocked();
      if (state.selectionRevision !== expectedRevision) return null;
      if (name !== null && !state.profiles.some((profile) => profile.name === name)) throw new Error(`unknown profile: ${name}`);
      state.active = name;
      state.selectionRevision += 1;
      writeUnlocked(state);
      return state;
    });
  }

  function setAutoSwitch(enabled) {
    return withProfileLock(() => {
      const state = readUnlocked();
      state.autoSwitch = enabled === true;
      writeUnlocked(state);
      return state;
    });
  }

  function activeHome() {
    const state = readUnlocked();
    if (!state.active) return null;
    return state.profiles.find((profile) => profile.name === state.active)?.home ?? null;
  }

  return {
    accountsDir: root, filePath, codexDefaultHome,
    read, write, ensureProfileHome, addProfile, removeProfile, setActive, setActiveIfRevision, setAutoSwitch, activeHome, validateName,
  };
}

module.exports = { createAccountProfiles, validateName, defaultState };
