---
name: orch-contracts
description: Design or review orchestrator task, attempt, artifact, approval, and event contracts with lifecycle invariants and version ownership.
---

# Orchestrator Contracts

Use when designing or changing interfaces among planners, schedulers, executors, stores, verifiers, and humans. Read sections 3, 5-6, 8-12, and 17 of `.codex/orch/REFERENCE.md` as relevant.

1. List each authoritative entity and owner. Distinguish run, plan revision, task, attempt, execution, artifact, event, and decision only where the system needs them.
2. Define input and result schemas with stable IDs, pinned revisions, allowed capabilities, limits, status/error classes, artifact references, and acceptance evidence. Explain which fields are required and which are optional.
3. Define legal state transitions and atomic boundaries. State how two dispatchers claim work, how a late or duplicate result is handled, and when capacity is released.
4. Specify idempotency or reconciliation for external effects and any gap between state persistence and delivery. Do not claim exactly-once execution from queue acknowledgment alone.
5. Validate representative success, failure, retry, cancellation, restart, approval, and stale-revision examples against the contracts.

Return schemas or interface tables, invariants, concrete examples, unresolved implementation choices, and the checks that will enforce the contract. Keep storage products and agent protocols replaceable unless the project's requirements select them.
