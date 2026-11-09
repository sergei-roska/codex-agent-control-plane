# AUT-03 progress

## S0

Freshly rehashed all 13 AUT-05 acceptance artifacts, all 26 AUT-01 acceptance artifacts, all 26 AUT-02 acceptance artifacts, and all 9 AUT-02 source/test files; zero mismatches. Confirmed AUT-01 context/map digests against the acceptance manifest and fixture bytes. Node is v24.21.0. No live calls or baseline capture.

## S1 source trace

`lead-graph.js` constructs full/delta prompts and calls `appServer.run` without `selectedSkills`. Worker assignment skills travel through `a2a-role-service` and a separate App Server call. `codex-app-server.js` validates selected skill path/hash and attaches explicit skill inputs before each turn. Built-in lead tool policy is `skills: false`. Session thread reuse currently fingerprints role profile, Codex home, and token threshold, so skill-on/off isolation needs to be included in its profile fingerprint.

## S1 review loop

Initial independent review rejected three design gaps. The design now treats missing audience metadata as worker-scoped, requires skill-on runs to roll over from legacy session rows with null profile hash, and freezes the skill selection/pin in the first checkpoint with pre-call rejection if resume configuration differs. Independent re-review APPROVED; see `docs/evidence/aut-03/s1-design-review.md`.

## Runtime delivery

Implemented lead-only audience filtering, the bounded proposal-only skill, trusted ID/hash selection, strict startup UUID allowlist parsing, checkpointed selection and drift checks, and skill-aware lead session fingerprints. The coordinator attaches the selected pin on full, delta, retry, resumed, rejected-thread rollover, and context rollover turns. Fake App Server tests confirm selected turn input and unchanged lead tool policy. Tests also cover default-off, worker isolation, missing/stale catalog entries, drift before model call, and legacy null-profile rollover.

Verification command: `node --test test/skill-catalog.test.js test/lead-graph.test.js test/lead-orchestrator.test.js test/server.test.js test/codex-app-server.test.js test/a2a-role-service.test.js` - 502 passed, 0 failed, 0 skipped. `git diff --check` passed. Skill SHA-256: `e0f10756e0486cdb827519edd8adfef866d84be449d6a10b1320412648e650ba`. No live call, service restart, shared DB write, rollout, or Git mutation occurred.

## Case review and final verification

The synthetic case set was independently approved. All 11 manifest references and the final manifest hash match. The reviewer required A1 to remain blocked pending a source-backed integration point, R4 regression coverage, the repository's `npm test` command, and T0 independence from T1; the final graph has four valid full orders. Evidence: `docs/evidence/aut-03/case-review.md`.

Independent runtime verifier APPROVED the bounded delivery delta. Re-ran the focused set: 502 passed, 0 failed, 0 skipped. AUT-01 regression tests passed 38/38; its 22 negative qualification probes all blocked as expected. Full suite: 1226 passed, 0 failed, 1 optional live confinement probe skipped out of 1227. Retained TAP logs are under `docs/evidence/aut-03/qualification-*.tap` and `qualification-aut01-probes.log`.

AUT-02's nine accepted source/test hashes matched at S0 before AUT-03 edits. The only current hash divergences are the intentional AUT-03 updates to `src/lead-graph.js` and `test/lead-graph.test.js`; the other seven still match. Independent final audit APPROVED all 23 source/evidence pins and 11 case references; see `docs/evidence/aut-03/final-audit.md`. Planning quality/economy and all live measurements remain unavailable.
