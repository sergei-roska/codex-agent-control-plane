# AD-03 usage-limit path trace

- `CodexAppServer.classifyFailure()` uses `classifyCodexError()` in `src/codex-app-server.js:157-164`; `src/contracts.js:1090-1111` recognizes typed `codexErrorInfo` / `rpcData.codexErrorInfo` usage-limit evidence, including nested HTTP 429. Plain text and a bare `statusCode: 429` do not qualify.
- `DeliveryRoleService` records the provider failure in `src/delivery-role-service.js:747-766`; `resultAdapter()` at `:826-844` validates terminal/effects-settled proof and currently turns every non-success into a generic failed attempt.
- `TaskExecutor.acceptTerminal()` invokes the trusted adapter and settles the attempt at `src/task-executor.js:291-325`; `TaskScheduler` wakes after settlement and `ProjectDeliveryController` wakes/plans at `src/task-scheduler.js:213-217` and `src/project-delivery-controller.js:350-356`.
- No current concurrent production call records `waiting_budget` after a provider usage-limit failure. `DeliveryLifecycle.recordBudgetWait()` and `BacklogStore.recordBudgetWait()` already persist blocker arrays and owner/control pins.
- Planner calls use a different path: `ConcurrentDeliveryEngine.#runLeadTurn()` rejects into `LeadPlanner.providerFailureEvidence()`, which currently omits raw `codexErrorInfo`; `ProjectDeliveryController.#runCycle()` handles the failure at `:256-267`. Do not conflate it with the worker-service slice.
- Required model is available from worker attempt settings/task role; the broader objective model set is the configured role union, matching the existing legacy watcher. Limit snapshots come from the server's per-home App Server readers.

Research only; no files changed.
