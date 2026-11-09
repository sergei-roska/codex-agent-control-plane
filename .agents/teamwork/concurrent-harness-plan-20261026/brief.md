# Concurrent Harness redesign: investigation and implementation plan

Owner request: deeply study Harness, create a reusable architecture/knowledge
map, and a detailed redesign plan other agents will implement later. Requested
behavior: durable task backlog, multiple worker instances, continuously prepared
ready work, concurrent independent reviews, autonomous blocker resolution,
long-lived delivery objectives rather than one serial assignment per round.

Authorization: source and read-only runtime investigation, documentation and
scratch evidence. No product code/test/config edits, dependency changes, commits,
restarts, task resumes, target project actions, or real model trials.
Preserve 20 existing modified files and 2 untracked tests. Root owns Git and
tracked docs/architecture/concurrent-harness/ and coordination. Explorers own
only their named ignored reports. English/ASCII for all files and agent messages.

Acceptance:
- Evidence-backed current architecture graph and navigation index, including
  scheduler, state, contracts, review, execution lanes, UI and recovery boundaries.
- Explain actual concurrency capabilities and restrictions, including repeated
  reviewers, same-role workers, waves, batching, and observed-vs-inferred claims.
- Specify a target design with durable backlog, dependencies, worker capacity,
  atomic claims, completion events, planning overlap, acceptance and owner controls.
- Define stable IDs, state transitions, concurrency/replay/cancellation invariants,
  candidate identity, budgets, migration, rollback and observability.
- Dependency-ordered implementation packages, ownership, interfaces, acceptance
  tests, adversarial scenarios, offline evidence, rollout and a clear first task.
- Independent critic review of plan; resolve substantive findings before handoff.

Source baseline: HEAD recorded in baseline.json; working tree is authoritative
and dirty. Prior diagnosis: ../parallel-lead-audit-20261026/{scheduler,policy}.md.
Current toolchain: Node CommonJS, node:test, SQLite better-sqlite3, LangGraph,
existing Codex App Server + A2A adapters. Prefer existing infrastructure; research
is local and read-only. Evidence of current APIs comes from source, not guesses.
Fresh native quota 2026-10-26T16:09:53Z: 96% five-hour, 84% weekly remaining.

Owner steering: prioritize single-project delivery. Preserve existing independent
project operation; make identities project-scoped. Defer shared cross-project
capacity/fairness broker and aggregate UI to a separate optional phase.
