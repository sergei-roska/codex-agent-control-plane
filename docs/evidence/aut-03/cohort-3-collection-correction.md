# AUT-03 cohort 3 collection correction

On 2026-10-17, the skill-off `bounded-dependencies` A2A task completed. The
first generated `run.json` classified its hard gates as failed. Its SHA-256 was
`dd2558023d3cb8dc049ce65fb981594a6d8db58517b5e496f702cf390c245ee8`, but its
bytes were not preserved. The initial `controls.json` was also overwritten by
the correction, so the precise field-level cause of the first classification
cannot now be independently confirmed. The earlier description that aggregate
command and file-change fields were absent is therefore not treated as a
verified fact.

The collection was corrected to compute those aggregates from the
`live_activity` rows and the `run.json` was regenerated. A separate read-only
SQLite check is preserved in
`live-trial/cohort-3/skill-off/bounded-dependencies/database-controls-check.json`.
The corrected records are supported by the preserved task response and that
database inspection:

- Task `c529a368-701d-4b33-8c0f-61a8ed426281` is
  `TASK_STATE_COMPLETED`; the client exit code is 0.
- The database contains zero dispatch rows, zero writer-execution rows, and
  zero permission events.
- Its only live-activity row is coordinator/done with zero commands and zero
  file changes.
- The workspace remained empty and read-only; skill context was disabled.
- One lead `turn/start` was attempted and sent under the eight-turn cap.
- The corrected `controls.json` aggregates agree with the database values.

The correction concerns post-task evidence classification. The original
classification record and original controls bytes are unavailable, which limits
review of its precise cause but does not change or reconstruct the A2A task.
The task was not resumed or retried. Keep the gate closed until independent
review accepts the corrected evidence and the next task receives fresh
preflight.
