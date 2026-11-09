# Brief: independent AUT-03 quota-policy review

Review the current percentage-stop override for the AUT-03 paired trial. The owner explicitly directed us to continue AUT-03 despite the displayed primary/weekly usage thresholds. Keep the trial pinned to the launcher system Team account and do not switch accounts. The revised protocol records quota percentages as evidence and stops only on an explicit provider quota-exhausted response, while retaining all model-turn, time, token, isolation, and no-command/no-dispatch caps.

Working directory: /home/sr/Projects/Workspace/codex-agent-control-plane. Source baseline: main at ebe51c8f3a6139afa4141f116707d9c94e8be952. The baseline gate must remain false during this review. Review only: no edits, tests, services, model calls, or trial tasks.

Read current files:
- docs/evidence/aut-03/paired-trial-declaration.md
- docs/evidence/aut-03/trial-entry.json
- docs/evidence/aut-03/trial-runtime-pins.json
- docs/evidence/aut-03/trial-prompts.json
- docs/evidence/aut-03/trial-server.js
- docs/evidence/aut-03/revised-controls-review-2.md

Check that: (1) the user's percentage-threshold override is represented consistently in the declaration and trial entry; (2) the 3 turn-start, 240-second, 500000 per-task token, 4000000 cohort token, read-only workspace, disabled worker/native-action controls, and exact prompt/runtime pins remain unchanged; (3) the explicit provider quota-exhausted response remains a cohort stop with no retries or account switch; (4) old stopped runs remain excluded; (5) account home remains the launcher system Team account; (6) the exact declaration and review pointers match; and (7) every executable baseline gate remains false until review and fresh preflight.

Return APPROVE, REJECT, or INCONCLUSIVE with concise evidence and the smallest correction. Update handoff.md with the verdict. Do not open the gate or start a task.
