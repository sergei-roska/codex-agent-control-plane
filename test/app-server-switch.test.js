'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createSwitchingAppServer } = require('../src/app-server-switch');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  const profiles = {
    home: null,
    activeHome() { return this.home; },
    name: null,
    selectionRevision: 0,
    read() { return { active: this.name, selectionRevision: this.selectionRevision }; },
    setActive(name) { this.name = name; this.home = name ? `/h/${name}` : null; this.selectionRevision += 1; },
    setActiveIfRevision(revision, name) {
      if (revision !== this.selectionRevision) return null;
      this.setActive(name);
      return this.read();
    },
  };
  const created = [];
  const create = (home) => {
    const gate = deferred();
    const inst = {
      home, closed: false, gate, calls: [],
      async start() { this.calls.push('start'); },
      async getAccount() { return { home }; },
      async readRateLimits() { return { home }; },
      getVersion() { return `v-${home}`; },
      supervisorState() { return { home }; },
      getCodexHome() { return home; },
      async run(args) { this.calls.push('run'); if (args?.hold) await gate.promise; return { home }; },
      async prepareThread(args) { this.calls.push('prepareThread'); if (args?.hold) await gate.promise; return { home, threadId: `thread-${home}` }; },
      async execCommand(args) { if (args?.hold) await gate.promise; return { home }; },
      async resolveExecutionPermissions(...args) { this.calls.push(['resolveExecutionPermissions', ...args]); return { home, args }; },
      async readConfig(cwd) { this.calls.push(['readConfig', cwd]); return { home, cwd }; },
      async close() { this.closed = true; },
    };
    created.push(inst);
    return inst;
  };
  return { profiles, created, wrapper: createSwitchingAppServer({ profiles, create }) };
}

test('forwards the App Server surface to the current instance', async () => {
  const { wrapper, created } = harness();
  await wrapper.start();
  assert.deepEqual(await wrapper.getAccount(), { home: null });
  assert.deepEqual(await wrapper.readRateLimits(), { home: null });
  assert.equal(wrapper.getVersion(), 'v-null');
  assert.deepEqual(wrapper.supervisorState(), { home: null });
  assert.equal(wrapper.getCodexHome(), null);
  assert.deepEqual(await wrapper.run({}), { home: null });
  assert.deepEqual(await wrapper.prepareThread({}), { home: null, threadId: 'thread-null' });
  assert.deepEqual(await wrapper.execCommand({}), { home: null });
  assert.deepEqual(await wrapper.resolveExecutionPermissions('/workspace', 'inherit'), { home: null, args: ['/workspace', 'inherit'] });
  assert.deepEqual(await wrapper.readConfig('/workspace'), { home: null, cwd: '/workspace' });
  assert.equal(created.length, 1);
});

test('no switch while a run is in flight; the next run after it switches', async () => {
  const { wrapper, created, profiles } = harness();
  const first = wrapper.run({ hold: true });
  await new Promise((r) => setImmediate(r));
  profiles.setActive('b');
  assert.deepEqual(await wrapper.run({}), { home: null });
  assert.equal(created.length, 1);
  created[0].gate.resolve();
  await first;
  assert.deepEqual(await wrapper.run({}), { home: '/h/b' });
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  assert.equal(wrapper.getCodexHome(), '/h/b');
});

test('an in-flight prepareThread blocks an account swap until preparation finishes', async () => {
  const { wrapper, created, profiles } = harness();
  const preparation = wrapper.prepareThread({ hold: true });
  await new Promise((r) => setImmediate(r));
  profiles.setActive('b');
  assert.equal(await wrapper.switchTo('b'), 'busy');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].calls, ['prepareThread']);
  created[0].gate.resolve();
  assert.deepEqual(await preparation, { home: null, threadId: 'thread-null' });
  assert.deepEqual(await wrapper.prepareThread({}), { home: '/h/b', threadId: 'thread-/h/b' });
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
});

test('a prepared thread carries its home pin and rejects a later profile swap before run', async () => {
  const { wrapper, created, profiles } = harness();
  profiles.setActive('a');
  const prepared = await wrapper.prepareThread({ captureCodexHome: true });
  assert.equal(prepared.codexHome, '/h/a');
  assert.deepEqual(created[0].calls, ['prepareThread']);

  profiles.setActive('b');
  let mismatch;
  await assert.rejects(wrapper.run({ expectedCodexHome: prepared.codexHome }), (error) => {
    mismatch = error;
    return error.code === 'provider_home_changed';
  });
  assert.equal(wrapper.isExpectedHomePreflightError(mismatch), true);
  assert.equal(wrapper.isExpectedHomePreflightError(Object.assign(new Error('spoof'), { code: 'provider_home_changed' })), false);
  assert.equal(created.length, 2);
  assert.deepEqual(created[0].calls, ['prepareThread']);
  assert.deepEqual(created[1].calls, []);
});

test('an in-flight execCommand also blocks the swap', async () => {
  const { wrapper, created, profiles } = harness();
  const exec = wrapper.execCommand({ hold: true });
  await new Promise((r) => setImmediate(r));
  profiles.setActive('b');
  await wrapper.run({});
  assert.equal(created.length, 1);
  created[0].gate.resolve();
  await exec;
  await wrapper.run({});
  assert.equal(created.length, 2);
});

test('two concurrent starts after a switch create one new instance', async () => {
  const { wrapper, created, profiles } = harness();
  await wrapper.run({});
  profiles.setActive('b');
  const results = await Promise.all([wrapper.run({}), wrapper.run({})]);
  assert.deepEqual(results, [{ home: '/h/b' }, { home: '/h/b' }]);
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
});

test('switchTo returns busy, switched and already_active', async () => {
  const { wrapper, created } = harness();
  await wrapper.run({});
  const held = wrapper.run({ hold: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(await wrapper.switchTo('b'), 'busy');
  assert.equal(created.length, 1);
  created[0].gate.resolve();
  await held;
  assert.equal(await wrapper.switchTo('b'), 'switched');
  assert.equal(created.length, 2);
  assert.equal(created[0].closed, true);
  assert.equal(await wrapper.switchTo('b'), 'already_active');
  assert.equal(created.length, 2);
});

test('switchTo rejects a stale expected selection after waiting for a swap', async () => {
  const closeGate = deferred();
  const profiles = {
    name: null,
    revision: 0,
    activeHome() { return this.name ? `/h/${this.name}` : null; },
    read() { return { active: this.name, selectionRevision: this.revision }; },
    setActive(name) { this.name = name; this.revision += 1; },
    setActiveIfRevision(revision, name) {
      if (revision !== this.revision) return null;
      this.setActive(name);
      return this.read();
    },
  };
  const created = [];
  const wrapper = createSwitchingAppServer({
    profiles,
    create: (home) => {
      const index = created.length;
      const instance = {
        home,
        async run() {},
        async close() { if (index === 0) await closeGate.promise; },
      };
      created.push(instance);
      return instance;
    },
  });
  await wrapper.run({});
  profiles.setActive('a');
  const settling = wrapper.run({});
  const stale = profiles.read();
  const switchAttempt = wrapper.switchTo('b', stale);
  profiles.setActive('c');
  closeGate.resolve();
  await settling;
  assert.equal(await switchAttempt, 'busy');
  assert.equal(profiles.read().active, 'c');
  await wrapper.close();
});

test('a failed target creation restores selection only while its revision is current', async () => {
  const profiles = {
    name: null,
    revision: 0,
    activeHome() { return this.name ? `/h/${this.name}` : null; },
    read() { return { active: this.name, selectionRevision: this.revision }; },
    setActive(name) { this.name = name; this.revision += 1; },
    setActiveIfRevision(revision, name) {
      if (revision !== this.revision) return null;
      this.setActive(name);
      return this.read();
    },
  };
  let fail = false;
  let ownerSelectDuringCreate = null;
  const created = [];
  const wrapper = createSwitchingAppServer({
    profiles,
    create: (home) => {
      if (fail) {
        fail = false;
        ownerSelectDuringCreate?.();
        throw new Error('replacement failed');
      }
      const instance = { home, async run() {}, async close() {} };
      created.push(instance);
      return instance;
    },
  });
  await wrapper.run({});
  fail = true;
  await assert.rejects(wrapper.switchTo('b'), /replacement failed/);
  assert.equal(profiles.read().active, null);
  assert.equal(wrapper.getCodexHome(), null);

  fail = true;
  ownerSelectDuringCreate = () => profiles.setActive('c');
  await assert.rejects(wrapper.switchTo('b'), /replacement failed/);
  assert.equal(profiles.read().active, 'c');
  assert.equal(created.length, 1);
  await wrapper.close();
});

test('close closes the current instance', async () => {
  const { wrapper, created } = harness();
  await wrapper.start();
  await wrapper.close();
  assert.equal(created[0].closed, true);
});

function providerHarness(t, { onCallBound } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homes = Object.fromEntries(['a', 'b'].map((name) => {
    const home = path.join(root, name);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: `account-${name}` } }));
    return [name, home];
  }));
  const profiles = {
    home: 'a',
    activeHome() { return homes[this.home]; },
    read() { return { active: this.home }; },
    setActive(name) { this.home = name; },
  };
  const created = [];
  let failNextCreate = false;
  const wrapper = createSwitchingAppServer({
    profiles,
    onCallBound,
    create: (home) => {
      if (failNextCreate) {
        failNextCreate = false;
        throw new Error('replacement creation failed');
      }
      const instance = { home, closed: false, calls: [], async run(options) { this.calls.push(options); return { home }; }, async close() { this.closed = true; } };
      created.push(instance);
      return instance;
    },
  });
  return { root, homes, profiles, created, wrapper, failCreate() { failNextCreate = true; } };
}

const callBinding = { runId: 'run-1', attemptId: 'run-1:r1:a0:t1', assignmentId: 'run-1:r1:a0', taskId: 'role-task-1' };

test('call binding captures the profile selected after a pre-call switch', async (t) => {
  const records = [];
  const harness = providerHarness(t, { onCallBound: async (record) => records.push(record) });
  harness.profiles.setActive('b');
  const result = await harness.wrapper.run({ callBinding });
  assert.deepEqual(result, { home: harness.homes.b });
  assert.equal(harness.created.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].accountId, crypto.createHash('sha256').update('account-b').digest('hex'));
  assert.equal(records[0].taskId, callBinding.taskId);
  assert.equal(JSON.stringify(records[0]).includes(harness.homes.b), false);
});

test('lead planning call binding records no fabricated A2A task', async (t) => {
  const records = [];
  const harness = providerHarness(t, { onCallBound: async (record) => records.push(record) });
  const leadBinding = { runId: 'run-1', attemptId: 'run-1:lead:attempt-1', assignmentId: 'run-1:lead-planning', taskId: null };
  await harness.wrapper.run({ callBinding: leadBinding });
  await harness.wrapper.run({ callBinding: { ...leadBinding, attemptId: 'run-1:lead:attempt-2' } });
  assert.equal(records.length, 2);
  assert.equal(records[0].taskId, null);
  assert.equal(records[1].taskId, null);
  assert.notEqual(records[0].invocationId, records[1].invocationId);
  assert.notEqual(records[0].attemptId, records[1].attemptId);
  assert.equal(harness.created[0].calls[0].callBinding, undefined);
});

test('call binding holds the selected target through persistence and binds a later call separately', async (t) => {
  const records = [];
  const hold = deferred();
  const bindingStarted = deferred();
  const harness = providerHarness(t, {
    onCallBound: async (record) => {
      records.push(record);
      if (records.length === 1) {
        bindingStarted.resolve();
        await hold.promise;
      }
    },
  });
  const first = harness.wrapper.run({ callBinding });
  await bindingStarted.promise;
  assert.equal(harness.wrapper.inFlight, 1);
  assert.equal(await harness.wrapper.switchTo('b'), 'busy');
  assert.equal(harness.profiles.read().active, 'a', 'a busy switch must not preselect its target');
  harness.profiles.setActive('b');
  hold.resolve();
  assert.deepEqual(await first, { home: harness.homes.a });
  assert.deepEqual(await harness.wrapper.run({ callBinding: { ...callBinding, taskId: 'role-task-2' } }), { home: harness.homes.b });
  assert.equal(records.length, 2);
  assert.notEqual(records[0].invocationId, records[1].invocationId);
  assert.equal(records[0].accountId, crypto.createHash('sha256').update('account-a').digest('hex'));
  assert.equal(records[1].accountId, crypto.createHash('sha256').update('account-b').digest('hex'));
  assert.equal(harness.wrapper.inFlight, 0);
});

test('missing account identity and durable callback failures prevent provider invocation and release reservation', async (t) => {
  const harness = providerHarness(t, { onCallBound: async () => {} });
  fs.writeFileSync(path.join(harness.homes.a, 'auth.json'), JSON.stringify({ tokens: {} }));
  await assert.rejects(harness.wrapper.run({ callBinding }), { code: 'account_identity_unavailable' });
  assert.equal(harness.created[0].calls.length, 0);
  assert.equal(harness.wrapper.inFlight, 0);

  const failed = providerHarness(t, { onCallBound: async () => { throw new Error('durable bind failed'); } });
  await assert.rejects(failed.wrapper.run({ callBinding }), /durable bind failed/);
  assert.equal(failed.created[0].calls.length, 0);
  assert.equal(failed.wrapper.inFlight, 0);
});

test('same-home auth replacement closes the old generation before binding the next call', async (t) => {
  const records = [];
  const harness = providerHarness(t, { onCallBound: async (record) => records.push(record) });
  await harness.wrapper.run({ callBinding });
  const old = harness.created[0];
  fs.writeFileSync(path.join(harness.homes.a, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a-rotated' } }));

  await harness.wrapper.run({ callBinding: { ...callBinding, attemptId: 'run-1:r1:a0:t2' } });

  assert.equal(harness.created.length, 2);
  assert.equal(old.closed, true);
  assert.equal(old.calls.length, 1);
  assert.equal(harness.created[1].calls.length, 1);
  assert.equal(records[0].accountId, crypto.createHash('sha256').update('account-a').digest('hex'));
  assert.equal(records[1].accountId, crypto.createHash('sha256').update('account-a-rotated').digest('hex'));
});

test('same-home auth replacement during a call fences new calls until the original settles', async (t) => {
  const records = [];
  const harness = providerHarness(t, { onCallBound: async (record) => records.push(record) });
  const hold = deferred();
  const started = deferred();
  await harness.wrapper.run({ callBinding });
  const old = harness.created[0];
  old.run = async (options) => { old.calls.push(options); started.resolve(); await hold.promise; return { home: old.home }; };
  // Use a held call to model an active generation before rotating auth metadata.
  const active = harness.wrapper.run({ callBinding: { ...callBinding, attemptId: 'run-1:r1:a0:t2' } });
  await started.promise;
  fs.writeFileSync(path.join(harness.homes.a, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a-rotated' } }));
  await assert.rejects(
    harness.wrapper.run({ callBinding: { ...callBinding, attemptId: 'run-1:r1:a0:t3' } }),
    { code: 'provider_identity_generation_busy' },
  );
  assert.equal(old.closed, false);
  assert.equal(harness.created.length, 1);
  hold.resolve();
  await active;
  await harness.wrapper.run({ callBinding: { ...callBinding, attemptId: 'run-1:r1:a0:t4' } });
  assert.equal(harness.created.length, 2);
  assert.equal(old.closed, true);
  assert.equal(records.at(-1).accountId, crypto.createHash('sha256').update('account-a-rotated').digest('hex'));
});

test('auth replacement during the durable callback is rejected before target invocation', async (t) => {
  let harness;
  const records = [];
  harness = providerHarness(t, {
    onCallBound: async (record) => {
      records.push(record);
      fs.writeFileSync(path.join(harness.homes.a, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a-rotated' } }));
    },
  });
  await assert.rejects(harness.wrapper.run({ callBinding }), { code: 'provider_identity_changed_during_binding' });
  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0].calls.length, 0);
  assert.equal(records[0].accountId, crypto.createHash('sha256').update('account-a').digest('hex'));
  await harness.wrapper.run({ callBinding: { ...callBinding, attemptId: 'run-1:r1:a0:t2' } });
  assert.equal(harness.created.length, 2);
  assert.equal(harness.created[1].calls.length, 1);
});

test('same-home recreation and close failures prevent provider invocation', async (t) => {
  const closeFailure = providerHarness(t, { onCallBound: async () => {} });
  await closeFailure.wrapper.run({ callBinding });
  const old = closeFailure.created[0];
  old.close = async () => { throw new Error('old generation close failed'); };
  fs.writeFileSync(path.join(closeFailure.homes.a, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a-rotated' } }));
  await assert.rejects(closeFailure.wrapper.run({ callBinding: { ...callBinding, attemptId: 'run-1:r1:a0:t2' } }), /old generation close failed/);
  assert.equal(closeFailure.created.length, 1);
  assert.equal(old.calls.length, 1);

  const createFailure = providerHarness(t, { onCallBound: async () => {} });
  await createFailure.wrapper.run({ callBinding });
  fs.writeFileSync(path.join(createFailure.homes.a, 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-a-rotated' } }));
  createFailure.failCreate();
  await assert.rejects(createFailure.wrapper.run({ callBinding: { ...callBinding, attemptId: 'run-1:r1:a0:t2' } }), /replacement creation failed/);
  assert.equal(createFailure.created.length, 1);
  assert.equal(createFailure.created[0].calls.length, 1);
});

test('busy cross-home switch fails a second bound call without starving the active call', () => {
  const childScript = String.raw`
    const assert = require('node:assert/strict');
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createSwitchingAppServer } = require('./src/app-server-switch');
    (async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-profile-race-'));
      try {
        const homes = {};
        for (const name of ['a', 'b']) {
          homes[name] = path.join(root, name);
          fs.mkdirSync(homes[name]);
          fs.writeFileSync(path.join(homes[name], 'auth.json'), JSON.stringify({ tokens: { account_id: 'account-' + name } }));
        }
        const profiles = {
          name: 'a',
          activeHome() { return homes[this.name]; },
          read() { return { active: this.name }; },
          setActive(name) { this.name = name; },
        };
        const created = [];
        const records = [];
        let entered;
        const enteredRun = new Promise((resolve) => { entered = resolve; });
        const wrapper = createSwitchingAppServer({
          profiles,
          onCallBound: async (record) => records.push(record),
          create: (home) => {
            const instance = {
              home,
              closed: false,
              calls: [],
              async run(options) {
                this.calls.push(options);
                if (options.hold) {
                  entered();
                  await new Promise((resolve) => setTimeout(resolve, 30));
                }
                return { home };
              },
              async close() { this.closed = true; },
            };
            created.push(instance);
            return instance;
          },
        });
        const binding = { runId: 'run-race', attemptId: 'run-race:t1', assignmentId: 'run-race:a1', taskId: 'worker-race' };
        const first = wrapper.run({ callBinding: binding, hold: true });
        await enteredRun;
        profiles.setActive('b');
        assert.equal(await wrapper.switchTo('b'), 'busy');
        await assert.rejects(
          wrapper.run({ callBinding: { ...binding, attemptId: 'run-race:t2' } }),
          { code: 'provider_home_switch_busy' },
        );
        assert.equal(created.length, 1);
        assert.equal(created[0].closed, false);
        assert.equal(created[0].calls.length, 1);
        await first;
        await wrapper.run({ callBinding: { ...binding, attemptId: 'run-race:t3' } });
        assert.equal(created.length, 2);
        assert.equal(created[0].closed, true);
        assert.equal(created[0].calls.length, 1);
        assert.equal(created[1].home, homes.b);
        assert.equal(created[1].calls.length, 1);
        assert.deepEqual(records.map((record) => record.accountId), [
          crypto.createHash('sha256').update('account-a').digest('hex'),
          crypto.createHash('sha256').update('account-b').digest('hex'),
        ]);
        await wrapper.close();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 1500,
  });
  assert.notEqual(child.error?.code, 'ETIMEDOUT', 'isolated repro exceeded its 1500 ms deadline');
  assert.equal(child.status, 0, `isolated repro failed: ${child.stderr || child.stdout}`);
});
