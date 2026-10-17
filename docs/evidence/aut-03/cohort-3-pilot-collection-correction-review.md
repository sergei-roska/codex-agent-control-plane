# AUT-03 cohort 3 pilot collection correction review

Verdict: APPROVE for corrected task evidence.

The independent reviewer compared the preserved initial controls with the
corrected controls, verified that the correction adds only zero-valued
`commandsObserved` and `fileChangesObserved` aggregates, and checked the
corrected values against the read-only SQLite inspection. The task completed
with one lead turn, zero worker dispatches, zero writer executions, zero
permissions, zero commands, and zero file changes. Corrected evidence hashes
and pointers matched the trial entry. `baselineCaptureAllowed` remained false.

The initial `run.json` bytes were not preserved, so historical values and gate
wording in that initial run cannot be independently verified. This does not
change the corrected evidence review. The task was not resumed or retried, and
this review does not open the task gate.

The reviewed trial-entry SHA-256 was
`ccfbe3b9ba591b111a410278f59dcb6645b015c07655dafdf480aecb73ee8e99`.
The independent reviewer was the AUT-03 trial critic on 2026-10-17.

Evidence:

- Correction report: `cohort-3-pilot-collection-correction.md`
- Corrected task: `live-trial/cohort-3/skill-off/pilot-price-f2/`
- Preserved initial controls:
  `live-trial/cohort-3/skill-off/pilot-price-f2/collection-correction/controls-initial.json`
- SQLite check:
  `live-trial/cohort-3/skill-off/pilot-price-f2/database-controls-check.json`
