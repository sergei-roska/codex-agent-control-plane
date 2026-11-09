# Decision submit UI repair

Owner: decision UI worker.

Scope: `launcher-ui/app.js` and `test/launcher-decision-ui.test.js` only, plus
this ignored coordination directory. Preserve inherited dirty work. No live task
submissions, service restarts, database writes, Git staging, or commits.

Acceptance: a failed decision submit preserves the answer and selected option,
shows the actual error, blocks duplicate sends, and does not apply an old
response to a changed session. Clear the submitted draft only after the server
acknowledges continuation and the returned A2A task is not still error-paused.
Root owns browser reproduction and live acceptance.
