# Concurrent Harness: lifecycle and visibility continuation

Updated 2026-10-27. Current owner root. Previous accepted handoff:
concurrent-continuation-20261026/handoff.md. Continuation workspace:
lifecycle-continuation-20261027/. Native quota 07:58:32Z 99% five-hour,54% weekly.

## Objective and acceptance

Autonomous available lead, durable backlog, parallel same-role team and dynamic
pipeline. Single project first, preserve independent projects. Capacities4/2/2/2
plus lead1, configurable. No per-role accounts/Claude/global broker. Local source
CN-01..CN-10 qualified; new engine not wired into startup. Remaining CN-11..15.

CN-11 must qualify durable pause/stop/cancel, bounded retries/budget wake and
trusted recovery. CN-13 must qualify truthful read-only backlog/team visibility
with old-schema and stale-selection compatibility. Require independent critic
and focused failure probes before accepting risky changes.

## Ownership

- Root: Git, tracked docs, scope/integration/acceptance; source-start.json captures
  72 dirty predecessor inputs, preserve all. No staging/commit/restart/live trial.
- CN11 worker: new delivery-lifecycle.js/test, controller source/test and narrow
  typed backlog-store.js/test transitions. Brief: lifecycle-continuation-20261027/brief-cn11.md.
- CN12 worker: new delivery-acceptance.js/test, read-only candidate-review
  finalization projection and SOLE backlog-store.js/test ownership after CN11 freeze. Brief: lifecycle-continuation-20261027/brief-cn12.md.
- CN13 worker: new delivery-visibility.js/test, launcher-app.js read routes, new
  backlog UI and narrow main UI hooks/dedicated tests. Performance source excluded.
  Brief: lifecycle-continuation-20261027/brief-cn13.md.

CN-12 depends on11, CN-14 on12+13, CN-15 on14. Root prepares successor contracts
while workers execute. Last frozen affected152/152; full suite has9 recorded
failures (8 legacy,1 isolated startup rerun passes). Do not claim full green.

CN13 accepted after semantic and browser corrections: independent critic APPROVE,
focused49/49, actual Chrome desktop1440/mobile390,0JS errors/no viewport overflow.
Reports: cn13-visibility-20261027/ and cn13-review-20261027/. API/schema read-only.
Configured capacity remains distinct from unknown live scheduler admission.
CN14 read-only composition map: cn14-map-20261027/handoff.md.

CN11 store32/32 frozen copy: lifecycle-continuation-20261027/cn11-store-freeze/.
CN11 temporarily regained SOLE backlog-store.js/test ownership for scoped retry
correction after CN12 confirmed it made no store edits. Refreeze/regrant required
before CN12 writes finalization methods. CN12 runner/read API prep
20/20; scoped critic active, full finalization state machine in progress.

Runner review found an actual Git isolation defect; candidate mirror now uses
trusted external config/hooks, sanitized per-call Git env (optional acceptance/
snapshot API) and explicit admission release proof. Worker tests36/36+68/68.
Adversarial re-review turn was stopped by an automatic content filter. A distinct
read-only defensive critic (cn12-safe-review-20261027) is active; do not repeat
the blocked probe. No CN12 gate acceptance yet.

CN11 final gate ACCEPTED: critic APPROVE after shutdown-generation fix,
98/98 focused, challenger HOLDS3SQLite probes+7focused tests.
CN13 narrow readable task objective summary followup50/50, lead inspected.
Only CN12 remains active; CN14/CN15 not started. Quota08:45:32Z21%primary/42%weekly.
