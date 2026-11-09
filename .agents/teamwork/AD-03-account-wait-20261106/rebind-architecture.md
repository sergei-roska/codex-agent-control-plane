# AD-03 provider rebind architecture consultation

Status: Sol consultant APPROVE; implementation not started.

## Recommendation

Keep `ConcurrentDeliveryEngine.#providerIdentity()` strict outside an explicit,
journaled account transition. A safe transition needs a project-wide admission
barrier, because the switching App Server is project-global and other objectives
could still dispatch on the old account.

Defer switching while any sibling objective can dispatch, a provider call is
active, or any claim, planner, publication, or process effect is unresolved.
Dormant sibling runs remain unchanged and must independently rebind when they
later resume. Existing `deliveryEngineFence` skips same-engine siblings and is
not sufficient as this barrier.

Persist transition intent before switching. After switching, prepare a fresh
provider thread, recheck the wait and owner/control pins after every await, then
atomically record provider lineage, bind the new thread, and wake the wait.
Startup must recover a transition interrupted between those phases without
dispatching work.

## Files and tests

- `src/app-server-switch.js`: exclusive switch operation that refuses busy
  before changing profile state; gate every provider caller and profile swap.
- `src/concurrent-delivery-engine.js`: separate budget-resume eligibility with
  exact wait/control/owner pins and existing effect proofs.
- `src/delivery-provider-identity.js`: update fixed-home identity only through
  the authorized transition.
- `src/server.js`: explicit auth/model availability and startup recovery of
  transition/wait records before any dispatch.
- Deterministic tests: active sibling defers switching; unknown effects block;
  pause/cancel during thread preparation wins; crash after switch recovers;
  repeated A/B exhaustion preserves objective/check identities.

## Evidence and pitfall

`createProviderIdentityPin()` captures a fixed home in its getter. The current
`switchTo()` writes the active profile before checking `inFlight`, so a dynamic
identity getter or a one-time in-flight check is unsafe. Source review covered
`app-server-switch.js`, `delivery-provider-identity.js`,
`concurrent-delivery-engine.js`, and `server.js` on 2026-11-06.
