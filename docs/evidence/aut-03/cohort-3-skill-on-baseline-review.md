# Cohort 3 skill-on baseline and correction review

Verdict: APPROVE. Status: complete. Scope expansion: none.

An independent read-only review checked the skill-on freeze manifest
`docs/evidence/aut-03/live-trial/cohort-3/skill-on-baseline-freeze.json`
(SHA-256 `30a2b74470a4bd2da77a68c874070ce61221927f3fd73adcde48c6f60c365e08`)
and `trial-entry.json` as it existed at SHA-256
`475f009eda30a33061df7394c4d25fad8f868cf0fa46365568f5fa4c03ae3339`.

The review verified all 56 recursive artifact hashes and sizes, all four task
and case identities, run evidence and protocol pointers, the approved
skill-off baseline pointer, runtime and prompt pins, and the recorded total of
87,076 tokens. Each task completed within its time, token, and turn limits.
Controls show an empty read-only workspace, zero worker roles, dispatches,
writer executions, permissions, commands, and file changes. Account switching
is false and every post-task provider error is null.

For each skill-on run, the corrected JSON preserves the initial file bytes
under the corresponding `collection-correction/run-initial.json`. The only
added fields are `settingsSha256` and `promptSha256`; both match the hashed
preflight, runtime attestation, and prompt manifest. No task was rerun. The
correction report is
`docs/evidence/aut-03/cohort-3-skill-on-collection-correction.md` (SHA-256
`7df506a6eafe3c736841e59781aabbf417cc2ad91a03af9aa88eefeff4b1889e`).

The trial gate remains closed. This approval covers evidence integrity and the
collection correction; it does not score task quality or authorize rollout.
