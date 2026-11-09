# CN14 trusted completion decision handoff

Status: complete policy review, 2026-10-27. Verdict: REJECT callback-only
composition as currently possible; narrow source seams below are required.
Evidence is source read, not a production integration run. No product files,
Git state, service, account, or target was changed. Temporary evidence: none.

## Trusted intake and checkpoint contract

Persist the original owner goal, owner-supplied criteria, their provenance, the
validated acceptance contract, selected policy, and digests before any provider
call. Create and register a critical `owner_request` checkpoint in the same
pre-call intake transaction. Its content means "this owner obligation must be
reviewed"; it is not evidence that natural-language success criteria were met.
The planner may add bounded checkpoints/tasks, but may not remove, rewrite, or
declare the owner checkpoint accepted. Preserve owner requirements across a
correction unless the authorized correction explicitly changes them. If the
owner supplied no runnable checks, pin a validated empty contract honestly;
never invent a passed check. This still requires a real current semantic verifier
receipt for the critical owner checkpoint before accepted finalization.

`BacklogStore.checkpointInventory` and `CandidateReviewStore.checkpointInventory`
return existence references only. `BacklogStore.checkpointAccepted` must return
literal true only for an active current checkpoint with a known complete read
closure and current qualified required-role receipts on the candidate/version
the dependency names. `CandidateReviewStore.qualification()` alone is unsafe:
it lists passed direct/promoted receipts without rechecking current pins. Use
`finalizationProjection().receipts` current+qualified or add an exact current
qualification method. An intermediate checkpoint may release dependent tasks
after its own review; that does not claim final objective acceptance. The owner
root checkpoint must not be released by a model status flag.

`attestClosure` must derive a full read manifest from the exact immutable
candidate, declared read dependencies, checkpoint ancestry, and pinned
environment/check/tool/profile inputs. Until completeness is demonstrated,
return `known:false` and reject receipt promotion. Whole-candidate closure is a
conservative default. Final `frozen:true` requires an actual publication barrier,
settled writers/unknown effects, and an exact candidate generation; it cannot
come from a model message.

## Review and finalization gates

`authorizeCheckpoint`, `authorizeProposal`, `authorizeBinding`,
`authorizeThread`, `authorizeSettlement`, `resolveAttempt`, and
`verifyReviewExecution` must read durable owner/policy records, exact
claim/fence/task/context/settings/request pins, and the host execution registry.
`verifyReviewExecution` must see the observed provider thread/turn terminal,
background-process cleanup, unchanged immutable verifier input, executed
required checks, and settled publication effects. The model's verdict supplies
semantic evidence only; report `checksPassed` and remote quiescence booleans
are not host proof. A failed or unknown check cannot create a passed receipt.

`finalizationAuthorized` must compare every begin/start/commit/replay request
against the durable owner/selected contract: current owner generation and
revisions, candidate and environment, nonempty active obligation set, required
roles (at least verifier for the critical owner checkpoint), check contract
source/digest/IDs, execution permissions, and exact frozen review projection.
Do not trust `requiredRoles`, pins, or `checkSource` copied from the request.
`finalizationRemainderResolver` may return a fact only from explicit durable
owner deferral or investigated outside-authority/capability evidence, never from
an exhausted internal retry. Invoke `finalizeCandidate()` to run real frozen
checks; commit only its qualified ready state. `finalizationCheckProofAuthorized`
needs a narrow hook after `runFrozenCandidateChecks()` and before
`recordFinalizationChecks()` to persist checkAttemptId, pins/result digest, and
actual host runner provenance; validate this on first record and replay. A
caller-supplied result object alone does not prove execution.

## Required narrow correction seam

`CandidateReviewStore.checkpointInventory()` unconditionally unions historical
registered rows. `finalizationProjection()` walks them all. An owner correction
stales old critical rows but does not remove them, so corrected goals cannot
complete. Filtering by goal revision alone is unsafe: it could silently erase
still-valid owner obligations. Add a durable typed supersession relation from
old checkpoint to replacement(s), tied to an authorized owner correction and
old/new owner requirement/check identities. The active set may exclude old rows
only after all still-binding owner obligations have registered replacements.
History and receipts remain immutable. `checkpointInventory()`,
`finalizationProjection()`, and checkpoint acceptance must agree on the same
active set; incomplete replacement denies finalization. Backlog references to
retired IDs must remain unaccepted and be replanned. A callback can implement
this only if it reads the durable typed relation and coverage proof.

## Decisive integration assertions

1. Empty inventory and a model `goalAchieved:true` cannot produce accepted;
   the persisted owner checkpoint and current verifier receipt are required.
2. Forged report `checksPassed:true`, `trusted:true`, or `effectsSettled:true`
   with no host terminal/cleanup/check evidence cannot settle a passed receipt.
3. A passed receipt from an earlier candidate or goal/check/policy revision
   cannot release a dependency or satisfy final acceptance; unknown closure
   blocks promotion.
4. Direct `recordFinalizationChecks()` with a fabricated accepted result and
   correct-looking pins fails proof authorization; `finalizeCandidate()` with
   actual pinned checks and cleanup can pass.
5. After owner correction, old checkpoint history remains, finalization waits
   for registered replacements with owner provenance; dropping old rows by
   revision without coverage is rejected.

Source evidence: `src/candidate-review.js` lines 119-137, 138-175,
260-317, 479-518, 542-551, 661-706, 854-860; `src/backlog-store.js`
lines 68-88, 1287-1337, 1350-1385, 1404-1410, 1442-1524,
1527-1559, 1570-1603; `src/delivery-acceptance.js` lines 394-474;
`src/acceptance.js` lines 57-105, 627-767.

Next action: lead grants the narrow review-store supersession/active-set and
acceptance proof hook source ownership, then workers integrate against these
gates. Re-review implementation delta and run targeted false-acceptance probes.
