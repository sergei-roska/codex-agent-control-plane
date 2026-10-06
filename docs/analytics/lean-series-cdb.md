# Lean route series on CDB tickets (2026-10-06)

Project policy `adaptiveRoute: on` (shadow for run B and C), model gpt-6-luna on every row. Time is wall time per the operator report. Input tokens include
the cached share; fresh = input - cached. Data from `npm run usage -- --task <ticketId>`
(per-run breakdown) as reported by the operator workers; run C and E of CDB-390 were
re-measured by the lead. All tickets are PHP; none was a twig, js or css ticket.
Companion: `cdb-390-comparison.md`.

| Ticket / run | Route (req/verdict/eff) | Promoted | Input | Cached | Fresh | Output | Lead model turns | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CDB-390 B (shadow, direct copy) | - | - | 412,239 | 268,288 | 143,951 | 11,658 | 4 | - |
| CDB-390 C (shadow, Jira) | lean/lean/full (shadow) | - | 425,940 | 311,552 | 114,388 | 9,399 | 4 | 3m13s |
| CDB-390 D (`on`, first) | lean/lean/lean | yes: `stage_not_succeeded:implement` (git `-c` rejected by the worker guard; fixed in role instructions) | 486,660 | 383,232 | 103,428 | 12,463 | 3 | 4m48s |
| CDB-390 E (`on`) | lean/lean/lean | no | 236,180 | 181,504 | 54,676 | 6,130 | 0 | 2m22s |
| CDB-389 | lean/lean/lean | no | 214,379 | 151,296 | 63,083 | 6,952 | 0 | 2m35s |
| CDB-368 | lean/lean/lean | no | 236,288 | 185,600 | 50,688 | 6,424 | 0 | 2m07s |
| CDB-367 | lean/lean/lean | no | 220,763 | 168,448 | 52,315 | 8,075 | 0 | 3m04s |
| CDB-377 | lean/FULL/full | n/a: protected path `Settings.php` (false positive, fixed) | 375,740 | 290,304 | 85,436 | 9,937 | 4 | 3m40s |
| CDB-364 | lean/lean/lean | yes: `stage_not_succeeded:verify` (QA failed on an unrelated untracked `.claude/` entry; role instruction added) | 419,960 | 310,528 | 109,432 | 12,950 | 2 | 4m34s |

All committed diffs are 1 file and at most 3 changed lines and matched the ticket texts
(reviewed by the lead from `git show`).

## Reading

- Lean held (E, 389, 368, 367): mean 226,903 input (fresh 55,190), 54.1% of the clean
  full mean of B and C (419,090), i.e. 45.9% less; zero lead model turns, about 2m30s.
- Promotion rate: 2 of 6 runs that started lean (D, 364); 1 of 5 if D is excluded
  because its cause (a git form the worker guard rejected) was fixed. A promoted run cost
  419,960 (about a full run) and 486,660 (16% more than a full run).
- Expected cost per lean-effective run: at the observed 1/3 promotion rate about 302k
  (28% below full); at 1/5 about 266k (37% below). Lean pays off unless more than roughly
  3 of 4 runs are promoted. Samples are small (n=6) and all are PHP one-file fixes.
- Both promotions were environment or tooling noise, not wrong changes, and both cost
  nearly a full run. Reducing false promotions is worth more than shaving a lean run.
- The PM proposed lean for all 7 tickets in this set; code vetoed one (CDB-377) by a
  protected-path rule that matched the class file `Settings.php` because the file name
  was compared case-insensitively with Drupal's `settings.php`.
- Intake cached share varies a lot between runs (one run had 0 cached Intake input), so
  the fresh-input column is noisier than the total.
