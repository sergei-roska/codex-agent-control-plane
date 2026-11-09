# CN14 router independent re-review

Verdict: REJECT. Status: complete. Scope expansion: none.

Blocking: `src/delivery-engine-router.js:76-83` checks immutable intake conflicts
only if the persisted request already owns the key. A normal mapped run created
without `newRequest`, `contract`, or `contextId` can add that field on replay,
despite its `resume_placeholder=0`. The merge then persists the new field and
calls the engine. Only a true resume placeholder may backfill once. Fix by
comparing every explicitly supplied immutable field against the persisted
first-intake schema, including absent keys, unless the row is a true placeholder.

Evidence (read): Conflict predicate uses `Object.hasOwn(oldRequest, key)` and
`mergedRequest = { ...oldRequest, ...supplied }`. `run()` calls `#pin` for any
nonempty intake on a mapped run. No caller or facade guard prevents the replay;
the router has no production construction site under `src` yet.

Evidence (ran): Inline in-memory better-sqlite3 probe called `run({runId:'r',
goal:'G'})`, then `run({runId:'r',goal:'G',newRequest:'new value'})`. Mapping request
changed from `{"goal":"G"}` to `{"goal":"G","newRequest":"new value"}`;
`resume_placeholder=0`; engine run call count was 2. Focused test command
`env -u NODE_TEST_CONTEXT node --test test/delivery-engine-router.test.js`
passed 7/7, but lacks this case. `git diff --check -- src/delivery-engine-router.js
test/delivery-engine-router.test.js` passed; files are untracked, so ordinary
`git diff` has no content for them. Source and tests were read directly.

Facade review (read): All current router facade methods are in the router; no
production construction/call site was found under `src`. `isResumable` awaits
the legacy async result. `getRunGoal` and `getRunDigest` fallback to their
selected engine. `activeRuns`, pause and recovery methods delegate to engines.
No additional blocking defect was established after the decisive intake probe.

Next action: Repair the absent-key immutable comparison, add a regression test
with a normal first run lacking each optional immutable field, then re-review
the delta. No source, test, Git, service, or account changes were made here.

## Re-review after repair

Verdict: APPROVE for the router seam delta. Status: complete.

Evidence (read): `src/delivery-engine-router.js:77-79` now rejects an explicitly
supplied immutable key when the normal stored request lacks it, or when its
value differs. The `resume_placeholder` branch still permits the first real
intake only; the first update clears its flag. `run()` routes persisted intake
over the caller input, and the existing facades have no new changes.

Evidence (ran): Repeated the exact prior two-call SQLite probe with changing
clock. The second call now rejects with `run_intake_conflict`; mapping remains
`{"goal":"G"}`, provider call count remains 1, and the placeholder flag is 0.
Focused router tests pass 8/8, including omitted-first coverage for all four
immutable fields. `git diff --check` passes. The source and test remain
untracked, so ordinary `git diff` contains no content; both were read directly.

No product, Git, service, or account changes were made in this re-review.
