# AUT-05 baseline — brief

## Objective

Implement the AUT-05 measurement foundation per `docs/aut-05-baseline-runbook.md`
(Phase 0 of `docs/spec-kit-luna-integration-plan.md`): a regression corpus, metric
definitions, an independent oracle, a frozen baseline, a pure offline evaluator,
and a `baseline_ready` handoff for AUT-01. Offline fixtures and existing reviewed
exports are sufficient; no live model call, service lifecycle action, or paid
benchmark is authorized.

## Ownership

- Lead (this agent): scope, corpus selection, metric definitions, source/target
  identity, frozen baseline acceptance, final handoff.
- Engineer (worker subagent): evaluator/CLI/schema/fixture implementation.
- Verifier (critic subagent): independent review of integrated candidate.
- Auditor (auditor subagent): evidence semantics + immutability review.

## Sequence

B0 inventory -> B1 schemas + metric defs + small fixture -> B2 full corpus +
planning-baseline freeze -> B3 evaluator + CLI -> B4 collect observations ->
B5 verify/audit -> B6 lead records `baseline_ready`.

## Boundaries

- Additive/new files only; preserve unrelated changes and owner pauses.
- Distinguish harness from target orchestrator in evidence.
- Never fabricate acceptance or zero spend; unknown measurements stay null.
- Only the lead records `baseline_ready`; evaluator emits findings/eligibility.
