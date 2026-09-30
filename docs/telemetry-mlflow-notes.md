# Automatic telemetry and MLflow discussion

Recorded on 2026-09-30. This document distinguishes product intent, observed
capabilities, approved direction, and open proposals. The owner approved the
incremental direction below. Production adoption of MLflow remains subject to
the integration evaluation; no implementation has been requested yet.

## Product intent

The owner wants automatic background telemetry for orchestrator executions,
without creating a separate board ticket for collecting it. Jira and direct
dashboard requests should generate observations as they execute. The data should
support debugging and later evidence-based improvements, including prompt
optimization.

Telemetry records what happened. It does not itself improve prompts, update
model weights, or make past experience available to the next execution.
Evaluation, prompt changes, and knowledge retrieval are separate capabilities.

## Observed baseline

- [UsageLedger](../src/usage-ledger.js) persists lead and worker usage in SQLite:
  role, task/run/attempt references, model, effort, elapsed time, available tokens,
  outcomes, and permission events.
- [Server wiring](../src/server.js) enables the ledger automatically.
- [Lead graph](../src/lead-graph.js) emits runtime decision, assignment, round,
  reconciliation, and acceptance callbacks. These are not a durable tracing export.
- [Usage reporting](../src/usage-report.js) distinguishes subscription usage
  from hypothetical API cost. Missing token counts remain unknown.
- The inspected implementation has no MLflow integration or prompt optimizer.

## Proposed observation contract

Correlate tickets, runs, assignments, attempts, and available tool events. Record
effective model settings and versions of prompts, role instructions, tool
configuration, orchestration policy, and relevant code for meaningful comparison.

Combine operational measurements with quality evidence: acceptance-check results,
independent review findings, rework, and the owner's review outcome. A completed
model turn is not proof of successful delivery. Export sanitized data; credentials
must not become trace payloads. Record available events and outputs without
promising visibility into hidden model reasoning.

Export should be independent of board actions. A temporary analytics failure
should not fail valid delivery work. Durable execution state remains the
orchestrator's responsibility.

## Approved prompt-cache metrics

The owner approved exposing cached input-token counts and their share in
telemetry on 2026-09-30. Aggregate these by role, product ticket, and execution
run, retaining attempt-level usage for diagnosis.

- Report input tokens and cached input tokens where available.
- Calculate cached-input share as `sum(cachedInputTokens) / sum(inputTokens)`
  over entries with both values known. Use a ratio of sums, not an average of
  per-entry percentages. Cached input tokens are a subset of input tokens.
- If no paired measurements exist or the denominator is zero, the share is
  unavailable. Distinguish an observed zero from missing data.
- Label partial aggregates and expose measurement coverage when entries lack
  counts. Do not present a partial measurement as the full run's cache share.
- This ratio measures token reuse, not the percentage of requests hitting cache.
  It does not establish monetary savings or subscription quota savings.

This is an approved requirement for future telemetry integration; the current
dashboard remains a prototype and these metrics have not been wired into it.

## MLflow capabilities and fit

- [Tracing](https://mlflow.org/docs/latest/genai/tracing/): execution steps,
  inputs/outputs, metadata, latency, token usage, and feedback.
- [Evaluation](https://mlflow.org/docs/latest/genai/eval-monitor/): datasets,
  deterministic custom scorers, model-based judges, and result comparison.
- [Prompt Registry](https://mlflow.org/docs/latest/genai/prompt-registry/):
  immutable prompt versions, comparison, aliases, and lineage.
- [Prompt optimization](https://mlflow.org/docs/latest/genai/prompt-registry/optimize-prompts/):
  explicitly executed optimization algorithms. Data-driven optimization uses
  examples and quality metrics; metaprompting also supports a zero-shot mode.

MLflow is a candidate analysis and experimentation service. The dashboard still
represents tasks and operator controls. MLflow does not replace orchestration,
Jira integration, or execution checkpoints.

The application is Node.js and calls Codex through subprocess JSON-RPC rather
than the OpenAI SDK. Automatic SDK tracing cannot be assumed to observe this
boundary; this is an inference from the documented integrations. Instrumentation
must capture orchestration and available App Server events explicitly.
[JS/TS tracing](https://mlflow.org/docs/latest/genai/tracing/quickstart/) and
[OpenTelemetry ingestion](https://mlflow.org/docs/latest/genai/tracing/opentelemetry/)
provide possible integration paths. The reviewed evaluation and optimization
examples use Python; they do not establish a JS/TS optimization API.

Trace collection does not require model calls. Model-based judges and prompt
optimizers require configured model execution and consume its budget.
Compatibility with the current Codex OAuth path is not established by MLflow's
direct-provider examples. Deterministic scorers can use existing check results.

## Approved incremental direction

1. Define event correlation and quality evidence alongside the initial read-only
   kanban. Avoid delaying it for a complete optimization platform.
2. Evaluate MLflow with a small tracing adapter and representative runs after
   the initial board works.
3. Curate evaluation cases and compare prompt candidates under controlled
   configuration. Re-execute code-changing tasks in isolated test workspaces.
4. Promote candidates after quality and regression checks, preserving versions
   and rollback. Scheduled automation remains a later policy choice.

The owner approved this sequence on 2026-09-30: automatic telemetry from the
early integration stages, a bounded MLflow integration evaluation, and later
prompt optimization based on collected data and quality criteria. Detailed
implementation and deployment choices remain open.

## Background system maintenance proposal

The owner asks whether system maintenance should have a background agent that
does not appear as a delivery role or create ordinary board tickets. The proposed
separation is:

- A deterministic telemetry service collects, buffers, exports, and manages
  observations without LLM calls. Basic health checks and bounded recovery
  should also be implemented as service logic where appropriate.
- A background analysis agent can periodically inspect sanitized traces and
  review outcomes, identify recurring failures, and propose prompt or workflow
  improvements. Evaluation jobs can test candidates in isolated environments.

This would be an internal system capability, outside the delivery roster and
ordinary task pipelines. Its executions should retain internal audit records,
status, and budget accounting even if excluded from the main board and sidebar.
Administrative visibility can be designed later without adding routine delivery
cards. It should not compete with foreground delivery work without an explicit
scheduling policy or bypass workspace write admission.

Candidate changes should be versioned, evaluated, and promoted through a defined
policy. Active runs retain their pinned configuration. Initial maintenance scope
is analysis and candidate preparation; automatic production changes, broader
repair authority, scheduling, and a final agent name are not agreed yet.
