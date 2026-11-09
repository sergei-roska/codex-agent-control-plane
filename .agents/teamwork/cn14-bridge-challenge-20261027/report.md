# CN14 prerequisite bounded challenge

Verdict: BROKEN. The verifier capability path sends a scoped model turn after an owner pause occurs in the synchronous `onTurnStart` callback. The subsequent capability check rejects the outcome, but the turn was already sent and completed. This is a start-time authorization failure, not a receipt-settlement failure.

## Failure

Probe: `.agents/teamwork/cn14-bridge-challenge-20261027/probe-capability.js`.

Input: Real BacklogStore claimed verifier attempt and opaque delivery capability, fake AppServer RPC process. `CodexAppServer.run` enters `onTurnStart`; that callback invokes `transitionLifecycleControl('p','o',{action:'pause',expectedControlRevision:1,expectedOwnerGeneration:0})`. The callback returns before `turn/start` is sent.

Expected: current scoped authority is rechecked after callback; zero `turn/start` requests and no passing receipt. Actual: objective is `paused_owner`; one `thread/start` and one `turn/start` were sent. The fake process completed the turn. `run` then rejected with `verifier_objective_inactive`, with execution reporting `turnStartSent:true`, `turnTerminal:true`; no receipt settled. This confirms the rejection came after the unauthorized model turn.

Command: `env -u NODE_TEST_CONTEXT node --test .agents/teamwork/cn14-bridge-challenge-20261027/probe-capability.js` (1 failed as intended). This is the normal `onTurnStart` hook call boundary; the probe does not mutate product source or test helpers.

Likely repair point: recheck `scoped.assertCurrent()` and frozen candidate after `onTurnStart` and immediately before calling `_request('turn/start', ...)` in `CodexAppServer._run`. Preserve no-send evidence and attempt reservation semantics when this recheck fails.

## Passing artifact interleavings

Probe: `.agents/teamwork/cn14-bridge-challenge-20261027/probe-artifacts.js`.

Command: `env -u NODE_TEST_CONTEXT node --test .agents/teamwork/cn14-bridge-challenge-20261027/probe-artifacts.js` (2 passed).

1. Captured private output waited in the real WriterAdmission queue behind a prior holder. Host binding authorization was revoked, then the holder released. Publication rejected with `publication_controls_denied_or_unknown`; CandidateStore intent was `refused`; workspace manifest unchanged; no candidate appeared; no admission holder remained.
2. Two calls with the same publication command while the first waited on real admission: the second projected authoritative `unknown` with `replay:true`; the first later applied. Instrumenting CandidateStore's configured real effect callback counted exactly one detached apply. Workspace contained expected private output, and the intent was `applied`.

Scope: three focused probes only. No live model, production service, product edit, account action, or Git mutation. Existing fake-AppServer fixture and artifact fixture were copied into owned probe files with imports adapted; failed syntax setup was corrected before the capability probe ran.
