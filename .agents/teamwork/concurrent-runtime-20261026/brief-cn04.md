# CN-04: immutable candidates and publication lineage

Project: /home/sr/Projects/Workspace/codex-agent-control-plane.
Read /home/sr/codex-work/agents/worker.toml developer_instructions,
development-access.md and project AGENTS.md. ASCII English only for artifacts.
Root owns Git/docs. Node v24.22.1 and installed better-sqlite3 available.
Preserve dirty source; no live state DB, service, model, network, commit or target
mutation. Git operations are allowed only in owned disposable test repositories.

Allowed product files: new src/candidate-store.js and
test/candidate-store.test.js only. Own .agents/teamwork/candidate-store/ notes.
Do not edit shared legacy hooks before CN-14 integration. Request expansions.

Read CN-04/local exit gate in docs/architecture/concurrent-harness/implementation-plan.md,
target-design.md Integration and immutable candidates, src/delivery-contracts.js,
src/writer-lanes.js, writer-worktree.js, writer-admission.js, workspace-snapshot.js
and relevant tests. Current workspace snapshot only fingerprints dirty paths;
that alone is insufficient for a complete immutable content manifest.

Implement reusable CandidateStore over injected better-sqlite3 db/state and an
owned content storage directory. Additive tables created in this module. Export
API and document contracts in source and handoff. Reuse existing admission/mutex
through an injected trusted adapter, do not introduce competing publication locks.
Keep CN-03 files independent (other worker owns them); synchronous event hook
injected for atomic candidate row/event commit where future integration needs it.

Required behavior:
- Attested full source manifest, content digest, immutable candidate record with
  project/objective IDs, parent lineage and monotonically ordered integration
  generation, source attempt, check/environment identity. Validate paths and
  reject escapes, symlink escapes, unsafe/special files/submodules unless exact
  content is supported. Unknown/unavailable capture cannot become known.
- Frozen content-addressed review copies include tracked plus nonignored
  untracked source, binary data/deletions/executable modes where supported.
  Never modify live repo index/HEAD to capture. Revalidate stored content before
  materializing/using known snapshots; filesystem tampering must be detected.
- Durable references and parent retention; garbage collection cannot remove
  referenced snapshots/evidence or required lineage. Immutable identity collisions
  fail. Reference operations and candidate events are transactionally coherent.
- Publication intent commits before external apply. Pin base manifest, intended
  resulting manifest/delta scope, attempt identity, controls/fence and admission.
  Recheck under admission immediately before effect, verify actual resulting full
  content before recording candidate. Owner edits/out-of-scope delta/stale base
  refuse or stay unknown, never silently attribute them to worker.
- Reconcile crashes before/during/after apply by exact before/after manifest and
  confirmed process quiescence. No double apply or release of unresolved effects.
  Do not claim atomic Git+SQLite. Distinct apply intent identity and durable
  effect status let a future executor/controller retain its fence while unknown.

Provide test-only injected apply/quiescence/current-control facts rather than
inventing a review consumer. Real disposable Git fixture tests must prove frozen
snapshots survive subsequent workspace edits, parent lineage/reference retention,
no owner-edit attribution, escape rejection, failure before/after apply, restart
reconciliation and one application. Do not use actual project Git mutations.
Run focused node:test and syntax/diff checks. Write local brief/handoff with exact
exports, commands/results and explicit limitations. Risk critic and targeted
crash/dependency challenger follow. No runtime rollout claim.
