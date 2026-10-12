# ADR: The auditor runs at defined points, not every round

Status: initial guidance accepted 2026-10-12 (owner decision), implemented in
`profiles/TEAM.md` and historically active from round 12 of run `a125b4c6`.
The refinement below was authorized after staging shutdown on 2026-10-12;
implementation is complete and independently accepted. Final isolated full
suite: 1026 passed, 0 failed, one optional live probe skipped. Live qualification
and resource comparison remain pending the owner's next service start.

## Context

In every recorded run of the `codex_team_work` project the lead dispatched the
`auditor` (gpt-6.1-sol, high, the most expensive regularly used role) in almost
every round: run `a125b4c6` had it in each of rounds 2-11, usually in parallel
with two engineers. No rule required this. `TEAM.md` described the auditor only
as "independent read-only flow, regression, and trust-boundary audit", and the
`decision.investigate_first` rule (`src/lead-graph.js`) names "explorer or
auditor" for every blocker, so the lead used it as a standing step.

The auditor does find real defects: in round 9 it found a HIGH
prerequisite/interface bypass in task T3.1.2b, which stopped dependent work
before it built on a broken base. Removing it, or auditing only once per phase,
would have let that defect spread.

## Decision

Routine changes are verified by the lead reading the actual diff and, where a
test or check can expose a risk, by a `verifier` in a later wave. The `auditor`
is dispatched only:

1. at the end of a phase or milestone and before finishing, on the integrated
   candidate;
2. for a change in a risk area (permissions and authority, authoritative state
   and transitions, concurrency, recovery and retries, trust boundaries),
   before other tasks start to depend on it;
3. for a blocker investigation that an `explorer` could not settle.

A change that already failed its checks or review is not audited; it is
repaired first, and the repaired candidate is audited if a point above applies.

## Alternatives considered

- Keep the auditor every round: rejected; it costs Sol-high requests and adds
  a serial wait without a stated reason.
- Audit only at the end of a phase: rejected; risk-area defects would be found
  after dependent tasks were built on them (the round 9 case).
- Replace the auditor with the verifier: rejected; the verifier runs tests in
  assigned files, the auditor reviews flows, races and boundaries that tests do
  not show. The verifier takes over routine per-change checks only.

## Consequences

- Fewer auditor turns and shorter rounds; round 13 of run `a125b4c6` was the
  first without an auditor, round 12 kept one for a risk-area repair.
- In risk-heavy projects (such as `codex_team_work` M4) the auditor still
  appears often; the saving is larger on ordinary projects.
- The rule is model guidance, not enforcement: the lead can still dispatch the
  auditor elsewhere. Check the dispatch journal if the frequency creeps back.
- `TEAM.md` is embedded in the lead profile, so a change rolls the lead session
  over to a new thread on the next server start; a running server keeps the
  rules it loaded.

## Refinement after staging shutdown, 2026-10-12

The owner authorized `docs/auditor-routing-plan.md` after stopping both services.
The frozen implementation contract is `docs/auditor-routing-contract.md`.

- Routine independent acceptance belongs to Quality Engineer/verifier, with
  the lead retaining final judgment. Material changes are checked after
  integration; unchanged and administrative rounds add no standing review.
- Auditor triggers are explicit critical changes, performance requirements,
  completed independently usable components, unresolved bounded investigations,
  security/integrity incidents, owner requests, and pinned-check integrity.
- Assignments declare review kind, reason, checkpoint, scoped paths, and
  evidence references. Runtime binds receipts to actual scoped content and
  check/requirement context, including uncommitted changes. Declared critical
  obligations block dependent implementation and final acceptance until their
  gates pass. Matching receipts are reused; changed relevant content invalidates
  them. Model risk classification itself is not mechanically proven.
- Direct auditor requests need structured context. The separate automatic
  read-only pinned-check review retains preserve/weaken semantics and owner
  authority. Neither an investigation nor a positive model report can override
  failed deterministic acceptance.
- Selection, reuse, results, failures, remedies, and architectural decisions
  receive durable correlated records for production transfer. The lead's
  `records` metadata links explicit architectural choices to their ADRs.

Read-only inspection found no active/unresolved writers in accessible staging
databases. It did not find the historical run's journal or usage rows, so exact
frequency, duration, and token coverage cannot be independently reconstructed
from those databases. Historical observations above retain their original
status; they are not a measurement of this refinement's effect.

Qualification must include focused checks, a stable full suite, and independent
review. Live profile loading and resource savings require a later bounded live
trial and are not established by source inspection or unit tests.

The required isolated qualification completed on 2026-10-12; detailed evidence
and all failed-review remedies are in `docs/auditor-routing-plan.md` and
`docs/production-transfer.md`. An audit reservation protects managed writer
overlap without widening the reviewer's filesystem permissions. Snapshot reads
preserve the Git index with optional locks disabled.
