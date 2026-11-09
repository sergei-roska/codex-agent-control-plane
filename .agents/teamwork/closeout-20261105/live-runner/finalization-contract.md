# Reassessment after two runner reviews
Root decision: preserve the independently verified helper repairs; replace early
whole-trial acceptance logic with a final evidence-collector result. Do not add
an engine-history validator to this experimental runner. Actual recovery-history
and final L6 acceptance remain root/critic responsibilities after genuine runs.

Exact remaining integrated fix from critic review-round2.md:
1. Await steeringPromise, then compute steeringAccepted and its final timings.
2. Always attempt normal close and collect nonnull pre/post-close DB backups.
3. Capture source-after and verify no drift. Compute final collector outcome
   ONLY after these steps and actual immutable checker/scope/native-objective facts.
4. Any unsafe close, absent/failed backup, absent source-after, drift, or failed
   required steering prerequisite yields status incomplete. Preserve underlying
   objective acceptance fact separately; never claim whole-trial acceptance.
5. If all collector gates hold, status objective_accepted_pending_independent_review.
   trialAccepted remains null/unset until actual root/critic history acceptance.
6. Final stdout and evidence JSON must agree. Probe integrated finalization:
   asynchronous late valid steering; close rejection; null backup; source read
   rejection/drift; success. Verify call order as well as helper values.

No source/fixture/goal/acceptance/model change. No live GO until delta approved.
This changes the attempted method: one final outcome reduction after effects,
instead of patching independent early status assignments. No tier escalation is
needed for this bounded known-order repair; escalate only a demonstrated obstacle.
