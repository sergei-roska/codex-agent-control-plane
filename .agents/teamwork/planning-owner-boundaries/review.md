# A3/A4 independent review

Verdict: APPROVE
Status: complete
Scope expansion: none

Latest owner-boundary re-review: PASS [read/ran]. `src/server.js` now admits budget auto-resume metadata only when auto-resume is enabled, the request is for an INPUT_REQUIRED task, and the authoritative live checkpoint pause is `waiting_for_budget`. A stale owner, human, stopped, nonwaiting, or new-task message returns before `orchestrator.resume`; the budget watcher is forgotten only after valid admission. The transient recovery path retains its separate durable identity check. Manual continuation without automatic metadata remains available.

The permanent negative cases and live watcher-positive test are meaningful: the former asserts zero `resume` and `run` calls, while the latter reaches `resume` with automatic origin. [ran] Targeted server checks: 8 passed, 0 failed, covering disabled auto-resume, stale budget metadata, owner pause, and valid watcher continuation. `node --check src/server.js` and `git diff --check` passed.

Earlier A3/A4 criteria remain PASS [read/ran]: three invalid turns lead to one fresh planning context; an invalid fresh result ends partial with one acceptance and no owner question. The explicit owner pause/restart regression preserves the pending retry counter; legacy owner continuation still works. Repeated investigated false finish becomes an honest partial, while genuine owner decisions require typed requests. Partial ledgers and acceptance preserve current-target review gates and failed or unknown verification. The prior affected suite had 446 passed, 0 failed; the new budget gate adds permanent negative coverage. No required verification was removed or weakened.

Non-blocking: No live App Server or model trial was run; evidence covers local fake-provider/SQLite paths.
