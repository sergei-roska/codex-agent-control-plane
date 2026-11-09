# Worker brief

Repair the scoped concurrent-v1 startup recovery failure in delivery role shutdown proof replay. Preserve inherited source changes, task history, candidates, sessions, and owner pauses. Do not touch live runtime or DB, dispatch model work, change Git state, or commit.

Allowed product files: `src/delivery-role-service.js`, `src/concurrent-delivery-engine.js`, `test/delivery-role-service.test.js`, `test/concurrent-delivery-engine.test.js`, and `test/server-delivery-engine.test.js`.

Acceptance: identify the exact failed invariant; make an idempotent recovery for already settled terminal shutdown attempts under provider/settings drift; retain identity, effect, process, receipt, digest, publication, and uncertainty checks; add positive and negative regressions; run focused tests and report before root runtime validation.
