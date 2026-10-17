# AUT-03 runtime, resource, S08 and S09 evidence review

Verdict: INCONCLUSIVE for full eight-task post-task provider-error verification; all other requested checks pass. Status: complete. Scope expansion: none. This report does not decide retention or assess response quality.

## Method and freeze integrity

Ran read-only Python/sha256 checks against the actual local files. `git diff -- docs/evidence/aut-03 docs/evidence/aut-01` was empty because the AUT-03 evidence is untracked; inspected those files directly. The independently approved skill-off and skill-on freeze pointers are respectively `docs/evidence/aut-03/live-trial/cohort-3/skill-off-baseline-freeze.json` (SHA-256 `2f73a1212e6c3ff882e1dc36037b0605f575759c25fbbac014c66975fa55a72f`) and `skill-on-baseline-freeze.json` (SHA-256 `30a2b74470a4bd2da77a68c874070ce61221927f3fd73adcde48c6f60c365e08`). Rehashed all 60 skill-off and 56 skill-on recursive artifact paths and sizes: zero mismatches. All eight `run.json` hashes match their freeze case entries. Read the two independent baseline reviews; both say APPROVE.

## Eight runtime records

PASS (read and rehashed): All eight run records have `TASK_STATE_COMPLETED`; task IDs, arms, case IDs, and prompt hashes agree with the freeze case entries. All eight ran `gpt-6.1-sol` at medium effort. Skill-off context is disabled with no skill pin; skill-on context is enabled with the same pinned skill ID/hash in all four records. The arm attestations agree. The two early skill-off runs include settings and prompt hashes directly; the later two omit those run fields, but the frozen preflight and attestations carry the arm settings hash and selected prompt hash. All skill-on run fields agree with preflight and attestation. The skill-on collection review says the missing fields were restored from preserved initial runs and hashed preflight records.

PASS (read): Preflight, run, and controls evidence records report empty read-only workspaces. All eight attestations report eight worker roles removed and zero remaining. Run and controls each record zero dispatch journal rows, writer execution rows, permission events, commands, and file changes. Each run sent one lead turn against an eight-turn cap; no limit exceeded. Each completed far below the 240-second and 500,000-token caps. All before-task quota snapshots report provider error null and account auto-switching false; account switching is false in all attestations and run accounts. Seven post-task quota snapshots report provider error null and auto-switching false. No explicit provider quota exhaustion or cap stop is recorded. All eight run records give monetary cost `null`, consistent with subscription usage evidence and unavailable task-level price data.

UNVERIFIED (read): `skill-off/bounded-dependencies/run.json` has `quotaAfter: null` and no `quota-after.json`; a post-task provider error cannot be independently observed for that one task. Its required pre-task snapshot reports provider error null, and the task completed. The earlier independent skill-off freeze review records the same limit. Do not state that all eight post-task provider errors were observed null.

PASS (read): Each `usage.json` has one completed row and matches its `run.json` input, cached input, output, reasoning output, total tokens, elapsed milliseconds, and one turn. Retry, startup, queue, and cold-start counts are null/partial in the usage source, so no numeric savings claim for those fields is supported. Every non-cached input and elapsed denominator is positive.

| Case | Arm | Non-cached input | Total tokens | Elapsed ms | Turns |
| --- | --- | ---: | ---: | ---: | ---: |
| pilot-price-f2 | off | 22741 | 24367 | 29690 | 1 |
| pilot-price-f2 | on | 22752 | 24104 | 25542 | 1 |
| bounded-dependencies | off | 18963 | 21286 | 42272 | 1 |
| bounded-dependencies | on | 18974 | 21082 | 32158 | 1 |
| owner-decision-required | off | 18693 | 20560 | 31200 | 1 |
| owner-decision-required | on | 18704 | 20624 | 33664 | 1 |
| contradictory-source-blocker | off | 18798 | 21191 | 45714 | 1 |
| contradictory-source-blocker | on | 18809 | 21266 | 46779 | 1 |
| Totals | off | 79195 | 87404 | 148876 | 4 |
| Totals | on | 79239 | 87076 | 138143 | 4 |

Ratios use skill-on / skill-off; below 1 is a reduction.

| Case | Non-cached input | Total tokens | Elapsed |
| --- | ---: | ---: | ---: |
| pilot-price-f2 | 1.000484 | 0.989207 | 0.860290 |
| bounded-dependencies | 1.000580 | 0.990416 | 0.760740 |
| owner-decision-required | 1.000588 | 1.003113 | 1.078974 |
| contradictory-source-blocker | 1.000585 | 1.003539 | 1.023297 |
| Median | 1.000583 | 0.996765 | 0.941793 |
| Maximum | 1.000588 | 1.003539 | 1.078974 |

No missing or zero denominator. Monetary cost ratio: `null`.

## S08 and S09 reuse

PASS (ran rehash): `docs/evidence/aut-03/s08/manifest.json` lists 13 files; all hashes and sizes match. `qualification.json` points to the frozen pilot-price-f2 raw output for each arm, and both raw output hashes match. Its three generated artifact hashes per arm match the corresponding `spec.md`, `plan.md`, and `tasks.md`; both traceability and analyzer reports are covered by the manifest. The S08 context hash is `44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf`, matching AUT-01 acceptance. Both arms have identical nine-file input hash maps before and after analysis, with `inputsUnchanged: true`.

PASS (read): Both S08 analyzer exits are 1 with verdict `blocked`, 20 error findings, blocked traceability/graph/projection/assignments, and `adapterContractPassed: false`. The real adapter validation entries show engineer `allowedFiles_size_limit` and verifier `review_size_limit` for both proposed tasks in both arms. S08 is qualification evidence for how the actual outputs fare under the accepted offline analyzer, not evidence that either output passed it.

PASS (ran rehash): The accepted AUT-01 negative-control artifact `docs/evidence/aut-01/qualification-probe-results.jsonl` has exactly 22 lines and SHA-256 `ee76389b8af152b2d68c8536104f85a383005ddef9432ead741b90afcdbfa85a`, matching its reference in `docs/evidence/aut-01/acceptance.json`. Every line says `verdict: blocked`; 21 carry `exit: 1`, while the Q24 disappeared-input line uses `opens` rather than an exit field. AUT-01 acceptance says 22 supplemental controls blocked, and `final-verifier.md` documents the offline accepted boundary.

## Limits

The files are local evidence snapshots, not a live provider query or direct observation of historical workspaces. No task, service, test, or model run was started here. The absent skill-off bounded-dependencies post-task quota snapshot is the one material observation gap in the requested provider-error check. It does not contradict its completed run or the observed before-task snapshot. The report makes no response-quality or retention judgment.
