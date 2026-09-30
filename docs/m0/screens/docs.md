# M0 screen pass: Docs

Authority: `artifacts/dashboard/tabs/docs.html`, `js/tabs/docs.js`. Documentation content is a reference, not a permission grant. The prototype viewer must not imply connected Docs integration or approved action. Jira and Confluence access is read-only; internal tracking location is separate and no external writes are supported.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `active-doc-title` | `tabs/docs.html` | `js/tabs/docs.js` |
| `btn-copy-doc` | `tabs/docs.html` | `js/tabs/docs.js` |
| `btn-toggle-raw` | `tabs/docs.html` | `js/tabs/docs.js` |
| `doc-viewer-content` | `tabs/docs.html` | `js/tabs/docs.js` |
| `docs-list` | `tabs/docs.html` | `js/tabs/docs.js` |
| `tab-docs` | `tabs/docs.html` | none |

Controls: **6**; never referenced IDs: **1** (`tab-docs`, navigation target `js/layout/header.js:2-14`).

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `active-doc-title` | selection/render | Displays selected fixture title (`js/tabs/docs.js:20-26`). | [Proposed] Identify selected available document and provenance.| Document set/owner. |
| `btn-copy-doc` | click | Copies raw fixture content and displays alert (`js/tabs/docs.js:48-55`). | [Proposed] Copy the currently displayed document content with accessible feedback.| - |
| `btn-toggle-raw` | click | Toggles raw/rendered local state then rerenders (`js/tabs/docs.js:37-46`). | [Proposed] Allow raw/rendered view of supported content.| - |
| `doc-viewer-content` | render | Escapes content in `<pre>` for raw view or calls local Markdown renderer (`js/tabs/docs.js:28-34`). | [Proposed] Render trusted/sanitized content; show honest unavailable state.| Supported formats/security policy. |
| `docs-list` | render/click | Renders fixture titles; click changes selected fixture id (`js/tabs/docs.js:2-18`). | [Proposed] List accessible available documents with provenance and meaningful selection.| Sources in initial release. |
| `tab-docs` | nav click | Header activates pane (`js/layout/header.js:2-14`). | [Proposed] Navigate to truthful document list/viewer.| - |

## Data this screen needs

| Field | Type | Source | Contract? |
| --- | --- | --- | --- |
| document id/title/content | string record | `state.docs` (`js/tabs/docs.js:6-34`) | Document/artifact provenance contract M0. |
| selected document id and raw view | local UI state | `state.selectedDocId`, `state.docRawView` (`js/tabs/docs.js:15,29,43`) | UI-local preference. |

## Simulation boundary

Documents are fixture strings in memory. No external provider/source is connected. Markdown rendering and clipboard success are assumed; the copy handler calls `alert` after write (`js/tabs/docs.js:48-55`).

## M0 resolution and owned follow-up

Displayed documents and references are evidence with source provenance, not permission grants; Jira/Confluence source access is read-only and internal tracking is separate ([contracts.md, Identity and ownership](../contracts.md#identity-and-ownership); [decisions.md, O-06](../decisions.md#confirmed-owner-decisions)). Unknown/unavailable content and truncation must be shown honestly. The current prototype's fixture docs do not establish connected integrations.

M0 has no Docs permission or source-write decision left open. M1 does not define a Docs read endpoint; show explicit unavailable state until M8 supplies the artifact list and sanitized rendering contract. M6 owns deployment-specific read connectors.

| ID | Question | What it blocks |
| --- | --- | --- |
| `docs-list` | Until data is available, show explicit unavailable state; then list available artifacts with source/status metadata. | M8 read projection; M6 connectors |
| `doc-viewer-content` | Render only supported sanitized formats; identify unavailable/truncated source content. | M8 rendering; M6 connectors |

## Dynamic controls

`.doc-item` rows are generated and select via `data-id`; markdown renderer output is dynamic (`js/tabs/docs.js:6-18,28-34`). Component names TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen docs.html --list` - **PASS: 6/6 (100%)**. Identifier gate is not semantic validation.
