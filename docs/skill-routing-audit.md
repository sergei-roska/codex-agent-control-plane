# Custom skill routing audit

Source reviewed on 2026-10-16: `/home/sr/Projects/Workspace/ws-knowledge/skills`.
The Harness copy of each present source folder remains byte-identical. Routing
policy lives in `profiles/skills/routing-policy.json`; only KEEP entries are
available to task selection. ADAPT and DEFER entries stay in the library but
are not assigned until their stated issue is addressed. The runtime selects at
most five skills per assignment and normally selects fewer.

## Decisions

| Skill | Decision | Harness fit and routing condition |
| --- | --- | --- |
| `actor-model` | KEEP | Use as conceptual guidance for actor/message-system work. It does not define Harness agent authority or require all Harness state to be private. |
| `a11y-frontend-twig` | ADAPT | Useful for Drupal Twig/SDC accessibility work; needs clear read-only reviewer and implementation boundaries. |
| `agent-factory` | DEFER | Specific to another orchestrator and depends on its agent-memory write tools and dispatch workflow. |
| `blast-radius-analyzer` | ADAPT | Useful for broad refactors and migrations; keep reports within the assignment scope and do not make it an approval gate. |
| `circuit-breaker` | ADAPT | Useful for retry-policy design; its retry and fallback examples cannot authorize live calls or extra dispatches. |
| `codebase-indexing` | DEFER | Requires an absent indexer MCP and includes index lifecycle and deletion operations. |
| `codebase-search` | ADAPT | Useful when a compatible indexed-search MCP exists; the matching source MCP is absent, so current tasks must use available search tools. |
| `copy-on-write` | ADAPT | Useful only where the Harness workspace layer actually provides copy-on-write isolation; it cannot impose that model on ordinary tasks. |
| `dead-letter-queue` | ADAPT | Useful for explicit queue design; do not assume a durable Harness DLQ or continue-after-failure behavior. |
| `design-by-contract` | KEEP | Use for bounded contracts, invariants, and tool/task boundaries. Its rollback advice cannot override user ownership or runtime approval gates. |
| `divide-and-conquer` | ADAPT | Useful for separable audits and plans; delegation remains lead-owned and must follow Harness ownership and concurrency rules. |
| `drupal-views-safe-edit` | ADAPT | Useful for Drupal Views changes; its MCP names and local fallback procedures need to match the selected task tools and target project. |
| `entity-query-analyzer` | ADAPT | Useful for report-only Drupal EntityQuery audits; external QA paths and analyzer contracts are not established by this Harness. |
| `event-sourcing` | ADAPT | Useful for event-store design; replay must not imply replaying external side effects or granting write authority. |
| `finite-state-machine` | KEEP | Use narrowly for workflow, lifecycle, and protocol transition modeling. It cannot grant transition or mutation authority. |
| `fork-join` | ADAPT | Useful for independent work branches; use only through lead dispatch and the Harness review, concurrency, and acceptance gates. |
| `hierarchical-work-decomposition` | KEEP | Use for multi-phase plans, milestones, and bounded task briefs; the lead retains dispatch ownership. |
| `idempotency-key-filter` | DEFER | Depends on an atomic shared journal and makes exactly-once claims that the current Harness tools cannot guarantee. |
| `investigate-before-asking` | ADAPT | Keep the inspect-first principle, but its host-specific tools and rigid thresholds can delay genuine owner decisions. |
| `lru-context-pruner` | DEFER | Claims control over live model context and token ceilings, which belong to the Harness runtime. |
| `mockup-to-spec` | ADAPT | Useful when a confirmed working mockup is authoritative; bundled scripts assume a particular working directory and coverage is literal rather than semantic. |
| `performance-maintainability-drupal` | ADAPT | Useful for Drupal performance work; distinguish static hypotheses from measured bottlenecks and require project-specific evidence. |
| `php84-systems-design` | DEFER | The target PHP version is not confirmed. Reconsider after project compatibility is known, then remove version-specific imperatives that conflict with it. |
| `pipes-and-filters` | KEEP | Use for deterministic data and artifact pipelines; its statelessness rule is a design choice, not a rule for every agent task. |
| `provision-ddev` | DEFER | Starts or changes DDEV and Docker state; keep unavailable until an explicit environment-provisioning capability and authorization contract exist. |
| `provision-lando` | DEFER | Starts or changes Lando and Docker state and contains an inconsistent scaffold procedure. |
| `provision-local-platform` | DEFER | Routes to mutating DDEV/Lando setup commands and duplicates both adapters; not suitable for ordinary task routing. |
| `raft-quorum-consensus` | DEFER | Its voting model conflicts with Harness lead/owner decision authority and is not a Raft implementation. |
| `rate-limiter-throttler` | DEFER | A skill cannot enforce runtime token, request, or tool-call budgets owned by Harness. |
| `saga-transaction-manager` | ADAPT | Keep as architecture guidance only. The current failure algorithm omits compensation for a possibly partial failed step. |
| `serial-item-processor` | ADAPT | Useful when serial order is required; no-lookahead and claimed context purging do not fit general Harness audits. |
| `supervisor-tree` | ADAPT | Useful for explicit supervisor design; process start, restart, signal, and shutdown actions remain runtime-owned. |
| `two-phase-commit` | DEFER | Prompt instructions cannot ensure atomic multi-file writes, and delegate votes cannot replace Harness acceptance and approval. |

## Scope notes

- Counts for the 33 current source folders: 5 KEEP, 17 ADAPT, 11 DEFER.
- `semantic-memory` is absent from the current source worktree. Its previous
  Git blob was reviewed separately and deferred because it depends on external
  memorygraph writes. It is not included in the 33-folder count.
- `aut-03-lead-decomposition-v1` is an internal Harness lead skill, not one of
  the imported source folders. It remains gated by the existing AUT-03 trial
  allowlist and is not available to worker assignments.
- Selecting a skill supplies guidance only. It never grants files, tools,
  external access, rollback rights, or approval authority.

## Additional source comparison

On 2026-10-16, the listed skills in
`/home/sr/Projects/Workspace/agent-factory/.codex/skills` were compared with the
Harness library. Eighteen of the 19 named folders are already present and
byte-identical. `eval-ops` is absent.

| Skill | Decision | Harness fit and routing condition |
| --- | --- | --- |
| `eval-ops` | DEFER | Do not import as-is. It prescribes an `evals.json` runner, Pass@k/JUnit reports, OpenTelemetry plus Langfuse/Phoenix, DSPy prompt optimization, and prompt commits/rollback. These are not the Harness evaluation contract and can conflict with its gated AUT-05 workflow. Harness already has a bounded offline evaluator and its own metric, evidence, and live-run rules in `src/autonomy-evaluation.js` and `docs/aut-05-baseline-runbook.md`. Reconsider only after rewriting the skill around those contracts and keeping live evaluation or prompt changes behind their existing authorization gates. |

## External candidate review

On 2026-10-16, `madsnorgaard/drupal-agent-resources/drupal-expert` was reviewed
from skills.sh and its public GitHub source. Decision: adapt before importing.
It has useful Drupal guidance on dependency injection, access checks, safe
queries, cache metadata, config schema, and Drupal 10/11 compatibility. Its
raw workflow also requires asking the user before custom work, assumes DDEV or
Docker and Drupal 10/11, and suggests mutating commands such as `drush updb`,
`drush en`, `drush pmu`, config import/export, field deletion, `phpcbf`, and
prompted generators. Those actions must stay subject to project discovery and
Harness task authorization. It also directs agents to inspect third-party web
content; skills.sh currently reports a medium Snyk W011 warning for that
exposure. Use the security boundary already in Harness if adapting these
principles. No files were imported and no installation command was run.
