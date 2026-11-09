# AD-03 project-wide provider admission gate primitive

## Goal

Extend the shared `createSwitchingAppServer` wrapper with an exclusive transition gate. This primitive closes provider-call admission, drains existing tracked work, and allows only a gate token holder to switch accounts. Engine/server wiring is out of scope.

## Verified context

- Approved architecture: `.agents/teamwork/AD-03-account-wait-20261106/rebind-architecture.md`.
- Source map: `.agents/teamwork/AD-03-account-wait-20261106/implementation-map/handoff.md`; current wrapper tracks provider run/prepare/exec/config calls but does not close new-call admission during a multi-step account transition. `switchTo` currently refuses when `inFlight > 0` but can mutate selection before asynchronous settle.
- Existing AD-02 selection CAS and wrapper tests in `src/app-server-switch.js` and `test/app-server-switch.test.js` are accepted and must remain intact.
- Cwd `/home/sr/Projects/Workspace/codex-agent-control-plane`; HEAD `435afa3` plus active AD-04 fix. Leave `:memory:.lockdb` untouched and do not change Git state.

## Ownership

Own only `src/app-server-switch.js`, `test/app-server-switch.test.js`, and this task directory. Coordinate by preserving every existing AD-02 selection revision/rollback behavior. Do not edit other files, engine/server wiring, or live provider state.

## API and behavior

Add an exclusive `acquireTransitionGate(transitionId)` returning an opaque token. It must close admission synchronously before its first await, reject a competing gate, then resolve only after all already-admitted wrapper provider calls drain. Ordinary tracked provider calls made while the gate is closed must reject with stable error code `provider_transition_in_progress`; no target invocation may occur.

`switchTo(name, expectedSelection, transitionToken)` keeps existing call compatibility and selection CAS. While the gate is closed, only the exact live token may authorize the switch. Without the token it returns `busy` and leaves profile selection unchanged. Add `releaseTransitionGate(token)`; only the live token can reopen admission. After release, calls are admitted normally. Stale tokens cannot switch or release.

Apply the gate consistently to tracked provider calls and pass-through provider reads (`getAccount`, `readRateLimits`, `getVersion`, etc.), tracking their in-flight duration. `close()` must close admission and wait for in-flight work/gate settling safely. Do not let transition state be confused with user selection revision.

## Acceptance

1. A held admitted call drains before gate acquisition resolves; calls arriving after closure reject and do not invoke the provider.
2. Unauthorized account switch while gated returns `busy` without changing the active profile; token-authorized switch succeeds and preserves CAS.
3. Wrong/stale tokens cannot switch or release; exact release permits subsequent calls.
4. Pass-through provider reads are also refused/tracked while gated.
5. Existing app-server-switch tests remain valid.
6. Run `node --test test/app-server-switch.test.js` and `git diff --check`.

Write exact command/results in `handoff.md`. This primitive is not AD-03 complete until durable journal, engine rebind, server recovery, and composition tests use it.
