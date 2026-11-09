# Runner re-review, round 2

Verdict: REJECT before GO. Re-review is limited to the original six findings and
their integrated acceptance wiring. Prior SQL/runtime/isolation/fixture inspection
is reused. No live/native/provider/service calls or reviewed-file edits.

Candidate pins:
- run-comparison.js SHA256 995578e80f0b53e867e8981bf546addc4e0faabb6598ed49bd18c0396ed9967b
- runner-probes.js SHA256 4c2954dcc84454d8d3a550b0ae0d01be252d16ec55816b3cda861dff419a7e36
- fixture-controls.json SHA256 8d6f5952a6f6575751eee5471bcb89415e729702b867a440f6899457f5f01050

## Resolved mechanisms

1. Numeric inbox epochs are normalized correctly; steeringTiming checks both
   received/applied times; steerOnActiveTurn waits for the actual terminal event
   before computing those predicates. Missing timing remains unaccepted.
2. Returned/thrown native calls now share authoritative usage capture, preserve
   original result/error identity, retain execution/terminal facts on errors and
   expose unknown totals as null. Unknown usage prevents new admission. Reservation
   happens synchronously before awaiting original native execution, closing the
   parallel pre-start turn-count race.
3. Failed startup conservatively retains the private root. Missing runtime no
   longer implies safe cleanup.
4. Extraction/backup errors no longer skip normal runtime.close. Both before and
   after close backup helpers are called and explicit null results now mark
   evidence incomplete. This last small delta was read after final re-freeze.
   Post-close snapshot includes shutdown/final rows, with durable backup retained.
5. Exact semantic goal/acceptance is retained independently of transport hash;
   all 341 inventory paths are captured before/after with drift rejection.
   Frozen control bytes and actual seeded/check hashes are verified before intake.
6. Immutable checker equality and product-only workspace status are included in
   the product acceptance predicate. Concurrent accepted candidate is required.

## Remaining integrated blockers

- run-comparison.js:471-472,484 - Steering acceptance is sampled before waiting
  for steeringPromise. A task may finish within the poller's 250ms interval;
  steeringAccepted is false, then the promise computes true while :484 awaits,
  but trialAccepted still reads the stale false. Fix: compute steeringAccepted
  only after the promise settles. Add a delayed-completion integration probe,
  not just a pure steeringTiming helper assertion. Evidence: read actual order.

- run-comparison.js:488-491,531-546 - trialAccepted/status are finalized before
  close and durable retention. A thrown close or missing backup merely sets
  retainRoot and leaves status accepted/trialAccepted true. The source-manifest
  catch clears trialAccepted but also leaves status accepted. Ran the actual
  closeWithEvidence with an unsafe throwing close and initially accepted state:
  it returns closeSafe=false/evidenceSafe=false while state remains accepted;
  inspected main confirms no later acceptance downgrade. Fix: finalize a single
  consistent status after close, required backups, source pin verification and
  steering; all unknown/failed prerequisites must leave trial unaccepted while
  preserving product completion evidence. Probe unsafe-close, null-backup and
  source-read-error through this final gate.

- run-comparison.js:488-490 - The full trialAccepted flag still never evaluates
  the required controlled failure -> investigation -> distinct repair -> fresh
  verifier -> host acceptance history. If the native planner skips diagnostic or
  investigation but completes repairs/checks, the runner can label this trial
  accepted. Fix: either add evidence-bound predicates using retained task/attempt/
  role records, or explicitly label this result preliminary product completion
  and reserve full trial acceptance for root/critic evidence review. Do not
  hardcode or infer recovery history from goal prose. Evidence: read predicate.

## Verification

Ran node live-runner/runner-probes.js: PASS all current local helper invariants.
These assertions are meaningful but do not exercise final orchestration ordering
or acceptance after lifecycle failures, which is why they miss the blockers.
Independent mocked lifecycle probe used the actual exported helper and no
network. Native source schema/full-suite acceptance remains unaffected.

Status: complete
Scope expansion: none
