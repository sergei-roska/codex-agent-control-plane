# AD-03 transition journal handoff

Implemented the durable SQLite journal primitive in `src/provider-transition-store.js` with focused coverage in `test/provider-transition-store.test.js`.

The store persists one active transition per project, enforces exact idempotent intent creation, validates bounded printable IDs and distinct lowercase SHA-256 account hashes, and stores no raw account or profile data. Advancement requires the full immutable record and permits only the next phase. Clear uses transition ID, phase, owner generation, and control revision compare-and-swap pins. Mutations use synchronous immediate better-sqlite3 transactions.

Verification:

- `node --test test/provider-transition-store.test.js` - passed, 5/5 tests.
- `git diff --check` - passed, exit code 0.

This completes only the journal primitive. Admission barriers, account selection, engine rebind, and startup recovery remain unwired AD-03 integration work.

Status: complete
Scope expansion: none
