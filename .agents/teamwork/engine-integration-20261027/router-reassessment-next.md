# Router reassessment after two rejected revisions

Current completed seam is still REJECTED, not accepted. The last correction fixed
async legacy resumability and undefined contract/context overwrite, but run() still
normalizes newRequest with `input.newRequest || null`. SQLite reviewer probe:
first run {runId:'r',goal:'G',newRequest:'original follow-up'}, then replay
{runId:'r',goal:'G'} changes mapping.request.newRequest to null. Test3/3 does not
cover this. Report ../cn14-core-seams-review-20261027/handoff.md.

Next repair must stop adding individual field guards. Normalize one immutable
intake schema for goal/contract/contextId/newRequest. On first intake, persist
only explicit defined fields; on replay preserve omitted fields and reject any
conflicting explicitly supplied immutable field before any database mutation.
A legacy resume placeholder may be backfilled exactly once by its first real
run, while retaining its legacy engine choice. Include omitted newRequest,
explicit conflicting/null newRequest, omitted contract/context, changed context,
async resumability, reopen and nonmutating event/timestamp assertions. No model
calls needed; use real SQLite fake engines. Independent delta re-review required.

The current inactive router source and test remain in src/test for successor
repair; server startup does not use it. Do not activate concurrent routing or
claim this seam is qualified. Native13:32:56Z7 percent primary/28 weekly, so no
further agent turns were dispatched. Preserve prior working tree and archived
engine prototype; do not discard or conceal the known defect.
