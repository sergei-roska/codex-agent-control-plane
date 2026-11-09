# CN14 capability implementation re-review

Verdict: APPROVE. Status: complete. Scope expansion: none.

## Resolved findings

1. Read: `src/delivery-role-capabilities.js:94-116,156-165` now accepts a `running` verifier only when the live active claim retains its fence/lease, the attempt and task are both running, and the durable `attempt.externalTaskId` equals the A2A SDK task ID passed by the boundary (`src/a2a-role-service.js:719-730`). All existing owner, control, settings, contract, context and candidate checks remain. Ran: the acknowledgement-first configured A2A/TaskExecutor regression delays resolution until `recordSubmitted` has made the attempt running, then reaches the fake AppServer and completes; a wrong external task ID is rejected.
2. Read: `src/codex-app-server.js:888` stores the same JSON MCP digest compared by `_run`; `:874-889` now derives the prepared turn policy with the same modern, legacy and strict branches as `run`. Ran: prepared physical threads successfully executed one turn with no extra thread/settings update under modern, legacy workspace-write, legacy full-access and strict read-only settings. Model, effort, Fast-off service tier, tools and approvals were asserted in the focused tests.
3. Read: `src/app-server-switch.js:80` forwards `prepareThread` through the tracked in-flight method. Ran: an in-flight preparation keeps the old instance, `switchTo` reports `busy`, and the next preparation after completion uses the new instance. This resolves the missing production wrapper surface for preparation.

## Checks and limits

- Ran `env -u NODE_TEST_CONTEXT node --test test/app-server-switch.test.js test/delivery-role-capabilities.test.js test/delivery-verifier-integration.test.js`: 21 passed, 0 failed.
- Reused root's read-only evidence in `acceptance-continuation-20261027/scoped-permissions-evidence.json` and its probe source: installed Codex 0.164.0 standalone `command/exec` with scratch cwd and the exact workspaceWrite policy read candidate input, wrote scratch, and denied candidate sibling, outside, and TMPDIR writes with EROFS. This supports standalone sandbox semantics only. Actual `turn/start` confinement and live model qualification remain UNVERIFIED and are outside this source review.
- Non-blocking: engine composition must pin account identity across prepare-to-run or reconcile an intervening account switch; the wrapper guarantees each in-flight call, not a multi-call transaction.

Pitfall: Test `returnImmediately:true` with an acknowledgement before remote setup; a completion-waiting transport hides valid running-state interleavings.

## Final send-boundary delta (2026-10-27)

Verdict remains APPROVE. Read: `src/codex-app-server.js:1159-1172` now validates scoped claim/control and candidate synchronously inside `_request('turn/start').onSending`, before setting `turnStartSent`. Read: `_request` calls `onSending` immediately before `_write` in the same synchronous `try`, and its catch invokes `onWriteError` and rejects while removing the pending request and timer (`src/codex-app-server.js:1377-1436`). There is no intervening await or external callback after the scoped check. Earlier checks before thread setup remain.

Ran `env -u NODE_TEST_CONTEXT node --test .agents/teamwork/cn14-bridge-challenge-20261027/probe-capability.js`: 1 passed. Original onTurnStart pause interleaving observed one thread/start, zero turn/start, no receipt, `turnStartSent:false`, and `verifier_objective_inactive`. Ran `env -u NODE_TEST_CONTEXT node --test test/delivery-verifier-integration.test.js --test-name-pattern='onTurnStart|pause'`: 11 passed, 0 failed; the permanent pause regression passed. No live model or service action. This is a source gate only; prior actual turn/start confinement limit remains.
