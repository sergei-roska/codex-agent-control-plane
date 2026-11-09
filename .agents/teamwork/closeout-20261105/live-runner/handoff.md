# Live comparison runner handoff

Status: round 2 integrated fix complete; awaiting critic approval. No provider,
quota, A2A, or native model call was made.

The runner retains the repaired native observer, numeric received/applied timing,
usage preservation, pre-await turn reservation, startup retention, isolated close
capture, full 341-path source hashes, stable semantic input hash, and frozen
fixture verification. Finalization now awaits steering, attempts normal close
with pre/post DB backups, captures source-after, then applies one collector gate
reduction. A complete collector result is
`objective_accepted_pending_independent_review`; otherwise it is `incomplete`.
`trialAccepted` is null. Objective acceptance facts remain separate; recovery
history is reserved for independent review.

Local-only verification:
- Syntax checks for runner, probes, and fixture JavaScript: pass.
- `node runner-probes.js`: pass, including late steering / ordered finalization,
  close rejection, null backup, source read error and source drift cases.
- Frozen fixture controls remain unchanged; negative control exit 1 and temporary
  positive control exit 0 from prior local control run.
- No-go invocation exits 1 at `live_run_requires_explicit_--go`.

No live evidence or DB backup exists. No model call until critic review and root GO.
