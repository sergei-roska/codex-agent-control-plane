# CN14 server and startup composition

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Same worker role/policies
and no-live boundaries as brief-host-prep.md. Root owns Git/docs. Extend ownership
to src/server.js, src/launcher-projects.js and new dedicated
test/server-delivery-engine.test.js; narrowly extend router source/test ONLY for
legacy intake/bootstrap/exclusivity compatibility when necessary. No core, UI,
accepted lifecycle/review/executor or shared test edits without another grant.
Your host-control/identity helpers remain owned; root critic reviews those frozen
helpers now, notify before any helper source adjustment.

Consume current ConcurrentDeliveryEngine constructor and fixed facade. Required
providerIdentityFor is synchronous/fresh, initial providerIdentity is immutable;
use your metadata helper and actual settled provider home (switch wrapper current
home or accountProfiles.codexDefaultHome), injected fake identity factory in tests.
No credential printing or real account reads in fixtures. Keep direct injected
AppServer legacy fixtures working without requiring concurrent-only identity.

Select deliveryEngine from validated project settings for NEW runs only. Missing/
invalid remains legacy; stored mappings authoritative. Legacy A2A tasks/checkpoints
that predate router must stay legacy after default changes. Capture existing lead
task identities at startup before new SDK submissions, or another proven durable
classification; do not classify every submitted task as old (SDK persists a new
row before executor.run). No provider work just to pin a legacy mapping. Preserve
original intake/owner checks and placeholder backfill once.

Use one shared state DB, existing workspace/state lock and admission/lanes. Add
explicit normalized project ID to launcher child env or derive exact existing
SHA1(real workspace).slice(0,10) for direct starts. Validate before using; UI/control
identity must match. Keep storage outside source workspace with injectable temp
root for tests. Register concurrent role routes and your authenticated control
registrar, compose router facade into existing lead executor/recovery/budget paths.
No bypass of legacy A2A lifecycle/status/owner-check persistence.

Preserve selected owner executionPermissions and existing writer isolation labels.
Do not force strict permissions or forge worktree confinement to satisfy a core
constructor. Report any worktree/cooperative/shared mode incompatibility to root
with source evidence before widening a dependency.

Engine exclusivity: changing default never permits simultaneous legacy/concurrent
publication into one workspace, especially restart with unknown prior claims or
publish intents. Preserve and reconcile persisted work, reject typed busy/unsafe
new intake when needed rather than silently migrate/discard it. Independent
project servers/workspaces remain independent.

Shutdown: stop new admissions, drain entered controller/role/provider activity,
await exact safe outcome before DB close/workspace lock release. Unsafe timeout
or unknown effects cannot be called safe; preserve durable fences/recovery facts
across restart/downgrade. Add tests for failure/retry of close and lock ownership.

Use existing injectable startServer factories and add a narrow concurrent factory/
identity test seam if needed. Acceptance fixtures must ALSO exercise the default
real composition, actual router/core/service/fake AppServer path, not only fake
factory selection. Cover legacy unchanged, new concurrent intake, preexisting
legacy resume, changed default with stored concurrent mapping, actual HTTP auth/
steer during held worker, restart unknown effects, independent projects, workspace
lock and downgrade drain. Core worker is adding real two-engineer overlap coverage
and fixes in its owned files, consume stable APIs; coordinate source needs with root.

No live service/project restart, models/providers/accounts/targets/dependencies/
Git actions. Only owned temp Git/SQLite/local test servers. Never rerun blocked
hostile Git regression/probe. Maintain cn14-server-composition-20261027/brief.md
and handoff.md; checkpoint tested source and exact pending criteria. This work is
source integration only; do not apply real owner settings or activate production.
