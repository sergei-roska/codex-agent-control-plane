# AD-05 legacy budget-cancel composition

## Objective

Add a deterministic integration regression proving an explicit cancel wins if
the legacy budget watcher is blocked inside an account switch.

## Scope

- Own `test/server.test.js` and this task handoff only.
- Use fake App Servers, profiles, and a deferred `switchTo`; never use live
  providers or credentials.
- Assert the task is initially INPUT_REQUIRED on `waiting_for_budget`, wait
  until the watcher enters the deferred switch, cancel through the lead A2A
  handler, release the switch, and prove the task remains CANCELED with no
  orchestrator resume call.
- Do not edit production code. If the regression exposes a production defect,
  stop and report the exact evidence for lead ownership.
- Do not stage or commit. Preserve inherited `:memory:.lockdb`.

## Verification

Run the new named server test and the relevant budget-watcher test file. Record
exact commands and results in the handoff.
