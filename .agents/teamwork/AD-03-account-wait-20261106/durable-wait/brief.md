# AD-03 durable budget wait groundwork

Add optional explicit provider blocking windows to the existing durable budget
wait record. Preserve legacy record compatibility and lifecycle control fences.

Own only `src/backlog-store.js`, `src/delivery-lifecycle.js`,
`test/backlog-store.test.js`, `test/delivery-lifecycle.test.js`, and this task
handoff. Do not edit engine/server or run live providers.

Blockers are at most 64 unique exact records with fields
`accountIdHash`, `provider`, `model`, `windowId`, `reasonCode`, and `resetsAt`.
Validate account hashes as lowercase SHA-256 digests; bound provider, model,
and window identities; allow model and reset to be null; validate reason codes
with the existing regex; accept only nonnegative safe integer millisecond
resets. Do not infer blockers from `nextWakeAt` or percentages. Retain every
explicit window supplied by the caller and expose blockers through lifecycle
projections where the durable wait is projected.

Add deterministic tests for SQLite persistence/reopen, invalid and duplicate
blockers, timestamp-only ineligibility, and re-exhaustion after an actual wake.
Run `node --test test/backlog-store.test.js test/delivery-lifecycle.test.js`
and `git diff --check`. Do not stage or commit.
