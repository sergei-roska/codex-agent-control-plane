# AUT-03 implementation handoff

Status: offline runtime delivery, synthetic case review, and final independent audit APPROVED. Paired live trial and effectiveness remain unqualified.

## Verified baseline

- AUT-05 acceptance is `baseline_ready`; all 13 referenced artifacts match.
- AUT-01 acceptance is `accepted`; all 26 referenced artifacts match. The accepted context and map digests are `44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf` and `212f256587a672c4c6de818a67a52e8a0463663258f39756d9409a6e53be3ec8`.
- AUT-02 acceptance was `accepted` at S0; all 26 referenced artifacts and all 9 source/test hashes matched before AUT-03 edits. AUT-03 intentionally updates the overlapping `src/lead-graph.js` and `test/lead-graph.test.js`; the other 7 accepted source/test hashes still match.
- The code path sends no selected skill to the lead today. `assignment.skills` targets workers. Lead `tools.skills` remains false.
- The App Server already validates explicit skill ID, canonical path, and current file hash before `turn/start`.
- Node is v24.21.0.

## S1 design and runtime decision

Use a dedicated `audience: lead` catalog entry under the canonical skills root, excluded from the default worker catalog. Pin its exact ID and SHA-256 in trusted runtime code. Load an exact UUID allowlist from `CODEX_A2A_AUT03_TRIAL_RUN_IDS`; it is read at server startup, defaults empty, and is never accepted from model output or request JSON. Bind the selected pin into lead run checkpoint context and the session profile fingerprint so skill-on/off runs roll over to distinct threads. The existing App Server validates the skill file again on each turn. Do not enable lead skill tools, bundled skills, MCP, plugins, or apps.

The reviewed design and as-built summary are in `docs/evidence/aut-03/s1-design.md`. Initial S1 review rejected three design gaps. The approved revision treats missing audience metadata as `worker`, forces skill-on rollover from legacy session rows with null profile hash, and freezes the selection/pin in the first checkpoint with pre-call rejection if resume configuration differs. Independent re-review APPROVED; see `docs/evidence/aut-03/s1-design-review.md`.

S1 design review is APPROVED after three findings were addressed: preserve untagged legacy skills as worker skills; force skill-on rollover from legacy session rows with null profile hash; and freeze skill selection at first intake, rejecting resumed runs if the allowlist or pin changes. Evidence: `docs/evidence/aut-03/s1-design-review.md`.

## Boundaries and next action

The synthetic case set independently passed review; see `docs/evidence/aut-03/case-review.md`. The review checked all 11 manifest references, case DAG, ASCII, and accepted F2 reference. It required explicit blocking of A1 pending a source-backed integration point, R4 regression coverage, use of the repository test command, and removal of a false T0-to-T1 dependency.

No live model call, service restart, session resume, shared DB write, or rollout occurred. Pairwise planning quality/economy results remain pending. Runtime changes and final audit are complete. Preserve the dirty worktree.

## Runtime delivery result

Catalog skills default to worker audience; explicit lead audience is excluded from worker candidates and assignment resolution. The bounded proposal-only skill is pinned by ID and SHA-256 in `src/aut03-lead-skill.js`. The startup UUID allowlist is read once from `CODEX_A2A_AUT03_TRIAL_RUN_IDS`, defaulting empty. The checkpoint freezes allowlist digest, selected state, and pin; resume drift and missing/stale skills fail before lead calls. Selected skills are passed on full, delta, retry, resumed, rejected-thread rollover, and context rollover turns. Session profile hashes separate on/off runs and force enabled runs off legacy null-hash threads. Lead tools remain read-only with skills false.

Verification: focused tests passed 502, failed 0, skipped 0; the AUT-01 test set passed 38/38; AUT-01 qualification probes exited 0; full suite passed 1226, failed 0, skipped 1 optional installed-App-Server live confinement probe. The full TAP report is `docs/evidence/aut-03/qualification-full.tap`. Skill file hash is `e0f10756e0486cdb827519edd8adfef866d84be449d6a10b1320412648e650ba`. Quality/economy acceptance remains deferred pending an explicitly authorized paired trial.
