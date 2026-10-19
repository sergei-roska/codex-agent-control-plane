# ADR: Bounded owner grant past recovery_generation_limit

Status: accepted 2026-10-19. Code: `src/lead-graph.js`
(`applyOwnerRecoveryGrant`, `validOwnerGrant`, `recoveryGenerationCap`).

## Decision

A checkpoint that stopped at `recovery_generation_limit` (generation 2,
phase `replan_required`) can receive exactly one more recovery generation, only
through an explicit owner choice. The grant applies when all hold:

- the pending decision is a lead-raised `human_decision` (not a server
  escalation) with reason `infeasible_requirement`, or a checkpoint has
  `blockedReason: recovery_generation_limit`;
- exactly one checkpoint is at the limit, in `replan_required`, at generation 2,
  and has no earlier grant;
- the owner choice id is exactly `supported_controller_replan`.

Effect: the checkpoint record gets `ownerGrant` (decisionId, choice, answer text,
timestamp, generationBefore), generation 3, `blockedReason: null`, and phase
`verifier_pending`. The existing recovery path then runs: a fresh verifier is
dispatched, then the fresh auditor. While the phase is `verifier_pending` no
earlier receipt is accepted, so verifier and auditor gates stay mandatory.
Receipts are never copied, edited, or reused across generations and
`reviewContextHash` is untouched.

Every other choice id keeps the generic behavior: the answer is recorded as text
in `humanAnswers` and no recovery state changes. A requested grant that does not
meet the conditions (no checkpoint at the limit, grant already used, several
candidates, unknown target, pending writer, round limit, no valid verifier
template) changes nothing and logs a `review_recovery` stage event
`owner_grant_rejected` with the reason.

## Bounds

- At most one grant per checkpoint; a second request is rejected
  (`owner_grant_already_used`).
- `MAX_REVIEW_RECOVERY_GENERATIONS` stays 2. `validReviewRecovery` accepts
  generation 3 only together with a grant whose `generationBefore` is 2, and
  rejects generation above 3 and any grant on a checkpoint that was not at the
  limit.
- After the grant, a further stale signal at generation 3 blocks again with
  `recovery_generation_limit`.
- The grant lives in `state.reviewRecovery`, inside the graph checkpoint, so it
  survives restart.

## Rationale

The README ("Long runs and repeated work") already lets an owner `continue` or
`change_goal` grant another configured allowance. This applies the same
pattern to the recovery cap: a human decision, recorded and bounded, rather than
an automatic extension.

## Exception to design-review.md:23

`docs/evidence/aut-02/design-review.md:23` says an exhausted generation cap
returns to replanning or the pause "without granting new rounds or budget". The
automatic path still does exactly that. The owner grant is the single explicit,
human-initiated exception, and only the owner's explicit choice
`supported_controller_replan` triggers it; the lead model cannot grant it.

## Alternatives rejected

- Raising `MAX_REVIEW_RECOVERY_GENERATIONS`: weakens the cap for every run.
- Editing checkpoint state or receipts by hand, or reusing receipts across
  generations: bypasses the verifier and auditor gates.
