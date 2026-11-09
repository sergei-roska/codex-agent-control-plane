# CN-08: dependency-aware continuous worker scheduling

Project /home/sr/Projects/Workspace/codex-agent-control-plane. Read worker TOML
developer_instructions/access policy under /home/sr/codex-work, project AGENTS.md,
CN-08/local gate in implementation-plan.md and target-design.md readiness/capacity.
Root owns Git/docs. Preserve dirty source. No real provider, target, shared DB,
service restart, account, network or Git mutation. Node24 and installed deps.
ASCII English artifacts. Create brief/handoff early under task-scheduler/.

Dispatch only after CN-05 local gate is accepted. Allowed files: new
src/task-scheduler.js, src/task-resource-policy.js, test/task-scheduler.test.js,
test/task-resource-policy.test.js, plus narrowly backward-compatible claim
eligibility extension in src/backlog-store.js and its focused test. Coordinate
exclusive ownership of the latter with root; no task-executor or candidate edits.
Read actual accepted backlog and task-executor APIs and their handoffs, not old
planning signatures. Legacy lead-graph stays untouched.

Implement TaskScheduler around injected store/executor, project/objective/current
controller identity, finite requested role subset, writer mode, and synchronous
admission policy. It fills eligible slots within persisted PROJECT/role ceilings
and reserved lead capacity. Actual claims/uncertainty are durable-store truth;
process-local promise maps are wakeups, never capacity accounting.

Critical store extension: claim eligibility/resource checks must run synchronously
inside the same immediate transaction that rechecks dependencies/controls and
claims task/capacity. A read-ready-then-claim sequence is not sufficient. Add an
optional strict-boolean canClaim predicate with stable task/current live claim
contract projection, or an equivalent narrow interface; default preserves current
behavior. Reject async predicate results. Avoid arbitrary state mutation or a
new publication/permission bypass. Tests must cover another connection changing
admission/resources between an outside projection and actual claim.

Pure resource policy uses productWritePaths, explicit readScope and resourceClaims,
not sandbox or role as a source-write proxy. Relative paths represent exact path
or subtree. Explicit shared resource identities are exclusive. Unknown read/
dependency scope remains conservative. In isolated writer mode, several writers
may overlap only with compatible declared writes/reads/dependencies. In shared
fallback, serialize product writers but admit compatible independent read-only
tasks. Keep broad critical review barriers until CN-10 supplies candidate-bound
proof; two independent auditors may overlap, but a live shared-tree review cannot
be treated as a frozen-candidate review. A model's baseCandidateId/readScope is
not trusted proof for relaxing that barrier. Allow a future injected synchronous
isFrozenReview predicate from CN-10; default is false. Scratch outputs are attempt-owned and
must be namespaced by the execution adapter; they are not product-write claims.
Return typed idle reasons (dependency, capacity, role, write/read/resource conflict,
pause/control/recovery/no-ready-work), rather than inventing tasks or model turns.

Start each claimed attempt independently; completion wakes scheduling immediately.
Do not await a Promise.all batch before allowing a fast sibling's dependent.
Accepted TaskExecutor.execute normally returns submitted, not terminal; handle
that by independent per-attempt polling/reconciliation through its actual API.
Do not free a slot or stop observing a task merely because send acknowledgement
returned. Known unknown/failed-transport attempts park for trusted recovery rather
than spinning or being re-sent. Fake executor barriers must also exercise the
submitted-then-terminal shape, not only final-result promises.
Preserve each error/unknown result and keep unrelated compatible work progressing.
No overlapping execution calls for the same attempt. Restart discovers durable
claims/events and delegates reconciliation to executor rather than sending a
fresh duplicate. A dropped in-memory wakeup is repaired from persisted state.
Bound nonprogress loops; an idle queue must not continuously reschedule itself.
Expose start/wake/runOnce/stop or equivalent bounded lifecycle plus projection.
Stopping scheduler admissions must not silently kill or release active attempts.

Local acceptance with fake barriers, actual SQLite store and injected executor:
four engineers with four distinct contexts can overlap when scopes allow;
two auditors overlap in shared writer mode; project/role/reserved limits never
exceed configured ceilings; A completion starts D while slow B remains blocked;
failed B retains A evidence and permits independent work; unknown/fenced writer
prevents conflicting replay; role subset and reduced limits affect only future
claims; paused/control-changed objectives admit none; independent projects run;
no-ready-work yields reason without repeated fake model calls. Validate shared
fallback and conservative unknown scope/critical review gates separately.

Run affected backlog/executor/resource/scheduler tests, syntax/format checks.
Report exact API, causal event trace and counts; independent concurrency critic
and targeted challenge follow. This does not qualify a live continuous lead,
candidate review promotion, migration or real provider throughput.
