'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const filename = path.resolve('test/concurrent-delivery-engine.test.js');
const prefix = fs.readFileSync(filename, 'utf8').split("test('cooperative writer mode")[0];
const probe = String.raw`
test('shutdown fences both controllers before draining and rejects first unsafe run', { timeout: 20000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let count = 0;
  const fx = await createHarness(t, { appServer: { async run(options) {
    count++;
    if (count === 1) entered.resolve();
    await release.promise;
    throw new Error('unknown provider outcome');
  } } });
  const aborts = [new AbortController(), new AbortController()];
  const running = ['a', 'b'].map((id, i) => fx.engine.run({ runId: id, goal: 'Test shutdown fencing',
    contract: { requiredChecks: [] }, signal: aborts[i].signal,
    engineMapping: { engine: 'concurrent-v1', projectId, objectiveId: 'objective-' + id, sessionId: 'session-' + id } }));
  await entered.promise;
  await waitFor(() => fx.engine.controllers.size === 2, 'second controller absent');
  const first = fx.engine.controllers.get('a');
  const second = fx.engine.controllers.get('b');
  assert.ok(first && second);
  first.inbox.receive({ messageId: 'pending', kind: 'steering', source: 'authenticated-control', payload: { text: 'Pending' } });
  const close = fx.engine.shutdown();
  assert.equal(first.shutdownRequested, true);
  assert.equal(second.shutdownRequested, true);
  release.resolve();
  await assert.rejects(close, { code: 'concurrent_shutdown_unsafe' });
  assert.equal(second.shutdownRequested, true);
  aborts.forEach((a) => a.abort());
  await Promise.allSettled(running);
});
`;
const m = new Module(filename, module);
m.filename = filename;
m.paths = Module._nodeModulePaths(path.dirname(filename));
m._compile(prefix + probe, filename);
