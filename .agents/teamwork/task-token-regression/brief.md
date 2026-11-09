# Task token regression

## Objective

Repair the performance page token data flow so known per-task token totals are
not hidden by a same-session static snapshot, while genuinely missing values
remain unknown. Preserve task attribution and do not turn unknown values into
zero or duplicate cumulative counters.

## Scope

Allowed files: launcher-ui/performance.js, launcher-ui/performance.html,
launcher-ui/performance.css, src/session-performance.js, src/performance-store.js,
src/usage-report.js, src/usage-ledger.js, test/launcher-performance.test.js,
test/performance-store.test.js, test/usage-report.test.js,
test/usage-ledger.test.js, and focused performance UI/data regression tests.

Do not edit app.js, index.html, styles.css, launcher-app.js,
codex-app-server.js, role settings, or architecture docs. Preserve all
pre-existing dirty source. No live model turns, service restarts, account
changes, or Git mutations.

## Verified cause and repair

The performance UI accepts a valid task-metrics/v1 snapshot for the selected
context, renders it, and returns without querying live usage. The existing
usage endpoint already supports ?details=performance and returns
session-performance/v1 attempts. That short-circuit hid known live per-task
token rows whenever a same-session snapshot was stale or contained only unknown
values. The collector and session projection carry per-attempt token values in
focused fixtures.

The UI now requests detailed usage alongside a valid snapshot and overlays
per-attempt token contributions by task and assignment, preserving snapshot
timing and task state. If the snapshot is missing, the UI can build token task
rows directly from the detailed live response. Nested and snake-case token
fields are also accepted by snapshot normalization. Unknown token contributions
remain unknown and are counted; known totals are not inferred as zero.

Offline UI regressions cover an unknown same-session snapshot with known live
totals, no snapshot with live details, legacy nested/snake-case fields, and
unknown rows. No live database inspection or service change was needed.
