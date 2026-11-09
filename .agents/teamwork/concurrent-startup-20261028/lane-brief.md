# Native workspace-write lane compatibility

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Read ../PROJECT.md,
brief.md, review.md and /home/sr/codex-home/agents/junior_worker.toml instructions.
English ASCII. User cannot start concurrent under active native legacy
workspace-write/on-request. Source selects shared then rejects concurrent.

Own only src/writer-lanes.js, src/codex-app-server.js, optional new
src/lane-execution-policy.js, and paired test/writer-lanes.test.js,
test/codex-app-server.test.js, test/server-delivery-engine.test.js. Root/other
worker owns launcher diagnostics and preflight/lead guidance; do not edit those.
No Git writes, native/project settings/account mutations, provider/model calls,
existing processes/services/DB changes, installs or broad test suites. Disposable
offline fixtures and fake providers allowed. Preserve inherited dirty source.

Implement smallest supported inherited LEGACY workspace-write cooperative lane
mode. Keep read-only/unknown/custom modern profiles unsupported; existing strict
and native full-access behavior unchanged. Do not pass generic untrusted sandbox
objects through as authority. A host-owned lane mapping/capability must be minted
only for an actual admitted lane with original workspace, canonical lane cwd and
current binding, and consumed/validated before provider request. Trust and native
policy resolve against original permissionWorkspace; writable project root maps
to this authorized private lane. Preserve configured native additional writable
roots, temp exclusions, network flags and approval policy/reviewer exactly. Do
not silently promote to full access, alter managed profiles, or claim confinement
for cooperative mode. This is an explicit supported project lane mapping, not a
claim that outside-root relocation is a mathematical subset of native roots.

Current cooperative LaneManager.sandboxPolicy returns null; actual strict lane
policy loses native extra roots/temp flags. Neither is an acceptable unchanged
reuse. Inspect real prepareThread/run and transport wrappers; apply mapping to
both fresh and resumed turns where relevant. Revalidate at actual send boundary;
wrong source/cwd, stale capability or unsupported native policy must fail closed.
No worker JSON may grant this authority. Keep effect/publication fences intact.

Meaningful tests: startup with real disposable Git repo + fake inherited legacy
workspace-write returns supported cooperative mode; outgoing fresh/resumed policy
writes admitted lane, preserves native extras/temp/network and approvals; wrong
lane/source or changed current policy denies. Existing full-access/strict and
unsupported custom/read-only remain qualified. Replace the earlier named
workspace-write rejection fixture with the supported behavior and retain negative
unsupported shared-selection test using explicit read-only/shared policy.

If this exceeds a bounded Luna implementation or decisions are missing, report
concrete complexity early rather than weakening the contract. Coordinate critic
startup_permissions_critic directly; freeze source/tests before review and save
lane-handoff.md + focused logs here. Focused env -u NODE_TEST_CONTEXT node --test.
Never execute prohibited test named candidate attributes and inherited Git
configuration cannot execute filters while mirroring. Every acceptance/full
command must include --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'.


## Approved review amendment

Retain existing documented native legacy writable-verifier IPC exception when
using the host-owned lane mapping: canonical verifier's effective networkAccess
remains true exactly as before this change. Ordinary writers retain configured
native networkAccess exactly; scoped concurrent verifier unchanged. Preserve
original native policy in capability binding so config changes still invalidate,
and compare the consistently derived role-effective policy at prepare/resume/send.
This exception is pre-existing behavior, not a new full-access promotion or a
generic override. Add actual lane-verifier outgoing-wire regression and actual
config/read resolver refresh/change denial regression.
