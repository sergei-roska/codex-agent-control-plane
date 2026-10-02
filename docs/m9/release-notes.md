# Beta candidate release notes

Status: proposal, not an authorized release. Proposed tag: `v0.1.0-beta.1` after
the M9 exit gate passes. `package.json` currently says `1.0.0`; the proposal does
not change the package version or create a tag.

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
- M9 candidate hardening adds permission-profile checks for Codex threads,
  protected runtime path preflight, stricter acceptance execution isolation,
  scope-aware workspace snapshots, and dashboard status/navigation corrections.
  It also rejects application-overlapping workspaces, holds writer admission
  during operator commit, binds commits to ticket branches and reviewed staged
  blobs, redacts diagnostics across persisted/operator-visible paths, and
  closes Stop/Cancel hold and writer-lease gaps. M9 final acceptance remains open.

## Known limits

- The release is designed for one local operator and a trusted task repository.
  It is not a hosted multi-user service.
- A real network Git remote and credential helper have not been included in
  the current M9 evidence. Local bare-remote commit/push tests passed. The owner
  creates the pull request.
- Live Atlassian source traversal has been exercised, but linked issues are not
  traversed by the current provider. The current M9 browser fixture reached
  human review from an imported Jira issue, while the earlier real Atlassian
  pilot stopped at Intake. A real imported issue has not completed engineering
  and review on this candidate.
- Session cookies are host-scoped across loopback ports, and the connector has
  no Jira project or Confluence space allowlist. Operate on a trusted local
  machine with a dedicated, restricted Atlassian account; see the
  [security review](security-review.md).
- Production MLflow adoption is deferred. The exporter logs bounded sanitized
  fields to Tracking runs, not GenAI trace records. The M8 prompt candidate had
  no measured quality improvement and was not promoted.
- Usage and cached-token coverage can be partial. Monetary cost remains
  unavailable without measured data; hypothetical API cost is labeled separately.
- Full candidate tests passed 932/932 in the source checkout and a clean
  offline-cached install. Bounded real Developer and PM pilots each passed 1/1.
  Remaining Jira, hosted Git, and manual recovery evidence is tracked in
  [M9 acceptance](acceptance.md).

The [operator guide](operator-guide.md) covers installation, both ticket sources,
recovery, and troubleshooting. Release publication, merge, and tag creation need
the owner's separate release authority.
