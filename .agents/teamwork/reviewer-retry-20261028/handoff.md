# Reviewer retry evidence handoff

## Status

Focused regression added and verified. Production retry API was sufficient; no
source expansion was needed.

## API evidence

`CandidateReviewStore.proposeReviews` derives one immutable review context from
project/objective/checkpoint/candidate/manifest and allocates new task IDs from
the existing task count for that context. `BacklogStore.applyPlan` supports
appending a new task while retaining the existing task records. A failed review
verdict is a durable receipt only after a trusted successful execution settles;
`qualification` includes passed receipts only. The retry therefore shares the
same review context pins but uses a distinct task, attempt, and provider context.

## Change

`test/candidate-review.test.js` now runs two independently claimable auditor
tasks through BacklogStore, settles one passed receipt and one failed verdict,
then proposes and settles a scoped retry. Assertions retain both histories,
compare the sibling receipt's stored JSON before and after, verify retry task,
attempt, provider context, candidate, manifest, and check pins, and ensure the
newer candidate does not gain qualification or final stabilization.

## Verification

Command: `node --test test/candidate-review.test.js`

Result: 20 tests, 20 passed, 0 failed, 0 canceled, 0 skipped. The first run
exposed a fixture mismatch (`selected_settings_conflict`) because the attempt
pin did not match the fixture's resolver; using the fixture's exact model pin
resolved it. Final run passed.

## Pending

Root owns Git and matrix-review documentation updates. No other checks were run.
