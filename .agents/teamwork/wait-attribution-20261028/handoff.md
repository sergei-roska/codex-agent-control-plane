# Wait attribution handoff

Implemented four per-attempt timing categories in delivery visibility and Backlog UI. Backlog is initial plan creation to first claim for revision 1, including dependency/control wait. Writer is acquisition call elapsed; provider is invocation to observed turn start, excluding inference; settlement is observed terminal to durable attempt settlement, including checks and publication. Missing, invalid or ambiguous timing remains null. Token unknowns remain null. Historical rows lack new timing and remain unknown. No current live wait duration is inferred.

CandidateStore stores best-effort acquisition timing in a separate table; timing write errors do not change publication. DeliveryRoleService persists terminal observation. Changes: src/candidate-store.js, src/delivery-role-service.js, src/delivery-visibility.js, launcher-ui/backlog.js, and paired test/candidate-store.test.js, test/delivery-role-service.test.js, test/delivery-visibility.test.js, test/launcher-backlog-ui.test.js.

Verification:
- node --test test/delivery-visibility.test.js test/launcher-backlog-ui.test.js: 13 passed, 0 failed.
- node --test --test-name-pattern='^records writer admission acquisition timing for publication$' test/candidate-store.test.js: 1 passed, 0 failed.
- node --test --test-name-pattern='^authenticated role card and returnImmediately TaskExecutor publish private output only through CandidateStore$' test/delivery-role-service.test.js: 1 passed, 0 failed. An initial assertion expected numeric role timestamps but service timestamps are ISO strings; corrected assertion and reran successfully.

SHA-256:
eaa189645baf502f1ad8b4eaee30852f6c665c7901ef190cabc182d81c5e59b4 src/delivery-visibility.js
1c39360f79a212453bdbab4a805b4957f684c360a36089a52cc8a2600ccdca1b src/delivery-role-service.js
ebc9b0704624665f8fba636b968019cd945a3638058115c6706dacd43b41fcd6 src/candidate-store.js
1f241b4a502c5d111d9bea6027875955fc094c333a9587f736f21de5aa9dae7d launcher-ui/backlog.js
b413bfe2b82fee7fbeb3d45ce064d404d1039c5578c7ed2582f7a76f4f0839eb test/delivery-visibility.test.js
541a878d7ab261dca83a13f415beb427bf47e191e76b8f8473aae78b845254bc test/launcher-backlog-ui.test.js
49012561019e1bd3d4ea6f12945b7faa26a1cf11fd9f3afc228bd130ecd53eca test/candidate-store.test.js
031745b89a59be27839a3e4e3dc7f14226074a5d686a34105986ebab1c61ed6e test/delivery-role-service.test.js

Next: independent review and root integration verification. No Git mutation.

Challenge repair: count all candidate intents, including those missing telemetry, and reject negative or non-ISO timestamp endpoints. Retained regression assertions cover both cases. node --test test/delivery-visibility.test.js test/launcher-backlog-ui.test.js: 13 passed, 0 failed; node --test .agents/teamwork/wait-attribution-20261028/challenge/probe.cjs: 3 passed, 0 failed. Probe is ignored temporary evidence and may disappear.

Final challenge repair: ISO timestamps require valid calendar, time and offset components before parsing; retained tests include leap years, impossible dates and hours, invalid offsets, and a valid offset. node --test test/delivery-visibility.test.js test/launcher-backlog-ui.test.js: 13 passed, 0 failed; node --test .agents/teamwork/wait-attribution-20261028/challenge/probe.cjs: 4 passed, 0 failed. Next: final delta review.
