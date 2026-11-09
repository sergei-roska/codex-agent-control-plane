# Frozen CN14 host source review

Verdict: REJECT
Status: complete for this bounded review; whole CN14 remains pending.
Scope expansion: none.

Scope: src/server.js, src/delivery-engine-router.js, src/delivery-host-controls.js, src/delivery-provider-identity.js, src/launcher-projects.js and their dedicated tests. Core is changing concurrently and is not re-reviewed here.

## Blocking: legacy downgrade ignores durable unknown planner effects

Location: src/server.js:88-109 (concurrentRunSettled terminal-objective predicate, called from deliveryEngineFence at :121).

Scenario: a concurrent planner turn becomes unknown, then owner cancellation makes the objective canceled. After restart with legacy default, recoverStoredRuns skips the terminal objective. The host predicate sees no attempts or claims, no controller fence and no publication, then returns true without inspecting delivery_planner_turns for the mapping session. New legacy work can start while the original planner effect remains unknown.

Evidence (ran): an inline Node probe extracted the actual hasTable, concurrentRunSettled and deliveryEngineFence functions from src/server.js into a vm context. In a disposable in-memory better-sqlite3 database it seeded a concurrent mapping (project 0123456789, objective objective, session session), concurrent run status running, backlog objective disposition canceled, no attempts/claims, and delivery_planner_turns status unknown for the exact project/session. Calling deliveryEngineFence for engine legacy and new run returned true, asserted by the probe. It printed: REPRODUCED: production legacy admission fence returns true with canceled concurrent objective and durable unknown planner turn.

Evidence (read, caller protections checked): DeliveryEngineRouter.#run invokes this canRunEngine before mapping/intake writes, but has no additional effect fence after it returns true. concurrentRunSettled checks objective disposition, attempt terminal digests, claims, optional controller fence and publications; no planner ledger query exists. src/concurrent-delivery-engine.js recoverStoredRuns skips canceled objectives; ProjectDeliveryController.cancelObjective transitions lifecycle cancellation and aborts admitted task attempts without settling the planner ledger. Core unknown-host-facts tests also preserve unknown ledger on cancellation. Root independently reproduced the persisted canceled/reopen unknown-planner state; that report is corroborating evidence, not a test run by this reviewer.

Fix: include exact mapping project/session planner-ledger active/unknown states in durable cross-engine admission fencing, before treating a terminal objective as settled. Preserve the mapping and refuse legacy intake until trusted settlement; add a default-change/reopen regression. Fixing core shutdown scanning alone does not protect admission before shutdown.

## Independently verified dimensions

Evidence (ran):
`env -u NODE_TEST_CONTEXT node --test test/delivery-engine-router.test.js test/server-delivery-engine.test.js test/delivery-host-controls.test.js test/delivery-provider-identity.test.js`
Result: 34 pass, 0 fail, 0 skipped. Disposable fixtures only; no prohibited Git-filter test or live provider/service/account.

PASS for covered mapping behavior: omission-preserving immutable intake, explicit-null/change rejection before mutation, SQLite reopen preservation, legacy resume placeholder behavior, existing task runLegacy preservation, and gating before mapping creation. Source inspection confirms project-scoped mapping lookup and stored engine selection.

PASS for covered symmetric fences: busy concurrent objective, mixed unknown/active claims, mixed unknown/pending publications, settled rows, durable working legacy task, unknown engine selection, and independent projects. The unknown planner case above is FAIL; these passes do not imply all unknown effects are fenced.

PASS for provider identity helper: actual helper canonicalizes home, hashes account_id, rereads metadata through a synchronous getter, bounds and validates the credential file, closes descriptors, and reports typed errors without credential content. Dedicated tests exercise real disposable auth files and same-home account replacement. Server passes the pin and getter into the concurrent engine. Core enforcement of those pins remains outside this host verdict.

PASS for authenticated host controls: source orders authentication before JSON parsing/mapping state access, validates exact bounded steering fields and persisted project/session/objective scope, checks returned acknowledgement identity, and maps stale/conflict errors. Tests cover unauthorized GET, unknown/legacy/mismatched scopes, immediate acknowledgement, duplicate and conflict/stale behavior; real server integration accepts authenticated steering. Core atomic steering semantics are not accepted by these helper tests.

PASS for covered server ownership/project behavior: normalized real workspace identity matches launcher hashing, configured mismatch and cross-project database reject, unsupported shared isolation rejects, legacy remains default, persisted concurrent mapping still composes concurrent engine after default switch, ordinary empty-check base candidate reaches accepted completion, and unsafe close retains open DB/workspace lock across repeated attempts. The launcher delta only threads record.id as CODEX_A2A_PROJECT_ID; hash compatibility inspected in both files.

UNVERIFIED here: successful retry-close after reconciliation, core pause/correction/reopen qualification, production invalid-planner recovery, complete CN14 acceptance, and broader legacy/concurrent effect-ledger combinations beyond the listed fixtures. Known core retry-close defects were not used to reject this host milestone. No source/test/config/Git mutations were made. Only owned ignored reports were written; the inline probe has no persistent artifact.
