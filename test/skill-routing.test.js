'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const express = require('express');
const { ServerCallContext, UnauthenticatedUser } = require('@a2a-js/sdk/server');
const { registerRoleAgents } = require('../src/a2a-role-service');
const { loadSkillCatalog } = require('../src/skill-catalog');

function fixtureCatalog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-routing-'));
  const dir = path.join(root, 'api-design');
  fs.mkdirSync(dir);
  const source = '---\nname: api-design\ndescription: Design stable APIs.\nkeywords: ["api"]\n---\nUse stable interfaces.\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), source);
  return { root, catalog: loadSkillCatalog({ root }), hash: crypto.createHash('sha256').update(source).digest('hex') };
}

function send(handler, value) {
  const message = {
    messageId: 'skill-routing-message', role: 1,
    parts: [{ content: { $case: 'text', value: typeof value === 'string' ? value : JSON.stringify(value) } }],
  };
  return handler.sendMessage({ message, configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false } },
    new ServerCallContext({ user: new UnauthenticatedUser() }));
}

test('worker resolves trusted skill ids and records selection hashes in provenance', async (t) => {
  const fixture = fixtureCatalog();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let runOptions;
  const roleMap = new Map([['orch-reader', { name: 'Reader', description: 'Read only', sandbox: 'read-only' }]]);
  const agents = registerRoleAgents(express(), {
    roles: roleMap,
    appServer: { async run(options) { runOptions = options; return { status: 'completed', text: '{"outcome":"completed"}' }; } },
    workspace: process.cwd(), baseUrl: 'http://127.0.0.1:7777', skillCatalog: fixture.catalog,
  });
  const result = await send(agents.get('orch-reader').handler, { role: 'orch-reader', skills: ['api-design'] });
  assert.deepEqual(runOptions.selectedSkills.map(({ id, sha256 }) => ({ id, sha256 })), [{ id: 'api-design', sha256: fixture.hash }]);
  assert.deepEqual(result.artifacts[0].metadata.selectedSkills, [{ id: 'api-design', sha256: fixture.hash }]);
});

test('invalid skill selections fail before writable admission and App Server execution', async (t) => {
  const fixture = fixtureCatalog();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let acquired = 0;
  let run = 0;
  const admission = { holder: () => null, async acquire() { acquired += 1; throw new Error('must not acquire'); } };
  const roleMap = new Map([['orch-writer', { name: 'Writer', description: 'Writes', sandbox: 'workspace-write' }]]);
  const agents = registerRoleAgents(express(), {
    roles: roleMap,
    appServer: { async run() { run += 1; return { status: 'completed', text: '' }; } },
    workspace: process.cwd(), baseUrl: 'http://127.0.0.1:7777', admission, skillCatalog: fixture.catalog,
  });
  const handler = agents.get('orch-writer').handler;
  const invalidInputs = [
    { role: 'orch-writer', skills: ['unknown-skill'] },
    '{"skills":["api-design"],',
    { role: 'orch-writer', skills: null },
    '{"skillPins":[{"id":"api-design","sha256":"bad"}],',
  ];
  for (const input of invalidInputs) {
    const result = await send(handler, input);
    assert.equal(result.status.state, 4);
  }
  assert.equal(acquired, 0);
  assert.equal(run, 0);
});

test('canonical role routes keep the legacy endpoint and persistent task namespace', () => {
  const app = express();
  const mounts = [];
  const originalUse = app.use.bind(app);
  app.use = (route, ...handlers) => { mounts.push(route); return originalUse(route, ...handlers); };
  const storeNamespaces = [];
  const agents = registerRoleAgents(app, {
    roles: new Map([['engineer', { name: 'engineer', displayName: 'Software Engineer', description: 'Builds software.', sandbox: 'read-only' }]]),
    appServer: { async run() { return { status: 'completed', text: '' }; } },
    workspace: process.cwd(), baseUrl: 'http://127.0.0.1:7777',
    taskStoreFactory(namespace) { storeNamespaces.push(namespace); return undefined; },
    skillCatalog: new Map(),
  });
  const canonical = agents.get('engineer');
  assert.equal(agents.size, 1);
  assert.equal(canonical.card.name, 'Software Engineer');
  assert.equal(canonical.card.skills[0].id, 'engineer');
  assert.ok(mounts.includes('/agents/engineer'));
  assert.ok(mounts.includes('/agents/orch-builder'));
  assert.equal(storeNamespaces[0], 'orch-builder');
});
