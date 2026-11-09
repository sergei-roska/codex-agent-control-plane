# Brief: Collapsed Accounts quota preview

## Objective
Change Accounts to collapsed by default, while preserving a compact and useful view of quota status in its collapsed summary.

## Verified context
- Current UI changes use native `<details>` cards; Accounts is currently marked `open` in `launcher-ui/index.html`.
- `launcher-ui/app.js` renders each account's 5-hour and weekly progress bars from `primary` and `secondary` `usedPercent`; the active account is marked by `active` on `system` or one profile.
- `renderAccounts(data)` is called on initial load, forced refresh, and after handshake updates.
- The current worktree has unrelated dirty source/tests and prior uncommitted sidebar disclosure changes. Preserve all existing changes.

## Decision
Show two tiny quota bars (5-hour and weekly) in the Accounts summary, derived only from the active account. Update widths, warning/danger classes, and an accessible label whenever account data is rendered. Keep full-size bars in the expanded card. Unknown/missing quota data must not be shown as 100% available.

## Allowed files
- `launcher-ui/index.html`
- `launcher-ui/styles.css`
- `launcher-ui/app.js`
- `test/launcher-role-page.test.js`
- `test/launcher-handshake-ui.test.js`

## Acceptance criteria
- Accounts has no default `open` attribute; all sidebar disclosures remain keyboard-operable.
- Collapsed summary shows compact 5-hour and weekly bars for the active account, with accurate fill widths and warning/danger colors.
- The preview updates on every `renderAccounts` call, including refresh and handshake updates; no active account or unknown limits are represented honestly.
- Full account details and existing account actions still render when expanded.
- `node --test test/launcher-role-page.test.js test/launcher-handshake-ui.test.js` and scoped `git diff --check` pass.
