# CN-05 local gate final re-review

Verdict: APPROVE
Status: complete
Scope expansion: none

## Evidence

- Read: first send compares caller `taskId` with the durable attempt, claim and task before intent creation. Existing-intent execute replay and reconcile/poll/abort/terminal paths validate the stored task identity too. The journal now uses the pinned task ID.
- Ran `node /tmp/cn05-task-identity-probe.js`: a caller supplying task-1 with task-0's attempt/fence received `task_identity_mismatch`, with zero sends. This temporary probe may disappear.
- Read: new sends still require the captured control revision to match. Reconcile, poll, abort and terminal handling allow control revision drift for already submitted work while retaining task, fence, authority and owner-generation checks. The result adapter receives current objective/control state; settlement remains historical task evidence and grants no publication authority.
- Ran `node /tmp/cn05-control-pause-probe.js`: after pause, abort returned unknown pending quiescence; poll settled a trusted result; direct terminal replay was idempotent; capacity fell to zero only after settlement. This temporary probe may disappear.
- Ran `env -u NODE_TEST_CONTEXT node --test test/task-executor.test.js`: 23 passed, 0 failed. The final related suite reported by the worker was 60/60; only the affected focused tests were repeated here.

## Thread and transport identity delta

- Read: a provider-assigned first thread is persisted in the local intent under an immediate transaction. Terminal, poll and reconciliation validation use that observed pin. The reservation table has `(transport_key, thread_id)` uniqueness, and known continuation threads are reserved in the intent transaction before send. A second observed thread conflicts with the stored pin, including a duplicate or late response.
- Ran the actual related suite after the delta: `env -u NODE_TEST_CONTEXT node --test test/task-executor.test.js test/backlog-store.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 65 passed, 0 failed. The natural send-A/terminal-B test rejects `thread_identity_mismatch` while capacity stays held. The known-thread test permits one send and rejects the second attempt with `provider_thread_busy`.
- Ran a separate in-memory SQLite probe with engineer and verifier intents using explicit keys `service:engineer` and `service:verifier`: failure of the engineer key affected one intent; states were engineer `uncertain`, verifier `submitted`, capacity 2. The suite's default-key test shows both roles in one project become uncertain when `project:<projectId>` fails.

No blocking finding remains in the bounded task-identity, pause, thread, and default-transport repair. Approval covers fake-transport local behavior, not runtime routing or live service qualification.
