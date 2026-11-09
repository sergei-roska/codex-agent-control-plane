# CN-04 blob durability challenge

Verdict: HOLDS
Status: complete
Scope expansion: none

## Decisive probes

Command: `node /tmp/cn04-durability-retry-probe.js`
- Inject file fsync failure on a new temporary blob. `createCandidate` throws; snapshot count 0, known-candidate count 0, blob directory empty. Retry succeeds with a known candidate; its two entries remain readable after a store reopen.
- Inject blobs-directory fsync failure after rename. `createCandidate` throws; snapshot count 0, known-candidate count 0, one content-addressed orphan remains. Retry validates and syncs the reused blob, then creates a known candidate readable after reopen.
- Pre-store an existing snapshot, then inject blob fsync failure during `commitCandidate`. Snapshot count remains 1, known-candidate count 0. Retry succeeds and the candidate remains readable.
The probe uses real fsync for nonfailed calls and disposable Git/SQLite fixtures. It checks ordered call failure, not destructive power loss or hardware persistence guarantees.

Command: `node .agents/teamwork/candidate-store-challenge/gc-race.cjs`
Result: referenced survivor readable; reopen repairs missing manifest cache and rejects corrupt cache.

Command: `node --test test/candidate-store.test.js test/delivery-contracts.test.js`
Result: 33 passed, 0 failed. Existing tests include SQLite trigger assertions that blob file and directory sync calls precede snapshot and known-candidate insertion, and post-effect sync failure leaves intent unknown.

Read inspection confirms new temporary bytes are synced before rename, blob directory sync precedes snapshot insertion, reused blobs are revalidated and synced, and `commitCandidate` repeats these barriers before known-candidate insertion. Temporary descriptors close on failure; post-rename failure can leave only an orphan for retry. Manifest files are reconstructible caches. This gate assumes the caller's documented SQLite FULL setting and ordinary filesystem fsync semantics.
