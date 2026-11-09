# AD-03 concurrent wait and safe provider rebind

## Goal

Wire the typed worker usage-limit signal into the concurrent controller, persist all explicit account/model/window blockers, and safely rebind the same objective to an available account through the durable transition journal and provider admission gate. Keep reset hints as scheduling only. This is the engine/controller slice; `src/server.js` startup/profile adapter wiring remains lead-owned.

## Verified context

Read these before editing:
- `.agents/teamwork/AD-03-account-wait-20261106/rebind-architecture.md` (Sol approved design)
- `.agents/teamwork/AD-03-account-wait-20261106/implementation-map/handoff.md`
- `.agents/teamwork/AD-03-account-wait-20261106/usage-limit-evidence/handoff.md`
- `.agents/teamwork/AD-03-account-wait-20261106/blocker-extraction/handoff.md`
- `.agents/teamwork/AD-03-account-wait-20261106/transition-journal/handoff.md`
- `.agents/teamwork/AD-03-account-wait-20261106/admission-barrier/handoff.md`
- `.agents/teamwork/AD-03-account-wait-20261106/wait-reschedule/handoff.md`

Existing primitives:
- `ProviderTransitionStore` in `src/provider-transition-store.js`: `create(record)`, `get(projectId)`, `advance(projectId, expectedRecord, nextPhase)`, `clear(projectId, pins)`.
- Switching wrapper in `src/app-server-switch.js`: `acquireTransitionGate(id)`, `switchTo(name, selection, token)`, `releaseTransitionGate(token)`.
- `DeliveryLifecycle.recordBudgetWait()` / `rescheduleBudgetWait()` and `BacklogStore` persist explicit blockers with owner/control pins.
- `extractBudgetBlockers()` and `isBudgetAvailable()` are exported from `src/budget-watcher.js`.
- `DeliveryRoleService.resultAdapter()` now emits trusted `failureKind: usage_limit` only for `classifyCodexError`-verified provider failures. Do not infer this from generic failed attempts.

## Ownership

Own only `src/concurrent-delivery-engine.js`, `src/project-delivery-controller.js`, `src/lead-planner.js` if strictly needed for typed planner evidence, their directly relevant tests (`test/concurrent-delivery-engine.test.js`, `test/project-delivery-controller.test.js`, `test/lead-planner.test.js`), and this task directory. Do not edit server/profile composition, app-server-switch, backlog-store, lifecycle, transition store, budget watcher, or delivery-role-service. Preserve active AD-04 changes and leave `:memory:.lockdb` untouched. No Git state changes or live providers.

## Engine dependency contract

Add an optional `budgetAccounts` constructor dependency; when absent, existing behavior stays unchanged. Expected shape:

```js
{
  profiles,                    // createAccountProfiles-like: read(), activeHome(), codexDefaultHome
  readProfileState(home),      // async -> { requiresOpenaiAuth?: boolean, limits: providerSnapshot|null }
  providerIdentityFor(home),   // synchronous -> { accountId: lowercase sha256, codexHome }
}
```

`ConcurrentDeliveryEngine.appServer` is the switching wrapper and supplies the gate/switch methods. `server.js` wiring will be performed later by the lead. The engine may create/use `ProviderTransitionStore` from its existing shared db.

While the gate is closed, the engine must prepare the target lead thread only through the narrowly authorized `appServer.prepareThreadForTransition(token, options)` method. The switching-wrapper implementation and real-wrapper composition test are lead-owned follow-up work; do not call ordinary `prepareThread()` while gated.

## Required behavior

1. On a durably settled worker attempt whose result is exactly `failureKind === 'usage_limit'`, stop new claims for that objective and record one `waiting_budget` wait using its existing lifecycle/store APIs. Record blocker rows from every configured account plus the system account using `extractBudgetBlockers`; hash identities only. Use the configured-role model union plus lead model. Null/ambiguous account reads are unknown, not available and not blockers. Do not let a reset timestamp or percentage alone create a blocker or wake.
2. A timer/recovery entry point must process due waits without owner input and be callable by server startup. Read each candidate's authoritative `limits`, require `requiresOpenaiAuth === false` when present, and use `isBudgetAvailable` for the required model set. Respect `profiles.read().autoSwitch`: the active account may resume when explicitly available; do not select a different account when automatic switching is disabled.
3. If no suitable account is available, refresh blockers and durably reschedule the same pending wait through `rescheduleBudgetWait`, using bounded polling/backoff even when reset hints are absent/stale. A positive availability result, never a timestamp, is required to resume.
4. Before changing accounts, prove project-wide safety across every concurrent run: no sibling can dispatch, no unresolved claim/attempt/planner turn/publication/process effect, no pending owner decision/inbox, and no unknown state. Close the switching-wrapper admission gate and drain calls; recheck the wait, owner/control pins, account selection revision, and project-wide safety after every await. Persist transition intent before switching.
5. Switch with the exact selected account revision and live gate token; verify the active account hash; prepare a fresh lead provider thread; then recheck all pins. Commit provider lineage, run binding, budget wait wake, and transition-journal clear atomically in SQLite. Preserve objective/run/session/check identity and current owner/control fence. Update the engine's pinned provider identity only after the authorized transition is confirmed. Release the gate after commit. Dormant siblings remain unchanged and must rebind independently when they later resume.
6. Recovered journal phases must resume safely before dispatch: if the selected target is active, continue from that phase; otherwise fail closed. An interrupted/failed transition must never dispatch under an unbound identity. Owner pause/cancel during an await wins and must not wake the objective.
7. Add deterministic engine/controller tests using fake profiles, limits, switching wrapper, and SQLite. Cover A/B blocked windows, reset-hint-only non-wake, A available while B blocked, fresh thread and same objective/check identity, active sibling defers switch, owner pause/cancel during thread prep, and restart after profile switch before commit. No provider/network calls.

## Verification

Run focused affected tests and `git diff --check`; record exact commands/results in `handoff.md`. Do not claim the server integration or AD-03 complete until lead wires adapters/startup recovery and composes end-to-end host restart tests.
