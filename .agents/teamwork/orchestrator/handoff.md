# Current handoff: final LL-8 repair

Status: partial; final narrow repair in progress, not activated.
Baseline HEAD: e5f5c6f. Preserve all uncommitted OPS-04 and LL-8 changes.
Root owns docs/Git/instructions; ll8_worker owns product and matching tests.

## Completed and verified

- AGENTS.md succession/token-economy rules; ignored .agents/teamwork is populated.
- Unlimited default rounds, real explicit caller allowance, bounded loop guard,
  checkpoint rollover, SQLite restart/budget/legacy coverage.
- Full suite before latest evidence-hash repairs: 1060 tests, 1059 pass, 1 optional
  skip, 0 fail. Command: env -u NODE_TEST_CONTEXT npm test.
  Log: /tmp/ll8-full-test.out. This is NOT final-patch acceptance evidence.
- Focused detector/graph suite after tail/prose repairs: 208 pass.
- Challenger prior failures repaired: failed risk prose and novel 21st file.
  Challenger also verified accept_as_is acceptance/review gates.

## Current blocker

Critic found full report prehashing occurs before final review failure status.
A TASK_STATE_COMPLETED report with a later rejected review can still count
changing risk prose as novelty. Worker is repairing by preparing failure-safe
full evidence before projection and selecting it at final observation time.
New graph regression 'precomputed full-report evidence uses the final rejected
review state' currently fails with 'lead script exhausted'; worker investigating.
Do not remove/weaken this regression to claim completion.

## Next

1. Worker completes the narrow repair and graph/detector regressions.
2. Reuse ll8_review for narrow re-review; challenger prior probes already hold.
3. Run final env -u NODE_TEST_CONTEXT npm test (normal sandbox escalation for
   /var/tmp/HTTP fixtures); git diff --check; inspect new files and ignore rule.
4. Mark LL-8/P-32 qualified only after actual checks; update docs/codex-handoff.md,
   design/backlog/production transfer and local reports with exact results.

Owner reports 25% five-hour quota remaining. No additional agents needed and no
Astra escalation. Do not restart service, resume live task, stage/commit/push,
or deploy. No real 10-hour run; outcome/checkpoint storage remains unbounded.
All reports/briefs in /tmp may disappear; copies here are the recovery map.
