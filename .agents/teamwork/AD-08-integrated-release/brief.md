# AD-08 primary deterministic release scenario

## Objective

Add the primary concurrent-v1 release qualification test from the AD-08
backlog: typed A exhaustion, automatic A-to-B rebind, typed B exhaustion,
durable wait, real server close/reopen, restored availability, same-objective
continuation, mandatory current-candidate check, and accepted final state.

## Scope

- Own a new `test/autonomous-delivery-release.test.js` and this task handoff.
- Use a disposable Git workspace, temporary A/B `auth.json` fixtures, the real
  `startServer` composition, and fake App Servers/limit reads only.
- Drive usage-limit failures through trusted `codexErrorInfo` and terminal
  execution evidence, not direct wait/journal insertion.
- Use stable run/objective/session/check IDs. Assert A/B attempt and hashed
  account lineage, unchanged objective/check identity, no duplicate effect,
  durable wait through server reopen, no owner continuation, mandatory check,
  and final `accepted` status.
- Do not edit production source. If a defect or missing product behavior blocks
  the scenario, return a concise evidence package for lead ownership.
- No live providers, real credentials, quota use, runtime activation, staging,
  or commits. Preserve inherited `:memory:.lockdb`.

## Verification

Run only the new named release test plus syntax and diff checks. Record exact
results and any excluded scenario in the handoff.
