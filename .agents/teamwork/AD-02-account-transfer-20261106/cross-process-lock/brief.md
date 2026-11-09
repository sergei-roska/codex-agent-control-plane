# AD-02 profile-state cross-process serialization

## Goal

Fix the AD-02 delta-review lost-update race by serializing every profile-state
read-modify-write operation across launcher and project-server processes. Keep
selection revision CAS semantics and synchronous public APIs unless evidence
requires a narrow API change.

## Ownership

Own `src/account-profiles.js`, `test/account-profiles.test.js`, and this task
handoff. Do not touch `src/server.js`; root will forward the watcher selection
pin after AD-04 releases that file. Avoid unrelated AD-02 changes.

## Acceptance

- All profile-state writers share a cross-process lock, including direct/public
  state writes, add/remove, active selection/CAS, and auto-switch updates.
- Lock recovery after owner-process termination is bounded and cannot silently
  admit concurrent writers while the lock owner is alive.
- A deterministic independent-process regression proves a newer owner selection
  cannot be overwritten by a stale CAS; include the failure interleaving from
  the Sol report.
- Preserve profile home safety and selection revision behavior.

## Verification

Run focused account-profile, App Server switch, budget-watcher, failover, and
launcher account suites after source changes. Record exact commands/results,
scoped diff check, and any remaining limits. No provider calls, runtime
activation, credentials, staging, or commits.
