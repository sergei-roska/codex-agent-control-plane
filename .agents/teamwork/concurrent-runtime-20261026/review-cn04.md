# CN-04 local exit review

Review/acceptance mode in /home/sr/Projects/Workspace/codex-agent-control-plane.
Read critic TOML developer_instructions and development-access.md under
/home/sr/codex-work, project AGENTS.md, brief-cn04.md here and the current
../candidate-store/handoff.md. Source freezes only when the worker signals ready.

Inspect actual new src/candidate-store.js and test/candidate-store.test.js
(untracked files do not appear in git diff). No reviewed-file/Git mutation.
Reports/probes only under .agents/teamwork/candidate-store-review/ and owned
disposable repositories/DBs. No real state/services/model/network/target changes.

Check complete immutable manifests including binary bytes/executable modes,
deleted/untracked files, subtree and unsafe path/symlink behavior, metadata/blob
tampering detection, safe fresh materialization and no index/HEAD mutation.
Verify identity immutability, project/objective/parent/generation validation and
identical replay under immediate transactions, plus synchronous row/event commit.

Publication must fail closed without adapters, pin exact controls/fence and hold
the same admitted identity through attestation/commit. Intent precedes any effect.
Before/during/after apply crashes must preserve unknown state and admission;
reconciliation never blindly re-applies or reacquires instead of settling saved
identity. Exact manifest mismatch/owner edit cannot become worker output.
Retention protects parent lineage, durable references AND pending intents;
SQLite rollback cannot undo file deletion, so GC ordering must preserve evidence.

Root flagged pending-intent GC retention, premature admission release during
reconciliation, and pretransaction generation/replay reads before worker freeze.
Verify those actual fixes and probe event-hook/owner-edit crash windows. No
claim of Git+SQLite atomicity or installed runtime hooks is acceptable.

Run decisive focused tests/probes. Write brief.md, handoff.md and review.md;
APPROVE/REJECT/INCONCLUSIVE with concrete evidence and local gate limitations.
Do not require a real review consumer or model call: those are successor gates.
