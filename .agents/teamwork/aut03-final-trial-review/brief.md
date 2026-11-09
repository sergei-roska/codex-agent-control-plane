# Brief: independent AUT-03 protocol control review

Review the next AUT-03 protocol revision. The original attempt was invalid after Explorer dispatched and executed shell commands. A later revised cohort was stopped when `bounded-dependencies` used four `turn/start` submissions against a cap of three. That cohort is excluded, and `trial-entry.json` is closed. The prior direct-App-Server revision received static APPROVE, but it did not enforce the turn cap. The latest helper injects a direct `CodexAppServer`, pins `/home/sr/.codex` and Team plan, asserts that the orchestrator receives that exact instance, and blocks/stops before a fourth `turn/start` request.

The cap review returned APPROVE. Since then, the declaration status line was updated to record that verdict, and `trial-entry.json` records the current review and deferred start. Recheck the exact declaration pointer, review pointer, and all gate fields in the current files.

Working directory: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Source baseline: `main` at `ebe51c8f3a6139afa4141f116707d9c94e8be952`. Review only; do not edit files, run tests, start services, make model calls, or start a trial task.

Read the current files, not just this brief:
- `docs/evidence/aut-03/paired-trial-declaration.md`
- `docs/evidence/aut-03/trial-entry.json`
- `docs/evidence/aut-03/trial-runtime-pins.json`
- `docs/evidence/aut-03/trial-prompts.json`
- `docs/evidence/aut-03/trial-server.js`
- `docs/evidence/aut-03/inspect-checkpoint.js`
- `docs/evidence/aut-03/cohort-stop-report.md`
- `docs/evidence/aut-03/revised-controls-review.md`

Review whether: (1) the shared worker-role map is empty before orchestrator construction and route registration; (2) the pinned direct App Server is the same instance used by `run`, has both hooks patched, and cannot switch accounts; (3) the per-task counter observes every model `turn/start`, permits at most three, and blocks before sending a fourth; (4) the cap breach shutdown cannot leave further model turns possible or hang startup/task completion; (5) per-thread native feature overrides remove command/subagent/action tools, including the distinction between `shell_tool` and `unified_exec`; (6) the read-only Codex sandbox and mode-0555 empty workspace prevent writes, including any remaining apply_patch tool; (7) prompt inputs are exact and complete; (8) start/resume, post-task checks, and hashes remain consistent, including the repaired declaration SHA-256 pointer; (9) both deviations stay excluded and all baseline gate fields remain false.

Use only read-only inspection and static checks if needed. Return `APPROVE`, `REJECT`, or `INCONCLUSIVE`, with concise evidence, any blocker, and the smallest required correction. Do not make a live model call or change the gate.
