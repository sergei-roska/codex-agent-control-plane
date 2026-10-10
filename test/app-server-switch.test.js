'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSwitchingAppServer } = require('../src/app-server-switch');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness() {
  const profiles = { home: null, activeHome() { return this.home; }, name: null, read() { return { active: this.name }; }, setActive(name) { this.name = name; this.home = name ? `/h/${name}` : null; } };
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
      async execCommand(args) { if (args?.hold) await gate.promise; return { home }; },
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
  assert.deepEqual(await wrapper.execCommand({}), { home: null });
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

test('close closes the current instance', async () => {
  const { wrapper, created } = harness();
  await wrapper.start();
  await wrapper.close();
  assert.equal(created[0].closed, true);
});
