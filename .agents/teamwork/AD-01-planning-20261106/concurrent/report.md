# AD-01 concurrent runtime map

Baseline source: `ab5c195`. Read-only inspection; no tests run.

## Call path and scope

- [Read] `src/server.js:1438-1470` composes the concurrent engine when configured as default or persisted mappings require it, pins the active provider identity, then calls `recoverInterruptedShutdown()` and `recoverStoredRuns()` before routing. `src/server.js:1479-1482` constructs `DeliveryEngineRouter`.
- [Read] `src/delivery-engine-router.js:33-45,65-103` persists a per-project/run engine mapping, objective ID, session ID, and immutable intake fields. For new concurrent runs, `:113-129` chooses/persists mapping and passes it to engine; deterministic IDs at `:171-172` are derived from project/run and project/context-or-run. `:149-168` routes resume by stored mapping and rejects missing concurrent objective.
- [Read] `src/concurrent-delivery-engine.js:1102-1151` requires that mapping, validates goal and acceptance contract, derives requirement/check/environment identities and owner checkpoint ID, persists run contract and checkpoint list, creates the scoped objective, candidate, and owner checkpoint. `:164-195` shows durable run and planner ledger tables. Run rows include project/run/objective/session, goal, contract/digests, check identity, checkpoint IDs, lead thread/home/settings, status and result; objective is stored separately by `BacklogStore`.

## Durable lineage and restart

- [Read] `src/concurrent-delivery-engine.js:1949-1966` reloads run identity and digests from SQLite by run or objective. `recoverStoredRuns()` is called by server composition; router mappings remain the external run-to-objective/session index.
- [Read] Objective tasks/attempt lineage is scoped by `(projectId, objectiveId)` throughout the engine and lifecycle (`src/delivery-lifecycle.js:156-185`); recovery cross-checks claims, persisted attempts, executor intent and planner facts before resuming. Checkpoint inventory/history is backed by review store (`src/concurrent-delivery-engine.js:1620-1631`). Attempt IDs and fencing/recovery generations are threaded through recovery paths (`:760-813,860-872`).
- [Read] Provider identity is pinned at engine construction and compared against fresh identity (`src/concurrent-delivery-engine.js:110-113,1979-1986`). Lead provider/account and codex home are persisted with run/thread state; provider-change resume path is `:889-900,946-950`. Existing behavior is restricted by same pinned provider identity on engine operations, and safe rebind relies on quiescence/effect checks.
- [Read] Objective ID is per run (`delivery-<hash(project,run)>`), while session is per context or run (`delivery-engine-router.js:171-172`). Therefore separate runs sharing a context receive distinct objectives but share session identity. Whether owner intent means one objective across multiple run IDs is not established by current code; AD-01 must resolve that from the stated requirement, not assume existing mapping is sufficient.

## Tests and gaps

- [Read] Relevant coverage includes `test/delivery-engine-router.test.js` (mapping/routing), `test/server-delivery-engine.test.js` tests at `:807` and `:1516` (restart with persisted concurrent mappings and fencing), `test/concurrent-delivery-engine.test.js` (engine persistence/recovery; e.g. reopen at `:780,901,1942`), `test/owner-decision-restart.test.js`, and `test/delivery-migration-qualification.test.js`.
- [Read] Backlog explicitly records the gap: `docs/autonomous-delivery-backlog.md:57-75,89-104` says concurrent has project/objective/task scope and deterministic acceptance components but needs runtime identity migration and restart lineage qualification. Current mapping binds run to objective, but does not evidence migration/continuation of the *same owner objective* across a newly submitted run ID. Checkpoint creation and attempt recovery exist as isolated persisted machinery; integrated acceptance obligations, provider-account change, and no-duplication under the required restart scenario are not proven by these source checks.
- [Hypothesis] Bounded independent AD-01 slice: `src/delivery-engine-router.js`, `src/concurrent-delivery-engine.js`, and narrowly scoped tests in `test/delivery-engine-router.test.js` / `test/server-delivery-engine.test.js`. Establish/persist owner objective identity at intake, retain the binding through restart, and prove the original contract/checkpoint/attempt lineage survives continuation and provider identity change without duplicate scope/effects. Keep provider failover/wait semantics out of this slice (AD-02/03); assert the current fence behavior until safe rebinding is implemented.
- [Read] Useful focused command after implementation: `node --test test/delivery-engine-router.test.js test/server-delivery-engine.test.js test/concurrent-delivery-engine.test.js test/owner-decision-restart.test.js`. No test execution was needed for this map.

Status: complete
Scope expansion: none
