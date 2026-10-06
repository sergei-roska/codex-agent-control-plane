# CDB-390 cost comparison (full route runs)

Ticket: duplicate `'bg-danger'` key in `themes/custom/b4main/theme-settings.php`
(one-line deletion). Model gpt-6-luna on every row, Intake and lead xhigh, workers
high. Numbers are `usage_ledger` input tokens (cached is a subset of input).
Sources: `cdb-390-baseline-two-runs.json`, `cdb-390-shadow-full-run.json`,
`usage-ledger-cdb-before-wipe.json`; the third run was measured with
`npm run usage -- --task <ticketId>` on 2026-10-06 (its ticket was later removed from
the state, so the totals below are the record). Decision record:
`docs/adr/adaptive-delivery-route.md`.

| Run | Intake | Lead | Workers | Total input | Cached | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 `run_INqask...` (pilot, first) | 110,866 | 143,151 | 344,606 | 598,623 | 431,872 | - | blocked at finish by a snapshot bug; Intake retry |
| A2 `run_bSFKL...` (pilot, recovery) | 130,207 | 111,077 | 254,969 | 496,253 | 398,080 | - | repeated Intake and all four stages; operator question |
| A total | 241,073 | 254,228 | 599,575 | 1,094,876 | 829,952 | 33,487 | the 1,128,363-token total including output |
| B `run_GDPKJ6...` (shadow, direct copy) | 69,848 | 108,363 | 234,028 | 412,239 | 268,288 | 11,658 | clean full route; one Intake retry (`presetId`) |
| C `run_xRd-tA...` (shadow, from Jira) | 43,307 | 111,675 | 270,958 | 425,940 | 311,552 | 9,399 | clean full route; no retry; PM proposed lean, verdict lean, effective full (shadow) |
| D `run_gqG8gM...` (`on`, first) | 40,632 | 115,069 | 331,959 | 486,660 | 383,232 | 12,463 | lean promoted to full at implement: the Developer's `git -c ...` was rejected by the Codex worker guard, outcome `blocked`; xhigh repair, Reviewer, 3 lead turns |
| E `run_VZzeV3...` (`on`, after the role fix) | 35,725 | 0 | 200,455 | 236,180 | 181,504 | 6,130 | lean as designed: reproduce skipped, implement and verify succeeded first try, review not run, 3 scripted decisions, no lead model call, 2m22s |

Run C by role (input / cached / output): PM 5 rows 154,982 / 96,000 / 5,086; Developer
119,735 / 97,792 / 1,388; QA 2 rows 99,753 / 74,496 / 1,920; Reviewer 51,470 / 43,264 /
1,005. Wall time about 3m13s (Intake 31s, engineering 2m41s).

## Reading

- A clean full run costs about 410-430k input tokens. The 1.09M of the pilot was two runs,
  one of them a recovery after a platform bug: the failure roughly doubled the cost.
- Lead is a constant 108-112k (about 26%) and is fully determined by the plan on a clean
  run; Intake dropped from 70k to 43k once the `presetId` retry was gone; worker cost
  varies run to run by about 15% (repo exploration), so single runs are noisy (n=1 each).
- Measured lean (run E): 236,180 input tokens = 55.4% of the clean full run C (44.6% less)
  and 21.6% of the 1,094,876 of the pilot pair A; output 6,130 vs 9,399; wall time 2m22s
  vs 3m13s. The ADR target (at most 60% of a clean full run) is met. The earlier
  projection (about 213k) was close; the gap is the Developer (127k vs 120k) and QA
  (73k vs 50k) calls.
- Run D shows the cost of a failed lean attempt: 486,660, more than the full run. A lean run
  that is promoted pays the lean attempt plus the full tail, so reliability of the first
  Developer attempt matters; the cause (a git form the worker guard rejects) was fixed in
  the role instructions (`78dcf13`). Watch the promotion rate in `route_promoted` events;
  if it stays above a few percent the saving erodes.
- All five measured runs are n=1; worker cost varies about 15% run to run.
- Caveat for this ticket class: no approved check detects a duplicate PHP array key, so a
  lean run relies on the independent QA verify stage, not on a mechanical check.
