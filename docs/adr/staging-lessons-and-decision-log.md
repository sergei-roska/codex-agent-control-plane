# ADR: Retain staging problems and decisions for production transfer

Status: owner requirement accepted on 2026-10-12. Documentation workflow applies
now; durable runtime additions are implemented and independently accepted in
isolated qualification. They load on the owner's next service start; no live
trial has been claimed.

## Context

This orchestrator is a staging environment for development-team experiments.
The owner will transfer the qualified behavior to a production orchestrator.
Successful final code alone does not explain failed approaches, discovered
limitations, or why an architectural decision was selected.

## Decision

- Record every discovered problem and attempted resolution, including failed
  attempts, unresolved issues, regressions, and reopened findings. Use a stable
  problem ID and link run, assignment, attempt, artifact, and verification
  identities when available.
- Record every architectural decision in an ADR and index it in
  `docs/production-transfer.md`. Log other consequential decisions with their
  reasons and evidence. UI-related problems and decisions are included too.
- Distinguish proposed, accepted, implemented, and verified statuses. State
  whether verification is static, isolated, or from a live trial. Never present
  a model report or an intended fix as proof of runtime behavior.
- Each problem record gives the symptom, scope, known cause or uncertainty,
  attempted fix, result, evidence, remaining limits, and production action.
  Each ADR gives context, decision, alternatives, consequences, evidence, and
  status. Unknown historical dates and measurements remain unknown.
- Preserve history through dated updates and superseding decisions. Closing a
  problem adds verification evidence; it does not erase its failed attempts.
- Runtime event persistence must survive restart, deduplicate retries, and
  retain correlations. Existing journals, checkpoints, ledgers, and evidence
  storage are reused where sufficient. Selecting the precise additional event
  schema and retention policy belongs to the implementation contract.
- Exclude secrets from event payloads. Reference sensitive evidence through
  existing access-controlled artifact storage. Record redaction or unavailable
  evidence explicitly.

## Consequences

The transfer log is the index of staging knowledge, with links to detailed ADRs,
problem evidence, and runtime records. Logging is part of completing a change,
not a retrospective task after the production rollout begins.

The first implementation is `docs/auditor-routing-plan.md`, including an
inventory of prior ADRs and known problems. The server injects persistent
`StagingLog` into lead and direct-role execution; `npm run staging:report` reads
bounded history without starting the server. No live runtime or session was
started during implementation.
