# M0 screen pass: ticket create/edit

Authority: `artifacts/dashboard/modals/ticket-create.html` and `js/modals/ticket-modal.js`. Owner decisions: direct New Ticket and Jira issue intake both supported; source and tracking location are separate; first milestone after read-only kanban is creation, followed by Intake; attachments must be real with supported formats/limits defined. Jira and Confluence are read-only sources; no external issue, comment, or status writes. Internal tracking location is separate from source. DOM labels are prototype labels, not approved contract names.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `btn-browse-attachments` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `btn-submit-ticket` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `btn-ticket-form-view-details` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `form-add-ticket` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `modal-add-ticket` | `modals/ticket-create.html` | `js/modals/ticket-modal.js`, `js/app.js` |
| `modal-ticket-form-title` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-ac-input` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-attachments-input` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-attachments-preview` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-confluence` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-desc-input` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-edit-id` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-figma` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-jira-issue` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-jira-parents` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-priority` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-role` | `modals/ticket-create.html` | `js/modals/ticket-modal.js`, `js/app.js` |
| `ticket-status-input` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |
| `ticket-title-input` | `modals/ticket-create.html` | `js/modals/ticket-modal.js` |

Controls in this screen: **19**; script-unreferenced IDs: **0**.

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `btn-browse-attachments` | click | Opens hidden file input; stores selected filenames only, deduplicated (`js/modals/ticket-modal.js:619-629`). | [Proposed] Store actual files under supported format/size rules; show clear source/reference vs uploaded-file state.| See M0 resolution. |
| `btn-submit-ticket` | click/submit | Disabled until title nonempty for create; submit creates/updates in-memory object (`js/modals/ticket-modal.js:432-435,647-650,653-731`). | [Decision] Persist direct ticket as a backlog draft; edit only by creating an immutable revision under optimistic version validation. | See M0 resolution. |
| `btn-ticket-form-view-details` | click | Hides edit modal and opens detail for current ticket (`js/modals/ticket-modal.js:638-645`). | [Proposed] Open corresponding persisted ticket detail.| - |
| `form-add-ticket` | submit | Reads fields, mutates fixture object or creates random `TICKET-###`, closes and rerenders (`js/modals/ticket-modal.js:653-731`). | [Decision] Submit a durable create/edit command with backend-generated ID, immutable revision and expected ticket version. | See M0 resolution. |
| `modal-add-ticket` | open/close | Create/edit functions reset/fill form and toggle `open`; global close removes `open` (`js/modals/ticket-modal.js:417-450,452-499`; `js/app.js:13-18`). | [Proposed] Modal hosts direct creation and editing of permitted draft/backlog ticket data.| Modal/component implementation name TBD. |
| `modal-ticket-form-title` | create/edit | Set to Create Ticket or status-dependent Edit Ticket label (`js/modals/ticket-modal.js:431,478`). | [Proposed] State clearly whether creating or editing.| Final accessible copy. |
| `ticket-ac-input` | submit | Reads textarea into `acceptanceCriteria` (`js/modals/ticket-modal.js:663-678,688`). | [Proposed] Persist explicit acceptance criteria as requirement revision content.| See M0 resolution. |
| `ticket-attachments-input` | file change | Accept filter in markup; JS retains only selected filenames (`modals/ticket-create.html:81-86`; `js/modals/ticket-modal.js:621-628`). | [Decision] Apply approved file count/size limits and format-specific storage/extraction; never imply filename storage means the agent read content. | See M0 resolution. |
| `ticket-attachments-preview` | render/remove | Shows no-file text or generated filename chips; remove button splices name (`js/modals/ticket-modal.js:6-29`). | [Proposed] Show stored/pending files and allow removal before submit.| - |
| `ticket-confluence` | submit | Reads free text into `confluence` (`js/modals/ticket-modal.js:667-678,693-694`). | [Decision] Read-only Confluence retrieval; preserve source provenance. No external writes.| Retrieval auth details M6. |
| `ticket-desc-input` | submit | Reads description text (`js/modals/ticket-modal.js:663-678,688`). | [Proposed] Persist description in immutable requirement revision.| - |
| `ticket-edit-id` | edit submit | Hidden key selects update path; creation uses random ID (`js/modals/ticket-modal.js:424,430,656-657,680-724`). | [Decision] Use backend-generated stable identity and expected-version validation. | See M0 resolution. |
| `ticket-figma` | submit | Reads free text into `figma` references (`js/modals/ticket-modal.js:667-678,693-694`). | [Decision] Preserve as source reference only; Figma extraction deferred.| None for beta behavior; connected extraction deferred. |
| `ticket-jira-issue` | submit | Reads a key/URL string into `jiraIssue` (`js/modals/ticket-modal.js:665-678,691`). | [Decision] Support configured read-only Jira issue types as Intake sources; source provenance is distinct from internal tracking. No external issue/comment/status writes.| M6 deployment mapping and pilot. |
| `ticket-jira-parents` | submit | Reads comma/newline text into `jiraParents` (`js/modals/ticket-modal.js:666-678,692`). | [Decision] Preserve read-only supported parent/epic references and retrieved provenance.| M6 deployment mapping and pilot. |
| `ticket-priority` | submit | Reads Normal/High/Low option (`modals/ticket-create.html:49-54`; `js/modals/ticket-modal.js:661-678,690`). | [Proposed] Persist accepted priority field.| Mapping to Jira priority deferred/M6. |
| `ticket-role` | submit | Populated from `ROLES`; defaults developer and saved as ticket.role (`js/app.js:3-10`; `js/modals/ticket-modal.js:438-440,661-678,685,712`). | [Decision] Record requested specialty only; it does not activate a business role, assign an active run, or bypass the PM coordinating contract. | See M0 resolution and `roles-tools.md`. |
| `ticket-status-input` | submit | Offers eight fixture states and directly writes selected status (`modals/ticket-create.html:17-28`; `js/modals/ticket-modal.js:441-442,659-678,685,713`). | [Decision] New tickets start in backlog. Lifecycle state changes use validated commands and the settled status mapping; the form cannot bypass gates. | See M0 resolution. |
| `ticket-title-input` | input/submit | Required markup; trims title; toggles submit; empty fallback `Untitled` (`modals/ticket-create.html:32-35`; `js/modals/ticket-modal.js:647-650,673,709`). | [Decision] Require nonempty title and enforce the 200-character limit. | See M0 resolution. |

## Data this screen needs

| Field | Type | Source in mockup | Already in contracts? |
| --- | --- | --- | --- |
| id | stable string | random fixture ID (`js/modals/ticket-modal.js:706-708`) | Backend-generated opaque ticket ID in [contracts.md](../contracts.md#identity-and-ownership). |
| title, description, acceptance criteria | strings | form fields (`modals/ticket-create.html:32-45`) | Immutable requirement revision; approved field length limits in [decisions.md](../decisions.md#attachments-and-limits). |
| role, priority, status | enumerations | selects (`modals/ticket-create.html:13-28,47-54`) | Validated lifecycle status ([contracts.md](../contracts.md#ticket-state-and-board-projection)); requested specialty and PM coordination ([contracts.md](../contracts.md#identity-and-ownership), [roles-tools.md](../roles-tools.md)). |
| Jira issue/parents, Confluence, Figma | reference strings/lists + provenance | form fields (`modals/ticket-create.html:57-76`) | Source provenance and internal-only tracking ([contracts.md](../contracts.md#identity-and-ownership)); Jira/Confluence read-only ([decisions.md](../decisions.md#confirmed-owner-decisions)). |
| file | binary, name, media type, size, provenance | filename-only fixture (`js/modals/ticket-modal.js:6-29,621-628`) | Artifact storage and supported file limits/formats in [decisions.md](../decisions.md#attachments-and-limits). |
| created/revision | timestamp/version | created fixture string (`js/modals/ticket-modal.js:719-720`) | Backend ticket version and immutable requirement revision ([contracts.md](../contracts.md#identity-and-ownership)); UTC timestamps displayed locally. |

## Simulation boundary

Creation/edit is in-memory; IDs can collide because random 3-digit suffix; attachments retain names only; no linked references are resolved; form permits direct status setting; default role/status are fixture choices. All require durable backend contracts, real attachment handling and validation before they can be product behavior.

## M0 resolution and owned follow-up

Ticket identity, immutable revisions, source type, tracking mode, optimistic versioning and create/edit commands are settled in [contracts.md, Identity and ownership](../contracts.md#identity-and-ownership) and [Commands and atomic effects](../contracts.md#commands-and-atomic-effects). Status values and board projections are settled in [Ticket state and board projection](../contracts.md#ticket-state-and-board-projection). Approved file counts, sizes, title/description/criteria lengths, formats and extraction states are explicit beta defaults in [decisions.md, Attachments and limits](../decisions.md#attachments-and-limits). Role input is `requestedSpecialty` and cannot replace PM coordination ([contracts.md:15,32](../contracts.md#identity-and-ownership)); role mapping details are in [roles-tools.md](../roles-tools.md).

Jira/Confluence remain read-only sources; internal tracking is separate, and no external issue/comment/status writes are supported ([decisions.md, O-06](../decisions.md#confirmed-owner-decisions)). The only owned integration choices are M6 deployment authentication and pilot references (`decisions.md`, U-01/U-02); they do not block ticket creation.

| ID | Question | What it blocks |
| --- | --- | --- |
| `ticket-status-input` | Implement the settled lifecycle states through validated commands. | M1 projection; M2/M3 create and submit |
| `ticket-role` | Store requested specialty without assigning execution or bypassing PM. | M3 Intake; nine-role activation M4 |
| `ticket-jira-issue`, `ticket-jira-parents`, `ticket-confluence` | Read supported source types; never publish source changes. | M6 connector setup and approved pilot |
| `ticket-attachments-input` | Enforce limits and real storage/extraction rules from the linked decision. | M2 attachments; later format expansion U-03 |

## Dynamic controls

`.btn-remove-attachment` buttons are created per filename and remove by `data-index` (`js/modals/ticket-modal.js:13-28`). `data-close="modal-add-ticket"` closes globally (`modals/ticket-create.html:6,93`; `js/app.js:13-18`). Implementation names remain TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen ticket-create.html --list` - **PASS: 19/19 (100%)**. Literal ID coverage does not verify meaning or renamed implementation identifiers.
