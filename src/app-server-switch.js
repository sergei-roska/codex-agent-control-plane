'use strict';

const { CodexAppServer } = require('./codex-app-server');

// Forwarding wrapper that moves the App Server to another CODEX_HOME without interrupting a turn.
// The swap happens only when no run/execCommand is in flight, and is serialized.
function createSwitchingAppServer({
  profiles,
  baseOptions = {},
  create = (codexHome) => new CodexAppServer({ ...baseOptions, ...(codexHome ? { codexHome } : {}) }),
} = {}) {
  if (!profiles || typeof profiles.activeHome !== 'function') throw new TypeError('profiles.activeHome is required');
  let current = null;
  let currentHome = null;
  let inFlight = 0;
  let swapping = null;
  let closed = false;

  function instance() {
    if (!current) {
      currentHome = profiles.activeHome();
      current = create(currentHome);
    }
    return current;
  }

  function needsSwap() {
    return current !== null && profiles.activeHome() !== currentHome;
  }

  function swap() {
    const old = current;
    currentHome = profiles.activeHome();
    current = create(currentHome);
    swapping = (async () => {
      try {
        await old.close?.();
      } catch (_) { /* the old instance is gone either way */ } finally {
        swapping = null;
      }
    })();
    return swapping;
  }

  // Settles pending swaps and performs one when idle. Callers increment inFlight right after it
  // returns, with no await in between, so the idle check cannot be overtaken.
  async function settle() {
    for (;;) {
      if (swapping) { await swapping; continue; }
      if (!closed && inFlight === 0 && needsSwap()) { await swap(); continue; }
      return;
    }
  }

  async function tracked(method, args) {
    await settle();
    const target = instance();
    inFlight += 1;
    try {
      return await target[method](...args);
    } finally {
      inFlight -= 1;
    }
  }

  async function switchTo(name) {
    const before = profiles.read();
    if (name !== null && before.active === name && !needsSwap()) return 'already_active';
    if (name === null && before.active === null && !needsSwap()) return 'already_active';
    profiles.setActive(name);
    if (!current) { instance(); return 'switched'; }
    if (swapping) await swapping;
    if (inFlight > 0) return 'busy';
    await settle();
    return needsSwap() ? 'busy' : 'switched';
  }

  const wrapper = {
    run: (...args) => tracked('run', args),
    execCommand: (...args) => tracked('execCommand', args),
    resolveExecutionPermissions: (...args) => tracked('resolveExecutionPermissions', args),
    readConfig: (...args) => tracked('readConfig', args),
    switchTo,
    async close() {
      closed = true;
      if (swapping) await swapping;
      const target = current;
      current = null;
      if (target) await target.close?.();
    },
    getCodexHome: () => currentHome,
    get inFlight() { return inFlight; },
  };
  // Plain pass-throughs: the supervised App Server owns their semantics.
  for (const method of [
    'start', 'getAccount', 'readRateLimits', 'getVersion', 'supervisorState', 'resetSupervisor', 'processIdentity',
    'listHooks', 'hookInventory', 'listMcpServerNames', 'mcpInventory', 'mcpServerStatus', '_request',
  ]) {
    wrapper[method] = (...args) => instance()[method](...args);
  }
  return wrapper;
}

module.exports = { createSwitchingAppServer };
