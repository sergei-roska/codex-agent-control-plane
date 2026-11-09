# Performance final repair

## Initial evidence and hypothesis

The review probe demonstrated a session aggregate regression: a persisted snapshot
with 12 tokens across two attempts rendered a live subset total of 4 for one
attempt. `mergeLiveTokenData` protected known task groups without entry-ID
coverage, but its session aggregate loop replaced each field whenever live data
was finite. Persisted task-metrics snapshots may omit entry IDs, so coverage
cannot be assumed from a finite live subtotal.

Hypothesis before editing: known snapshot token aggregates should remain intact
until live data establishes complete attributable coverage of persisted task
groups. Live aggregate values should populate snapshots whose token aggregate is
wholly unknown.

## Implementation

Added a session coverage predicate that requires matching task/assignment groups,
entry-ID coverage, compatible per-group attempt counts, no unattributed live
rows, and compatible session attempt counts. Known snapshot token components
are replaced only with that coverage; otherwise a wholly unknown aggregate can
be filled from live data. Added regressions for a finite one-of-two-attempt live
total and a fully covered refresh.

## Re-review correction

Re-review showed that the first fix kept `total.attempts` from the live subset
alongside retained snapshot token values. Auditing the merge also found an
unconditional overlay of `unattributedUsageRows`. Both now follow session
aggregate coverage: retain known snapshot attempt/unattributed counts when live
coverage is partial, use live attempts when the snapshot has no count or
coverage is complete, and fill live unattributed count only when absent from the
snapshot or when coverage is complete.
