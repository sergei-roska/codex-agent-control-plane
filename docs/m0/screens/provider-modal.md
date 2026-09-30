# M0 screen pass: provider configuration modal

Authority: `artifacts/dashboard/modals/provider-create.html`, `js/modals/provider-modal.js`. User decision: only OpenAI via Codex ChatGPT OAuth in beta. API-key mode, third-party vendors, fake OAuth handshakes and fake connection checks are not beta behavior. Dynamic model catalog and effective settings are M5. The prototype's labels are cited evidence; new label wording is proposed pending approved contract.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `advanced-chevron` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `btn-oauth-authorize` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `btn-submit-add-provider` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `btn-test-provider-connection` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `btn-toggle-key-visibility` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `btn-toggle-provider-advanced` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `form-add-provider` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `method-option-api` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `method-option-oauth` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `method-segmented-group` | `modals/provider-create.html` | none |
| `modal-add-provider` | `modals/provider-create.html` | `js/modals/provider-modal.js`, `js/app.js` |
| `oauth-status-text` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-api-key` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-custom-headers` | `modals/provider-create.html` | none |
| `provider-custom-model` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-edit-id` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-endpoint-input` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-modal-title` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-model-select` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-name-error` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-name-input` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-oauth-profile` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-preset-grid` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-tag-input` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-test-result` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `provider-timeout-input` | `modals/provider-create.html` | none |
| `section-api-fields` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `section-oauth-fields` | `modals/provider-create.html` | `js/modals/provider-modal.js` |
| `section-provider-advanced` | `modals/provider-create.html` | `js/modals/provider-modal.js` |

Controls: **29**; never referenced IDs: **3** (`method-segmented-group`, `provider-custom-headers`, `provider-timeout-input`).

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `advanced-chevron` | advanced toggle | Changes glyph with display state (`js/modals/provider-modal.js:480-488`). | [Proposed] If advanced fields retained, reflect disclosure state accessibly.| - |
| `btn-oauth-authorize` | click | After 700ms marks OAuth authorized without provider exchange (`js/modals/provider-modal.js:491-507`). | [Decision] Show Codex CLI/App Server login setup instructions and actual account state. Do not start or promise a new dashboard OAuth flow. | See M0 resolution. |
| `btn-submit-add-provider` | submit | Adds/updates in-memory provider and always marks connected (`js/modals/provider-modal.js:533-612`). | [Proposed] Persist supported Codex OAuth configuration only after validated auth.| Exact editable settings M5. |
| `btn-test-provider-connection` | click | After 550ms reports random 200 OK and random latency (`js/modals/provider-modal.js:510-530`). | [Proposed] Only show result of actual health/auth probe; omit if no safe probe contract.| Probe definition M5. |
| `btn-toggle-key-visibility` | click | Toggles API-key field between password/text (`js/modals/provider-modal.js:467-478`). | [Proposed] No API-key mode in beta.| Deferred. |
| `btn-toggle-provider-advanced` | click | Shows/hides advanced fields and changes chevron (`js/modals/provider-modal.js:480-488`). | [Proposed] Expose only settings approved for supported Codex OAuth.| Which settings, M5. |
| `form-add-provider` | submit | Validates unique name then mutates fixture provider/model catalogs (`js/modals/provider-modal.js:533-612`). | [Proposed] Persist approved connection/config with server-side validation.| Config schema M5. |
| `method-option-api` | click | Selects API mode and shows API fields (`js/modals/provider-modal.js:307-327,456-465`). | [Proposed] API-key mode excluded from beta.| Deferred. |
| `method-option-oauth` | click | Selects OAuth mode and shows OAuth fields (`js/modals/provider-modal.js:307-327,456-465`). | [Decision] Codex ChatGPT OAuth only.| - |
| `method-segmented-group` | render | Wraps API/OAuth choices (`modals/provider-create.html:87-104`); script targets child options (`js/modals/provider-modal.js:307-327`). | [Proposed] Present only supported OAuth choice.| - |
| `modal-add-provider` | open/close | Add/edit populates then toggles `open`; close selector removes it (`js/modals/provider-modal.js:329-392,419-443`; `js/app.js:13-18`). | [Proposed] Configure supported OpenAI connection.| Implementation component name TBD. |
| `oauth-status-text` | auth response | Displays ready/opening/authenticated based on timer (`js/modals/provider-modal.js:491-507`). | [Decision] Display truthful Codex CLI/App Server account state and setup instructions; no simulated handshake. | See M0 resolution. |
| `provider-api-key` | input | Password field; only visibility handler reads/toggles, form submission does not persist value (`modals/provider-create.html:116-122`; `js/modals/provider-modal.js:467-478`). | [Proposed] Excluded; never imply secure key storage.| Deferred. |
| `provider-custom-headers` | input | Declared JSON text field but no script reads it (`modals/provider-create.html:169-173`). | [Proposed] Excluded with generic advanced/provider mode.| Deferred. |
| `provider-custom-model` | submit | Overrides selected model and is inserted into local catalog (`js/modals/provider-modal.js:543-551,593-606`). | [Proposed] Model choice must come from supported dynamic catalog/capability contract.| M5. |
| `provider-edit-id` | open/submit | Chooses local update vs new provider (`js/modals/provider-modal.js:329-345,547-590`). | [Proposed] Stable server-owned config identity.| Config identity M5. |
| `provider-endpoint-input` | submit | Preset URL or edited URL becomes fixture endpoint (`js/modals/provider-modal.js:244-289,366-372,543-554`). | [Proposed] Use only official supported Codex endpoint/configuration.| Any endpoint override support M5. |
| `provider-modal-title` | open | Says Add New or Configure Provider (`js/modals/provider-modal.js:329-348,419-425`). | [Proposed] Clearly identify supported OpenAI connection configuration.| Approved copy. |
| `provider-model-select` | preset/submit | Filled from hardcoded multi-provider models and submitted (`js/modals/provider-modal.js:244-289,543-551`). | [Proposed] Dynamic OpenAI catalog with validated capability/effort support.| Catalog behavior M5. |
| `provider-name-error` | validation | Shows duplicate-name message and disables submit (`js/modals/provider-modal.js:208-242`). | [Proposed] If display naming is user-configurable, validate; otherwise omit.| Need for configurable connection name. |
| `provider-name-input` | input/submit | Required display name; case-insensitive duplicate validation (`js/modals/provider-modal.js:208-242,413-417`). | [Proposed] Name only if multiple supported OAuth profiles/accounts require it.| Account multiplicity M5. |
| `provider-oauth-profile` | preset select | Filled from fake provider profile options (`js/modals/provider-modal.js:244-289`). | [Decision] Reflect account state from installed Codex CLI/App Server; do not add a dashboard-managed OAuth profile flow. | See M0 resolution. |
| `provider-preset-grid` | click | Click picks one of 13 hardcoded providers and populates fields (`js/modals/provider-modal.js:3-202,244-305,446-454`). | [Decision] Only OpenAI Codex preset available.| - |
| `provider-tag-input` | submit | User-editable category tag is saved to local provider (`js/modals/provider-modal.js:366-372,543-564`). | [Proposed] No unsupported category semantics; likely omit.| Display categorization need. |
| `provider-test-result` | test | Shows fabricated success/latency after timeout (`js/modals/provider-modal.js:510-530`). | [Proposed] Truthful result from actual probe or explicit unsupported state.| Probe M5. |
| `provider-timeout-input` | input | Declared numeric setting but never read (`modals/provider-create.html:174-178`). | [Proposed] Excluded unless an enforced config contract is approved.| Deferred. |
| `section-api-fields` | method selection | Shown only for API mode (`js/modals/provider-modal.js:307-327`). | [Decision] Remove API-key fields in beta; only OAuth flow.| - |
| `section-oauth-fields` | method selection | Shown only for OAuth mode (`js/modals/provider-modal.js:307-327`). | [Decision] Show approved Codex OAuth state/action.| - |
| `section-provider-advanced` | disclosure | Hidden/shown by toggle; contains unread custom headers/timeout (`js/modals/provider-modal.js:480-488`). | [Proposed] Exclude unsupported generic options.| Deferred. |

## Data this screen needs

| Field | Type | Source | Contract? |
| --- | --- | --- | --- |
| provider/config identity and auth state | server-managed | fixture `state.providers` (`js/modals/provider-modal.js:341-391`) | Codex OAuth contract M5. |
| model id/capabilities/effort | catalog records | hardcoded `PRESET_PROVIDERS` (`js/modals/provider-modal.js:3-202`) | Dynamic catalog/capability contract M5. |
| endpoint/headers/timeout/API key | strings/secret/number | form fields (`modals/provider-create.html:113-184`) | Excluded unless explicitly approved; key not stored by prototype. |

## Simulation boundary

OAuth handshake and connection check always report success after timers; test latency is random. Submit sets status connected without auth validation. Presets, endpoints, model catalog, API-key/session storage claims and duplicate-name state are fixtures. Beta retains only real OpenAI Codex ChatGPT OAuth.

## M0 resolution and owned follow-up

Only OpenAI via the current Codex ChatGPT OAuth adapter is supported. Authentication remains in the installed CLI/App Server; the UI shows account status/setup instructions and does not store access tokens or simulate OAuth ([decisions.md, Browser and integration authentication](../decisions.md#browser-and-integration-authentication)). API keys, endpoint editing, third-party presets, generic provider profiles, and the general secret editor are excluded from beta. Model catalog and reasoning effort are resolved against installed protocol/account capabilities and pinned per run ([contracts.md, Effective configuration and measurements](../contracts.md#effective-configuration-and-measurements)); exact entitlement is M5 U-04.

No M0 provider-auth decision remains open. M5 owns the live capability catalog and truthful account/configuration presentation. A real probe may be added only if that milestone defines one; otherwise omit test controls.

| ID | Question | What it blocks |
| --- | --- | --- |
| `provider-model-select` | Resolve model/effort options against installed protocol and account capabilities. | M5 U-04 |
| `provider-test-result` | Show only an actual supported probe result or omit this control. | M5 |

## Dynamic controls

`.preset-card[data-preset]` generated from markup, model and OAuth `<option>` lists from presets, plus `data-close="modal-add-provider"` (`modals/provider-create.html:18-84,9,194`; `js/modals/provider-modal.js:278-289`). UI uses no separate stable IDs for each preset option. Names TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen provider-create.html --list` - **PASS: 29/29 (100%)**. Identifier-only coverage cannot validate semantic correctness.
