# V14 required owner decision lifecycle

Goal: routine reversible choices stay internal; named required owner decisions
block acceptance until an authenticated exact scoped response. Read predecessor
cn14-terminal-20261028/worker/v14-plan.md and integration-closeout-20261028/
v14-decision.md. Implementation awaits approved protocol amendment.

Ownership after approval: src/backlog-store.js, src/lead-planner.js,
src/project-delivery-controller.js, src/delivery-lifecycle.js,
src/concurrent-delivery-engine.js, src/delivery-host-controls.js and their paired
existing tests; new focused owner-decision test permitted. Root owns Git/docs.
V42 worker owns candidate-store/role-service/visibility/backlog UI and tests.
V16 worker owns candidate-review.test.js. Preserve all inherited work.

No Git mutations, live providers/services/settings/accounts/dependency installs.
Disposable offline Git/SQLite/HTTP/child fixtures permitted. Never run prohibited
candidate filter test. Focused checks only; root owns frozen broad verification.
English ASCII in all files and reports. Keep brief/handoff current here.

Acceptance: strict investigated typed request and durable immutable named scope;
request registration atomically fences new work/finalization; honest input_required
facade, no polling/model loop; exact response auth/scope/digest/revisions/generation;
no new external action capability implied; idempotent response before current-pin
validation; pause/stop/cancel precedence; changed goal/authority/owner needs explicit
authenticated refresh/replacement, never silent model rebind; restart retains wait
without resend, safe drain can preserve the future authorization boundary.
Null ownerDecision remains compatible with V43 and ordinary accepted objectives.
Whole-objective gate is bounded V14 coverage, not selective obligation deferral.
Independent review/challenge required before final matrix acceptance.
