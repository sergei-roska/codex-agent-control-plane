# Scheduler state trace handoff

Completed read-only source trace for `.agents/teamwork/concurrent-harness-plan-20261026/scheduler-state.md`.

- Covers `LeadState` and graph flow, SQLite state tables, ID semantics, replay/crash windows, batch/wave and review barriers, and concrete extension points/invariants.
- Added multi-project ownership: launcher spawns per-project servers/DBs; no global scheduler exists; the workspace lock is keyed by Git common dir and excludes aliased workspaces. Recommendation is project-local scheduler/review/reconciliation plus global arbitration only for actually shared provider capacity.
- Source evidence only; no live runtime verification or tests. Dirty tree and services untouched.
- Next: root integrates with review/candidate and runtime/UI/recovery traces; independent critic should check design-level invariants and cross-project fairness/locking claims.
