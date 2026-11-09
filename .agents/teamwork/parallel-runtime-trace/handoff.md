# Runtime operations trace handoff

Status: complete. Assigned report: `../concurrent-harness-plan-20261026/runtime-operations.md`.

Evidence is source-read only; no runtime probes, tests, or lifecycle actions were run. Report captures per-project process/state ownership, cross-project account coupling and repository lock boundary, runtime concurrency and same-thread contention, restart/pause/budget behavior, UI/API polling and metrics compatibility. Primary references: `src/launcher-projects.js`, `src/server.js`, `src/lead-orchestrator.js`, `src/a2a-role-service.js`, `src/codex-app-server.js`, `src/launcher-app.js`, `src/activity-store.js`, `src/usage-ledger.js`, `src/performance-store.js`, `src/launcher-sessions.js`.

Additional owner task complete: role settings trace is at `../concurrent-harness-plan-20261026/role-settings.md` (under 1000 words). Locally generated App Server schema is temporarily at `/tmp/codex-app-schema-runtime-role-audit-20261026`; it was generated statically with `codex app-server generate-json-schema`, without starting a server or making calls. Confirmed model/effort fields are correctly wired in current DOM source; current data choices are static and no Fast service tier is wired. Owner role capacities are preferences, not current source behavior. No product files or tests were changed/run.

Working tree was already dirty at start (20 modified tracked files and two untracked tests); no existing product files were changed. No tests were run, per read-only research scope.
