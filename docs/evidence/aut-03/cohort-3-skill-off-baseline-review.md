# AUT-03 cohort 3 skill-off baseline review

Verdict: APPROVE.

The independent reviewer verified the freeze manifest pointer and all 60
recursive evidence hashes and sizes. Run evidence and protocol pointers, case
identity and order, runtime and prompt pins, correction reports, usage,
checkpoints, attestations, and controls match. All four tasks completed within
the eight-turn, 240-second, and 500,000-token caps. Each used one lead turn.
Each workspace is empty and mode `0555`; worker roles remaining, dispatches,
writer executions, permissions, commands, and file changes are zero. Total
measured tokens are 87,404. The trial gate remained closed during review.

The pilot route-availability correction is supported by the runtime attestation
and server code: all worker roles were removed before route registration. The
corrected run changes only `workerRouteAvailable` from true to false.

Non-blocking evidence limits: the bounded-dependencies run has no post-task
quota snapshot, while its required pre-task snapshot records
`providerError: null`. The overwritten initial correction bytes and historical
pre-freeze trial-entry bytes cannot be reconstructed. These limitations do not
change the verified corrected evidence or hard-gate decision.

The trial-entry SHA-256 reviewed was
`90479084dc35866e9e34078a4bd9e377edff5f2ad728e515898bf8368b69e316`.
The review was performed by the AUT-03 cohort-3 freeze critic on 2026-10-17.

Evidence: `live-trial/cohort-3/skill-off-baseline-freeze.json`.
