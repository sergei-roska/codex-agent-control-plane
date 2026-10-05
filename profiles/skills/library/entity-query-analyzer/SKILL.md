---
name: entity-query-analyzer
description: "Активируется при: EntityQuery audit, accessCheck missing, unbounded loads, N+1 entity loads, static performance-risk scan, code/security/upgrade review of query patterns WITHOUT profiler evidence. Предназначен для read-only static EntityQuery/load risk audit on custom modules/themes/profiles. НЕ активировать для: confirmed live slowness with SQL/APM/slow-query evidence (→ query-performance-investigator), cache context/tag mismatches (→ cacheability-access-auditor), or deprecation API scans (→ deprecation-assistant)."
---

# Drupal Entity Query Analyzer

Report EntityQuery correctness and performance candidates without pretending that static patterns prove runtime cost.

## Guardrails

- Remain report-only. Do not edit code or configuration, execute application queries, add indexes, clear caches, enable profiling, or install tooling.
- Default scope to custom modules, custom themes, and custom profiles. Include core or contributed extensions only when explicitly requested.
- Establish installed and target Drupal versions, entity types in scope, custom-code roots, and configured analyzer commands before classifying a query.
- Discover configured PHP static-analysis rules first. Do not replace a precise installed rule with a weaker text search. Never collapse absence, missing configuration, excluded scope, execution failure, baseline suppression, findings, and a completed clean run into one status.
- Verify current accessCheck requirements and storage-specific semantics against official documentation for the complete target range. Do not apply a content-entity rule blindly to every query implementation.
- Treat accessCheck(FALSE) as a security-sensitive decision, not an automatic defect. Its caller, execution context, result exposure, and later access enforcement determine the finding.
- Never choose TRUE or FALSE for an omitted access decision. Report the required human or domain decision.
- Treat a query or load inside a loop as a candidate until source control flow proves repeated execution. Static source alone does not prove production frequency or cost.
- Do not use local-memory-search find_callers as loop or frequency analysis. It maps symbol relationships, not control flow.
- Use local-memory-search only when it is available and an index already exists. Do not start or rebuild an index. Fall back to exact filesystem search and report incomplete semantic coverage.
- Do not prescribe loadMultiple, query hoisting, pagination, or caching before checking ordering, access, memory, staleness, and batch semantics.
- If query-performance-investigator is available, hand confirmed runtime slowness, repeated query traces, plan inspection, and index analysis to it. Otherwise keep this skill self-contained: report the runtime evidence and next-stage procedure required without claiming confirmation.

## Workflow

### 1. Fix scope and coverage

1. Record audit scope, exclusions, installed and target Drupal versions, and requested report path.
2. Discover actual static-analysis commands, rule configuration, baselines, and CI gates. Run commands through the project's established environment wrapper.
3. Build a coverage matrix:

| Surface | Primary detector | Secondary review | Status |
| --- | --- | --- | --- |
| Explicit access-check decision | configured analyzer | source flow | covered/gap |
| Query construction and execution | exact search | source flow | covered/gap |
| Repeated query or load candidates | structural/source review | call-path context | covered/gap |
| Result-size and hydration risks | source review | entity/storage context | covered/gap |
| Runtime frequency and cost | outside this skill | optional companion handoff | not claimed |

4. Record each analyzer in exactly one execution state:
   - not installed
   - installed but no relevant rule configuration found
   - configured but the requested custom-code scope is excluded or unverified
   - attempted but failed to execute or parse
   - completed with findings
   - completed without reported findings
5. Record baseline state separately: no baseline, baseline irrelevant to this surface, relevant suppressions present, or baseline effect unresolved.
6. Treat only completed states as executed coverage. Call a result clean only when the command, rules, files, and baseline effect are all verified.

### 2. Enumerate query and load sites

1. Run installed analyzers with verified EntityQuery or Drupal rules. Preserve command, scope, exit state, rule identifier, file, line, baseline suppression, and raw message.
2. Use `drupal-codebase-introspect` inventory and registry finders where available to identify custom controllers, blocks, field formatters, forms, queue workers, cron code, event subscribers, access handlers, and services. Verify paths in source.
3. Search all verified custom-code roots for direct and injected entity-query construction, aggregate queries, storage getQuery calls, execute calls, entity or storage load and loadMultiple calls, and static entity loading.
4. Search for accessCheck calls separately. Do not assume proximity in a text match proves that the call belongs to the same query object.
5. If local-memory-search is usable, inspect index_status first. Use keyword search for exact APIs and find_callers only to widen real symbol call paths. If unusable, continue with exact filesystem search.
6. Read full methods and any helper methods that build, alter, pass, clone, or execute the query. Separate executable code from tests, fixtures, examples, comments, and update-history artifacts.

### 3. Reconstruct each query lifecycle

For every candidate, record:

| Query origin | Entity or storage type | Builder methods | Access decision | Execution site | Result consumer | Repetition boundary | Result bound |
| --- | --- | --- | --- | --- | --- | --- | --- |

1. Follow the query object from construction to execute, including helper returns, decorators, callbacks, and alter hooks.
2. Determine the actual entity/storage type when possible. Mark dynamic or custom storage semantics unresolved rather than guessing.
3. Identify whether execution occurs inside a loop, recursive path, repeated render callback, per-row preprocess function, queue item, batch item, or independently invoked helper.
4. Distinguish one query returning many IDs from many query executions. They have different remedies and risks.
5. Trace ID results into load or loadMultiple calls. Record whether entities are loaded individually, in a batch, from static cache, or not loaded at all.
6. Record explicit range, pager, count mode, sort requirements, and the maximum result set implied by validated domain constraints. Do not call a query unbounded when a real invariant bounds it.
7. Map the site to its likely execution surface, but do not infer real request frequency from class type alone.

### 4. Classify access decisions

1. Verify whether the query implementation and target range require an explicit access decision.
2. For an omitted decision, report the call site and the unresolved choice. Do not auto-fix it.
3. For accessCheck(FALSE), record:
   - caller and privilege boundary
   - whether the code is administrative, background, update, internal service, or user-facing
   - whether returned IDs or loaded entities can reach a user
   - whether later per-entity or domain access enforcement exists
   - why bypass is necessary, when documented
4. For accessCheck(TRUE), verify current documentation and the actual entity query access implementation before claiming that all required domain access is enforced.
5. Classify analyzer findings separately from source-confirmed security findings.

### 5. Classify performance candidates

Use confidence levels:

- Confirmed static repetition: source control flow proves the query or uncached load executes once per loop item or recursive step.
- Likely repetition: the call is in a repeated callback or helper, but invocation count is external or dynamic.
- Potential large result: result size lacks a proven bound or pagination, but runtime cardinality is unknown.
- Intentional bounded pattern: a verified small invariant, static cache, or batch boundary contains the cost.
- Runtime confirmation required: cost or frequency cannot be established statically.
- False positive: the match is unreachable, non-executable, already batched, or misattributed.

For each non-false-positive candidate, record which evidence would confirm or dismiss it at runtime. When query-performance-investigator is available and runtime confirmation is requested, hand off the ledger and required evidence. Otherwise include the same next-stage requirements in this report; do not make the companion skill a prerequisite.

### 6. Assess remediation direction without changing code

1. Describe the cause before suggesting a direction: repeated query construction, per-ID hydration, oversized result set, repeated count, redundant load, or access-filtering ambiguity.
2. State constraints that a future fix must preserve: access behavior, ordering, memory ceiling, cache invalidation, freshness, transaction or batch boundaries, and empty-result behavior.
3. Recommend a category, not an unverified patch:
   - batch compatible loads
   - hoist invariant work
   - reuse already loaded entities
   - add an explicit result boundary
   - separate counting from hydration
   - resolve the access policy explicitly
4. Do not recommend an index or rewrite query conditions without an actual captured SQL statement and plan evidence.

## Report

Write a Markdown report to the user-specified path. If no path was supplied, return it in the response and ask before creating a file. Do not modify audited source or configuration.

Include:

- scope, versions, exclusions, analyzer commands, execution states, scopes, baseline state, and results
- coverage matrix and local-memory or filesystem-search mode
- query lifecycle ledger
- access findings grouped as confirmed, tool finding, decision required, false positive, and unresolved
- performance candidates grouped by confidence
- file and line evidence
- affected execution surfaces and call paths
- runtime evidence required for each candidate
- remediation constraints and suggested direction
- residual gaps and recommended tooling not installed

Never report a confirmed N+1, slow query, or secure access policy from keyword matches alone.

## Structured contract for `dev-validatecode` routing

When invoked as a specialist subagent by `dev-validatecode` (see `New-MCP-Servers.md` §4
step 9), this skill runs under a structured contract *in addition to* the report above. The
guardrails and workflow prose above remain the source of truth for *how* the analysis is
performed; this section only defines the calling contract.

### Accepted Input

- `validation_run_id` — the orchestration run this call belongs to (scopes `qa/runs/<validation-run-id>/`).
- `requirement_ids[]` — requirement IDs (at their current revision) this call must evaluate.
- `changeset_slice` — only the changed paths/surfaces routed to this specialist, never the whole changeset.

Evaluate only the provided slice and requirements. Missing upstream evidence is a coverage
limitation, never silently reconstructed.

### Structured Output

Return the normal Markdown report AND a compact structured result:

- `specialist_id`: `entity-query-analyzer`
- `verdict`: `PASS` | `FAIL` | `BLOCKED` | `DEGRADED` | `NOT_RUN` (aggregate precedence `FAIL` > `BLOCKED` > `PASS`; a degraded or non-executable check is never promoted to `PASS`). A static-only candidate needing runtime confirmation is `DEGRADED`, not `PASS`/`FAIL`.
- `findings[]` — each with location, evidence, severity, and the `requirement_id` it bears on.
- `coverage_notes` — surfaces/requirements not fully evaluated and why.
- `artifact_path` — path under `qa/runs/<validation-run-id>/` where this specialist's detailed artifact was written.

Persist the artifact; do not collapse degraded coverage into success.
