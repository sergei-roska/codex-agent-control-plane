# Final independent review: background process cleanup

Verdict: APPROVE

Resolved blocking race: `_assertTurnAdmission(ctx)` now checks the captured generation both at initial admission and after awaited setup, before `onTurnStart` and `turn/start`. Evidence (ran): I repeated the formerly failing isolated fake-RPC probe. The waiting second run now failed with `background_terminal_cleanup_blocked`, `outcomeUnknown: false`, and zero `turn/start` requests after the first run's cleanup failed.

Evidence (read): Cleanup is thread-scoped, has a 5000 ms independent timeout, retains the in-flight thread entry through acknowledgement, and marks resource quiescence unknown on failure. A2A writer settlement uses `outcomeUnknown` to retain unresolved ownership; a live shared App Server is protected from group killing by process quiescence checks. The documentation describes the final lifecycle and managed restart boundary accurately.

Evidence (ran): Focused quarantine and race tests: 2 passed, 0 failed. `git diff --check`, `node --check src/codex-app-server.js`, and `node --check test/codex-app-server.test.js` passed. The worker reports 10/10 focused tests. Existing broader App Server and related-suite failures were compared with the isolated HEAD baseline in `baseline-comparison.json` and `related-baseline-comparison.json`; their names and messages match. Native empty-thread cleanup RPC was smoke tested by the lead. The challenger reports controlled real OS child probes passed, including 75 sequential runs with no leftovers, neighbor isolation, and late abort; I did not rerun those probes.

Non-blocking: Real background process termination was assessed by the challenger's controlled RPC probes rather than by this critic.

Pitfall: Admission checks placed before awaited setup can become stale before the operation they guard.

Status: complete
Scope expansion: none
