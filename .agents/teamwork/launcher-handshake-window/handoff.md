# Launcher handshake implementation handoff

Source implementation is complete and frozen for independent review. The
handshake runs one bounded low-effort `gpt-6.1-sol` turn on the exact selected
account using the existing App Server `run()` lifecycle, an ephemeral thread,
temporary cwd, strict read-only sandbox with network disabled, and empty tool
and skill selection. Provider primary/secondary limits are read after terminal
completion; stale or missing future reset data is retried briefly and the final
provider values are preserved without local reset calculation. Per-account
concurrent requests share one turn. A cache epoch prevents an older forced GET
from overwriting newer handshake data.

The UI requires explicit completed-turn and fresh-limit fields, updates the
selected card from the returned provider data, retains status through card
refresh, and displays `Limits pending` when the provider has no future primary
reset. A legacy backend response produces a restart-required error instead of
claiming success. The button tooltip says `Send a short request and refresh
this account usage window`.

Changed source/tests: `src/codex-app-server.js`, `src/launcher-app.js`,
`launcher-ui/app.js`, `test/codex-app-server.test.js`,
`test/launcher-accounts.test.js`, and new `test/launcher-handshake-ui.test.js`.
This agent owns this handoff. Existing dirty launcher/port files were preserved.

Installed protocol schema inspection used:
`codex app-server generate-json-schema --experimental --out /tmp/launcher-handshake-schema`.
The installed schema confirms `thread/start.ephemeral`, the model/cwd/config
fields, and turn model/effort/sandbox policy fields. No model turn or app restart
was run. Launcher PID 18693 remains running old backend code; live application
upgrade is outside this worker scope.

Verification:

- `node --test test/launcher-accounts.test.js test/launcher-handshake-ui.test.js`: 22 pass, 0 fail.
- Final polish: `node --test test/launcher-handshake-ui.test.js`: 3 pass, 0 fail. This executes the real `formatResetCountdown`, `limitBlock`, `accountBlock`, and `renderAccounts` functions in the VM and asserts the future provider reset renders `(5h 1m)` with completed status.
- `node --test --test-name-pattern='account usage handshake uses|performs initialize handshake and completes a turn|runs on the requested profile before reading and caching provider limits|retries stale provider reset data briefly|does not let an older account refresh overwrite|deduplicates the same account|uses the system home while a named profile is active|returns failure without inventing a reset|reports limits pending' test/codex-app-server.test.js test/launcher-accounts.test.js`: 9 pass, 0 fail.
- `node --check src/launcher-app.js`, `node --check src/codex-app-server.js`, `node --check launcher-ui/app.js`, `node --check test/launcher-accounts.test.js`, and `node --check test/launcher-handshake-ui.test.js`: pass.
- `git diff --check`: pass.
- A full `node --test test/launcher-accounts.test.js test/codex-app-server.test.js` run observed 128 pass and 2 baseline failures in untouched tests: the existing enumeration-failure expectation at `test/codex-app-server.test.js:1640`, and the skill identifier fixture expectation at `:1822` (same pinned hash, changed identifier). Independent review reproduced both against HEAD source and tests.

Independent review verdict: APPROVE, no blocking findings. Final polish syntax
checks for `launcher-ui/app.js` and `test/launcher-handshake-ui.test.js`, plus
`git diff --check`, pass. Next action: root acceptance. No Git operation,
commit, live request, or restart was performed.

Root acceptance: independent review APPROVE and final tooltip/test delta accepted.
Owner explicitly chose to defer live application until a planned restart. Task
complete for source scope; launcher/project processes remain unchanged. Root
evidence and baseline failure reproduction are in acceptance.md.
