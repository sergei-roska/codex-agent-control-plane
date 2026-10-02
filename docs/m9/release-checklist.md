# Beta release checklist

Status: procedure for the owner. Running it does not authorize publication; merge,
tag, and publication remain the owner's release decision. Evidence for the current
candidate is in [acceptance](acceptance.md).

## Freeze the candidate

1. Stop every local server started from this checkout.
2. Confirm the tree contains only intended changes: `git status --short`. The
   zero-byte placeholders `.codex/auth.json`, `.codex/sessions`, `data`, and
   `runtime` are sandbox artifacts; never commit them.
3. Recompute the functional fingerprint and compare it with the value in
   [acceptance](acceptance.md):

   ```sh
   { for d in src test scripts profiles web/dashboard; do find "$d" -type f; done; echo package.json; echo package-lock.json; } \
     | LC_ALL=C sort | xargs sha256sum | sha256sum
   ```

   A different value means the evidence no longer describes this tree; rerun the
   checks below before continuing.

## Required checks on the frozen tree

| Check | Command or procedure | Pass condition |
| --- | --- | --- |
| Full suite | `node --test test/*.test.js` (loopback binding required) | 0 fail, 0 skipped |
| Fake role cases | `node scripts/role-capability-check.js --fake` | 10/10 |
| Whitespace | `git diff --check` | no output |
| Protected reference | `sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt` | no output |
| Runtime UI path | `grep -rn "DASHBOARD_WEB_DIR\|artifacts" src/server.js` | `DASHBOARD_WEB_DIR` resolves to `web/dashboard`; no `artifacts/dashboard` path |
| Clean install | fresh copy without `node_modules`, `.runtime`, `.git`; `npm ci`; full suite | install succeeds, suite passes |

Live model checks are optional at release time, use the operator's quota, and need
the explicit `--i-understand-this-uses-my-quota` flag. They are evidence of model
behavior, not a gate for unchanged code.

## State and data

1. Back up the operator's state before upgrading: stop the server, then copy
   `state.sqlite` and the attachment directory as described in
   [state upgrade](../operations/state-upgrade.md). Keep the backup until the
   upgraded server has been checked.
2. Pause or settle active runs before the stop; a clean stop cancels an executing
   run (see the operator guide, Recovery and upgrade).
3. Start the new version once and confirm the migration backup path it prints, the
   retained tickets and runs, and that pending work is still listed.

## Publication (owner only)

1. Review the [release notes](release-notes.md) known limits and waivers.
2. Decide the version. The proposal is `v0.1.0-beta.1`; `package.json` still says
   `1.0.0` and is changed only by an explicit owner decision.
3. Commit, push the branch, open the pull request, merge, and tag according to
   the owner's repository rules. The application never creates pull requests,
   tags, or releases.

## Pilot cleanup

- Keep `/home/sr/Projects/Workspace/m9-pilot/`: it holds the pilot evidence and
  logs (owner decision, 2026-10-02).
- The temporary Jira issue `KAN-1` created for the M9 pilot cannot be deleted by
  the owner or by the connectors; deletion needs a KAN project administrator.
  Do not create issues in shared Jira projects for future pilots.
