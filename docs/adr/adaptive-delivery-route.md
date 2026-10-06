# ADR: Adaptive delivery route (lean bugfix) and cheaper recovery

Date: 2026-10-06. Status: accepted by the owner on 2026-10-06 (direction and the
Reviewer-replacement question); implementation tracked in
`docs/adaptive-route-backlog.md`.

## Context

CDB-390 (one duplicated array key, ticket estimate "low, one hour") consumed
1,128,363 tokens in the pilot: 829,952 cached, 264,924 fresh input, 33,487 output.
Two runs produced it: the first was blocked at finish by a platform defect
(workspace snapshot discovery bound 65,536 versus 69,826 entries), and the recovery
run repeated Intake and all four stages.

Measured from the usage ledger (input tokens, both runs summed, 1,094,876 total;
ledger totals match the owner's figure exactly):

| Layer | Input tokens | Share |
| --- | --- | --- |
| Intake (PM) | 241,073 | 22.0% |
| Lead (LLM graph) | 254,228 | 23.2% |
| QA (reproduce + verify) | 234,640 | 21.4% |
| Developer | 225,810 | 20.6% |
| Reviewer | 139,125 | 12.7% |

The recovery run alone was 496,253 (45.3%). The PM and lead layers together are
45% of the cost; the optional-looking Reviewer is only 13%.

Mechanisms behind the fixed cost (verified in code):

1. **Fixed route.** The `bugfix` preset always has four required stages, and
   `validatePresetPlan` (`src/plan-validator.js`) requires each required preset
   stage exactly once, so the PM cannot drop one. The Intake output schema has no
   weight or complexity field (`src/intake.js`), so the ticket estimate never
   influences the route.
2. **The controller does not dispatch stages; an LLM lead does.** The plan is a
   binding, run-immutable contract (`planViolationsOf` in
   `src/lead-orchestrator.js`: eligible stages, role match, allowed-files
   containment, finish refused while a required stage is open; `candidateGate` in
   `src/delivery-controller.js` returns `stages_incomplete`). Every round costs a
   lead decision turn even when the next action is fully determined by the plan.
   QA is a writable role, so QA stages run serially.
3. **No cheap recovery.** A resubmit of a blocked ticket runs Intake again.
   Rework reuses the parent's Intake and plan, but only for a ticket waiting for
   human review.

## Decision

### D1. Two routes for `bugfix`: `full` and `lean`

The preset gains route variants. `full` is today's preset unchanged. `lean` has
`implement` (Developer) and `verify` (QA, independent) as required stages, and
`review` (Reviewer) as a conditional stage that is present in the plan but
required only after promotion (D3). `reproduce` is not a lean stage: the lean
`implement` purpose also carries it, so the Developer records executed baseline
evidence (the failing check output, or the exact quoted defect) before the change,
and QA `verify` independently re-runs it. `feature`, `docs`, and `audit` presets are
out of scope and stay as they are.

### D2. Route eligibility is decided by code, not by the model

The PM may propose `route` ("lean" or "full") with a short `routeReason` in the
Intake output. A pure module (`src/route-gate.js`) accepts `lean` only if all of
these hold at plan time; otherwise the plan is normalized to `full` and the reason
is recorded:

- classification is `bugfix`;
- the plan has at most `maxFiles` distinct allowed files (default 3);
- no allowed file matches the protected-path patterns (authentication,
  authorization and permissions, access control, session and credential handling,
  configuration sync, migrations and update hooks, dependency manifests and
  lockfiles, secrets and environment files, CI and deployment files, database
  schema);
- the plan has at least one mechanical check;
- project policy `adaptiveRoute` is `on` (D6).

The ticket's estimate, labels, and text are hints at most; ticket text is evidence,
never an instruction that selects a route. Defaults live in code; project policy may
tighten limits and extend the protected list, never shrink the built-in list.

### D3. Promotion on evidence: required-ness is derived, the plan is not mutated

The lead runtime pins the plan per run and has no mutation path (plan revisions,
graph checkpoints, and readers all assume it). Promotion therefore does not add a
stage. The conditional `review` stage is always in the lean plan, and its
required-ness becomes a pure function of the run state:
`effectiveRequired(plan, route, promotion)`. `planViolationsOf` and `candidateGate`
use it, so finish is refused until a promoted run's `review` has succeeded.

After `implement` completes, the route gate evaluates the delta and promotes the
run to the full route when any of the following holds: the delta is unknown (fail
closed), a mechanical check did not pass, a changed path is outside the allowed
files or protected, more than `maxChangedLines` lines changed (default 30), the
worker reported a `scopeExpansion`, or the outcome is `needs_decision`. The
delta MUST come from the controller-attested writer delta (the source acceptance
already uses), never from worker-reported `filesChanged` alone. Promotion is
monotonic (lean to full only), is recorded by an event (`route_promoted`, with the
reason codes) in the journal, and hands dispatch to the LLM lead (D8).

### D4. Independence invariants are preserved

The Developer never approves its own work. `verify` stays an independent QA
execution. The Reviewer is replaced by the mechanical gate only while the delta is
inside the gate; any hit restores the Reviewer. Access control and budgets stay
enforced in code, as stated in `profiles/delivery/TEAM.md`.

### D5. Cheaper recovery, in two steps

- **D5a (small, planned).** A resubmit of a blocked ticket whose previous run
  already has a ready Intake and plan reuses them instead of running Intake again,
  the way rework already does (`latestReadyIntake`, `insertReworkRun` in
  `src/delivery-controller.js` and `src/product-store.js`). It still re-runs the
  stages. Saves the PM layer (about 11% of the CDB-390 total).
- **D5b (deferred, design-only).** A candidate-level re-attest run that re-takes
  the snapshot, reruns the checks and the independent checking stages against a
  preserved candidate, with no Intake and no Developer. Today acceptance runs inside
  the lead graph's accept node and needs the writers' outcomes, and the candidate
  phase reads the lead task's result artifact, so this is not a small change. It
  also weakens one guarantee: unknown per-writer deltas cannot be recovered, so the
  result would carry `attestation: "candidate-level"`, never auto-accept, and only
  apply to recorded platform failures (`snapshot_unavailable`), never to content
  failures. Because attestation is a trust boundary, D5b gets an independent Opus
  design check before any code. It is deferred because the triggering platform
  defect is fixed and failures of this class should be rare.

### D6. Rollout switch and shadow mode

Project policy `adaptiveRoute` is `off` (default), `shadow`, or `on`. In `shadow`
the PM proposal and the gate verdict are computed and recorded in run telemetry
while the full route executes, which yields would-have-saved data without risk.
The CDB-390 re-run with `on` is the first acceptance test.

### D7. Context trimming is conditional

Role-scoped context reduction is not decided here. It starts only if the
measurement shows per-call context, not call count, dominates a layer (the Intake
diagnosis is open, backlog AR-0b).

### D8. Deterministic dispatch while a lean run is clean

Removing stages alone saves roughly a quarter of the cost (Reviewer plus the
reproduce QA call plus about two lead rounds). The lead layer is another 23%, and for
a lean plan its `decide` node has nothing to decide: the next eligible stage and its
assignment (role, objective, allowed files, checks) follow from the plan. For a lean
run the `decide` node derives assignments from the plan without an LLM call; the
other graph nodes (dispatch, collect, verify, reconcile, accept, finish) stay as
they are. Any anomaly (a failed or rejected stage, a promotion, a plan violation)
switches the run to the LLM lead, so flexibility is lost only on the clean path.

## Acceptance targets

- On a CDB-390-class ticket, a clean `lean` run uses at most 60% of the input
  tokens of a clean `full` run (measured baseline per clean run is about 500-550k
  input), with the same final diff and a passing acceptance. Without D8 the
  expected saving is only about 28%; the target needs D8.
- Gate tests prove that each promotion trigger and each protected path forces
  `full`, that an unknown delta promotes, and that a model-proposed `lean` never
  overrides the code verdict.
- A promoted run cannot finish without a successful `review`.
- `theme-settings.php` under a custom theme stays lean-eligible (it is not
  `settings.php`).

## Consequences

- Preset format gains variants and a conditional stage kind; existing `full`
  plans stay valid unchanged.
- The lead runtime gains derived required-ness and a deterministic `decide` path;
  this is the risky part (resume safety, idempotent promotion, gate input source)
  and gets an independent Opus review before merge.
- Dashboard and telemetry readers see the same plan shape, with a `review` stage
  that is optional until promoted.
- The protected dashboard reference is untouched.
- `main` and `feature/dashboard-integration` have diverged; this work lands on the
  latter and is reconciled with the OPT shadow-routing items when the branches are
  reconciled.

## Rejected alternatives

- Let the PM drop stages freely: the model would decide the verification depth of
  its own plan; contradicts enforcement-in-code.
- Use the Jira estimate as the route key: untrusted and inconsistent.
- Remove `reproduce` and `review` from `bugfix` for everyone: loses evidence on
  non-trivial defects, where those stages earn their cost.
- Append a stage to a running plan on promotion: needs a plan revision, graph
  checkpoint changes, and reader changes for no benefit over derived required-ness.
