# Handoff: Collapsed Accounts quota preview

Status: complete.

## Changes
- Accounts is collapsed by default.
- The collapsed summary shows compact 5-hour and weekly remaining-quota bars for the active account, with percentages, warning/danger colors, and an accessible label.
- Tightened the summary to one horizontal row: Accounts label, both quota indicators, then the chevron.
- The preview is hidden while expanded, when the detailed bars are already visible. It updates with every `renderAccounts` call.
- Unknown quotas start as zero-width striped bars and stay unavailable rather than being presented as 100% remaining. Detailed bars use the same honest unknown state.
- Existing sidebar disclosure order/styling and account actions are preserved.
- Fixed expanded-card overflow by containing the native details-content grid wrapper and allowing account cards/reset rows to shrink or wrap within the card.

## Verification
- `node --test test/launcher-role-page.test.js test/launcher-handshake-ui.test.js`: 16 passed, 0 failed.
- `node --check launcher-ui/app.js`: passed.
- `git diff --check -- launcher-ui/app.js launcher-ui/index.html launcher-ui/styles.css test/launcher-role-page.test.js test/launcher-handshake-ui.test.js`: passed.
- Local Chrome viewport screenshot at 1440x1000 confirmed the collapsed Accounts card remains a single row in the fixed-width 360px sidebar. Temporary evidence: `/tmp/opencode/sidebar-preview-visual/sidebar.png` (static local page; backend was not started).
- Critic review of the final one-row adjustment: PASS, no blockers; reviewer assessed source, not the screenshot.
- Expanded-card browser fixture at 1440x1000: card bounds x=24..384, account list x=45..363 (318px), account card x=45..363 (318px), and session starts at x=404; no overlap. Region capture: `artifacts/region_1793377763903_7c17303d.png`.

## Baseline and workspace notes
- Baseline HEAD: `5fc60b44774be59da7463b4d50fa67b67431363a`.
- A default worker dispatch failed because its model was unavailable; a retry using the active OpenAI model completed. Lead reviewed the actual diff and independently reran verification.
- Existing unrelated dirty files and untracked `:memory:.lockdb` remain untouched. No runtime service or database was touched.

## Next action
None for this request.
