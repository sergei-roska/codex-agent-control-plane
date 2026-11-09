# Runner finalization re-review, round 3

Verdict: APPROVE the bounded evidence collector for root-authorized dispatch.
This is runner readiness, not live qualification or whole-trial acceptance.
Scope: only the three round2 integrated blockers and finalization-contract.md.
All prior helper/source/fixture/SQL/isolation evidence is reused.

Reviewed frozen pins:
- run-comparison.js SHA256 07a10b02b703776036ca0ae7de4fa1e84eb87f9fc5d7d67b972e9e64314a86c6
- runner-probes.js SHA256 fb6be4e020cc678fb61532e78b92824d3bac2c389a0e2d6920f50e08861722b4

## Resolved blockers

1. PASS - Actual main finally block calls finalizationSequence with awaited
   steering, lifecycle including pre/post backups, source-after capture, then one
   reduction. steeringAccepted is sampled in that final reduction, after the
   asynchronous steering promise. No stale early sample remains. Read :543-599
   and actual sequence helper :209-222.
2. PASS - finalizeCollector :225-259 requires no runner/finalization errors,
   completed checked immutable product, scope/engine acceptance, closed runtime,
   both nonnull backups, complete before/after lifecycle evidence, captured source
   before/after with no drift, and required steering. Every missing/unsafe gate
   produces incomplete. Failed source capture cannot leave an accepted status.
   Missing backups mark lifecycle incomplete in actual capture callbacks. Normal
   close remains attempted independently of extraction failures.
3. PASS - Successful collection yields only
   objective_accepted_pending_independent_review. trialAccepted is always null;
   underlying objectiveAcceptance is preserved separately. Whole controlled
   failure/investigation/distinct repair/fresh verifier acceptance remains an
   independent actual-evidence review. Final evidence JSON and stdout both use
   evidence.status after the one reduction (:604-613).

## Independent verification

Ran node --check run-comparison.js: pass.
Ran node runner-probes.js: PASS local helper and integrated finalization probes.
Additionally ran an independent no-network probe against exported actual helpers:
initial steeringAccepted=false became true only after an awaited delayed promise;
asserted exact steering -> close -> source -> reduce order and pending-review
status. Eight distinct final gate failures (unsafe close, missing pre backup,
missing post backup, absent source-after, source-read error, source drift, missing
steering, incomplete lifecycle retention) all returned incomplete with
trialAccepted=null while preserving the true objective acceptance fact.

No provider/task/service calls, source changes or Git mutations performed.
Next: root may dispatch within the existing quota/design bounds; retain all
incomplete attempts. Independently inspect actual recovery history, checker and
candidate evidence, steering timings, costs/unknowns and safe close afterward.

Status: complete
Scope expansion: none
