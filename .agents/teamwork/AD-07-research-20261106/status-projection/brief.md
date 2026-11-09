# AD-07 concurrent objective status projection

Role: junior_worker (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, `map.md`, the existing status/control methods, and `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Goal

Extend the concurrent control status response so chat has a durable, objective-scoped view of phase/disposition, next automatic action, provider/account binding, budget waits, blockers, mandatory checks, and terminal result. The AD-07 outcome and source map are in `docs/autonomous-delivery-backlog.md` and `map.md`.

Use authoritative persisted sources and existing projection APIs. Missing or unsupported values must be `null`/`unknown` with a reason; do not derive successful completion or provider identity from absent data, process-local state, counters, or prose. Preserve current scope pins, inbox receipt/application distinction, legacy status behavior, and existing response fields.

## Allowed files

- `src/concurrent-delivery-engine.js`
- `src/project-delivery-controller.js`
- `test/concurrent-delivery-engine.test.js`
- `test/project-delivery-controller.test.js`
- this task's `handoff.md`

No other agent owns these files for this slice. Do not edit host/launcher routes, UI, other AD-01/AD-06 source, or any unlisted file. If the durable source for a requested field does not exist, expose an explicit unknown and report the missing source rather than expanding scope.

## Acceptance

- Status remains scoped to run/project/session/objective and preserves revisions, inbox, decisions, and disposition.
- It exposes phase and a next-action description tied to current persisted state; accepted/canceled/partial/waiting/paused/active states remain distinct.
- Account/provider identity and wait windows are exposed only from durable binding/wait records; raw account IDs/tokens are never exposed. If current account is not durably attributable, it says unknown.
- Blockers and mandatory check outcomes are taken from current persisted objective/task/acceptance evidence, and unknown evidence stays unknown.
- Final result/fingerprint is present only when accepted finalization is durably recorded; no narrative or counter-based inference.
- Add focused tests for active, waiting/blocked, and terminal/unknown projections, including SQLite reopen where needed. Retain existing response compatibility.
- Run focused concurrent-engine and controller tests; report exact command/counts and any unsupported status fact.

No live provider, quota use, runtime activation, or Git state changes. Update `handoff.md` with changed files, decisions, exact verification, and remaining status facts that cannot yet be shown.
