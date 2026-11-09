# AUT-02 direct baseline and origin handoff

Status: implementation complete; awaiting lead integration/review.

Added `docs/evidence/aut-02/replay-baseline.cjs`. It reads
`entry.json.implementationCommit`, uses `git archive` in a temporary directory,
overlays the four focused tests and current AUT-02 fixtures, symlinks current
`node_modules`, runs the requested name pattern from the archived workspace,
and inserts a JSON replay manifest into a TAP comment. The manifest records
baseline source hashes, current overlay hashes, exact command, counts, Node
version, and the dependency link policy. The temporary archive is removed after
the run. Output paths are limited to `docs/evidence/aut-02`.

`docs/evidence/aut-02/direct-baseline.tap` captures the direct verifier A->B
probe against baseline commit `cc0958edd54a5c7ddaab02e4844fa69b823af365`.
Same-target continuation passed; stale continuation reached `appServer.run`
(3 calls total) and was accepted, failing the required 2-call assertion. TAP
manifest counts: 1 test, 0 pass, 1 fail. Baseline service hash is
`4ab02f2bd1ec8b14120bb39ccb88fb0137ffe45a9792e52a7d32b3129d410516`.
Current overlay test hash recorded in the manifest must match the current
`test/a2a-role-service.test.js` hash.

Origin validation now requires a unique complete origin record matching event
type, started status, kind, checkpoint, role, run when present, and target.
Verifier review continuations require a run ID. A 10,000-event result stops
closed to avoid hidden conflicts beyond the bounded list. Any matching attempt
record with malformed evidence invalidates the origin. Verifier preflight
rejections include structured review metadata with `reason` and boundary code
`review_origin_stale`, `failureKind: request_invalid`, and `effects: none`.

Focused tests cover stale/same-target direct verifier continuations, missing,
runless, cross-run, unavailable, corrupt, valid-plus-corrupt, wrong-role,
ambiguous, and full-window origin evidence; auditor origin variants; pinned
fallback unchanged/missing controls; and six-field immutability. With
`AUT02_TRACE_DIR`, the direct verifier test writes sanitized call counts,
attempt/checkpoint IDs, target identities, and outcome. Temporary baseline and
final traces were observed at `/tmp/aut02-direct-baseline-trace-20261015/` and
`/tmp/aut02-direct-final-trace-20261015/`; they may disappear. Baseline trace
shows 3 App Server calls and accepted outcome; final trace shows 2 calls and
`review_origin_stale`.

Follow-up trace-format check: named direct verifier probe passed, trace parsed
with `JSON.parse`, and final byte was LF (`0x0a`). The replay baseline was
regenerated; the focused test overlay hash did not change and baseline remained
1 test, 0 pass, 1 expected fail.

Verification:

- `node --check docs/evidence/aut-02/replay-baseline.cjs` passed.
- `node --test --test-isolation=none --test-reporter=tap test/contracts.test.js test/review-policy.test.js test/a2a-role-service.test.js` passed 115/115, 0 failed/skipped.
- Direct baseline replay via `node docs/evidence/aut-02/replay-baseline.cjs --test-name-pattern 'direct verifier continuation requires its originating target and preserves same-target control' --output docs/evidence/aut-02/direct-baseline.tap` recorded the expected baseline failure.
- Generic graph replay smoke recorded 1 failing baseline test in `/tmp/aut02-graph-replay.tap`; the direct baseline artifact was restored afterward.
- `git diff --check` passed.

No graph source/test was edited. `aut02_graph` was given exact failed-task
metadata fields for Q05 wiring. Lead owns final graph integration and durable
trace retention decisions.

## Thread-origin challenge repair

The challenger repro was captured before this repair with
`node .agents/teamwork/aut02_direct_challenge/thread-origin-probe.cjs` to
`/tmp/aut02-direct-thread-origin-before.log`. It failed as expected: the forged
`attempt-b` plus `thread-1` continuation made a third App Server call and was
accepted using candidate A context.

Direct auditor, verifier, and pinned-review continuations now write an
append-only `review_continuation_emitted` event before result artifact or
terminal publication, after writer and lane settlement, whenever a returned
thread ID is available. The tuple is finalized once and that cached value is
used for both digest and returned artifact/failure metadata, including when
lane completion removes a lane row. Version 1
stores a SHA-256 digest over a domain-separated canonical tuple containing
`threadId`, `laneId`, and `codexHome`, with explicit null values; raw tuple
values are not written to staging. The event's run, assignment, attempt, role,
and target columns bind it to the started review evidence, while payload fields
bind version, kind, and checkpoint.

Any supplied non-null thread, lane, or codex-home value requires exactly one
matching version-1 binding from the same run, attempt, role, checkpoint, and
known target before App Server execution. Missing, malformed, ambiguous,
saturated, unavailable, or unknown-version binding evidence rejects with
`review_origin_unknown`. A complete valid v1 binding whose tuple digest differs
rejects with `review_origin_stale`. Clearing all three context fields permits a fresh/replan path after
the existing target-origin check, including for legacy attempts that predate
the binding event. Verifier review continuations still require a run ID;
investigations and ordinary non-review continuations retain their existing
policies.

Rollback/default: do not resume legacy context tuples without a version-1
binding. Preserve this fail-closed guard during rollback; clear thread/lane/home
and start fresh when using older attempt evidence. No staging schema migration
or shared/live database operation is needed. Reverting the guard itself would
reintroduce the reproduced cross-attempt context acceptance.

Added named tests for thread/lane/home mismatches, verifier structured
preflight metadata, absent/malformed/ambiguous/unavailable/unknown-version
bindings, same-origin usage resume, and cleared-fields fresh execution. Updated
the staging event contract assertion.
Verification after the changes:

- `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='direct review continuations bind thread lane|direct review resumable context|direct verifier continuation requires' test/a2a-role-service.test.js`: 3 passed.
- `node --test --test-isolation=none --test-reporter=tap test/contracts.test.js test/review-policy.test.js test/a2a-role-service.test.js`: 117 passed, 0 failed.
- `git diff --check`: passed.

The pre-repair output is temporary and may disappear. Graph Q05 structured
failure metadata did not change; no graph fixture update is needed.

The durable direct replay was refreshed after the final test hash changed:
`docs/evidence/aut-02/direct-baseline.tap` now overlays test hash
`ab5408a7be89c86bc42c6e70be2e7ef171e3c9255c6ff47da5eb349760076089` on baseline
commit `cc0958edd54a5c7ddaab02e4844fa69b823af365`. It records 1 test, 0 pass,
1 fail: the baseline service accepted the mismatched verifier thread (state 3
instead of expected failed state 4).

The verifier regression now keeps its lane present until `lanes.complete`,
removes it there, confirms the published lane ID is null, then verifies the
same returned tuple resumes successfully. Final service/test hashes for the
Q06 update:
`95281c89bdab68f0aae8e0375b2f72930d9e4fa3868670f66600056144717234` and
`ab5408a7be89c86bc42c6e70be2e7ef171e3c9255c6ff47da5eb349760076089`.

Read-only graph check: `node --test --test-isolation=none --test-reporter=tap
test/lead-graph.test.js` had 203 pass and 1 fail. The failure was
`a scoped content change invalidates matching receipts before reuse`, which
threw `lead script exhausted` from the scripted lead callback; no staging
assertion failed. Full TAP is in `/tmp/aut02-direct-graph-check.tap`. No graph
files were edited.
