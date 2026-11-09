# CN-14 integration preparation

Status: plan only, not dispatched. Source map:
../cn14-map-20261027/handoff.md. Root must recheck final CN11/12/13 APIs
before assigning file ownership. No runtime activation inferred.

## Composition decisions

- Preserve missing-setting legacy default and every stored legacy run. Strictly
  validate new deliveryEngine setting; select engine for new objective intake
  only. Persist engine identity per run. Existing project servers remain independent.
- Reuse state/workspace locks from startServer, one publisher for one workspace.
  An engine switch is stop admission, drain/reconcile, explicit safe outcome, then
  new intake. Unknown effects forbid silently releasing fences or dropping work.
- Use actual configured roles/settings and physical provider thread identities.
  Fast/effort/model/account pins survive every adapter; no fallback.
- Compose real store/executor/controller/lifecycle/candidates/reviews/acceptance
  behind a narrow engine facade compatible with makeLeadExecutor events/control.
  A fixture-only engine factory does not satisfy production composition.
- Preserve actual A2A context/task/attempt mappings and usage provenance, durable
  initial goal/check contract before any call, durable received/applied steering.
- Connect scheduler/lifecycle projections to CN13 effective admission visibility.
  Keep old schemas and endpoint shapes additive.

## Potential disjoint implementation areas

A. New concurrent engine facade/adapters, src/server.js composition/intake/control,
   project-settings.js selection and dedicated integration tests.
B. Capability-aware specialist request/validation/execution, contracts.js,
   a2a-role-service.js, codex-app-server.js, narrow TaskExecutor compatibility and
   configured verifier fake-AppServer integration tests.
C. Owner engine setting UX/API only if needed; no silent setting updates and no
   change while project is active. Coordinate launcher ownership after CN13 freeze.

These are proposed packages, not simultaneous ownership grants. Establish exact
capability wire contract between A/B before either edits shared source.

## Required concrete integration evidence

1. New concurrent objective executes independent same-role tasks through actual
   configured A2A/fake AppServer endpoint with overlap barriers. A fast sibling
   unlocks its dependent while slower sibling remains active.
2. Lead steering durably acknowledged while workers run; valid plan delta applies
   and feeds next work without waiting for a round. No overlapping physical lead
   thread. Real provider thread binding created/pinned before planning admission.
3. Configured workspace-write verifier has productWritePaths=[] and a frozen
   candidate, writable scratch only. Exercise actual request validator, sandbox
   roots/permission profile, model call, report parsing, process/effect evidence,
   exact candidate-bound receipt. Do not fake away checkSpecialistRequest.
4. Unknown lease/process/send outcome and shared transport failure preserve fences
   across close/reopen. Trusted recovery restores exact work without duplicate send.
5. Real CN12 final barrier/check adapter records exact accepted candidate after
   required receipts. Owner pause/cancel/goal correction defeats stale final output.
6. Legacy stored run resumes with legacy engine even when new intake defaults
   concurrent. Different projects/settings/DBs remain isolated. Same workspace
   lock rejects double publisher. Additive migration/downgrade behavior verified.
7. Server shutdown stops admission, handles provider closure, reconciles lifecycle
   facts and cannot claim safe switch while effects remain unknown. Tests own all
   disposable servers; no restart of the user's running services.

Full affected and compatibility suites plus independent integration critic and
probes precede source gate acceptance. A small real model trial remains separate
owner authorization after a concrete source-qualified result exists.

## Additional identity evidence

Launcher project IDs are sha1(real workspace path).slice(0,10) in
src/launcher-projects.js:64-65. Child env currently carries workspace/state/settings
paths but no explicit project ID at lines457-465. CN14 must supply or derive the
SAME stable identity for BacklogStore and read projections; otherwise CN13's
project-qualified endpoint would never find actual objectives. Preserve realpath
normalization and project isolation; do not infer a project ID from arbitrary
untrusted request metadata.

## Verified local permission protocol constraint

Root generated the INSTALLED Codex experimental JSON schema offline with:
`codex app-server generate-json-schema --experimental --out <ignored scratch>`.
Evidence is under codex-schema/v2/ThreadStartParams.json and TurnStartParams.json
in this continuation directory; regeneration uses no model/provider call.
`turn/start.permissions` is a named profile ID and explicitly cannot be combined
with sandboxPolicy. Current CodexAppServer.run ignores sandboxPolicy overrides
when inherit resolves a modern named permission profile, and also reconstructs
native legacy policies from the broad permissionWorkspace. Thus merely passing
scratch-only sandboxPolicy from a new role adapter will NOT enforce that scope.

CN14 must verify explicit per-attempt capability handling through this branch,
with inherited approval policy preserved and FS capabilities bounded. The local
schema still exposes explicit sandbox/sandboxPolicy parameters without a named
permissions field. A possible implementation is a dedicated trusted capability
path selecting those explicit parameters for a narrowed review; this is a design
candidate, NOT qualified behavior. Do not combine incompatible profile/policy
fields, silently force owner settings, mutate user profile configuration, or
claim confinement from chmod. Validate real generated protocol requests and
fail closed for unsupported runtime behavior before any live trial.

Additional UI followup found by lead: valid delivery/v1 task contracts carry
`objective`, never `title`. Visibility currently uses task.title || task.taskId,
so real task labels fall back to IDs. A narrow CN14/CN13 followup should show a
bounded human-readable objective summary while retaining the stable ID in details.
