# Beta candidate release notes

Status: release candidate; publication is not authorized by these notes.
Proposed tag: `v0.1.0-beta.1`. `package.json` still says `1.0.0`; changing it,
merging, tagging, and publishing are the owner's decisions. Evidence:
[M9 acceptance](acceptance.md). Procedure: [release checklist](release-checklist.md).

## Changelog for the candidate

- M1-M3 established local authentication, durable ticket and attachment state,
  role execution, saved plans, acceptance, writer admission, and reconciliation.
- M4-M5 added the nine-role delivery pack, capability checks, model catalog,
  account status, effective settings, and versioned run snapshots.
- M6 added read-only Jira/Confluence Intake with internal source provenance and
  guarded OAuth egress. It does not publish to Atlassian.
- M7 added operator pause/stop/cancel, bounded corrections, candidate-bound
  review, and explicit commit/push with repository ownership checks.
- M8 completed six backend-driven tabs, run/usage views, durable telemetry,
  an isolated prompt comparison, and an optional bounded MLflow Tracking export.
- M9 hardening:
  - Codex permission profiles: application-overlapping workspaces rejected;
    carve-outs emitted only for existing paths, so Codex 0.160 no longer leaves
    placeholder files in task repositories; `.codex`, `.agents`, and `.claude`
    are real directories that roles can only read; thread bindings stay stable.
  - Acceptance: stricter check isolation, scope-aware snapshots; a role's
    self-reported out-of-scope file is a visible non-blocking warning when the
    server attested the real delta, while attested violations still block.
  - Lead recovery: invalid lead decisions are discarded with the error fed back
    (two in a row end the run); resolutions for decisions the operator already
    answered are ignored; schemas state their cross-field rules.
  - Protected Git: commits bound to ticket branches and reviewed staged blobs,
    writer admission held during commit, one push per commit and remote.
  - Operator controls: Stop/Cancel reconciliation and hold boundaries fail closed.
  - Diagnostics redaction across persisted and operator-visible paths.
  - Dashboard: Connections tab loads reliably with bounded requests, role table
    scrolls, mutating ticket actions are disabled while disconnected, the Board
    marks stale data, the header works at 390 px; settings snapshots record the
    App Server version.
  - Docs: operator guide, state upgrade/backup/restore corrections, security
    review, release checklist, README quickstart, session handoff.

## Verified on the candidate

- Commit `e8eca67` on `feature/dashboard-integration`, functional fingerprint
  `d7169fa124a7fb1da31841f27b19fe77346d47b3ce781e0d36115b776a360a90`
  (command in the release checklist).
- Full suite 960/960, fake role cases 10/10, `git diff --check` clean, protected
  dashboard reference unchanged, server serves `web/dashboard` only.
- Network-fresh install in a clean copy: `npm ci` 130 packages, 0
  vulnerabilities, full suite green (941/941 on the tree of that day).
- Both primary scenarios end to end on real model turns through the browser:
  a direct ticket with a correction round, Accept, Commit, Push; a Jira issue
  imported read-only, reviewed, accepted, and committed, with a clean egress audit.
- Manual recovery, upgrade, backup/restore, two-ticket lease, revision history,
  reconnect/error states, and layouts; see acceptance.

Tested combination: Node.js 24.21.0, npm 12.1.0, Codex CLI 0.160.0 with a
ChatGPT login. This is not a support range.

## Waivers by the owner

- Hosted Git remote and credential helper were not exercised; pushes were
  verified against a local bare remote. The owner creates pull requests.
- Live pilots ran every role on `gpt-6-luna` to save quota, not on the shipped
  Sol profiles for the coordinator, architect, reviewer, security, and the Sol
  repair executor.

## Known limits

- One local operator, a trusted task repository, one writer at a time; not a
  hosted multi-user service. Session cookies are host-scoped across loopback
  ports; run on a trusted machine.
- Model quality is uneven and only bounded live evidence exists: developer, PM,
  architect, and technical writer passed their live case; QA, performance, and
  DevOps each failed one case on model behavior; reviewer and security have only
  fake-protocol evidence. The product fails closed on invalid model output.
- A run whose finish gate rejects after every stage succeeded cannot reopen
  stages; answer the stop/leave option, then Return to Backlog and Submit.
- A clean stop cancels executing runs (Pause first); a crash leaves them
  resumable.
- A commit recorded as `unknown` is terminal; inspect the branch and push with
  Git directly if needed.
- Paths an agent creates during a run are not carved out for already loaded
  threads. Top-level `.runtime`, `runtime`, `data`, and `.env` in a task
  repository are hidden from agents.
- Codex may report a different reasoning effort than requested; the run view
  shows the difference per attempt.
- Atlassian: read-only, no project or space allowlist (use a dedicated
  restricted account), linked issues are not traversed, PKCE not verified.
- The M9 live Jira pilot completed one issue through review and commit.
  Repeated validation across varied real Jira tasks, including epic and
  Confluence context through delivery where available, is planned for the next
  live project and is outside the M9 exit gate.
- Production MLflow adoption is deferred; the exporter logs bounded sanitized
  Tracking runs. The M8 prompt candidate showed no improvement and was not
  promoted.
- Usage and cached-token coverage can be partial; monetary cost is unavailable
  for subscription usage.

Deferred follow-ups are listed in the [session handoff](session-handoff.md).
