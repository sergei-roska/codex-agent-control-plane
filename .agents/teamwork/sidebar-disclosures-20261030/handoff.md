# Handoff: Sidebar disclosures

Status: complete.

## Changes
- Converted Project, Accounts, Team activity, and Connectors to native `details` disclosures. About Orchestrator was already collapsible.
- Accounts is the only card with the default `open` attribute. Team activity stays above Connectors.
- Added shared disclosure styling, visible keyboard focus, chevrons, and an Accounts header grid that keeps its refresh controls beside the title while open.
- Added a markup regression test for direct summary controls and default expansion state.

## Verification
- `node --test test/launcher-role-page.test.js`: 11 passed, 0 failed.
- `git diff --check -- launcher-ui/index.html launcher-ui/styles.css test/launcher-role-page.test.js`: passed.
- `node --check launcher-ui/app.js`: passed (unchanged JavaScript syntax check).

## Baseline and workspace notes
- Baseline HEAD: `5fc60b44774be59da7463b4d50fa67b67431363a`.
- Worktree contains unrelated pre-existing source/test modifications and untracked `:memory:.lockdb`; they were preserved and not included in this UI task.
- No runtime service or database was touched.

## Next action
None for this request.
