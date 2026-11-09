# Session repair acceptance review

Verdict: APPROVE
Status: complete
Scope expansion: none

## Criteria

- PASS - Repeated failed auditor reviews use stable role, checkpoint, and scope identity despite paraphrased assignment checks and incidental IDs. Read: `src/loop-guard.js:99` excludes request prose from gated review work identity, while report check command/result and scoped content identity remain in evidence; `src/lead-graph.js:2433` computes the latter from scoped content and observes settled batches. Ran: detector 17/17, graph 195/195, orchestrator 22/22 focused cases reported by owners; independently, the full suite below passed. The graph regression exercises four paraphrased failed reviews after a verifier and asserts third warning and fourth pause. Interleaved diagnostic, content changes, performed-check changes, and resume behavior have focused detector coverage.
- PASS - Existing worker-report/v1 fields remain intact. Read: `src/contracts.js:84`, `src/review-policy.js:153`, `src/a2a-role-service.js:121`, and `src/lead-graph.js:2012`. Strict standalone verdict validation and all-passed checks remain enforced. The direct auditor prompt now routes pinned-check reviews to preserve/weaken guidance and leaves investigations diagnostic; the A2A regression inspects actual model-run input. Supplemental, excluded, and reused evidence is instructed into risks with limits; required failed or unrun checks remain in checks. Natural-language assignment-to-report check mapping remains a documented semantic responsibility, not a new mechanical guarantee.
- PASS - Read: `launcher-ui/app.js:455` checks the latest task, matching project/session situation, explicit owner_pause/stopped kind, no running batch, and no pending send/pause before enabling New session; `newSession` repeats the guard and clears decision state. The route's situation builder supplies explicit pause kinds. Ran: seven launcher session-control cases, including a new context payload without old task continuation, and 10 pause route cases with disposable loopback servers.

## Independent checks

- `env -u NODE_TEST_CONTEXT npm test > ../full-suite.log 2>&1` outside the sandbox for disposable loopback and /var/tmp fixtures: exit 0, 1,077 tests, 1,076 passed, 0 failed, 1 skipped. The skip is the optional live confinement probe against an installed Codex App Server, not an acceptance test weakened by this change.
- `env -u NODE_TEST_CONTEXT node --test test/launcher-pause.test.js` inside the sandbox timed out because its loopback listen promise did not resolve; the same test outside the sandbox passed 10/10. An earlier opaque launcher-session-controls wrapper failure occurred during concurrent edits; after file freeze its wrapper passed, and the full suite passed.
- `git diff --check`: exit 0. Reviewed the regenerated session.patch against the baseline snapshot; changes are confined to the listed session files. Preexisting dirty HEAD changes were not treated as session changes.

## Activation

No real task was resumed and no deployed service was restarted in review. The launcher serves the UI from files, so reload the page after integration. Server-loaded roles and modules require the project server to restart before backend behavior changes take effect.
