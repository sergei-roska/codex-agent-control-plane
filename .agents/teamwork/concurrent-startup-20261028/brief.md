# Concurrent startup failure and silent diagnostics

Project cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Read current
PROJECT and final integration handoff as accepted baseline, not authority for
service changes. Read /home/sr/codex-home/agents/junior_worker.toml instructions.
English ASCII. User says stopping agent-harness, selecting Concurrent delivery
and starting makes server silently fail; reverting legacy works. Current live
project3d9c2e759c on3002 is running legacy, PID564657 at inspection. Never touch
that process, live project settings/accounts, native Codex config or databases.
No live providers/model calls, installs, Git writes or dependency changes.

Verified read-only evidence: selected account home config sandbox_mode=workspace-write,
approval_policy=on-request; project settings only deliveryEngine legacy. Workspace
is Git root with valid HEAD. Server selectWriterIsolation returns shared reason
native_permissions_use_shared_workspace for inherited non-full sandbox, then
concurrent startup rejects unsupported isolation (server1094). Last startup JSON
only retains successful legacy start, overwriting the earlier failure. User saw
no error. Need reproduce exact reject with disposable fixture, do not infer all
causes from a hypothesis.

Own implementation in src/launcher-projects.js, src/launcher-app.js,
launcher-ui/app.js and their paired tests; test/server-delivery-engine.test.js
may add decisive offline rejection evidence but do not edit server/writer-lanes
or permission source yet. First inspect startup diagnostic propagation and UI
start response/polling. Fix silent failure: persistent sanitized actionable error
must appear for failed start, survive polling and subsequent page load, without
stale errors on a later successful attempt. No raw secrets. Keep existing safe
startup lifecycle, token handling and permission/isolation guards intact.
If actual startup compatibility needs source beyond scope, send a bounded
recommendation; lead decides. Do not auto-switch engine/permissions or retry
with weaker policy. No provider API or new key needed; use existing offline
fixtures/fake transport only. Dependencies present, Node test toolchain.

Focused commands env -u NODE_TEST_CONTEXT node --test. NEVER execute test named
candidate attributes and inherited Git configuration cannot execute filters while mirroring.
All full/acceptance commands must include exact exclusion
--test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'.
No broad/full suites without root assignment. Preserve inherited dirty/untracked
work and offline accepted baseline; add meaningful regression for observed defect.
Record brief/handoff and logs in this directory; source/tests freeze before
independent review. Report exact commands/counts and any unmet startup criterion.
