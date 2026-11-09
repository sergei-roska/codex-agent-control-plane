# CN-04 local gate final re-review

Verdict: APPROVE
Status: complete
Scope expansion: none

## Evidence

- Read: GC commits candidate/snapshot metadata pruning before deleting only manifest cache files. It keeps immutable blobs for the database lifetime, then uses an immediate transaction to restore a manifest cache if a concurrent publisher recreated an active snapshot row. `storeManifest` and `readManifest` also use immediate transactions; reads rebuild an absent cache from canonical SQLite JSON, while a present mismatched cache fails as corrupt. Candidate/intent commits require active snapshot metadata.
- Ran `node .agents/teamwork/candidate-store-challenge/gc-race.cjs`: passed; the second connection's referenced candidate remained readable and its manifest cache existed after injected unlink. The probe created a disposable `/tmp/candidate-gc-race-*` fixture that may be removed independently.
- Read: publication and reconciliation require quiescence to return literal `true`; admission release/reconcile counts as settled only with explicit `released` or `reconciled` state. Truthy malformed callback results remain unresolved.
- Ran `env -u NODE_TEST_CONTEXT node --test test/candidate-store.test.js`: 13 passed, 0 failed. The new test covers cross-connection reuse, a missing cache between stat/read, and restart repair. Existing tests cover event rollback, identity pins, crash paths, tampering and lineage.

## Blob durability repair

- Read: `putBlob` syncs new temporary bytes before rename and syncs the blobs directory before snapshot row insertion. Existing blobs are hash-checked and re-synced. `commitCandidate` repeats every referenced blob's validation and file/directory sync inside the immediate transaction before a known row. Directory creation syncs parent entries; sync failures abort metadata commits. The cleanup path closes the temporary descriptor and removes a failed temporary file where present. Manifest files remain disposable caches.
- Ran `env -u NODE_TEST_CONTEXT node --test test/candidate-store.test.js test/delivery-contracts.test.js`: 33 pass, 0 fail including call-order triggers and file/directory sync failure injection. Ran the exact GC race probe again: survivor readable; reopen/cache repair and corrupt-cache rejection pass.
- Decision detail: `durability.md`. Approval assumes the caller's documented SQLite FULL synchronous setting and filesystem fsync semantics. It does not claim actual power-loss testing or Git+SQLite atomicity.

No blocking finding remains in the bounded CN-04 durability repair. Prior independent evidence for pinned recovery metadata and delivery/v1 projection remains valid. Approval covers the local candidate store gate, not runtime wiring or live publication.
