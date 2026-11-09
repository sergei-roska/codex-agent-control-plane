'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const filename = path.resolve('test/delivery-role-service.test.js');
const prefix = fs.readFileSync(filename, 'utf8').split("test('authenticated role card")[0];
const probe = String.raw`
test('provider identity drift during awaited lane cleanup retains claim', async (t) => {
  const fx = await fixture(t);
  await fx.executor.execute(identity(fx));
  const recovery = { ...identity(fx), recoveryGeneration: 0 };
  const complete = fx.lanes.complete.bind(fx.lanes);
  fx.lanes.complete = async (input) => {
    const result = await complete(input);
    fx.service.getProviderIdentity = () => ({ account: 'replaced-during-cleanup', codexHome: SETTINGS.codexHome });
    return result;
  };
  await assert.rejects(fx.service.prepareNoPublicationRecovery(recovery), { code: 'delivery_role_recovery_proof_unavailable' });
  assert.equal(fx.store.listClaims(PROJECT, OBJECTIVE)[0].state, 'active');
  assert.equal(fx.executor.getAttempt(recovery.attemptId).state, 'submitted');
  assert.equal(fx.service.getExecution(recovery.attemptId).noPublicationRecovery, undefined);
});
`;
const m = new Module(filename, module);
m.filename = filename;
m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(prefix + probe, filename);
