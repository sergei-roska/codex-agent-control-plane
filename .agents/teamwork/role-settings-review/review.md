# Verdict: APPROVE after final re-review

## Account refresh cache follow-up

APPROVE. [read] `src/launcher-app.js:676-705` advances per-account cache authority
when a forced read starts and after an authoritative write; older background
results cannot replace the forced result. `storeLimits` still invalidates older
reads for handshake precedence. [ran] The challenge's original forced/cache
race probe now reports `{"forced":20,"cached":20,"reads":2}`. [ran] Account,
role, UI and launcher tests pass 85/85, including both completion orders.
Syntax and `git diff --check` pass. No live account or model call was made.

Current source resolves every finding below. `launcher-ui/roles.js:137` now sends
`effort.value || null` independently of model. [read] The new rendered-card test
invokes Save, checks the actual null-effort PUT payload, normalizes it, proves a
later profile effort update propagates, and invokes Reset to check DELETE.
[ran] Focused role/UI/launcher tests pass 63/63; focused App Server tests pass
4/4; syntax and `git diff --check` pass. The sections below retain the historical
findings and probes for context, not current blockers.

New blocker found after re-review: `launcher-ui/roles.js:34` [read] uses the
catalog's `defaultReasoningEffort` for the inherited label, while
`src/role-overrides.js:142-143` retains the profile effort unless an explicit
effort override exists. A profile `high` with catalog default `medium` and no
override displays inherited `medium` but `CodexAppServer.run()` sends `high`.
Use the effective profile/default effort for inherited display and make model
change/save behavior agree with the actual persisted request.

The display mismatch is now fixed, but a new save-path blocker remains:
`launcher-ui/roles.js:134` [ran/read] sends the effective `role.effort` for an
empty `Inherited` effort selector whenever the model selector has an override.
With profile `high` and existing override `{model:"new"}`, unchanged Save sends
`{model:"new",effort:"high"}`; `normalizeOverride` persists explicit high.
The UI then changes from Inherited to explicit high, and later profile effort
updates stop propagating. The worker's `updateEffort(true)` already selects a
new model's catalog default explicitly when intended. Preserve `null` for an
empty inherited effort selector in the Save payload.

The three findings below describe the original candidate and are resolved by the
follow-up. `app.js` now guards the removed modal in the Escape handler.
`roles.js` captures the rendered project/revision for mutations and rejects late
team responses. The UI and resolver now require a single canonical `fast` tier ID
instead of matching descriptive prose. [ran] Focused role/UI/launcher tests:
62/62; focused App Server tests: 4/4; `git diff --check`: pass. The prior deceptive
standard-tier probe now throws `Fast service tier is unavailable for this model`.

## Historical findings resolved

## Blocking findings

1. `launcher-ui/app.js:2692` [ran/read]: Removing `#roleModal` from `index.html` left its unconditional Escape key handler. Evaluating the actual handler with the now-absent element and pressing Escape throws `TypeError: Cannot read properties of null (reading 'classList')`. Search of `launcher-ui/` found no replacement `#roleModal`; the handler is installed on the main page. Remove the obsolete modal code and handler, or guard the element lookup.

2. `launcher-ui/roles.js:102-109` [read]: `loadTeam()` captures project A, awaits `/team`, then renders without checking whether project selection changed or a newer request completed. If A is slow, the user switches to B, and B completes first, the late A response replaces B's cards, note, and back link while the selector still says B. A Save/Reset on the displayed A card uses `select.value` at lines 89/96 and writes B's role override. No response token, selection check, or save-project binding exists in the caller at line 120. Capture and verify a request generation before rendering, and bind each card's mutations to its source project or disable stale cards during selection.

3. `src/model-capabilities.js:22` [ran/read]: Fast selection searches arbitrary tier description text. Given only `{id:'standard', name:'Standard', description:'Fast tier is unavailable on this plan'}`, `resolveServiceTierForTurn('on', model)` returns `standard`. `CodexAppServer.run()` passes the returned ID to `turn/start`; the Roles UI uses the same fuzzy check and enables Fast on. This silently selects standard under an explicit Fast on choice. Resolve from a protocol-defined tier identity/availability field or a narrowly validated tier ID, and reject ambiguous metadata.

## Checks

- [ran] `node --test test/role-overrides.test.js test/role-model-capabilities.test.js test/launcher-role-page.test.js test/launcher-accounts-refresh-ui.test.js test/launcher-app.test.js`: 59/59 pass.
- [ran] `node --test --test-name-pattern='Fast on|Fast off|initialize handshake' test/codex-app-server.test.js`: 4/4 pass.
- [ran] `git diff --check`: pass.
- [read] `git diff` for changed role, app-server, launcher API/UI/test paths, plus new capability and Roles page files. Existing dirty unrelated paths were not assessed.

Counts remain configured ceilings only; this review does not require scheduler enforcement. No live service or model turn was used.
