# AD-05 legacy cancel restart handoff

Status: complete for legacy cancellation restart coverage.

Added a disk-backed real `startServer` close/reopen regression in
`test/server.test.js`. It cancels a waiting legacy task while the fake active
profile's account switch is blocked, releases and settles the switch, closes
the first runtime, and reopens the same SQLite state. The test confirms the
task remains CANCELED before and after restart, with no extra orchestrator run
or resume. The fake A/B profiles, fixture-only budget states, blocked-switch
gate, and fake orchestrator avoid live provider, credential, or quota use.

Verification:
- `node --test --test-name-pattern='an explicit cancel during a legacy account switch stays canceled after server restart' test/server.test.js` - 1 passed, 0 failed.
- `node --test --test-name-pattern='an explicit cancel wins while the legacy budget watcher is blocked in an account switch|an explicit cancel during a legacy account switch stays canceled after server restart' test/server.test.js` - 2 passed, 0 failed.
- `node --test test/budget-watcher.test.js` - 45 passed, 0 failed.

No production changes, runtime activation, or external actions. No staging or
commit.
