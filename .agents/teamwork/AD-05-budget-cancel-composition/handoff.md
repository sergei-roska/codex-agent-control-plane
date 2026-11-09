# AD-05 legacy budget-cancel composition handoff

Status: complete; deterministic composed race regression added and verified.

Added `test/server.test.js` case `an explicit cancel wins while the legacy
budget watcher is blocked in an account switch`. It uses fake profiles and App
Servers, blocks the fake active profile's close during `switchTo`, cancels via
the public lead A2A handler, releases the switch, and verifies persisted task
state remains CANCELED with zero orchestrator resume calls.

Verification:
- `node --test --test-name-pattern='an explicit cancel wins while the legacy budget watcher is blocked in an account switch' test/server.test.js` - pass 1/1, fail 0.
- `node --test test/budget-watcher.test.js` - pass 45/45, fail 0.

No production defect exposed. No live providers or credentials used; inherited
`:memory:.lockdb` left untouched. No staging or commit.
