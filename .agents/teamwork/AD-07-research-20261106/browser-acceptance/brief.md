# AD-07 real-browser decision card acceptance

Role: junior_worker (Luna), follow-up to LL-7 rendered-DOM check. Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Local environment evidence: `/usr/bin/google-chrome` is available; Node is v26.13.0 with built-in WebSocket. Read root `AGENTS.md`, the AD-07 source map, `ll7-acceptance/handoff.md`, and `/home/sr/codex-work/agents/junior_worker.toml` before work.

## Goal

Complete the missing actual browser acceptance. Exercise the real launcher page, `launcher-ui/app.js` and its decision card markup in headless Chrome against a local synthetic API fixture. Verify reason/question, recommendation, evidence, independent work, radio option selection, option-only submit, and the scoped choice ID sent to the task endpoint.

## Allowed files

- `test/launcher-decision-browser.test.js` (new)
- `.agents/teamwork/AD-07-research-20261106/browser-acceptance/handoff.md`
- the existing `ll7-acceptance/handoff.md` for a cross-link only

No app/UI source edits unless a concrete defect is reproduced and reported first. No dependency install, network service, user profile, or production project. Use a temporary Chrome profile and local synthetic API only. No Git state changes.

## Acceptance

- Run the full launcher HTML and actual `app.js` in `/usr/bin/google-chrome` headless mode; do not extract individual functions or use a mocked DOM for this browser check.
- Stub only the local API needed to show one paused task and accept its option. Capture the POST and assert exact project/task/decision scope and selected option ID.
- Verify the browser-rendered DOM contains the LL-7 fields and that free text alone cannot submit when options exist.
- Keep the browser test dependency-free. It may skip on environments with no supported Chrome binary, but it must run here and must not claim a browser pass when skipped.
- Use disposable temp directories, close browser/server, and leave no artifacts in the project workspace except the allowed test and handoff.
- Run `node --test test/launcher-decision-browser.test.js` and report exact result. Do not run the full suite.

Update this task handoff and the LL-7 handoff with the browser command, evidence, and any limitation. Report under 200 words and end with `Status: complete | partial | blocked` and `Scope expansion: none` or exact path/reason.
