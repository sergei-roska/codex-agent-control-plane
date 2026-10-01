# M6 live pilot plan

Date: 2026-10-01. Status: operator OAuth app connected with read-only scopes;
phase 1 done, see [live pilot report](live-pilot-report.md); phase 2 pending. Site: `insomniacdesign.atlassian.net`
(cloud ID `0a0664d0-92e4-45ce-a079-98138872173f`).

## Approved sources

| Role | Issue | Why it fits |
| --- | --- | --- |
| Feature | INSDEV-406 "ADR5 - Migrate Google reCAPTCHA to Google Cloud Platform" | Story, In Progress, epic INSDEV-403, two Confluence remote links (pageId 1506181122 ADR, pageId 1527021591 migration guide), eight `relates to` links into client projects (not traversed, see below) |
| Bugfix | INSDEV-408 "Custom Font Icons loading issue" | Jira type is Story but content is a defect report (expected/actual, impact, workaround); epic INSDEV-1, seven comments, link to Bug PSPME-751. Confirms Intake classifies by content, not by Jira issue type |

Both are internal (INSDEV, category Internal). Phase 1 showed Jira issue links are
not traversed. M6 scope is the issue, comments, parent/epic and linked Confluence
content, so client-project issue text does not enter Intake context. This is a scope
clarification, not a gap.

## Zero-trace constraint (owner decision)

The owner requires no traces in Jira. Neither the orchestrator nor the lead or any
worker creates, edits, transitions, or comments on issues or pages. All reads only.

- The dedicated app is registered with read scopes only, as listed in
  [operator setup](operator-setup.md); no `write:*` scope is granted.
- The only expected visible artifact is the app authorization in the owner's
  Atlassian connected apps.
- Verification of zero external writes: the runtime egress guard refuses anything but
  GET to Atlassian resource APIs and the fixed OAuth token POST, and persists every
  request as an `atlassian_egress` event. The violation query in the
  [egress audit](operator-setup.md#egress-audit) must return no rows.

## Gate coverage

| Gate item | How it is exercised |
| --- | --- |
| Feature and bugfix pass Intake with provenance | Import INSDEV-406 and INSDEV-408, run PM Intake, inspect source provenance and saved snapshots |
| Missing epic/page | Leave one linked Confluence page or space outside the granted/selected access so it stays visible as missing context; if not feasible, import a third approved issue without an epic |
| Expired credentials | Invalidate the stored token locally (revoke the app grant or corrupt the local token record), then refresh; expect a redacted reconnect state and preserved evidence |
| External edits | Owner decision: wait for an organic change to INSDEV-406 between two imports. If none occurs by pilot end, accept fixture-level evidence (new Backlog revision, pinned run input, pending context) and record the waiver in acceptance |
| Repeated requests | Import the same key twice and by numeric ID; expect the same internal ticket and no new run |
| Outage recovery | Block Atlassian egress during refresh; expect preserved snapshot and progress, then successful refresh after restore |
| No publication | Egress audit violation query returns no rows |
