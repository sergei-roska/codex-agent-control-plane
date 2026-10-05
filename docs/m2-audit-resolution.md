# M2 audit resolution

Status: accepted for merge after the M2 owner-scope fixes. Phase B owner scope was
SUP, WAL-01, WAL-02, and OPS-02. OPT-01..03 were not started and remain outside
this M2 resolution; OPT-04 remains dependent on later routing work.

## Findings and fixes

- **F1, supervisor generation ownership:** a delayed event from an old child
  could clear the replacement's pending start or trigger duplicate starts. The
  supervisor now tracks start ownership and child state by generation, so old
  generation events cannot release current start state. The test asserts the
  late old-generation exit does not cause a second replacement spawn.
- **F2, bounded failure settlement:** timeout/termination paths could leave a
  run pending until child exit and bypass the configured exit deadline. The
  supervisor now fails the generation at the decision point, settles its runs
  by the per-run outcome rule, and records `unreaped` when the injected-clock
  exit wait expires. The regression uses a leader that never exits.
- **F3, start-response failure race:** invalid JSONL delivered with the
  `turn/start` response could fail before the run was registered for terminal
  waiting, leaving a stale run and allowing its timer to affect another
  generation. Timers now capture their generation, start checks failure after
  the response, and failed-child cleanup rejects remaining runs.
- **F4, launcher session deletion:** deletion now refuses while any execution
  row belonging to the run's tasks is `active` or `unresolved`; it removes only
  released or reconciled rows. The transaction preserves session and execution
  data on refusal, including when a later task is held. Direct lead-task
  deletion is covered too.
- **F5, cancel confirmation:** the default deadline is now 30,000 ms.

## Verification

- On the stabilized `c277612` baseline, the three new F1-F3 regressions failed
  independently and without hanging: F1 observed 3 spawns instead of 2; F2's
  run did not settle when `turn_timeout` chose termination at 100 ms (the
  500 ms exit wait had not yet begun); F3's run did not observe the process
  failure. Tests: `test/codex-app-server.test.js`. Evidence:
  `/tmp/supervisor-senior-baseline-f1-f3.log`.
- Before fixes, the F4 regression did not refuse deletion with a held execution;
  see `test/launcher-sessions.test.js`. The F5 regression confirmed the default
  was 20,000 ms instead of 30,000 ms; see `test/lead-orchestrator.test.js`.
- Focused checks passed 86/86; the new regression checks passed 9/9.
- Independent read-only audit accepted I1-I5 and F1-F5.
- `env -u NODE_TEST_CONTEXT npm test` passed: 548 tests, 13 suites, 0 failed,
  cancelled, or skipped; exit code 0. Full log:
  `/tmp/supervisor-senior-full-escalated.log`.
- Before staging, `git diff --check` passed with no whitespace errors.
  `git diff --cached --check` will be run after staging the exact authorized files.

No OPT work is included in this resolution. No Phase C branch or implementation
is created here.
