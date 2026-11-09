# CN-08 review

Verdict: APPROVE

## Resolved findings

1. `src/task-scheduler.js:137-145` - The first-page role gate was removed. The store's full ready scan now reaches an engineer task after 500 auditor tasks. Re-ran the independent in-memory SQLite probe: `idle.cause=null`, `claimed=['z-engineer']`, `active=1`, `sends=1`. Idle dependency classification pages all queued/ready tasks only after a claim pass returns empty.

2. `src/task-scheduler.js:110-125` - `admissionOpen` is checked before launching a claimed attempt with no intent. Re-ran the independent pause probe: `idle.cause=pause_control`, `sends=0`, `active=1`. The new focused test also polls and settles a separate already-submitted intent during pause while keeping the no-intent claim reserved.

## Verification

- Read actual `src/task-scheduler.js`, `src/task-resource-policy.js`, `src/backlog-store.js`, `src/task-executor.js`, focused tests, CN-08 brief and design.
- Ran `env -u NODE_TEST_CONTEXT node --test test/task-scheduler.test.js test/task-resource-policy.test.js test/backlog-store.test.js test/task-executor.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 78 pass, 0 fail, including current CN-05 thread tests.
- Ran the two decisive independent in-memory SQLite probes above. `node --check` passed for scheduler source/test. No product files were changed.

Status: complete for frozen CN-08 repair snapshot. Approval is the local fake-executor gate, not installed runtime qualification.
Scope expansion: none.

## Final challenge re-review

Verdict remains APPROVE for the final frozen CN-08 source.

- Read `src/task-scheduler.js:127-151` and BacklogStore's immediate `canClaim` hook: the reduced runtime worker ceiling is checked against the complete project-wide live projection inside the claim transaction, including prior claims from another connection and earlier claims in the batch. Ran `node .agents/teamwork/task-scheduler-challenge/capacity-race.cjs`: active 3, sends 3, expected ceiling 3.
- Read `src/task-resource-policy.js:21-50`: frozen review proof is only considered for declared product-read-only tasks; a review declaring product writes cannot use that proof to skip writer checks. Ran `node .agents/teamwork/task-scheduler-challenge/frozen-writer.cjs`: overlapping writer refused with `review_barrier`.
- Read `src/task-resource-policy.js:7`: canonical verifier roles and `verification` kinds are critical. Ran `node .agents/teamwork/task-scheduler-challenge/verification-gate.cjs`: critical true, refused with `review_barrier`.
- The earlier full-scan and pause branches remain in place at `src/task-scheduler.js:110-125,138-146,225-233`. The affected suite includes both prior regressions and passed: `env -u NODE_TEST_CONTEXT node --test test/task-scheduler.test.js test/task-resource-policy.test.js test/backlog-store.test.js test/task-executor.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 81 pass, 0 fail.

No blocking finding remains in this bounded repair. The three challenge probe scripts are ignored local evidence and may disappear. No product/test/Git/live state was changed by the reviewer.
