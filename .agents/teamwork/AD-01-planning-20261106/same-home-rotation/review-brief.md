# AD-01 same-home App Server generation fence review

Role: critic (Sol). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root AGENTS.md, `.agents/teamwork/PROJECT.md`, the same-home rotation brief and handoff, `same-home-research/map.md`, and `/home/sr/codex-work/agents/critic.toml` before review.

## Mode

Review the same-home generation fence only. Inspect actual diffs in `src/app-server-switch.js` and `test/app-server-switch.test.js`; do not edit code/tests or Git state. Check the identity pin representation, lifecycle/concurrency around `inFlight` and `swapping`, fail-closed callback/recheck behavior, and preserved existing switching/expected-home semantics. Reuse the exact focused verification in the handoff unless a specific concern requires a probe.

## Criteria

- A bound invocation uses the hash captured for its selected cached process generation.
- Same-home credential rotation cannot bind a new identity to the old generation; active generation is not closed, and no new call runs ambiguously.
- Identity rotation during the awaited durable callback or before target invocation fails closed.
- Missing identity and callback/close/recreation failures prevent invocation; raw ID/token is not retained or emitted.
- Existing profile switching, expectedCodexHome fences, worker and lead bindings remain intact.
- Do not treat call_bound as proof of provider execution/effect or as evidence of external CLI reload semantics.

Write criterion verdicts and any findings to `review-handoff.md`. Return APPROVE, REJECT, or INCONCLUSIVE with concise evidence.
