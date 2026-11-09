# AD-02 legacy account-transfer qualification review

Role: critic (Sol). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root AGENTS.md, `.agents/teamwork/PROJECT.md`, AD-02 implementation brief/handoff, the AD-02 backlog acceptance, and `/home/sr/codex-work/agents/critic.toml` before review.

## Mode

Review the deterministic integration test in `test/account-failover-context.test.js` against its brief. Inspect the actual test and production mechanisms it exercises. Do not edit reviewed source/tests or Git state. Reuse valid test evidence or run the new test if necessary.

## Criteria

- Uses a real `LeadOrchestrator`, account switching wrapper, and budget watcher with disposable profiles and fake provider responses; does not replace the actual continuation mechanism with a mock orchestrator.
- A's provider limit selects B automatically without an owner message and preserves the same run/context/pinned check and settled worker outcome without duplication.
- Account B starts a fresh provider thread, not A's thread; scope is retained and result is accepted only through the pinned check path.
- Durable call bindings contain both one-way account hashes and no raw account identifiers.
- Test cleanup and remaining evidence limits are honest; no live provider claim.

Write concise criterion evidence and a verdict to `review/handoff.md`.
