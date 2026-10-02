# M9 session handoff

Last updated: 2026-10-02 (lead session). Read this first when resuming M9; then
[acceptance](acceptance.md), [security review](security-review.md), and the
[release checklist](release-checklist.md). Nothing is committed yet; all M9 work
is in the working tree of `feature/dashboard-integration` on top of `7f1906f`.

## Owner decisions in force

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

## Pilot state at handoff

- Server: `node src/server.js` on port 3000 with `CODEX_WORKSPACE=/home/sr/Projects/Workspace/m9-pilot/direct/task`,
  `CODEX_A2A_STATE_DB=.../direct/state/state.sqlite`, `CODEX_A2A_TOKEN_FILE=.../direct/state/a2a-token`,
  `CODEX_ATLASSIAN_CONFIG=/home/sr/.config/orchestrator-atlassian/config.json`. Restart it after the
  acceptance fix lands (backend code changed).
- Ticket `tkt_J4zzRx3DYKRC6c7Llnlh4w` is `blocked` on branch
  `feature/add-formatprice-cents-helper-lnlh4w`; untracked `src/price.js` and
  `test/price.test.js` are the latest correct candidate files (RangeError version).
  Runs: `run_d5PYJyH1fi4oifr2o8iYMQ` (rejected, sandbox bug), `run_OqPqYY8OmcQ4ZYalWqg7Pw`
  (resubmit, reached review), `run_2EBmv6E6SPMvTSTrZlpVtA` (rework, rejected by the gate defect).
- Bare remote: `/home/sr/Projects/Workspace/m9-pilot/direct/remote.git` (main only so far).

## Next steps

1. Verify the acceptance fix diff, run the full suite, then restart the pilot
   server on port 3000 with the same environment.
2. Return to Backlog and Submit the direct ticket; at review request one small
   correction; confirm the rework candidate is accepted with any warning shown;
   Accept, Commit, Push; confirm Push is no longer offered; `git ls-remote` the bare remote.
3. Import `KAN-1`, check provenance and internal tracking, run it to review,
   Accept, Commit; run the read-only egress audit (docs/m6/operator-setup.md).
4. Stop the server. Update [acceptance](acceptance.md) and
   [release notes](release-notes.md) with the evidence and limits below; recompute
   the fingerprint with the command in the [release checklist](release-checklist.md);
   rerun the full suite, `--fake` role cases, `git diff --check`, and the reference check.
5. Ask the owner to delete `KAN-1` in Jira and decide on commit. The zero-byte
   placeholders `data`, `runtime`, `.codex/auth.json`, `.codex/sessions` in this
   repository root must not be committed.

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
