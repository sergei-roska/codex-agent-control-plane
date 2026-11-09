# CN-04 candidate store repair challenge

Verdict: HOLDS
Status: complete
Scope expansion: none

## Decisive probes

- `node .agents/teamwork/candidate-store-challenge/gc-race.cjs` passed. It injects a second SQLite connection creating and referencing the identical manifest during GC's post-transaction unlink. The live candidate remains readable, and the cache exists after GC repairs it.
- The same probe deletes that cache, closes both original connections, reopens the database/store, and verifies the canonical SQLite row reconstructs it. It then writes a corrupt present cache and confirms `stored_manifest_corrupt` rather than silent repair.
- `node --test test/candidate-store.test.js` passed 13/13. Its recovery test checks malformed truthy quiescence and absent/unknown admission reconciliation results remain unknown, then explicit `reconciled` settles the intent once. The targeted GC test checks stat/read race and reopen reconstruction.
- `node --check src/candidate-store.js` and `node --check .agents/teamwork/candidate-store-challenge/gc-race.cjs` passed.

No new failure found in the bounded GC/cache and strict settlement repair. Shared blobs are intentionally retained for database lifetime; this verdict makes no claim about physical blob reclamation or runtime wiring.
