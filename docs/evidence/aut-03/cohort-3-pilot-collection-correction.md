# AUT-03 cohort 3 pilot-price-f2 collection correction

Task `31534413-7377-4faf-9479-147079092c80` completed at
2026-10-17T08:28:14.900Z with client exit code 0. Its initial `controls.json`
omitted the aggregate `commandsObserved` and `fileChangesObserved` fields. The
initial controls bytes are preserved at
`live-trial/cohort-3/skill-off/pilot-price-f2/collection-correction/controls-initial.json`
with SHA-256
`2698e96b2493680345e9a73f513b94ada7d9d744a9ace800573810a22ef7dd6f`.

The corrected controls compute both aggregates from their `liveActivity` rows.
A separate read-only SQLite check is preserved at
`live-trial/cohort-3/skill-off/pilot-price-f2/database-controls-check.json`.
It confirms the task completed, the sole coordinator/done activity has zero
commands and file changes, dispatch and writer rows are zero, permission events
are zero, the one usage row records one turn, and the workspace is empty and
read-only. The corrected aggregate values are both zero.

The run's recorded hard-gate values were already zero and its initial run hash
was `9ac75b6c6ca76189027fa8c01b62f700907c1f225b0ec2a2a394991a73f9bfc7`.
The task, response, and model execution were not resumed or retried. This
correction repairs missing evidence fields only; preserve the initial controls
alongside the corrected record and review the corrected hashes before scoring.
