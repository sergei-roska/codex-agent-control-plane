# AD-02 cross-process serialization handoff

Status: implementation and focused verification complete; ready for lead review.

## Blocking evidence

Sol reproduced a stale compare-and-set overwriting a newer owner activation
from a separate process. `src/account-profiles.js` read revision and then
renamed the full JSON state without a shared cross-process lock.

## Implementation

- `src/account-profiles.js` uses a stable `profiles.json.lockdb` SQLite lock,
  held with `BEGIN EXCLUSIVE` across each complete read-modify-write. The
  existing `better-sqlite3` dependency is used directly; the broader durable
  store module is not imported.
- Public `write`, add/remove, active selection/CAS, and auto-switch all use the
  same lock. Internal operations call private unlocked read/write helpers only
  while inside the lock. `read()` remains lock-free because the JSON file is
  published with atomic rename.
- The lock database is mode 0600 under the accounts directory. A 10-second
  SQLite busy timeout bounds acquisition. SQLite's kernel lock and rollback
  journal release/recover automatically if the owning process exits; the
  process-exit regression verifies a subsequent writer completes promptly.
- Independent-process tests pause one process while it owns the lock, then
  queue an owner activation or stale CAS in another process. They assert owner
  C is final and a stale CAS queued behind C is rejected. A separate test
  verifies public writes advance/preserve the active-selection revision.

## Verification

- `node --test test/account-profiles.test.js test/app-server-switch.test.js test/budget-watcher.test.js test/account-failover-context.test.js test/launcher-accounts.test.js` - 101 passed, 0 failed.
- `git diff --check` - passed.

## Independent review

Sol reviewed every profile-state writer, lock acquisition/failure behavior,
revision semantics, and both interleaving orders. Verdict: APPROVE, no blockers.
The reviewer reran `node --test test/account-profiles.test.js` - 11 passed -
and scoped `git diff --check`. Full report:
`/tmp/codex-ad02-profile-lock-review-20261106.md`.

Changed paths: `src/account-profiles.js` and `test/account-profiles.test.js`.
No `src/server.js` or AD-04-owned file was changed. No provider calls, runtime
activation, staging, or commit was performed. Root separately owns forwarding
the watcher selection pin in `src/server.js` after AD-04 releases that file.

Next: lead performs integration review and sends the repair for independent
delta review.
