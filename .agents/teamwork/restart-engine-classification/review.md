# Restart engine classification review

Verdict: APPROVE
Blocking: none.
Status: complete
Scope expansion: none

## Scope and mechanism (read)

Read the brief/handoff and inspected actual git diff plus exact comparisons against evidence/baseline/server.js and evidence/baseline/server-delivery-engine.test.js. The task delta is confined to src/server.js and its HTTP restart regression. Extensive earlier dirty changes are excluded from this review.

storedDeliveryMappings validates supported engines and the normalized project identity before returning concurrent run IDs. Startup now subtracts only those durable concurrent IDs from its historical legacy fallback set, then retains the explicit legacy mappings. Unmapped historical tasks remain subject to the same terminal-state checks. No database write or recovery behavior was added to the production delta.

Checked surrounding prevention mechanisms: deliveryEngineFence still checks durable cross-engine mappings, concurrentRecoveryUnsafe, active/unresolved workspace writer executions, and the existing concurrent settlement/effect guards. The router checks admission before pinning or invoking an engine, preserves stored engine selection, and keeps old legacy resume routing. ConcurrentDeliveryEngine.recoverStoredRuns skips terminal/canceled objectives; recovery that reports unknown still closes concurrent admission. The change does not reinterpret unknown planner facts as settled and does not remove the separate legacy-downgrade planner guard.

## Independent verification (ran)

- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='concurrent engine admission recognizes persisted terminal legacy task states|restart excludes a persisted concurrent task|durable legacy mappings block concurrent intake|unknown engine|different project|unknown.*planner|recovery' test/server-delivery-engine.test.js: 12 passed, 0 failed. This selected the terminal/active historical legacy matrix, HTTP restart regression, and mapped active legacy fence.
- env -u NODE_TEST_CONTEXT node --test test/delivery-engine-router.test.js: 11 passed, 0 failed, including mapped legacy resume placeholder retention, immutable engine selection, and publication admission refusal.
- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='state database mappings from another normalized project|restart refuses unknown stored engine' test/server-delivery-engine.test.js: 2 passed, 0 failed.
- Ran the new HTTP restart regression with the exact saved baseline server compiled into the module cache in memory, without changing reviewed files. Command used node --test-name-pattern='restart excludes a persisted concurrent task', Module._compile on evidence/baseline/server.js with the actual src/server.js filename, then required the current test file. Expected baseline result: 1 failed assertion, engineCalls 0 rather than 1; HTTP task error was "Delivery is busy with an active run on the other engine". The candidate regression above passed with engineCalls 1.
- git diff --check -- src/server.js: passed.

The regression seeds a canceled concurrent objective and durable mapping, persists its INPUT_REQUIRED A2A task, closes and restarts the disposable server, and submits a fresh authenticated JSON-RPC SendMessage request. Production startup, transport, router, and fence are used; the concurrent engine is intentionally stubbed. It asserts one admitted engine call, a new concurrent mapping, unchanged old task INPUT_REQUIRED status, and unchanged unknown planner status. Production source classification has no path that writes those historical records.

## Limits

This verdict covers startup classification and admission. It does not claim a real model turn, live UI task, or end-to-end production engine recovery was run. All test server and database instances were disposable; no original project/launcher services or live data/tasks were started or modified. Full server-suite results belong to the lead's separate run and are not claimed here.

Pitfall: Classify persisted tasks using validated durable engine mappings before applying historical legacy fallback admission fences.
