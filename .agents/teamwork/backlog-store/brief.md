# CN-03 worker brief

Implement additive SQLite backlog and delivery event stores in only
`src/backlog-store.js`, `src/delivery-events.js`, `test/backlog-store.test.js`,
`test/delivery-events.test.js`, and this local handoff directory. Do not wire
startup, mutate legacy storage/contracts, touch services/databases outside
fixtures, or make Git changes. Validate plan CAS and merged graph projection;
provide transactional claims, project and role limits, fences, readiness, event
dedupe/cursors, expiry recovery, and local focused verification. Preserve
claimed contract snapshots and require explicit trusted/controller evidence for
settlement and checkpoint acceptance. Contract validation remains CN-01's
boundary.
