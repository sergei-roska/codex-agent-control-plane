# Parallel delivery backlog: one worktree per ticket

Status: planned, not started, no owner priority set. Recorded 2026-10-06 at the
owner's request. Nothing here is implemented, and the default behavior (one
repository-mutating ticket at a time per project) stays unchanged until a package
below says otherwise. Each package needs its own brief and acceptance evidence.

## Current behavior and why

- Beta design rule 7 ([master plan](beta-master-plan.md)): one repository-mutating
  ticket pipeline at a time per checkout. A checkout has one working directory and
  one active branch, so two tickets in it would switch branches under each other
  and mix context. A per-turn writer lock alone cannot prevent that.
- Implementation: `repository_leases` has `project_id` as its primary key, so one
  lease per project. The lease is taken at Intake and held until the ticket is
  cancelled or accepted (and, by the manual commit gate, until the owner commits).
  Other runs queue FIFO with "Repository in use by <ticket>"
  ([M3 implementation](m3/implementation.md)). A ticket waiting for human review
  therefore blocks the queue.
- Parallelism that exists today: read-only role assignments inside one run
  (`src/lead-graph.js`); any writer in the batch makes it serial. Different
  repositories need separate server instances (separate state and lock
  directories); the launcher owns only one child.
- "Parallel developers writing to a shared checkout" and "concurrent projects in
  one server instance" are listed as Deferred in the master plan.

## Idea: a git worktree per ticket

A git worktree is an extra working folder of the same repository with its own
checked-out branch; history and objects are shared. Each ticket would get its own
folder (for example `<state dir>/worktrees/CDB-390`), the lease would be keyed by
that folder instead of the project, and tickets could not switch branches under
each other. The main checkout stays untouched.

What it does not solve:

- Two tickets editing the same file still conflict at merge time.
- Untracked and ignored files are absent in a new worktree: `vendor/`,
  `node_modules/`, `.env`, local environment config. For a Drupal project on
  Lando the environment is bound to a folder, so each worktree may need its own
  `composer install` and containers or checks cannot run. This is a suspicion,
  not verified (PAR-2 verifies it).
- Quota. One ticket costs roughly 0.2-1.1M tokens in the CDB pilot and the 7-day
  window was 73% used. Parallel tickets may hit quota before the lease was the
  real bottleneck.

## Status

| ID | Package | Owner tier | Depends on | Status |
| --- | --- | --- | --- | --- |
| PAR-0 | This backlog and links from the plan and handoff | lead | - | done |
| PAR-1 | Measure the real cost of the lease: queue wait per ticket (run_queued to lease_acquired, time spent holding the lease while waiting for review or commit) from the journal and ledger. Gate: continue only if the wait is significant for the owner | auditor-sonnet | - | planned |
| PAR-2 | Feasibility probe on the Drupal/Lando project: create a worktree by hand, check what is missing (vendor, env, Lando, checks, MCP root). Needs an owner-run git command because hooks block `git checkout`/`branch` for lead and workers | owner runs git, worker-sonnet inspects | PAR-1 | planned |
| PAR-3 | ADR: lease keyed by worktree; worktree location and naming; relation to `ticket_branches` and the per-repository workspace lock; concurrency cap (default 1, quota-aware); crash recovery and orphan worktree cleanup; merge-conflict policy between sibling tickets; permission profile and snapshot path binding | lead (auditor-opus once, because lease and recovery are subtle) | PAR-1, PAR-2 | planned |
| PAR-4 | Implementation: store migration, delivery controller, Git adapter, permission profile, workspace snapshot, worktree create/remove, tests | worker-sonnet, auditor-opus review of lease idempotence | PAR-3 | planned |
| PAR-5 | Dashboard: queue and lease per worktree, cleanup action, concurrency setting | worker-sonnet | PAR-4 | planned |

## Open owner decisions

- Whether this is worth doing at all; PAR-1 exists to answer that with numbers.
- Which projects need it first (Drupal/Lando makes PAR-2 important).
- Concurrency cap, driven by quota rather than by the lease.
