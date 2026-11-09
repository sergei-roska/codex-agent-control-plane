# CN-12: exact final acceptance and honest completion

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane, Node CommonJS/node:test.
Read /home/sr/codex-home/agents/worker.toml developer_instructions and
development-access.md. English/ASCII. Root owns Git/docs. Preserve dirty source.

Objective: implement CN-12 from implementation-plan.md and completion contract in
target-design.md. CN09/10 source gates are accepted. CN11 lifecycle is currently
being implemented; its acceptance is a predecessor to final CN12 qualification,
not to independent adapter/fixture preparation. CN13 owns launcher/UI.

Initial exclusive ownership: NEW src/delivery-acceptance.js, NEW
test/delivery-acceptance.test.js. Existing acceptance.js, partial-ledger.js,
candidate-store.js/review.js are read-only dependencies until a narrow grant.
CN11 owns backlog-store.js/test, task-executor.js/test, controller and lifecycle.
Do not edit these concurrently. Design required typed finalization store methods
and send root the proposed contract; root will grant sole store ownership after
CN11 freezes its edits. Do not implement a generic SQL/update bypass. No additional
agents. No Git writes, dependencies, shared services, live model/account/target
actions. Owned disposable repos/SQLite/process/fake AppServer fixtures allowed.

Read bounded relevant sections of foundation-api.md, candidate-store.js,
candidate-review.js, acceptance.js (runAcceptance/verifyCandidate/pins),
partial-ledger.js, BacklogStore and lifecycle handoff if present.

Acceptance behavior:
- A durable project/objective scoped finalization/barrier pins fixed ownerGeneration,
  exact goal/plan/control/authority/check/requirement identity and candidate ID,
  manifest/environment/check identity. Never accept a model's goalAchieved flag
  or trusted:true payload as controller authorization. Default deny trusted callbacks.
- Stop new relevant publication, drain/reconcile actual claims and candidate
  publication intents, then freeze exact known candidate. A running/unknown process
  cannot disappear because its lease expired or a DB row is absent. Preserve unrelated
  private-lane work where safe; never publish into the frozen acceptance candidate.
- Use real exported runAcceptance for owner-required checks; retain selected
  executionPermissions, scratch opt-in, check source and pinned check integrity.
  Check the actual materialized candidate before/after checks, actual required
  candidate-bound registry receipts and full closure/pins. Known candidate or
  isFinalStabilized alone is not proof of all owner criteria.
- Final receipt/evidence, candidate retention ref, objective terminal disposition
  and event commit atomically under unchanged pins. Exact authorized replay retains
  first timestamp/record; conflict never mutates a prior accepted record. Check
  owner pause/cancel/correction/takeover and newer candidate before committing.
- No accepted/goalAchieved with ready/queued/draft/active/settling/delayed authorized
  work, pending planning/steering/retry/wakeup or unresolved publish/process effects.
  Define precisely how internal final-review tasks already settled are included.
- Later publication/new candidate cannot inherit prior final acceptance. Historical
  acceptance remains attached to immutable candidate. Reads must distinguish
  historical evidence from current final qualification.
- Terminal partial requires complete investigated ledger: no executable authorized
  progress, retry/wakeup/recovery; every remainder outside authority/capability or
  explicitly owner deferred. Validate provenance through trusted injected facts.
  Internal retry exhaustion is resumable blocked_technical, never terminal partial.
  Failed/unreviewed integrated checkpoints cannot appear accepted in partial ledger.
- Crash/reopen with checking/unknown status cannot fabricate a passed check or
  blindly rerun a possibly live check. Trusted lifecycle reconciliation is required
  before safe retry; pending barrier remains conservative and visible.

Testing: actual store/candidate/review modules, disposable Git/SQLite reopen and
real runAcceptance with fake AppServer or bounded local owner check. Cover exact
pass, stale pins/control/takeover/candidate, claim/publication/check-in-flight
barrier races, check failure/tampering, unknown effects, retry/wakeup blockers,
partial deferral vs internal failure, post-acceptance publication invalidation,
transaction rollback/reference retention and replay/conflict. Preserve accepted
predecessor suites. Final source gate requires independent risk review + probes.

Maintain .agents/teamwork/cn12-acceptance-20261027/brief.md and handoff.md. Report
concrete proposed store/finalization API early. No startup/legacy routing work
(CN14), no claim of active runtime from a local source gate.
