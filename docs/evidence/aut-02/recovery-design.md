# AUT-02 recovery design

Scope: deterministic harness recovery, qualified offline. Live lead decision
quality, model cost and production recovery duration remain unmeasured.
Acceptance is recorded separately after qualification and independent review.

## Selection and admission

The graph keeps the stored six-field review obligation authoritative. Recovery
uses validated reviewer permission/profile/skill templates, never old-target
prose or reconstructed scope. Its trigger is a supported graph stale rejection,
a trusted role-service stale-origin rejection, or a specifically evidenced
known target change during review. Generic failed or inconclusive reports do
not authorize automatic retries. Unknown origin remains nonauthorizing.

Fresh verifier and required auditor are separate normal dispatch rounds with
new assignment, attempt and context IDs. They carry no origin continuation.
Auditor admission still requires a current verifier receipt. Routine review
requires only verifier evidence. An authorized verifier test-only write retains
existing settled post-verification target binding. Current target and all gates
are checked again at dispatch and integration.

## Graph persistence

The checkpoint annotation `reviewRecovery` has version 1 and defaults to an
empty checkpoint list for older state. The list is bounded to 40 checkpoints,
with at most two automatic recovery generations per checkpoint, including
restarts and target churn. Each record correlates checkpoint/context digest,
source assignment/attempt, phase, generation, last recovery target and validated
reviewer templates. The obligation owns actual review values; the context
digest uses the existing array normalization semantics.

Planning a fresh assignment and advancing its recovery phase share a graph
checkpoint update. Dispatch uses existing deterministic IDs, journal and task
lookup. Usage-limit continuations preserve the recovery marker and generation.
Unknown versions, corrupt templates or unavailable pins cannot construct a
writable assignment. Existing owner pause, cancellation, budget, round,
continuation and writer-settlement gates remain authoritative.

No database schema migration is required. New state uses the existing graph
checkpoint JSON. Older graph readers ignore the new annotation and still see
all review obligations and receipt statuses. They do not acquire authority to
accept historical receipts. Pending new-format internal assignment metadata
must not become an unvalidated older-reader request.

## Direct continuation provenance

A review continuation first requires complete same-origin target evidence.
Verifier resumptions require an explicit run. Saturated 10,000-event lookups
fail closed rather than claiming uniqueness from truncated history.

The append-only staging event `review_continuation_emitted` records version 1,
kind, checkpoint and SHA-256 of the actual emitted thread/lane/home tuple. The
event correlates run, role, attempt and captured target. Raw context fields are
not placed in staging. The tuple is finalized after writer and lane settlement
and reused exactly in result or failure metadata, including usage-limit exits.
Its evidence is written before the continuation metadata is published.

Any supplied resumable field requires a unique valid binding from the same
origin. Known binding with a different tuple is `review_origin_stale`.
Missing, malformed, ambiguous, unavailable or unknown-version binding is
`review_origin_unknown`, so it cannot trigger automatic stale recovery. Legacy
origins may use the existing current-target check with all thread/lane/home
fields cleared for fresh execution; they cannot resume unproven context.

## Rollout and rollback

This milestone does not apply code to running services or resume sessions.
Future live application is a separately authorized lifecycle action.

Retain obligations, journal outcomes and append-only staging history. A rollback
must stop new automatic recovery admission and retain the direct origin guard,
or quiesce review continuations before using an older service. Reverting to the
baseline direct service would restore the demonstrated stale-context defect;
it is not a safe continuation-enabled rollback. Never delete failed history,
downgrade scope or reopen a gate to make an older request pass.
