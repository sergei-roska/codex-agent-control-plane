# AD-07 real-browser decision card acceptance

Status: complete.

## Evidence

- Added `test/launcher-decision-browser.test.js`. It serves the checked-in full
  launcher HTML, CSS, and `app.js` from a local synthetic API, then runs them in
  `/usr/bin/google-chrome` headless with a disposable profile and no external
  networking.
- Actual rendered DOM shows the infeasible-requirement reason, question,
  recommended option, both option descriptions, evidence list/count, and
  independent work. Free text alone keeps submit disabled; selecting `recover`
  enables it.
- Captured POST: `/api/projects/project-a/task/send` with exact body
  `{"goal":"recover","taskId":"task-a","decision":"decision-browser-1","choice":"recover"}`.
- Browser test creates no workspace artifacts; server, Chrome, profile, and CDP
  connection are closed/removed after the run.

## Verification

- `node --test test/launcher-decision-browser.test.js`: 1 passed, 0 failed,
  0 skipped. This launches Chrome and exercises the real browser DOM.
- `node --check test/launcher-decision-browser.test.js`: passed.
- `git diff --check -- test/launcher-decision-browser.test.js .agents/teamwork/AD-07-research-20261106/browser-acceptance/handoff.md .agents/teamwork/AD-07-research-20261106/ll7-acceptance/handoff.md`: passed.
