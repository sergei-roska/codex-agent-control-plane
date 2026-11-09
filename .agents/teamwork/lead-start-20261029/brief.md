# Lead start failure

Goal: fix lead startup failing provider_home_changed without switching accounts or weakening provider identity guards.
Baseline: inherited dirty tree, preserve all prior changes. No commits, live task runs or database edits.
Read-only DB evidence: .runtime/projects/3d9c2e759c/state.sqlite, run cdb27a0c-e3c5-40c2-ac4a-9005e7c041ef, planner unknown with errorCode provider_home_changed, plan_revision 0. Lead pin /home/sr/.codex. Project currently stopped after owner stop. Switching wrapper currentHome can be null for default profile while concurrent provider pin resolves concrete default path.
Worker owns minimal app-server-switch.js/concurrent engine/provider identity source and relevant tests as needed, report extra scope before editing. Investigate exact root cause, regression reproduce with real composition and stub model (zero paid calls), implement narrow fix retaining actual account-swap rejection. Tests: affected focused suites. Read /home/sr/codex-home/agents/junior_worker.toml instructions. All reports English ASCII.
