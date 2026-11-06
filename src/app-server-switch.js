'use strict';

const { CodexAppServer } = require('./codex-app-server');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { providerIdentityFor } = require('./delivery-provider-identity');

function canonicalHome(home) {
  try { return fs.realpathSync(home); }
  catch (_) { return path.resolve(home); }
}

// Forwarding wrapper that moves the App Server to another CODEX_HOME without interrupting a turn.
// The swap happens only when no run/execCommand is in flight, and is serialized.
function createSwitchingAppServer({
  profiles,
  baseOptions = {},
  onCallBound = null,
  create = (codexHome) => new CodexAppServer({ ...baseOptions, ...(codexHome ? { codexHome } : {}) }),
} = {}) {
  if (!profiles || typeof profiles.activeHome !== 'function') throw new TypeError('profiles.activeHome is required');
  let current = null;
  let currentHome = null;
  let currentIdentityHome = null;
  let currentGenerationAccountId = null;
  let inFlight = 0;
  let swapping = null;
  let closed = false;
  const expectedHomePreflightErrors = new WeakSet();

  function accountIdForGeneration(home) {
    try { return providerIdentityFor(home).accountId; }
    catch (_) { return null; }
  }

  function createCurrent(home, identityHome) {
    current = create(home);
    currentGenerationAccountId = accountIdForGeneration(identityHome);
  }

  function instance() {
    if (!current) {
      const home = profiles.activeHome();
      const identityHome = canonicalHome(home || baseOptions.codexHome
        || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
      const next = create(home);
      current = next;
      currentHome = home;
      currentIdentityHome = identityHome;
      currentGenerationAccountId = accountIdForGeneration(identityHome);
    }
    return current;
  }

  function needsSwap() {
    return current !== null && profiles.activeHome() !== currentHome;
  }

  function swap() {
    const old = current;
    const nextHome = profiles.activeHome();
    const nextIdentityHome = canonicalHome(nextHome || baseOptions.codexHome
      || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const next = create(nextHome);
    current = next;
    currentHome = nextHome;
    currentIdentityHome = nextIdentityHome;
    currentGenerationAccountId = accountIdForGeneration(nextIdentityHome);
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

  async function ensureBoundGeneration() {
    for (;;) {
      await settle();
      instance();
      const identity = providerIdentityFor(currentIdentityHome);
      if (identity.accountId === currentGenerationAccountId) {
        return { target: current, identityHome: currentIdentityHome, accountId: currentGenerationAccountId };
      }
      if (inFlight > 0) {
        throw Object.assign(new Error('Provider identity changed while the current App Server generation is in use'), {
          code: 'provider_identity_generation_busy',
        });
      }
      const old = current;
      const home = currentHome;
      const identityHome = currentIdentityHome;
      const rotation = (async () => {
        await old?.close?.();
        createCurrent(home, identityHome);
      })();
      swapping = rotation.finally(() => { swapping = null; });
      await swapping;
    }
  }

  async function tracked(method, args) {
    await settle();
    const options = args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : null;
    const expectedCodexHome = options?.expectedCodexHome;
    const callBinding = method === 'run' ? options?.callBinding : null;
    let boundGeneration = null;
    if (callBinding) {
      for (;;) {
        boundGeneration = await ensureBoundGeneration();
        if (boundGeneration.target === current && !needsSwap()) break;
        if (inFlight > 0) {
          throw Object.assign(new Error('Provider home changed while the current App Server generation is in use'), {
            code: 'provider_home_switch_busy',
          });
        }
      }
    }
    const target = boundGeneration?.target || instance();
    const identityHome = boundGeneration?.identityHome || currentIdentityHome;
    if (expectedCodexHome !== undefined && expectedCodexHome !== identityHome) {
      const cause = Object.assign(new Error('The active Codex home changed after the provider thread was prepared'), {
        code: 'provider_home_changed', expectedCodexHome, actualCodexHome: identityHome,
      });
      expectedHomePreflightErrors.add(cause);
      throw cause;
    }
    const captureCodexHome = method === 'prepareThread' && options?.captureCodexHome === true;
    let targetArgs = args;
    if (options && ('expectedCodexHome' in options || 'captureCodexHome' in options)) {
      const { expectedCodexHome: _expectedCodexHome, captureCodexHome: _captureCodexHome, ...callOptions } = options;
      targetArgs = [callOptions, ...args.slice(1)];
    }
    if (callBinding && options) {
      const { callBinding: _callBinding, ...callOptions } = targetArgs[0];
      targetArgs = [callOptions, ...targetArgs.slice(1)];
    }
    inFlight += 1;
    try {
      if (callBinding) {
        if (typeof onCallBound !== 'function') {
          throw Object.assign(new Error('Provider call binding persistence is unavailable'), { code: 'provider_call_binding_unavailable' });
        }
        const fields = ['runId', 'attemptId', 'assignmentId'];
        if (!callBinding || typeof callBinding !== 'object'
          || fields.some((key) => typeof callBinding[key] !== 'string' || !callBinding[key])
          || !(callBinding.taskId === null || (typeof callBinding.taskId === 'string' && callBinding.taskId))) {
          throw Object.assign(new TypeError('Provider call binding requires runId, attemptId, assignmentId, and a taskId string or null'), { code: 'provider_call_binding_invalid' });
        }
        await onCallBound({
          runId: callBinding.runId,
          attemptId: callBinding.attemptId,
          assignmentId: callBinding.assignmentId,
          taskId: callBinding.taskId,
          invocationId: crypto.randomUUID(),
          accountId: boundGeneration.accountId,
          boundAt: new Date().toISOString(),
        });
        if (providerIdentityFor(identityHome).accountId !== boundGeneration.accountId) {
          throw Object.assign(new Error('Provider identity changed during call binding'), {
            code: 'provider_identity_changed_during_binding',
          });
        }
      }
      if (callBinding && providerIdentityFor(identityHome).accountId !== boundGeneration.accountId) {
        throw Object.assign(new Error('Provider identity changed before App Server invocation'), {
          code: 'provider_identity_changed_before_invocation',
        });
      }
      const result = await target[method](...targetArgs);
      return captureCodexHome && result && typeof result === 'object' && !Array.isArray(result)
        ? { ...result, codexHome: identityHome }
        : result;
    } finally {
      inFlight -= 1;
    }
  }

  function sameSelection(state, expected) {
    return state.active === expected.active
      && (expected.selectionRevision === undefined || state.selectionRevision === expected.selectionRevision);
  }

  function selectIfCurrent(expected, name) {
    if (typeof profiles.setActiveIfRevision === 'function' && expected.selectionRevision !== undefined) {
      return profiles.setActiveIfRevision(expected.selectionRevision, name);
    }
    const state = profiles.read();
    if (!sameSelection(state, expected)) return null;
    profiles.setActive(name);
    return profiles.read();
  }

  function rollbackIfCurrent(selected, name) {
    if (typeof profiles.setActiveIfRevision === 'function' && selected.selectionRevision !== undefined) {
      profiles.setActiveIfRevision(selected.selectionRevision, name);
      return;
    }
    const state = profiles.read();
    if (sameSelection(state, selected)) profiles.setActive(name);
  }

  async function switchTo(name, expectedSelection = null) {
    const before = profiles.read();
    const expected = expectedSelection || before;
    if (!sameSelection(before, expected)) return 'busy';
    if (name !== null && before.active === name && !needsSwap()) return 'already_active';
    if (name === null && before.active === null && !needsSwap()) return 'already_active';
    if (swapping) {
      await swapping;
      if (!sameSelection(profiles.read(), expected)) return 'busy';
    }
    if (inFlight > 0) return 'busy';
    const selected = selectIfCurrent(expected, name);
    if (!selected) return 'busy';
    try {
      if (!current) instance();
      else await settle();
    } catch (error) {
      rollbackIfCurrent(selected, before.active);
      throw error;
    }
    const after = profiles.read();
    if (!sameSelection(after, selected)) return 'busy';
    return needsSwap() ? 'busy' : 'switched';
  }

  const wrapper = {
    run: (...args) => tracked('run', args),
    prepareThread: (...args) => tracked('prepareThread', args),
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
    setCallBindingHandler(handler) {
      if (handler !== null && typeof handler !== 'function') throw new TypeError('Call binding handler must be a function or null');
      onCallBound = handler;
    },
    callBindingVersion: 'call-bound/v1',
  };
  // Plain pass-throughs: the supervised App Server owns their semantics.
  for (const method of [
    'start', 'getAccount', 'readRateLimits', 'getVersion', 'supervisorState', 'resetSupervisor', 'processIdentity',
    'listHooks', 'hookInventory', 'listMcpServerNames', 'mcpInventory', 'mcpServerStatus', '_request',
  ]) {
    wrapper[method] = (...args) => instance()[method](...args);
  }
  wrapper.isExpectedHomePreflightError = (cause) => Boolean(cause && typeof cause === 'object' && expectedHomePreflightErrors.has(cause));
  return wrapper;
}

module.exports = { createSwitchingAppServer };
