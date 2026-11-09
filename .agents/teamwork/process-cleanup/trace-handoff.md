# Process cleanup trace handoff

Status: complete. Read-only trace; no source edits, tests, or live process actions.

Findings: see `trace.md`. Per-task runs share a persistent App Server child, so process-group termination at task completion is unsafe under concurrency and continuation. Source already provides an appropriate native integration seam: installed App Server schema supports experimental thread-scoped background terminal list/clean/terminate calls, while source currently does not negotiate `experimentalApi` or use these requests. R129 PID 124021 is confirmed by the saved observation as a pytest process still alive after role completion, but its App Server `processId` and spawning mechanism are not preserved.

Important next checks for implementation: confirm runtime method compatibility and terminal cleanup semantics against the installed App Server; preserve per-thread ownership through A2A terminal publication; do not conflate cleanup RPC failure with turn outcome or writer quiescence. Exact focused cases are in trace.md.

Evidence: `.agents/teamwork/runtime-audit-20261019/lead-findings.md`, `process-observation.json`, installed schema `/tmp/harness-process-cleanup-schema-20261019`. No test command run.
