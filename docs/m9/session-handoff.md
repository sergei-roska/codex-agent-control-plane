# M9 session handoff

Last updated: 2026-10-02 after M9 closure. The release candidate is recorded in
[acceptance](acceptance.md); also review the [security review](security-review.md)
and [release checklist](release-checklist.md). M9 implementation and pilot work
is complete on `feature/dashboard-integration`; merge, tag, and publication remain
owner decisions.

## Owner decisions in force

- CDB live pilot authorized (2026-10-06): run the 24 owner-supplied issues in
  `/home/sr/Projects/dccourtscode`, base `dccr-master`, one local task branch per
  issue (`feature/CDB-N` or `bugfix/CDB-N`). Execute work, preserve results
  locally, supervise the orchestrator and fix its bugs. No Jira status/comments
  or other writes, no push, PR, or merge. All roles must use Luna. Local commits
  are the preservation strategy discussed before the owner's start instruction.
  Inspect every candidate before accepting/committing. Never read SQL dumps.
- Current delivery defaults (owner instruction, 2026-10-06): all eleven roles
  use `gpt-6-luna`; Project Manager and Architect use `xhigh`, all other roles,
  including both repair executors, use `high`. This supersedes the earlier
  pilot-only model choice below. Saved operator overrides still take precedence.
- All Codex roles run on `gpt-6-luna` for pilots to save quota. The owner set the
  five Sol-profile roles to Luna in the pilot state's model settings; shipped
  profiles are unchanged.
- Live role checks: approved and run. Reviewer and security live checks are
  skipped (Sol by profile); record them as a beta limit.
- Hosted Git remote and credential helper: waived for beta; evidence is push to a
  local bare remote. State the waiver in release notes.
- Real Jira pilot uses temporary issue `KAN-1` (site insomniacdesign, project KAN),
  created by the lead through the claude.ai Atlassian connector. The owner wants
  all Jira traces removed afterwards; the connector cannot delete issues, so the
  owner deletes `KAN-1` manually at the end.
- The Atlassian OAuth redirect is registered for port 3000, so the Jira part runs
  on port 3000.
- Commit verified work promptly on `feature/dashboard-integration` (owner
  instruction, 2026-10-02); never commit the zero-byte placeholders `data`,
  `runtime`, `.codex/auth.json`, `.codex/sessions`. Push, merge, tag, and
  publication need a separate owner instruction.

## Evidence collected this session

| Area | Result | Where |
| --- | --- | --- |
| Full suite | 953/953 after the sandbox fixes (rerun required after the acceptance fix) | `node --test test/*.test.js` |
| Clean network install | 285 files copied, `npm ci` 130 packages, 0 vulnerabilities, 941/941 | fresh copy, removed afterwards |
| Idempotency review | 6 properties mapped to code and tests; push-after-success gap fixed; new tests added | security review, second table |
| Manual recovery (fake model) | Upgrade v2->v6 with 0600 backup, SIGKILL interrupt and Resume, SIGTERM cancel and resubmit, offline/online backup and restore, two-ticket lease, revision history: all pass | `/home/sr/Projects/Workspace/m9-pilot/recovery/` |
| Browser checks (fake model) | Six tabs, server down/up, session revoke, 390/1280/1600 layouts; defects fixed afterwards | `/home/sr/Projects/Workspace/m9-pilot/browser-checks/` |
| Live role checks | architect PASS (Sol, `--live`); qa FAIL (Sol reviewer reported filesChanged with empty delta); tech-writer PASS, performance FAIL (no MEASURED/HYPOTHESIS labels), devops FAIL (invalid decisionRequest recommendation) on Luna `--live-workers`; developer and pm PASS earlier | logs in the session scratchpad `m9-live-roles/` |
| Live direct pilot | Run 1 hit the sandbox placeholder bug and was rejected fail-closed; resubmit run reached review in about 6 min with a passing check and a confined diff; settings snapshot pinned gpt-6-luna for all 11 roles; usage 1.63M tokens, 77% cached share, monetary cost unavailable; correction run produced a correct candidate but was rejected by the acceptance gate (fix in progress) | `/home/sr/Projects/Workspace/m9-pilot/direct/` |

## Defects found and fixed this session

1. Codex 0.160 placeholder files from permission-profile carve-outs broke QA and
   dirtied task repos (critical). Fixed in `src/permission-profile.js`.
2. Writer could create `.codex/config.toml` after (1). Fixed: `.codex`, `.agents`,
   `.claude` ensured as real directories, read-only to writers.
3. Second push of a pushed commit (medium). Fixed in `src/product-store.js` and
   `src/dashboard-api.js`.
4. Schema hints for decision/report cross-field rules; App Server account timeout;
   Connections tab load/clip; stale actions while disconnected; Board stale label;
   mobile header (low). Fixed.
5. Acceptance gate rejected rework because a role's self-reported `filesChanged`
   outside scope blocked even when the attested delta was empty. Fixed: with a
   known writer delta, reported-only items are non-blocking
   `reported_scope_mismatch` warnings shown in review, also in `isStageSuccess`;
   attested violations and unknown deltas stay blocking. Settings snapshots now
   read `appServer.appServerVersion` (still null before the App Server initializes;
   `src/server.js` passes a nonexistent `appServer.version`, harmless cleanup item).

Checkpoint commit: `77da677` (full suite 956/956, fake role cases 10/10,
reference unchanged). The pilot resumed on that commit.

6. On `77da677` the resubmit run `run_0n7ucWh9uMKGuiAqkECk5w` reached review in
   about 8 minutes, accepted, confined diff, settings snapshot with gpt-6-luna for
   all roles and the App Server version; usage 2.65M tokens, 75% cached share.
   Its rework run `run_uXRuaXCgW4jyfR6CjQ2eMw` (JSDoc correction) is `interrupted`:
   (a) the read-only reviewer was denied `.codex` and Git called it unreadable;
   (b) after the operator answered, the lead resolved an already closed decision
   and validateDecision threw "Resolution references a decision that is not open",
   which interrupts the run and repeats on Resume. In progress at this point:
   read-only roles get `.codex: read` with the auth/sessions glob denies; resolutions
   for already closed decisions are ignored; other invalid lead decisions are
   discarded with the error fed back, ending the run after two in a row.
   Plan after the fix: commit, restart the server, and press Resume on the
   interrupted rework run (cheaper than a new resubmit, about 2.6M tokens per run).

7. Fixed in `6a88756` (960/960): read-only roles read `.codex` (auth/sessions
   globs denied); resolutions for already closed decisions are ignored; other
   invalid lead decisions are discarded with feedback, two in a row end the run.
   README rewritten as an operator quickstart in `4d6ffa2`.

## Final pilot status (lead verified, 2026-10-02)

Both primary scenarios completed on real gpt-6-luna turns through the browser;
the pilot server is stopped and the task repository is clean.

- Direct ticket `tkt_J4zzRx3DYKRC6c7Llnlh4w`: the interrupted rework run
  `run_uXRuaXCgW4jyfR6CjQ2eMw` resumed cleanly on `6a88756` (reviewer had no
  `.codex` problem), reached review about 3.5 minutes later with an accepted
  candidate (check passed, diff only `src/price.js` and `test/price.test.js`),
  then Accept, Commit `b99cb0e`, Push. The bare remote has
  `refs/heads/feature/add-formatprice-cents-helper-lnlh4w b99cb0e`; `main` is
  unchanged at `626e392`. After the push the dashboard shows "This commit was
  already pushed" and "The candidate is already committed".
- Jira `KAN-1` as `tkt_zkq4qvb46RERTRprU7R_yw`: Jira identity, source revision,
  snapshot, and "Internal ticket only" tracking shown; run
  `run_nh9ltH1R5NQxfv8bUMBnrw` reached review in about 21 minutes with an accepted
  candidate confined to `src/discount.js` and `test/discount.test.js`; Accept and
  Commit `8fdb8d5` (not pushed). Egress audit: 16 events, two OAuth token POSTs
  plus GETs only, violation query `[]`.
- Quota before the last model work: 5 h window 10% used, 7 d window 73% used.
- Pause/Resume during engineering was exercised on the first run: no dispatch
  while paused.
- Logs: `/home/sr/Projects/Workspace/m9-pilot/direct/server-3000*.log`.

## Next phase: owner plan (week of 2026-10-05)

0. Visual review of the dashboard working copy (`web/dashboard`) on a running
   server: walk every tab, modal, and state (empty, loading, error, reconnecting,
   not paired) at desktop and 390 px, and fix obvious visible inconsistencies or
   errors. Use the protected reference `artifacts/dashboard` only as read-only
   design evidence; never edit or rebuild it, and include the reference integrity
   check in verification. Screenshots must be saved under
   `/home/sr/Projects/Workspace/m9-pilot/` (the session scratchpad does not persist).
1. Role deep dive for the nine delivery roles: system prompts
   (`profiles/delivery/agents/*.toml`), a skills matrix, permissions (sandbox and
   the generated permission profile in `src/permission-profile.js`), and MCP
   servers per role, keeping the number of tools and skills at the useful minimum.
   Starting points: `docs/m0/roles-tools.md`, `docs/m4/implementation.md`,
   `src/role-pack.js`, `scripts/role-capability-check.js` (fake and live cases to
   measure each change).
2. Live-project validation: the owner runs a varied set of real Jira tasks through
   the dashboard and reviews outcomes. Where available, include epic and
   Confluence context through the full delivery lifecycle. This repeats and broadens
   the M9 issue pilot; it is a follow-up, not an M9 exit gate. A Claude observer can
   inspect state DB, server log, dashboard API, and task repository status read-only
   and record findings into the backlog; it does not drive runs or write to Jira.
3. Delivery path end to end: how the orchestrator starts a task, creates and owns
   the branch (`branchPrefixes`, ticket-owned branch, lease), drives it to an
   accepted candidate, commits and pushes, and, if feasible, opens a Bitbucket
   pull request. A PR is a new outward write: it changes the beta decision "the
   owner creates the pull request" and needs an owner decision, candidate-bound
   authorization, Bitbucket credentials and egress allowlist, idempotency, and a
   hosted-remote push test first (still waived in M9).

## Deferred follow-ups (not fixed in M9; plan for later)

- `src/server.js` passes a nonexistent `appServer.version`; drop it (the
  controller now reads `appServer.appServerVersion`).
- `docs/operations/state-upgrade.md` table lacks `CODEX_PROJECT_CONFIG` and
  `CODEX_A2A_WORKSPACE_LOCK_DIR`; the operator guide attributes the CODEX_HOME
  check to the server preflight, but it is enforced in `src/permission-profile.js`.
- A run whose finish gate is rejected after all stages succeeded cannot reopen
  stages and the lead loops on decisions; add a terminal path or an operator
  "reopen stage" action.
- `unknown` commit deliveries are never re-reconciled; re-reconcile them and
  consider blocking Release Repository while one exists.
- Commit/push uniqueness has no DB constraint; add a partial unique index.
- With several push remotes the UI stops offering Push after the first success
  (ticketActions has no remote list); the API still allows other remotes.
- Reasoning effort reported by Codex differs from the requested one (architect
  xhigh reported high; others "high/default"); find out whether the effort is
  sent per turn correctly or Luna caps it.
- Live role evidence: rerun performance and devops on Luna after the schema
  hints; reviewer and security live cases are still missing.
- Session cookies are host-scoped across loopback ports (per-origin secret);
  Atlassian project/space allowlist; Atlassian PKCE verification; remove or
  escape the inactive escalation modal `innerHTML`.
- `.gitignore` only ignores `data/` and `runtime/` as directories; the zero-byte
  placeholder files `data`, `runtime`, `.codex/auth.json`, `.codex/sessions` in
  this repository root should be deleted and ignored.
- Screenshot evidence from browser workers sits in the session scratchpad
  (`/tmp/claude-1000/...`), which does not survive the session; the MCP screenshot
  tool refuses paths outside its roots. Copy needed evidence into
  `/home/sr/Projects/Workspace/m9-pilot/` next time.
- M9 closure done on 2026-10-02: acceptance and release notes final, release
  checks rerun on `e8eca67` (960/960, fake 10/10, diff check, reference check),
  fingerprint `d7169fa124a7fb1da31841f27b19fe77346d47b3ce781e0d36115b776a360a90`.
  Owner decisions: keep `/home/sr/Projects/Workspace/m9-pilot/`; `KAN-1` cannot be
  deleted by the owner (no permission) or the connectors, the owner handles it
  with a KAN administrator - do not write to Jira again without the owner's
  explicit request. Version, merge, tag, and publication per the release checklist.
- The owner has not personally repeated the pilot scenarios. Repeated owner-run
  checks across varied Jira tasks, including epic and Confluence context where
  available, are deferred to the next live project and do not block M9 closure.
  Shipped Sol profiles were not exercised live; run a pilot on those profiles
  before building on them.

## Limits to record in release notes

- Reviewer and security roles have no live evidence; performance and devops failed
  their single live-workers case on Luna; qa's live case failed on the reviewer's
  self-report (now a non-blocking warning class).
- A run whose finish gate is rejected after all stages succeeded cannot reopen
  stages; the operator answers the stop/leave option, then Return to Backlog and Submit.
- Codex may report a different reasoning effort than requested; the dashboard
  shows "differs" per attempt.
- A clean stop cancels executing runs; a crash leaves them resumable.
- `unknown` commit deliveries are terminal; inspect and push with Git directly.
- Paths created by an agent mid-run are not carved out for already loaded threads.
- Hosted Git remote waived; top-level `.runtime`, `runtime`, `data`, `.env` in a
  task repo are hidden from agents.

## Operator startup checkpoint: dccourtscode

The owner requested startup for `/home/sr/Projects/dccourtscode` on 2026-10-06.
No application server was listening on port 3000; Codex ChatGPT login passed.
Plain `npm start` reproduced the workspace/application overlap rejection because
`CODEX_WORKSPACE` defaults to the application checkout. The target is a separate
repository with current branch `dccr-master`.

Started the live server with isolated state, token, and workspace locks under
`.runtime/dccourtscode/`. Its operator policy `project.json` sets
`baseRef` to `dccr-master`; no checks were inferred. The previous default state
and `.runtime/projects.json` refer to tower-defense and were left unchanged.
Verified dashboard HTTP 200, pairing/session creation, and authenticated context
reporting the exact dccourtscode workspace. Browser automation was unavailable;
a fresh pairing URL was issued for the owner. No ticket or model run was started.
The target has existing untracked files; clean-workspace admission may require
operator attention before submitting a ticket. No target files were changed.
Protected dashboard reference remains unchanged.

Repeat launch from the application checkout:

```bash
CODEX_WORKSPACE=/home/sr/Projects/dccourtscode \
CODEX_A2A_STATE_DB="$PWD/.runtime/dccourtscode/state.sqlite" \
CODEX_A2A_TOKEN_FILE="$PWD/.runtime/dccourtscode/a2a-token" \
CODEX_A2A_WORKSPACE_LOCK_DIR="$PWD/.runtime/dccourtscode/workspace-locks" \
PORT=3000 npm start
```

Fresh pairing URL while this instance is running:

```bash
CODEX_A2A_TOKEN_FILE="$PWD/.runtime/dccourtscode/a2a-token" \
PORT=3000 npm run dashboard:pair
```

The owner then reported Chrome pairing failure `Origin not allowed`. Exact
browser request headers and URL remain unobserved; valid-origin local API pairing
passes. Applied a bounded compatibility mitigation: dashboard `Referrer-Policy`
is now `same-origin`, avoiding the historical browser interaction between
`no-referrer` and a null Origin without changing the strict origin/host guards.
Cross-origin referrers remain suppressed. Added regression assertions for the
served policy and literal `Origin: null` rejection, with the rejected code still
usable for a valid request. Focused checks: dashboard auth 13/13, Atlassian API
5/5, diff check and protected reference check pass. Restarted the instance on
this change; owner Chrome verification remains pending. Do not describe the
reported browser root cause as confirmed without observing its request.

Browser verification then succeeded through the connected `chrome-devtools` MCP
(the earlier `cua_repl` browser inventory was empty, not a general browser-tool
limitation). Opened a dashboard tab: `dccourtscode`, `Session: connected`, POST
session 204 and context/roles/cards 200. In that Chrome 154 context, diagnostic
invalid-code requests under both `no-referrer` and `same-origin` policies returned
401 rather than Origin rejection. Therefore the owner's original rejection is
still unexplained; the header change remains a compatibility mitigation, not
proof of a current Chrome defect. The connected browser may have a separate
profile from the owner's failing tab.

The owner repeated the Origin failure and confirmed the exact URL
`http://127.0.0.1:3000/dashboard/` in Google Chrome. Added bounded Origin
diagnostics to the rejection response: missing, literal null, parsed scheme/host,
or unparseable, plus the expected live-port origins. Credentials, paths, queries,
fragments, request body and cookies are never echoed; the allowlist is unchanged.
Dashboard auth tests 13/13 pass; diff/reference checks pass. Verified live
`Origin: null` rejection with diagnostic text and an independent clean Chrome
context pairing successfully (session 204; context/roles/cards 200). The owner
paused work, then authorized continuing. Server remains running with this
diagnostic change. Waiting for the new error from the owner's failing profile
before choosing the actual fix; do not weaken Origin validation speculatively.

The owner's new diagnostic confirmed a portless Origin `http://127.0.0.1`
despite the page URL including port 3000. The component removing the port remains
unknown. Implemented a narrow compatibility path, independently audited: raw
portless loopback Origin must match the validated live-port Host hostname,
`Sec-Fetch-Site` must be exactly `same-origin`, and a bounded absolute,
credential-free Referer must have that exact Host origin including the port.
All three are required. Missing/null/foreign Origins and missing/mismatched
evidence remain rejected; no generic portless allowlist or forwarded-header trust.
Security rationale: [Fetch Metadata](https://www.w3.org/TR/fetch-metadata/#sec-fetch-site-header)
distinguishes same-origin from same-site and its Sec headers cannot be set by
website JavaScript. Diagnostic output remains sanitized and bounded.

Verification: dashboard auth 15/15, dashboard API plus Atlassian API 13/13,
independent guard audit two acceptance and 14 denial cases, diff/reference checks.
Restarted the server; live portless pairing with both corroborating headers
returned 204, authenticated context 200, and another-port request 403. Issued
a fresh owner pairing link; the owner confirmed "works" in the previously
failing Chrome profile. Startup/pairing issue is resolved. The dccourtscode server
remains running on port 3000; no tickets or model runs were started.

## Simple launcher checkpoint - 2026-10-06

The owner requested a single `node launcher.js` command and a local browser form
for choosing a project and starting its server. Implemented an independent
launcher at `http://127.0.0.1:3100/` with Start server, Open dashboard, Stop server,
recent repositories, and optional dashboard port selection. Start/Open obtain a
fresh pairing URL and open the dashboard; no terminal pairing step is required.
The launcher starts only one owned child, never stops an existing port owner,
and closes its child on Ctrl+C. Failed cleanup retains ownership and permits
Stop retry instead of allowing a replacement process.

Each canonical repository has private state under
`.runtime/launcher/projects/<sha256>/`. Existing manual state and project policy
are preserved. Initial baseRef is selected from a local default/main/master or
current branch; dccourtscode resolves to `dccr-master`. The child uses the normal
Git common-directory workspace lock, including across worktrees; an inherited
custom lock-directory override is removed. Manual instances with custom lock
directories must be stopped before using the launcher for the same repository.

Implementation workers owned runtime/API and independent UI files; a read-only
audit found and verified correction of the lock-domain issue. Root reviewed the
implementation and tests. Final focused launcher/dashboard API/auth checks:
36/36 pass with local sockets allowed. The initial sandbox run could not execute
socket-based dashboard auth checks. Launcher API tests exercise the Express
middleware stack; actual network behavior was verified separately in Chrome.

Browser evidence: missing-folder error, temporary Git project startup on port
3001, automatic session pairing, Stop, occupied-port rejection without touching
the existing server, real dccourtscode startup on port 3000, Open dashboard,
SIGINT cleanup of both owned processes, offline status without a false stopped
claim, and restart with the remembered project. After restart dccourtscode is
running again; the temporary smoke entry was removed from recents. Target Git
status before/after is unchanged. Protected `artifacts/dashboard/**` diff and
whitespace checks pass. No tickets or model runs were started.

Current local state: launcher on port 3100 and its dccourtscode child on port
3000. The earlier manual dccourtscode process was stopped to free port 3000;
its `.runtime/dccourtscode/` data remains intact. Operator instructions are in
`docs/operations/launcher.md` and the README. No push or publication is authorized.

## Atlassian launcher configuration checkpoint - 2026-10-06

The owner reported that the previously tested Confluence connection was missing.
The launcher inherited `CODEX_ATLASSIAN_CONFIG` only; plain startup therefore
omitted the existing configuration when that variable was absent. It now discovers
an existing standard user configuration under absolute `XDG_CONFIG_HOME` or
`~/.config/orchestrator-atlassian/config.json`. Explicit overrides, including
empty disable, retain precedence; absent defaults leave the connector optional.

Read-only diagnosis found the existing configuration valid for dccourtscode on
port 3000, but the saved token store read returned `credential_store_failed` for
that workspace. Tokens are workspace-bound; a different prior workspace is a
possible cause, not a proven diagnosis of this generic error. No credential
write, OAuth handoff, or external request was performed. Fresh launcher state
also has independent site selection. Owner reconnect/site selection may remain
necessary after restarting the launcher. This session could not observe the
previously running launcher or dashboard process; do not claim a live restart
or restored connection. Focused launcher runtime/server checks, whitespace and
protected dashboard reference checks passed.

## Launcher field guidance checkpoint - 2026-10-06

The owner requested an empty initial project path and self-contained guidance
for every launcher field. Removed automatic recent-project prefill; explicit
recent selection still fills the path and polling preserves user input. The path
placeholder is `/path/to/project`. Project path, recent projects, and port now
have visible descriptions connected through `aria-describedby`, including local
Git repository requirements, explicit selection behavior, allowed ports, the
default dashboard URL, and Atlassian callback port requirements.
Verification: JavaScript syntax, bounded inspection of all three field helper
associations and the remaining path assignment, whitespace, and protected
dashboard reference checks passed. No live browser check was performed.

## Delivery default models checkpoint - 2026-10-06

The owner requested Luna high for workers and Luna xhigh for managing roles in
Connections & Models. Updated delivery profile defaults: Project Manager and
Architect are the managing roles; the remaining nine entries, including repair
executors, use high. The settings API derives unsaved defaults from these profiles.
Saved overrides retain precedence and active runs retain pinned settings.
The updated defaults require a server restart to reload the role pack.
Verification: role-pack, settings-store, dashboard-settings, and delivery-pack
checks passed with loopback enabled: 71/71, no skips. Updated stale default
expectations and the removed-model fixture without weakening the checks.
Whitespace and protected dashboard reference checks passed.

## Dashboard field guidance and Atlassian site checkpoint - 2026-10-06

The owner extended field guidance to the orchestrator and requested that checks
remain focused rather than running the full suite for copy changes. Active
ticket, run, decision, source snapshot, Git delivery, board, monitor, Atlassian,
and per-role model controls now have visible guidance and accessible description
links. Inactive provider and approval prototypes were excluded; Battle Pass and
the protected dashboard reference were not changed.

The owner also reported that the Atlassian site did not persist between sessions.
Backend selection is durable in the same project's SQLite database, verified by
closing/reopening a file database and recreating the integration. The frontend
previously hid the selector until available sites were loaded again. It now
renders the saved cloud ID from connection health immediately, preserves an
explicit unsaved selection during rerenders, and clears the draft on disconnect
or OAuth completion. Display restoration performs no automatic network request
or site selection; the existing backend checks still apply on save/import.
Completing a new OAuth authorization intentionally clears site selection.
Verification: focused connection-render checks 4/4 and Atlassian integration
checks 7/7 passed, without real credentials or network access. Changed JavaScript
syntax and active-field helper links were inspected. Regenerated only
`web/dashboard/index.html`; whitespace and protected reference checks passed.
No full suite or live browser run was performed for these changes.

## CDB pilot startup checkpoint - 2026-10-06

Target checkout verified clean on `dccr-master`, baseline
`9ef992e892e8b550ad8560665be70bf2b711dd95`. Launcher owns the active port-3000
server and uses `.runtime/launcher/projects/d94a686bc9927c4423122555ec9fd6041e24f83a84fea78da5253204b7ebe450/`.
Atlassian health is connected/read-only at insomniacdesign; all eleven effective
role selections are Luna with xhigh for PM/Architect and high otherwise.
CDB-390 imported as `tkt_J8P1I70Vdl4nokTMWLaWWQ` (backlog, no model run yet),
title "Fix duplicate array keys in b4main theme settings".

Fixed the first setup incompatibility: Jira branch naming now uses the validated
source display key rather than a title slug/internal suffix. Direct-ticket naming
and existing ownership/collision guards remain intact. Git adapter checks 24/24
and delivery controller checks 53/53 passed with Git/socket permission; no full
suite. Private project policy now pins feature/ and bugfix/ prefixes and provides
the minimum whitespace check; this is not a functional Drupal check. Run relevant
task checks through Lando separately and record their actual results. Do not use
`run-code-analysis.sh`: it runs phpcbf and composer require, so it mutates files.
Drupal MCP could not resolve a project root; Lando is installed and reports the
local dccourts environment. AGENTS.md references missing spec-start-ticket.md and
spec-model-selection.md; no matching files found. User explicitly authorized
execution and pinned Luna; use ticket evidence and the orchestrator plan gates.

Queue, in owner order: CDB-390, CDB-389, CDB-388, CDB-387, CDB-386, CDB-384,
CDB-383, CDB-382, CDB-381, CDB-380, CDB-378, CDB-377, CDB-372, CDB-370,
CDB-369, CDB-368, CDB-367, CDB-366, CDB-365, CDB-364, CDB-363, CDB-362,
CDB-360, CDB-359.

## CDB target mismatch checkpoint - 2026-10-06

All 24 issues imported successfully as internal tickets, with source snapshots
and no Jira writes. CDB-390 run `run_E5jEsl72p82Wmv_YnEOoeA` and CDB-389 run
`run_99xb_sMWMt7L_kyWHB1lHg` both correctly stopped at Intake for missing target
code, before planning, branch creation, or candidate edits. CDB-390 was initially
returned to local Backlog while awaiting a corrected path.

The owner then confirmed that no other branches exist and explicitly instructed
cancellation of CDB-390 and subsequent tasks whose file or code is absent.
An exhaustive read-only comparison of all 24 descriptions against the tracked
`dccr-master` tree found no runnable targets. Ticket paths were checked with and
without the `web/` prefix; matching unrelated files are not substitutes. In
particular, `web/themes/custom/dccourts/theme-settings.php` does not replace the
missing b4main theme. Cancel these internal tickets only, preserving Jira state.
The local filename scan also included hidden, ignored, and untracked custom
module/theme files, with SQL dump globs excluded; targets remained absent.
All 24 local ticket cancellation commands settled successfully, with zero errors
or pending cancellations. Jira was not mutated. The target checkout remains
clean; no task branches, commits, pushes, pull requests, or merges were made.
Inventory evidence: `/tmp/cdb-pilot-inventory.json`; cancellation evidence:
`/tmp/cdb-pilot-cancellations.json`. The engineering workflow could not be tested
with these issue targets; do not describe the batch as implemented.

## Historical target investigation - 2026-10-06

Owner requested a historical base and conditional `test-dccr` branch if the
missing code exists. Read-only Jira metadata through the existing guarded OAuth
client confirms CDB-390 was created `2025-08-28T08:20:52.407-0400`, and CDB-359
`2025-08-26T08:41:13.775-0400`. No credential writes or Jira writes occurred.
Nearest dccr-master predecessors are `b49cb86bba3a1c94fa21eee86d0e4166b023bfa3`
and `e40c0f36ce4fcf21311a9820091dc769f2b6aa25`; both lack b4main, style_guide,
and cdb_projects_api targets. Local all-history searches likewise found no
target module paths.

Read-only discovery found `/home/sr/Projects/cdb` has the exact b4main theme
settings and style_guide controller in HEAD. Its current branch is
`upgrade/CDB-565`, with untracked `lancedb/` which must be preserved. The nearest
HEAD ancestor before both issue dates is
`8ebc63df2c48c16f1077273bea6ef555edc70c69` (2025-08-22). Owner clarification
about switching the pilot project is pending; no checkout, branch creation,
server retarget, or model run in cdb has been authorized yet.

## Corrected CDB pilot startup - 2026-10-06

Owner confirmed the project mix-up, restarted launcher for `/home/sr/Projects/cdb`,
connected Confluence, and authorized execution after checking target files.
This supersedes the historical-base proposal: use clean `master`, baseline
`a99ac3423e857a59581292e6f3d80f2d5a143fc2`. Existing pilot restrictions persist:
Luna for all roles, separate local feature/bugfix task branches, local commits
after inspected acceptance, no Jira writes, push, PR, or merge. No `test-dccr`
branch or historical checkout is needed for the corrected current project.

Read-only master inventory: 22 tasks have their stated targets. CDB-383's
ShapeAttributeSource.php is absent; CDB-359 has only one of six target files.
Exclude those two under the owner's missing-code cancellation instruction.
CDB-390's duplicate bg-danger keys and CDB-389's drupal_get_path call are both
still present. Do not substitute files or resurrect removed modules.

Active state is `.runtime/launcher/projects/e91fe54976e6370902ee1f74298f6dab2cd69a95dded070a336325c53a7db939/`.
Policy pins master, delivery roles, feature/bugfix/docs prefixes, and the minimum
whitespace check (not functional validation). Restarted the owned child before
any submissions; context confirms cdb and connected read-only Jira/Confluence.
Effective settings verify all eleven roles on Luna, PM/Architect xhigh, others
high. Original dcc inventory and cancellations remain separate evidence.

New import inventory is `/tmp/cdb-master-pilot-inventory.json`, generated by
`/tmp/cdb-import-queue.py`; imports are in progress. CDB-390 imported as
`tkt_L-i3IKBvWtQTLUxtAlxe-Q`, submitted to
`run_INqaskNN2MxyUMg4HN18HA`. Supervise sequentially, inspect actual candidate
diffs and relevant checks, accept and commit locally, then continue next task.
Never run the entire suite without a concrete need and never read SQL dumps.

All 24 imports completed. CDB-383 and CDB-359 were cancelled locally, leaving
22 viable tickets. CDB-390 completed all four stages on bugfix/CDB-390, with a
correct single-line deletion and passing approved whitespace check; lead also
ran `lando php -l themes/custom/b4main/theme-settings.php` successfully. Lando
created and removed its temporary PHP container; no site/database writes ran.
However, run finish is blocked: candidate_changed, acceptance unverifiable with
delta_unknown for all writers and snapshot_unavailable. Candidate
`cand_sgAWl0cqOkc4mtWhOulqMA` preserves the tiny diff; do not accept or commit
until attestation is repaired. Read-only investigation is assigned to
cdb_target_presence. Suspected workspace discovery cap in workspace-snapshot.js
is unconfirmed. Ticket version4, blocked; resubmit and return-to-backlog allowed.

Owner raised quota concerns and requested Codex default Luna xhigh. Updated
only root model/effort in `/home/sr/.codex/config.toml`; verified TOML parse.
Current chat model does not automatically switch; owner was told to use model
selector for this session. Keep lead work and monitoring compact, delegate
bounded implementation to Luna, and avoid unnecessary repeated model runs.

Snapshot defect confirmed and fixed: metadata-only discovery sees 69,826 entries
in cdb (old bound 65,536), vendor contributes 21,404; protected/depth bounds were
not exceeded. Raised finite discovery bound to 262,144 without excluding vendor
or nested .env protections. Preserved enumeration limit errors and distinguished
missing/unavailable snapshots from actual fingerprint changes in candidate gate.
Scoped worker changes reviewed by lead. Snapshot tests17/17 and focused controller
regressions passed; real-cdb helper now returns kind=git, one dirty entry, in about
0.5 seconds. No full suite. Original unknown writer deltas cannot be retroactively
attested; resubmit CDB-390 on its owned branch with the existing correct fix
preserved, then inspect the newly attested candidate before local delivery.

CDB-390 recovery run `run_bSFKL-nCqp35GO7xJfUY8g` needed one Intake answer:
the current duplicate-free file is the prior run's pending correction, not an
already resolved Jira task. Operator provided base/branch/run provenance and
asked to verify the existing diff without recreating the defect. All four stages
then passed, attestation accepted with no reasons/warnings, whitespace check0.
Lead rechecked the exact single deletion, accepted candidate
`cand_rpPGDSdj1nvy-plGYY4Ivg`, and committed through local delivery API:
`4d07be648c538fc6b83cd6406eb56875740f3bb4` on `bugfix/CDB-390`.
Target clean, master unchanged. CDB-389 next ticket
`tkt_hxQyC7P1V17msdhVKVJXAg` submitted; maintain sequential execution.

Owner then explicitly stopped further tickets and asked to stop subagents.
CDB-389 had already been submitted before the instruction; returned to local
Backlog and verified run `run_5A8iUmOZgC3H7AqLBdi07w` stopped/settled at Intake,
with no plan, branch, or candidate. All assistant subagents are completed and
none remain active. Do not resume the queue without a new owner instruction.
