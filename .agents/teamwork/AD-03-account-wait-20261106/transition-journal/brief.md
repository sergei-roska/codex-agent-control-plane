# AD-03 durable provider transition journal

## Goal

Add the small durable SQLite journal primitive required by the approved AD-03 transition design. The journal must record intent before provider switching and expose incomplete transitions after restart. This task does not wire dispatch barriers, account selection, engine rebind, or server recovery.

## Verified context

- Project objective and acceptance: `docs/autonomous-delivery-backlog.md`, AD-03.
- Approved design: `.agents/teamwork/AD-03-account-wait-20261106/rebind-architecture.md`.
- Source map: `.agents/teamwork/AD-03-account-wait-20261106/implementation-map/handoff.md`; no provider-transition journal currently exists.
- Use the existing better-sqlite3 conventions. Project cwd: `/home/sr/Projects/Workspace/codex-agent-control-plane`.
- The shared checkout is at HEAD `435afa3` plus the active AD-04 router fix. Do not change Git state or touch that fix. Leave inherited `:memory:.lockdb` untouched.

## Scope and ownership

Own only new files `src/provider-transition-store.js`, `test/provider-transition-store.test.js`, and this task directory. No existing source/test files; no server or engine wiring. No staging, commits, runtime activation, or live providers.

## Contract

Export `ProviderTransitionStore` and `createProviderTransitionStore(db, options)`.

Persist at most one active transition per project, using a SQLite table with project identity and bounded printable IDs. Intent fields must bind `transitionId`, `runId`, `objectiveId`, `sessionId`, `waitId`, source and target lowercase SHA-256 account identity hashes, `ownerGeneration`, and `controlRevision`. Do not persist raw account IDs, homes, credentials, or profile names.

Support exact record creation/idempotency, `get(projectId)`, monotonic phase advancement, and compare-and-clear. Phases: `intent`, `profile_switched`, `thread_prepared`. Reject skipping/reversing phases, mismatched immutable fields, stale phase/pins, malformed records, and replacing an existing different project transition. Validate all fields before mutation. Transactions must be synchronous better-sqlite3 transactions; preserve a single project-wide transition fence across process restarts.

Keep public shapes and method names documented in the module. Use existing project conventions for validation errors. Do not add general abstractions or async methods.

## Acceptance

1. SQLite reopen retains an active intent and all pins/hashes.
2. A second distinct intent for the same project is refused; exact idempotent create is safe.
3. Phase movement is strictly sequential and compare-and-swap guarded.
4. Clear requires the exact transition ID, phase, and control pins; stale clear fails closed.
5. Malformed/hash/raw-sensitive fields are rejected before any mutation.
6. Tests prove the above, including a stale concurrent phase update.
7. Run `node --test test/provider-transition-store.test.js` and `git diff --check`.

Write exact results to `handoff.md`. Status must distinguish this journal primitive from the still-unwired AD-03 integration.
