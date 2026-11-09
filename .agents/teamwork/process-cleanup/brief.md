# Task-scoped background process cleanup

User requests preventing accumulation of scripts surviving completed roles.
Also preserve completed QA (Quality Assistance) display rename and the untracked
runtime audit report. Lead owns coordination, docs, Git and bounded live cleanup.
No service restart, deployment, target source edits or paid model calls.

Verified root cause: CodexAppServer shares one child across roles, enables no
experimentalApi capability and only cleans the child group on process failure
or shutdown. A completed thread can retain tool background terminals.
Installed schema and official docs support thread/backgroundTerminals/clean,
list and terminate, scoped to threadId. Source trace: trace.md.

Acceptance:
- Enable native per-thread cleanup, never kill a shared App Server to clean a
  successful role and never scan/kill by command name or cwd alone.
- Complete cleanup before exposing a task result/integrating a lane/releasing
  writer ownership. Preserve model terminal outcome as distinct from cleanup
  state; do not accept unknown live writers after cleanup failure.
- Cover success, terminal failure/interruption, same-thread continuation,
  concurrent distinct threads and failed/unsupported cleanup RPCs.
- Persistent cleanup failure quarantines new turns on that generation, including
  read-only and Lead work; existing concurrent work can finish. Late failure
  from an old generation cannot quarantine its replacement.
- Cleanup has bounded independent timeout, works after aborted caller signal,
  targets only original generation/thread, and cannot affect another generation.
- Tests use fake RPC and disposable child processes only. No live inference.
- Independent critic and concrete challenger probes before completion.
- Explain loaded-runtime boundary; no automatic service restart authorized.

Implementation worker owns src/codex-app-server.js and focused tests under
test/codex-app-server.test.js (additional isolated test files if needed).
Lead handles documentation and exact old R129 orphan PID identity independently.
