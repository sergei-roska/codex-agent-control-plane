# M9 acceptance ledger

Date: 2026-10-02. Status: in progress; no beta release or tag authorized.
Gate: [M9 plan and release checklist](../beta-master-plan.md#m9-prove-and-package-beta).

## Candidate and executed checks

- Baseline commit: `7f1906f31807c8b9cde75b18ab39a2416dfc2afe`. The candidate also
  contains working-tree changes. The functional candidate fingerprint is
  `0abcadfe044dacd447209ff3c764e58387803e23cc1542e585c62bbe44f6f600`:
  SHA-256 over the sorted per-file SHA-256 records from `src`, `test`, `scripts`,
  `profiles`, `web/dashboard`, `package.json`, and `package-lock.json`. This
  includes the new untracked product and test files; it excludes runtime state,
  credentials, documentation, and the protected reference.
- On Node.js `v24.21.0`, npm `12.1.0`, and Codex CLI `0.160.0`,
  `node --test test/*.test.js` completed with **932 pass, 0 fail, 0 skipped**.
  Local HTTP and Git tests required execution with loopback binding available;
  the restricted sandbox made server addresses unavailable before assertions.
- `node scripts/role-capability-check.js --fake` completed **10/10** cases.
  This validates routing, contracts, scope and acceptance against scripted
  workers; it is not model-quality evidence.
- `node scripts/role-capability-check.js --live --only developer
  --i-understand-this-uses-my-quota` completed **1/1** with real Codex turns.
  The direct fixture changed only the allowed file, ran a passing check, and
  reached an accepted candidate. Two inline verification commands were blocked
  by the local PreToolUse hook; the role recovered and completed through an
  allowed check. This is one bounded scenario, not evidence for all nine roles.
- `node scripts/role-capability-check.js --live --only pm
  --i-understand-this-uses-my-quota` completed **1/1** with real Codex turns.
  Intake withheld dispatch for an ambiguous audit, recorded the operator answer,
  saved a valid plan, and kept the coordinator read-only. The first attempt
  failed a harness assertion that required literal stage IDs, although the
  contract requires preset keys and roles; the corrected harness passed on the
  second attempt.
- In a separate clean copy outside `/tmp`, without `node_modules`, runtime
  state, credentials, or Git history, `npm ci --offline` installed 130 packages
  from the local cache and reported zero vulnerabilities. The focused acceptance
  suite passed **35/35** and the full suite passed **932/932**. The copy was
  removed after verification. The tested installation used cached packages;
  this is not a fresh network download test.
- `git diff --check` and
  `sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt` passed.
  `src/server.js` serves the working copy at `web/dashboard`, not the protected
  reference.
- A paired browser exercised all six tabs on the working dashboard, created and
  submitted a direct ticket, inspected its candidate and diff, and requested a
  correction that opened a new run. A local Atlassian fixture imported `DEMO-1`;
  the ticket detail showed its Jira identity, source revision, provenance, and
  internal tracking intent. The fixture worker again added an unrelated export,
  so neither candidate was accepted. These browser actions do not establish
  real-model quality or a complete Jira engineering delivery.
- A second fresh browser fixture imported Jira `DEMO-1`, submitted it to Intake,
  and reached human review with a saved plan, ticket-owned branch, accepted
  check evidence, one-file candidate, and internal-only tracking. Its fake
  writer added an unrelated `farewell` export, so the candidate was inspected
  but not operator-accepted or committed. The fixture has no epic or Confluence
  page; the earlier [M6 live source pilot](../m6/live-pilot-report.md) contains
  real issue, epic, and Confluence provenance but stopped at Intake.
- At 1280px the working-copy header now keeps all six navigation tabs visible.
  At an emulated 390px mobile viewport, the Board remained within the viewport
  (`documentElement.scrollWidth` 390) and the navigation scrolled horizontally.
  The protected reference was not changed.
- An independent read-only security audit identified self-hosted workspace
  writing as high severity. Startup now rejects workspaces overlapping the
  application root. Owned-branch commit and commit-time writer fencing were also
  added, with focused tests passing. Shared redaction, persisted wait/decision
  text, and stderr were hardened. The full-suite rerun passed.
- A live Codex role pilot failed during engineering because the generated
  permission profile changed after `.codex` appeared in the task workspace.
  That failed attempt is not counted as successful. Fixed profile entries
  preserved the binding when `.codex` appeared, and the second Developer pilot
  passed. See the [security disposition](security-review.md).
- A separate read-only control-flow audit found Stop/Cancel reconciliation and
  hold-boundary defects. Reconciliation now retries while a terminal lead is
  held by an unresolved writer; pause/stop gates fail closed at decision and
  accept boundaries. A conditional terminal-lead/writer lease gap was fixed
  with regressions using different parent and child task IDs. The full suite
  passed after these changes.

## Second M9 pass (2026-10-02, lead session)

Details, ids, and the follow-up list are in the [session handoff](session-handoff.md).

- Live direct-ticket pilot through the browser with every role on gpt-6-luna
  (owner choice): it found a critical Codex 0.160 sandbox placeholder defect, a
  writer path to project Codex config, an acceptance false rejection on rework,
  and two lead-decision recovery gaps; all were fixed with regressions
  (`77da677`, `6a88756`). The resubmit run reached review in about 8 minutes with
  a passing check, a confined diff, and a settings snapshot pinning gpt-6-luna for
  all 11 roles plus the App Server version; usage 2.65M tokens, 75% cached share,
  monetary cost unavailable. The correction run resumed after the fixes and was
  accepted and committed (task commit `b99cb0e`). Jira `KAN-1` (temporary issue)
  was in engineering at the time of writing.
- Manual recovery on the fake model: upgrade v2 to v6 with a 0600 backup, crash
  and Resume, clean stop and resubmit, offline and online backup and restore,
  two-ticket lease order, and revision history all passed; the procedures were
  corrected where they were wrong.
- Browser checks: six tabs, server down/up, session revoke, and 390/1280/1600
  layouts; the defects found were fixed.
- Idempotency review of the six duplicate/stale properties; the push-after-success
  gap was fixed and missing tests were added. An independent pre-merge audit of
  the sandbox and Git changes found the `.codex` writer path (fixed) and two
  accepted low limits.
- Live role cases: architect (Sol) and tech-writer (Luna, live-workers) passed;
  qa, performance, and devops failed one case each on model behavior; reviewer and
  security have no live case (owner kept all live spend on Luna).
- Network-fresh install in a clean copy: `npm ci` 130 packages, 0
  vulnerabilities, 941/941. Current tree: full suite 960/960, fake role cases
  10/10, protected reference unchanged.
- Hosted Git remote is waived for beta by the owner; pushes go to a local bare
  remote.

## Release checklist

`Automated` means the named test evidence passed on the current tree; the row is
not closed until the M9 scenario and review evidence are attached where required.

| Plan case | Current evidence | M9 closure still needed |
| --- | --- | --- |
| Direct ticket | Controller/dashboard/M7 tests; live Developer direct fixture passed 1/1; clean install passed | Browser human review used a fake worker; repeat a full operator-reviewed real-model delivery |
| Jira ticket | [M6 live source pilot](../m6/live-pilot-report.md), M6 integration tests; current browser fixture reached human review | Real imported issue through engineering and review on this candidate |
| Tracking intent | M6 egress tests and [read-only connector contract](../m6/operator-setup.md) | Candidate egress review during Jira pilot |
| Nine roles | 10/10 fake capability cases; real Developer and PM cases each passed 1/1 | Real evidence for remaining specialist roles, or an explicit beta limit |
| Pipeline | Controller and plan tests; direct and Jira browser fixtures reached review | Real-model end-to-end operator flow |
| Acceptance | Acceptance/controller tests; live Developer check passed; Jira fixture showed passed check but unrelated diff | Inspect real operator-reviewed candidate outcome |
| Corrections | M7 tests; browser correction request created a new run | Live candidate rework outcome |
| Protected Git | Git delivery, real local bare-remote tests, M7 HTTP tests, owned-branch and staged-blob guards | Hosted remote/credential behavior or documented waiver |
| Pause/stop/cancel | M7 tests plus M9 hold/reconciliation/lease regressions | Live interruption or explicit pilot limit |
| Edits/backlog | Product store and dashboard ticket tests | Browser revision history check |
| Restart | E2E/controller/server tests; `test/m9-recovery.test.js` stopped-server backup/restore/reconciliation passed | Manual operator restore and resume exercise |
| Duplicates/stale results | Store, server and M7 tests | Candidate review of idempotent replay evidence |
| Repository concurrency | Writer admission, checkout, controller tests | Two-ticket operator scenario |
| Model settings | Catalog/settings tests | Pinning visible in live run |
| Usage/cache | Usage, projection and M8 tests | Live run coverage/unknown-state inspection |
| Six tabs | All six tabs opened on current working copy; 1280px and 390px layouts inspected; Jira fixture used after source fixes | Browser reconnect/error variants beyond the fixture |
| Credentials/content | Independent read-only M9 security audit, [disposition](security-review.md), self-hosting/branch/commit/redaction fixes, 932/932 tests | Real Codex sandbox behavior beyond bounded live pilots |
| MLflow experiment | [M8 result and deferral](../m8/acceptance.md) | Keep deferral visible in release notes |
| Prompt comparison | [M8 live evaluation](../m8/live-eval-result.json) | Keep non-promotion visible in release notes |
| Installation/recovery | Migration/restart/E2E tests; stopped-server backup/restore/reconcile test passed; offline cached `npm ci` and 932/932 in a clean copy | Manual operator resume reproduction and network-fresh install if required |

## Release decision

The candidate is not ready for publication while a real imported Jira issue has
not completed engineering and operator review on this candidate, hosted Git
credentials have not been exercised, and manual operator recovery remains
unverified. The proposed
`v0.1.0-beta.1` tag in [release notes](release-notes.md) is a proposal only.
The [operator guide](operator-guide.md) covers setup and known operational limits.
