# AUT-03 cohort 3 collection correction review

Verdict: APPROVE for corrected task evidence.

The independent reviewer checked the corrected run and controls against the
preserved A2A task response, checkpoint, attestation, and a read-only SQLite
inspection. It confirmed the task completed, the lead skill was disabled, the
workspace was empty and read-only, one of eight permitted lead turn starts was
sent, and dispatch, writer, permission, command, and file-change counts were
zero. The durable SQLite query record agrees with those values.

The reviewer verified the database-check, report, corrected-run, and
trial-entry hash pointers. The trial-entry hash reviewed was
`64a646f064b2252ebb9db564c125def1f144637d395d492523bd4b742f15bad3`.
At that point `baselineCaptureAllowed` was false and the trial gate was closed.

The initial failed `run.json` and initial `controls.json` bytes were overwritten.
The precise field-level cause of the initial classification therefore remains
unverified. This limits review of the classification failure's cause, not the
corrected task's hard-gate evidence. The task was not resumed or retried. A fresh
preflight is required before the next task; this review does not itself open the
trial gate.

Evidence:

- Corrected task: `live-trial/cohort-3/skill-off/bounded-dependencies/run.json`
- Read-only database check:
  `live-trial/cohort-3/skill-off/bounded-dependencies/database-controls-check.json`
- Correction details: `cohort-3-collection-correction.md`
- Independent review was performed by the AUT-03 reviewer agent on 2026-10-17.
