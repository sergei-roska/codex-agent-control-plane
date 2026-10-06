# Observability and prompt optimization backlog

Status: planned for the phase after the beta release and the live-project pilot.
Recorded 2026-10-06 at the owner's request so that OpenTelemetry integration and
the prompt-improvement decision cannot be dropped silently. Nothing here is
implemented. Each package needs its own brief, acceptance evidence and, where
named, an owner decision before work starts.

Background: [telemetry and MLflow notes](telemetry-mlflow-notes.md) (approved
direction of 2026-09-30, M8 outcome), [M8 acceptance](m8/acceptance.md),
[product goals](product-goals.md).

## Rejected: Python-based integrations (do not re-propose)

The owner has declined integrating anything that runs on Python into this
project. This is a standing decision, not a deferral. It has come up more than
once, so do not suggest it again.

- Stated reason: Python-based integrations create overlaps and friction with the
  existing Node.js stack (owner, 2026-10-06; the owner's word was "nakladki").
  No further technical detail was recorded; do not invent one.
- Out of scope, permanently: DSPy; MLflow's Python SDK and its Python prompt
  optimizers; any Python sidecar, subprocess, virtualenv or Python-based
  evaluation job managed by or shipped with this repository.
- If a future idea needs Python to work (an optimizer, an eval library, a
  tracing SDK), the idea is dropped or redesigned in Node.js. Do not propose a
  sidecar as a compromise.
- Boundary for MLflow: the MLflow server is itself a Python program, but it is
  treated as an external service. This repository talks to it only over HTTP or
  OTLP from Node.js and never installs, builds, starts or supervises it. The
  M8 README keeps a disposable-server recipe for verification only. The owner
  confirmed on 2026-10-06 that an external MLflow server is acceptable.

## Why this file exists

M8 delivered local telemetry (`UsageLedger`, cache metrics) and a bounded MLflow
Tracking export that logs sanitized fields as run parameters. It does not emit
OpenTelemetry spans, does not write MLflow GenAI traces or feedback records, and
no prompt-improvement mechanism exists beyond the M8 baseline/candidate
comparison. The approved direction (telemetry, then MLflow evaluation, then
data-driven prompt improvement) is only partly done. The rest is tracked here.

## Do not forget: revisit triggers

1. The M9 session handoff links this file under deferred follow-ups, so every
   session start sees it.
2. When the current phase closes (CDB pilot and adaptive-route measurement), the
   lead must either start OBS-1 or record an explicit deferral with a reason in
   the status table below. Silence is not an option.
3. Any milestone or phase plan written after M9 must review this table in its
   scope section.

## Decisions (lead, 2026-10-06)

- D1: OpenTelemetry is the instrumentation layer; MLflow is one backend. The
  orchestrator emits spans through `@opentelemetry/api` only. No MLflow-specific
  call sites in orchestrator code. The M8 Tracking-run exporter stays as is until
  OBS-4 replaces it.
- D2: Opt-in, off by default. Configure with the standard `OTEL_*` environment
  variables plus a project-policy switch. Default target is a local collector or
  loopback MLflow. A non-loopback endpoint needs an owner decision and an egress
  allowlist entry (the egress audit already exists).
- D3: Payload hygiene equals the M8 exporter: ids, role, model, effort, durations,
  token counts, outcome, route. No prompt or response bodies, no credentials, no
  ticket text, no absolute paths by default. Content capture is a separate later
  opt-in with its own review.
- D4: Exporter failure never fails or blocks delivery. Bounded buffer, drop on
  overflow with a visible counter. Durable execution state stays the
  orchestrator's responsibility.
- D5: Span model is ticket -> run -> stage -> attempt -> turn -> tool event.
  Use the OpenTelemetry GenAI semantic conventions where they apply (check the
  current spec version first, they are still evolving) plus `orch.*` attributes:
  ticket id, run id, route, acceptance outcome.
- D6: Node.js only. No Python anywhere in this repository's runtime or tooling
  (see the rejected section above). Prompt improvement uses the existing M8
  evaluation harness and candidates written without an optimizer library, for
  example by a role through the normal Codex path or by the owner. Promotion
  stays manual under the existing evaluation and review policy.

## Status

| ID | Package | Owner tier | Depends on | Status |
| --- | --- | --- | --- | --- |
| OBS-0 | This backlog and links from the plan, goals, notes and handoff | lead | - | done |
| OBS-1 | Short ADR: span model, attribute names, sanitization list, config keys, failure behavior (D1-D5 made concrete) | lead | - | planned |
| OBS-2 | OpenTelemetry instrumentation module with correlation ids from the ledger and journal; tests with an in-memory exporter; failure isolation test | worker-sonnet | OBS-1 | planned |
| OBS-3 | Backend verification: OTLP ingestion into an externally run MLflow (verify the endpoint and headers against the MLflow version in use, 3.16.1 was used in M8) and the MLflow JS tracing package as the alternative; readback of a real run; adopt/defer note | worker-sonnet, then lead decision | OBS-2 | planned |
| OBS-4 | Outcome and feedback as MLflow feedback records linked to traces (review outcome, acceptance, rework) over HTTP, replacing the run-parameter bridge | worker-sonnet | OBS-3 | planned |
| OBS-5 | MLflow production decision: where the external service runs, retention, credentials, egress | owner decision, lead brief | OBS-3, OBS-4 | planned |
| OBS-6 | Short ADR: Node-only prompt-candidate method (who writes candidates, how many evaluated runs are enough, scorers, budget); no optimizer library | lead | OBS-3 and a usable evaluation dataset | planned |
| OBS-7 | Offline candidate comparison on the M8 harness: candidates versioned, isolated test workspaces, deterministic scorers first, no automatic promotion | worker-sonnet | OBS-6 | planned |
| OBS-8 | Background analysis agent (proposal in the MLflow notes), outside the delivery roster, internal audit and budget accounting | tbd | OBS-7 | planned |

OBS-1 to OBS-5 realize the telemetry and MLflow steps of the 2026-09-30
direction with OpenTelemetry as the instrumentation layer (new). OBS-6 to OBS-8
follow the approved "later prompt optimization" step, reshaped to Node-only by D6.

## Open owner decisions

- When OBS-1 starts relative to the adaptive-route work (lead suggestion: right
  after the route measurement closes).
- Whether any non-MLflow, non-local OTLP backend is ever wanted. Until then the
  scope is local collector and MLflow only.
- Resolved 2026-10-06: an externally run MLflow server (Python, never touched by
  this repo) is acceptable under the Python rejection (owner confirmed).
