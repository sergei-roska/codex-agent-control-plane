# M9 acceptance ledger

Date: 2026-10-02. Status: M9 exit gate met for the release candidate at `e8eca67`
(fingerprint `d7169fa124a7fb1da31841f27b19fe77346d47b3ce781e0d36115b776a360a90`);
no beta release or tag authorized.
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
  accepted, committed (`b99cb0e`), and pushed to the local bare remote; Push is
  no longer offered afterwards. Jira `KAN-1` (temporary issue) was imported with
  its identity, revision, and internal tracking, reached review in about 21
  minutes with a confined passing candidate, and was accepted and committed
  (`8fdb8d5`); the egress audit found only the OAuth token POSTs and GETs.
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

The table records the final M9 disposition. Epic and Confluence context across
the full delivery lifecycle will be exercised during the next live-project pilot;
it is deferred from M9 and does not block this candidate.

| Plan case | Current evidence | M9 disposition |
| --- | --- | --- |
| Direct ticket | Real-model direct ticket completed through correction, review, Accept, Commit, and Push; see the second M9 pass above | Passed |
| Jira ticket | Real Jira issue `KAN-1` completed through review, Accept, and Commit with source identity and revision recorded | Passed for issue delivery. Epic and Confluence context across the full delivery lifecycle is deferred to the next live-project pilot. |
| Tracking intent | Jira egress audit found only OAuth token requests and GETs; no write violations | Passed for the M9 Jira issue pilot |
| Nine roles | 10/10 fake capability cases; live results and limits are recorded above and in release notes | Passed with the stated live-evidence limits |
| Pipeline | Direct and Jira real-model runs reached accepted review candidates | Passed for the two piloted scenarios |
| Acceptance | Both live candidates passed checks and were accepted by the operator | Passed |
| Corrections | Direct-ticket rework was resumed, accepted, committed, and pushed | Passed |
| Protected Git | Direct candidate pushed to a local bare remote; Jira candidate committed; owned-branch and staged-blob guards passed | Passed under the hosted-remote waiver |
| Pause/stop/cancel | Pause/Resume, crash recovery, and clean-stop recovery exercised; regressions pass | Passed within the documented operating limits |
| Edits/backlog | Revision history and two-ticket lease behavior exercised in manual recovery checks | Passed |
| Restart | Manual upgrade, backup/restore, interruption, and resume checks passed | Passed |
| Duplicates/stale results | Idempotency review fixed push-after-success behavior and added regressions | Passed |
| Repository concurrency | Two-ticket lease scenario passed; writer admission and checkout regressions pass | Passed |
| Model settings | Live run snapshots recorded gpt-6-luna settings for all roles | Passed for the owner-approved pilot configuration |
| Usage/cache | Live usage and cache coverage recorded; monetary cost unavailable for subscription usage | Passed with partial-coverage limitation disclosed |
| Six tabs | All six tabs and desktop/mobile layouts exercised; reconnect and error variants checked | Passed for the tested states; visual review follow-up remains in the handoff |
| Credentials/content | Independent security audit, Jira egress audit, and bounded real Codex sandbox pilots completed | Passed within the documented beta limits |
| MLflow experiment | [M8 result and deferral](../m8/acceptance.md) | Deferred and disclosed in release notes |
| Prompt comparison | [M8 live evaluation](../m8/live-eval-result.json) | Not promoted; disclosed in release notes |
| Installation/recovery | Network-fresh `npm ci`, full suite, and manual recovery checks passed | Passed for the tested environment |

## Release decision

The M9 exit gate is met for the candidate at `e8eca67`. No critical defect remains
open in the primary flows, command lifecycle, data durability, repository
ownership, or protected actions: every defect found by the live pilots and audits
was fixed with regressions, and both primary scenarios ran end to end on real
model turns from a clean pilot setup. Remaining limitations and the owner's
waivers (hosted Git remote; Luna for every role in pilots) are explicit in the
[release notes](release-notes.md). The full suite (960/960), fake role cases
(10/10), `git diff --check`, and the protected reference check passed on that
commit.

Publication is not authorized by this ledger. The proposed `v0.1.0-beta.1` tag,
the package version, merge, and publication follow the
[release checklist](release-checklist.md) under the owner's release authority.
The [operator guide](operator-guide.md) and README cover setup and operation;
follow-ups are in the [session handoff](session-handoff.md).
