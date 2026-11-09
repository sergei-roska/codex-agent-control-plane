# Task token regression handoff

## Status

Review fixes integrated in the assigned scope. No Git or live service changes.

## Cause

`launcher-ui/performance.js` returned immediately after accepting any
same-session `task-metrics/v1` snapshot. It therefore did not consult the
already-supported `?details=performance` usage API when a snapshot was stale
or had unknown per-task values. The API and collector fixtures preserve
per-attempt task/assignment token attribution, so this is a UI data-source
precedence defect rather than missing ledger attribution.

## Changed files

- `launcher-ui/performance.js`: query detailed usage with the snapshot, overlay
  live per-attempt token totals by task and assignment, and use live details to
  build token rows if no usable snapshot exists. Fallback merges token rows into
  session lifecycle rows and uses attempt timing when available. Known snapshot
  token fields survive unknown live fields; unknown contributions remain
  partial. The detailed usage request is reused after snapshot failure. Accept
  nested and legacy snake-case token fields.
- `test/launcher-performance-ui.test.js`: browser-script regression cases for
  unknown stale snapshots, missing snapshots with lifecycle timing/state,
  legacy field shapes, incomplete live tokens, retries grouped by assignment,
  distinct assignments, unknown contributions, and a single detailed usage
  request.

## Verification

`env -u NODE_TEST_CONTEXT node --test test/launcher-performance-ui.test.js test/launcher-performance.test.js test/performance-store.test.js test/usage-report.test.js test/usage-ledger.test.js`

Result after review fixes: 26 passed, 0 failed, 0 skipped.

`node --check launcher-ui/performance.js`: passed.

`git diff --check -- launcher-ui/performance.js test/launcher-performance-ui.test.js`: passed.

## Limits

No live state database was inspected. If the currently running launcher serves
an older App Server without `?details=performance`, valid snapshot data still
renders, but missing/stale snapshot token values cannot be recovered until the
existing detailed endpoint is available. No backend file needed a change.

## Review delta

Preserved `timingKind: 'lifecycle'` through task normalization. The UI regression
now checks the rendered lifecycle tooltip as well as the measured-attempt
tooltip. After this delta, `env -u NODE_TEST_CONTEXT node --test
test/launcher-performance-ui.test.js test/launcher-performance.test.js` passed
10 tests, 0 failed; syntax and diff checks passed.

Sanitized read-only evidence reported by root: the current local project
database has 98 usage rows, 95 with known totalTokens and 3 unavailable. This
supports that token data exists upstream. No model call or database write was
used.

The provenance delta derives time summary, chart coverage, row tooltips, and
table notes from each row's timingKind, independent of snapshot presence. The
mixed fallback asserts 1 measured duration and 2 lifecycle spans; additional
cases cover all-measured, all-lifecycle, and unknown-duration rows.

## Final overlay correction

Current task-metrics snapshots have no per-row entry IDs, so live attempt
coverage cannot be verified for known persisted groups. The UI now treats known
snapshot token and measured-time aggregates as coherent values and does not
replace them with live subsets. Live data fills wholly unknown token groups;
when the snapshot gives an attempt count, missing live attempts increase the
unknown token/time contribution count. Lifecycle fallback spans can still be
upgraded to measured attempt durations, with the measured source retained.
Partial live token components are not mixed into a known snapshot aggregate.

Exact challenge command: `node .agents/teamwork/ui-settings-challenge/probe-performance-overlay.js`
Result: passed; row retained 12 tokens and 100 ms, session total 12.

Exact focused command: `env -u NODE_TEST_CONTEXT node --test test/launcher-performance-ui.test.js`
Result: 11 passed, 0 failed, 0 skipped. Includes 2 persisted attempts vs 1
live attempt, partial live components, unknown-group enrichment/coverage,
lifecycle provenance, and per-assignment retry aggregation.

`node --check launcher-ui/performance.js`: passed.
`git diff --check -- launcher-ui/performance.js test/launcher-performance-ui.test.js`: passed.

Root's sanitized readonly evidence remains: 98 usage rows, 95 with known
totalTokens and 3 unavailable; no model call or database write was used.

Same-critic re-review is pending. Root requested freeze at 10 percent native
quota remaining; no further feature work or broader tests were started.
