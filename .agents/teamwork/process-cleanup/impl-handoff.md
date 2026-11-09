# Process cleanup implementation handoff

Status: implementation complete; independent review and challenger probes pending.

Changed `src/codex-app-server.js` and `test/codex-app-server.test.js`. Initialize now advertises `capabilities.experimentalApi`. After a confirmed terminal event, the run sends `thread/backgroundTerminals/clean` for its own thread and holds the existing `runs` entry until the RPC acknowledges or fails. Cleanup has a positive safe-integer timeout (default 5000 ms), uses no caller abort signal, and checks the run's original generation and child state before sending. It never signals the shared process group.

Cleanup failure is `background_terminal_cleanup_failed`. Its `originalTurnOutcome` and `originalError` preserve completed, failed, or aborted model state; `outcomeUnknown` is true for any started turn whose resource quiescence was not confirmed, so writer settlement remains blocked. An abort arriving while cleanup waits is reported as `AbortError` only after cleanup acknowledgement. No cleanup RPC is sent for rejected starts, unconfirmed terminals, or a changed/dead generation.

A failed cleanup quarantines new turns for that App Server generation with `background_terminal_cleanup_blocked`, before config enumeration, thread start/resume, or turn start. The blocked error exposes only the original cleanup failure class, generation, thread ID, and turn ID. Existing runs still terminalize and perform their own thread cleanup. Quarantine is stored only when the failure still belongs to the current generation and clears when a replacement generation starts, so a late old-generation failure cannot block the replacement.

Focused tests cover handshake capability, delayed acknowledgement and same-thread overlap, failed-turn/unsupported RPC metadata, abort during delayed cleanup, bounded timeout, generation change, concurrent thread isolation, same-thread continuation, persistent-failure quarantine, continued cleanup for an already-running distinct thread, and quarantine clearing on generation replacement. Native protocol smoke was independently run by root against an ephemeral thread; no model turn was used.

Verification:
- `node --test --test-name-pattern='performs initialize handshake|waits for thread-scoped|cleanup RPC failure|quarantines new turns|cleanup ignores an abort|bounds cleanup RPC|generation has changed|routes concurrent|does not resume a thread started' test/codex-app-server.test.js` - 9 passed, 0 failed.
- `node --test test/codex-app-server.test.js` - 98 passed, 3 failed. Remaining failures: fixed-per-role tool config expects an older permissionConfig shape; enumeration-failure fails during config/read before thread creation; selected-skills expects a stale catalog ID. These paths do not reach cleanup. No pre-edit test run is available.
- `node --check src/codex-app-server.js` and `node --check test/codex-app-server.test.js` - passed.
- `git diff --check` - passed.

Loaded runtime remains unchanged; no service restart, deployment, or live inference performed by this implementation. Root owns live cleanup and runtime loading.

Status: complete
Scope expansion: none
