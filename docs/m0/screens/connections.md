# M0 screen pass: Connections and Models

Authority: `artifacts/dashboard/tabs/connections.html`, `js/tabs/connections.js`. Owner decision: beta supports OpenAI only through existing Codex ChatGPT OAuth. The prototype's API-key, third-party provider and many model options are not approved beta behavior. Jira and Confluence retrieval are read-only; internal tracking is separate and no external writes are supported. Model selection/history is a separate M5 contract; defaults apply to new runs and active runs pin effective settings.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `btn-add-provider` | `tabs/connections.html` | `js/tabs/connections.js`, `js/modals/provider-modal.js` |
| `providers-grid` | `tabs/connections.html` | `js/tabs/connections.js` |
| `role-defaults-body` | `tabs/connections.html` | `js/tabs/connections.js` |
| `tab-connections` | `tabs/connections.html` | none |

Controls: **4**; never referenced IDs: **1** (`tab-connections`, routing target `js/layout/header.js:2-14`).

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `btn-add-provider` | click | Opens modal, preselects DeepSeek API and fake setup defaults (`js/modals/provider-modal.js:394-444`). | [Decision] Configure only the approved OpenAI Codex ChatGPT OAuth integration; no API-key or non-OpenAI provider options. | See M0 resolution. |
| `providers-grid` | render/action | Displays fixtures as connected/disconnected; generated connect, disconnect, reauth, remove buttons mutate local providers (`js/tabs/connections.js:101-194`). | [Proposed] Display actual connection status; expose only supported guarded account actions.| Reauth/disconnect UX details M5. |
| `role-defaults-body` | render/change | Generates provider/model/tier selects for each role and mutates defaults locally (`js/tabs/connections.js:196-281`). | [Decision] Keep Provider=OpenAI, Model=catalog, and Reasoning Effort as separate settings; apply defaults to new runs and preserve active-run snapshots. Add Fast/serviceTier only when installed protocol/account advertises support. | M5 capability catalog. |
| `tab-connections` | nav click | Header activates pane (`js/layout/header.js:2-14`). | [Proposed] Navigate to supported connection/model settings.| - |

## Data this screen needs

| Field | Type | Source | Contract? |
| --- | --- | --- | --- |
| connection status/account | state | provider fixture (`js/tabs/connections.js:101-144`) | Codex OAuth connection status contract M5. |
| role default model/effort | per-role config | generated defaults (`js/tabs/connections.js:198-249`) | Effective settings snapshot and run pinning ([contracts.md](../contracts.md#effective-configuration-and-measurements)); editable defaults M5. |

## Simulation boundary

All provider connection states and defaults are fixtures. Connect/disconnect mutates memory; removal silently resets role defaults to Gemini; model options are hardcoded across unsupported vendors (`js/tabs/connections.js:3-66,146-192,205-280`). These are excluded from beta. No cost is inferred here.

## M0 resolution and owned follow-up

Only the existing Codex ChatGPT OAuth adapter is supported. Authentication remains in the installed CLI/App Server; show account state and setup instructions, without browser OAuth/token storage. Effective model/settings snapshots are pinned to runs; defaults apply to new runs ([decisions.md, O-03 and D-10](../decisions.md#confirmed-owner-decisions); [contracts.md, Effective configuration and measurements](../contracts.md#effective-configuration-and-measurements)). Jira and Confluence retrieval are read-only; internal tracking is separate and external writes are excluded ([decisions.md, O-06](../decisions.md#confirmed-owner-decisions)).

Owner-approved UI addition absent from the prototype: display Provider=OpenAI, Model from the available catalog, and Reasoning Effort as a separate setting. Add Fast/serviceTier only if the installed protocol and account advertise support; never substitute reasoning effort for speed ([contracts.md, Effective configuration and measurements](../contracts.md#effective-configuration-and-measurements); [decisions.md, U-04](../decisions.md#owned-open-decisions)). This is an explicit contract addition, not a prototype behavior or a new DOM ID; component names remain TBD.

The exact model/effort catalog is an owned M5 capability-driven choice (U-04 in [decisions.md](../decisions.md#owned-open-decisions)), not an unresolved M0 contract. Beta exposes only the installed active Codex account; no multi-account/profile selector is required.

| ID | Question | What it blocks |
| --- | --- | --- |
| `role-defaults-body` | Query the installed Codex/App Server protocol and account for actual supported model and effort choices. | M5 |

## Dynamic controls

`.btn-connect`, `.btn-disconnect`, `.btn-reauth`, `.btn-remove-provider`, `.role-provider-select`, `.role-model-select`, `.role-tier-select` are rendered from fixtures (`js/tabs/connections.js:110-125,234-249`). Keep only supported controls; component names TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen connections.html --list` - **PASS: 4/4 (100%)**. Literal ID count does not prove semantic coverage.
