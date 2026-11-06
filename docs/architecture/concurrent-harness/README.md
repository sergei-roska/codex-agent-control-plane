# Concurrent Harness: architecture and delivery plan

Current assignments come from the [autonomous delivery backlog](../../autonomous-delivery-backlog.md).
The package plan below is archived planning history. Architecture and implementation
evidence remain useful at their recorded revisions; historical exclusions do not
override current owner requirements. Read the [migration map](../../autonomous-delivery-migration.md)
for pending work dispositions.

Status: accepted design, implementation in progress since 2026-10-26.
Role settings/UI, contracts, transactional backlog, immutable candidates,
per-attempt execution and worker scheduling have qualified local source gates.
Continuous lead/inbox and candidate review policy also passed local source gates.
Lifecycle/recovery, visibility and final acceptance passed their local source
gates. Engine integration and overall qualification remain. The new engine is not activated.
This package studies the Harness that builds and runs work on target projects.
It does not redefine the target Orchestrator's product requirements.

Current accepted source and pending gates: [implementation status](implementation-status.md).
Source application, engine selection and restart boundaries:
[activation procedure](activation.md).

## Start here

1. Read [current architecture](current-architecture.md) for source-backed facts,
   terminology, bottlenecks, and boundaries that must survive the redesign.
2. Read [target design](target-design.md) for the backlog, scheduler, autonomous
   lead, candidate reviews, resource limits, and recovery contracts.
3. Read [role authority and execution rights](role-policy.md) for role capabilities,
   autonomy, practical tool access and lead availability.
4. Use the [active backlog](../../autonomous-delivery-backlog.md) to assign new work.
   [Historical implementation packages](implementation-plan.md) preserve prior scope
   and package acceptance evidence.
5. Use [validation and rollout](validation.md) for acceptance traces, crash
   injection, comparative measures, migration, and rollback.
6. Query [knowledge-graph.json](knowledge-graph.json) for baseline file imports, subsystem
   membership, evidence, requirements, and package dependencies. The graph covers
   every `src/*.js` module in the recorded research baseline. New foundation APIs
   are documented in [foundation-api.md](foundation-api.md) and implementation
   status. The graph is a navigation artifact, not runtime state.
7. Check [source-baseline.json](source-baseline.json) before relying on line numbers
   or reusing the research. It records the dirty working tree, not a deployed build.

All source references are repository-relative. A path and line identify the
investigated version; match its baseline SHA-256 before assuming it is unchanged.
Generated or temporary research is not required to understand this package.

## Product direction

The lead owns delivery of an objective. It prepares a durable backlog, chooses a
team and a dependency graph, handles ordinary blockers, and maintains useful ready
work while agents execute. Workers receive independent tasks whenever capacity
and dependencies permit. Completion of one task wakes scheduling immediately.
A planning turn is an event in this process; it is not a barrier around a batch.

The lead chooses roles, counts, and pipeline structure for the actual task.
Templates are suggestions. Additional independent review is justified by risk,
requirements, and evidence, rather than by the end of an arbitrary round.
Deterministic restrictions must identify the invariant they protect.

First delivery concentrates on one project's concurrent team. Existing separate
project servers must remain independently usable. New cross-project scheduling,
shared-account fairness, and a combined multi-project dashboard are deferred.
Per-role account selection was considered and explicitly excluded by the owner.

## Requirements and traceability

| ID | Required behavior | Acceptance location |
| --- | --- | --- |
| HCR-01 | Durable backlog with stable tasks, dependencies, priorities, blockers and acceptance | V01-V05 |
| HCR-02 | Several instances of one role, including engineers and auditors, execute concurrently | V06-V09 |
| HCR-03 | Lead remains available for steering and prepares future work while workers run | V10-V12 |
| HCR-04 | Lead selects team and pipeline dynamically within configured capacity and authority | V13-V14 |
| HCR-05 | A blocker creates bounded internal recovery; unrelated authorized work continues | V15-V17 |
| HCR-06 | Truthful candidate-bound review, integration, owner checks and final acceptance | V18-V23 |
| HCR-07 | Pause, stop, cancel, quota recovery and restart preserve intent and prevent duplicate effects | V24-V29 |
| HCR-08 | Role cards configure agent counts and correctly expose model, reasoning effort and Fast | V30-V33 |
| HCR-09 | UI shows ready, active and blocked tasks, worker instances, causes of idle time and evidence | V34-V35 |
| HCR-10 | Preserve distinct-project isolation without requiring a global broker in the first release | V36-V37 |
| HCR-11 | Migrate incrementally, retain legacy runs and permit rollback without discarding work | V38-V40 |
| HCR-12 | Demonstrate throughput and autonomy gains against equivalent accepted work | V41-V43 |

## Initial capacity policy

Owner-preferred core role-card defaults are 4 engineers, 2 explorers, 2 verifiers,
and 2 auditors, plus one lead. These are ceilings available to the lead, not a
requirement to start eleven agents on every objective. The lead can use fewer,
choose a different combination, or request a temporary subset of those slots.

A proposed initial project ceiling is 12 active model turns, including one
reserved planning slot. The eleven-agent core arrangement fits with one spare
slot. This aggregate default is a design proposal to qualify, not a measured
provider limit. Counts remain finite and configurable. Non-core roles retain
small explicit defaults and share the aggregate pool; they do not add hidden
capacity. Detailed semantics are in the target design.

## Evidence and limits

Research inspected current source, tests, bundled role instructions, and existing
design decisions. Five focused existing tests passed for wave grouping, reviewer
ordering, parallel lane writers, and shared-mode serialization. The package does
not claim a live throughput measurement, an observed cause for every historical
single-worker run, or a reproduced reasoning-effort rendering defect.

The active server's loaded source and isolation mode were not inspected. No live
model trial, service restart, target-project execution, or source repair was part
of this work. Current product changes that predate this plan must be preserved.

## Assignment protocol for successor agents

Select a ready implementation package, read its predecessors and source entry
points, then refresh the affected baseline and tests. Record actual file ownership
in `.agents/teamwork/PROJECT.md`; package ownership in this document is a proposal,
not a lock. Workers own product changes; the lead owns integration decisions and
cross-cutting contracts. Review concurrency, durable formats, failure paths, and
permissions independently before accepting the corresponding package.

Do not replace an existing safety guard with prompt text. Every relaxed guard
requires the replacement invariant and adversarial evidence named by its package.
Do not infer deployment, external writes, or real model trials from plan acceptance.
