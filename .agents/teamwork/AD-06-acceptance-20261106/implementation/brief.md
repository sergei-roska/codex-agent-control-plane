# AD-06 concurrent acceptance integration

Role: junior_worker (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Baseline source: `ab5c195` plus shared uncommitted backlog, AD-01, and concurrent restart changes. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, `map.md`, AD-06 in `docs/autonomous-delivery-backlog.md`, and `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Goal

Turn the existing concurrent acceptance primitives into executable AD-06 evidence. An objective may be accepted only after every required successor and check is complete against the current candidate, uncertain effects are settled, and a durable accepted fingerprint remains qualified after reopen. Prove that a dependent successor reads the accepted predecessor candidate and rejects a stale target.

## Allowed files

- `test/concurrent-delivery-engine.test.js`
- `test/delivery-acceptance.test.js`
- `test/backlog-store.test.js`
- `src/concurrent-delivery-engine.js`
- `src/delivery-acceptance.js`
- `src/backlog-store.js`
- this task's `handoff.md`

No other agent owns these paths. Do not edit legacy `lead-graph.js`, `server.js`, `durable-store.js`, tracked docs, or unrelated files. Preserve existing changes. No Git state changes, live provider calls, real quota use, or runtime activation.

## Acceptance

- A worker claim of `goalAchieved: true` with a queued successor cannot finalize the objective.
- A stale candidate receipt, failed/missing pinned mandatory check, or unknown writer effect cannot be accepted. An unresolved effect remains explicitly unknown/incomplete.
- When required work settles and fresh checks pass on the current candidate, accepted state and its fingerprint survive SQLite reopen and status/result replay without changing.
- An executable successor-rebasing test proves the dependent task consumes the accepted predecessor candidate and rejects stale target identity/output.
- Reuse existing candidate, check, and lifecycle contracts. Fix source only when a new test demonstrates an actual gap; do not weaken assertions or change completion policy for convenience.
- Run focused suites for touched files and report exact commands/counts. Do not run the full repository suite in this slice.

Update this task's `handoff.md`, report under 200 words, and end with `Status: complete | partial | blocked` and `Scope expansion: none` or the exact path/reason.
