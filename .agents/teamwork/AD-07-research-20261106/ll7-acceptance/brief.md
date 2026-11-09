# AD-07 LL-7 decision card acceptance

Role: junior_worker (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, `map.md`, LL-7 row in `docs/orchestrator-improvement-backlog.md`, AD-07 in `docs/autonomous-delivery-backlog.md`, and `/home/sr/codex-work/agents/junior_worker.toml`.

## Goal

Close the explicitly open LL-7 browser acceptance check for the decision/status card. Verify the real rendered UI displays the owner-decision reason/question, recommended option, evidence checked, independent work, and option-only selection; submit an option and prove the intended choice is applied. Preserve scoping, stale decision handling, and draft/selection behavior.

## Allowed files

- `test/launcher-decision-ui.test.js`
- `launcher-ui/app.js` only if the acceptance check exposes a real UI defect
- this task's `handoff.md`

No other agent owns these files. Do not edit controller APIs, unrelated launcher UI, or tracked docs. Preserve all shared edits. No Git state changes, live provider/quota use, or runtime activation.

## Method and acceptance

1. Inspect the existing decision UI test harness and available browser automation. Use an existing project-local browser harness if one exists; do not install dependencies or invent an unverified browser run. If no browser is available, implement the strongest integrated rendered-DOM check supported by the repository and report the browser limitation precisely.
2. Cover all LL-7 content fields and confirm the owner chooses by option ID only, with authenticated decision scope and stale-decision rejection intact.
3. Run the focused test and syntax/diff checks for changed paths; report exact commands/counts. No full suite.

Update this task's `handoff.md`; report under 200 words and end with `Status: complete | partial | blocked` and `Scope expansion: none` or exact path/reason.
