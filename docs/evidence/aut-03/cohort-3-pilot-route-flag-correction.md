# AUT-03 cohort 3 pilot route flag correction

The pilot run recorded `workerRouteAvailable=true`, which contradicted its
`workerRoles.remainingCount=0` and the runtime attestation that all eight worker
roles were removed before orchestrator construction and route registration.
The route flag is corrected to `false`. No task was resumed or rerun.

The pre-correction run bytes are preserved at
`live-trial/cohort-3/skill-off/pilot-price-f2/collection-correction/run-before-route-flag-correction.json`
with SHA-256 `af4dc282feef7a4ce166f0cdab48ed1dcbe288fe631d191f74002e7c899bcbed`. The corrected run SHA-256 is `7b58c05c41ccc53c5727967a4dacd1ec284195f7ef39d2efba9f7e0e6609c508`.
The existing dispatch journal, writer-execution records, permission records,
commands, and file-change aggregates remain zero.

The read-only SQLite inspection and runtime attestation are unchanged. The
trial gate remains closed pending independent baseline-freeze review.
