# Reviewer retry evidence

## Scope

Close matrix-review G2 by adding one focused L2 regression in
`test/candidate-review.test.js`. Do not change production code or other test
files. Root owns Git and durable docs.

## Acceptance

- Use real CandidateReviewStore and BacklogStore fixture behavior.
- Run two independent reviewers on the same frozen candidate/check context.
- Preserve a passed sibling receipt byte-for-byte while another reviewer has a
  failed verdict and receives a fresh, valid retry.
- Keep failed receipt history; pin retry to the original candidate, manifest,
  and check pins; reject stale candidate qualification.
- Run only `node --test test/candidate-review.test.js`.
