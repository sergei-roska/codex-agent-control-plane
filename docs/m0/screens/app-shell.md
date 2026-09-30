# M0 screen pass: app shell

Prototype authority: `artifacts/dashboard/index.html`, `js/layout/sidebar.js`, `js/layout/header.js`, `js/theme.js`, `js/app.js`, and `js/modals/approval.js`. The inventory's synthetic shell contains 24 script-referenced IDs declared only in the assembled shell or generated at runtime. Prototype labels and effects below are evidence, not contracts. Beta decisions: OpenAI Codex ChatGPT OAuth only; nine roles (Project Manager, Architect, Developer, QA, Reviewer, Security, Performance, DevOps, Technical Writer); remove role switches; operator controls guarded; no fabricated costs or hidden-reasoning promise.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `btn-close-sidebar` | `index.html` | `js/layout/sidebar.js` |
| `btn-copy-command` | generated approval body | `js/modals/approval.js` |
| `btn-escalation-confirm` | generated approval footer | `js/modals/approval.js` |
| `btn-escalation-deny` | generated approval footer | `js/modals/approval.js` |
| `btn-menu-toggle` | `index.html` | `js/layout/sidebar.js` |
| `btn-open-battlepass` | `index.html` | `js/modals/battlepass.js` |
| `btn-open-new-ticket` | `index.html` | `js/modals/ticket-modal.js` |
| `btn-theme-toggle` | `index.html` | `js/theme.js` |
| `btn-toggle-secret-visibility` | generated approval body | `js/modals/approval.js` |
| `btn-toggle-sidebar-collapse` | `index.html` | `js/layout/sidebar.js` |
| `m3-cb-prompt` | generated approval body | `js/modals/approval.js` |
| `m3-cmd-env` | generated approval body | `js/modals/approval.js` |
| `m3-command-payload` | generated approval body | `js/modals/approval.js` |
| `m3-decision-notes` | generated approval body | `js/modals/approval.js` |
| `m3-pm-clarifications` | generated approval body | `js/modals/approval.js` |
| `m3-record-adr` | generated approval body | `js/modals/approval.js` |
| `m3-scope-notes` | generated approval body | `js/modals/approval.js` |
| `m3-sec-duration` | generated approval body | `js/modals/approval.js` |
| `m3-sec-justification` | generated approval body | `js/modals/approval.js` |
| `m3-secret-value` | generated approval body | `js/modals/approval.js` |
| `main-sidebar` | `index.html` | `js/layout/sidebar.js` |
| `roles-list-container` | `index.html` | `js/layout/sidebar.js` |
| `sidebar-overlay` | `index.html` | `js/layout/sidebar.js` |
| `theme-icon` | `index.html` | `js/theme.js` |

Controls in this screen: **24**; inventory IDs not touched by script: **0**. Rows cover synthetic shell IDs; selector-only and generated controls are recorded below.

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `btn-close-sidebar` | click | Removes `open` from sidebar and `active` from overlay (`js/layout/sidebar.js:77-84`). | [Proposed] Close responsive navigation.| - |
| `btn-copy-command` | click | Copies generated command text with Clipboard API; temporarily changes button label (`js/modals/approval.js:448-460`). | [Proposed] Do not expose hidden reasoning; copy only an explicitly displayed, safe command payload.| Payload schema and approval types in M7. |
| `btn-escalation-confirm` | click | Calls generic resolution handler as approved (`js/modals/approval.js:479-485`). | [Decision] Route only a supported guarded operator command; backend validates capability and state.| M7 UI integration |
| `btn-escalation-deny` | click | Calls generic resolution handler as denied (`js/modals/approval.js:487-493`). | [Decision] Route a guarded deny/request-research command with explicit semantics.| M7 UI integration |
| `btn-menu-toggle` | click | Adds `open` to sidebar and `active` to overlay (`js/layout/sidebar.js:72-83`). | [Proposed] Open responsive navigation.| - |
| `btn-open-battlepass` | click | Opens Battle Pass modal (`js/modals/battlepass.js:2-8`). | [Decision] Excluded from beta; prototype retained.| Deferred by owner. |
| `btn-open-new-ticket` | click | Opens ticket form (`js/modals/ticket-modal.js:632-636`). | [Decision] Start direct New Ticket creation.| - |
| `btn-theme-toggle` | click | Toggles light/dark and persists choice in localStorage (`js/theme.js:16-26`). | [Proposed] Theme preference may persist locally.| - |
| `btn-toggle-secret-visibility` | click | Toggles password/text input and eye icon (`js/modals/approval.js:462-477`). | [Decision] Omit this generic secret input; beta has no dashboard credential-entry/vault UI. | Outside beta |
| `btn-toggle-sidebar-collapse` | click | Toggles `collapsed` class (`js/layout/sidebar.js:64-70`). | [Proposed] Collapse/expand navigation.| - |
| `m3-cb-prompt` | approval modal input | Generated textarea; read into synthetic resolution payload (`js/modals/approval.js:294-302,535-543`). | [Decision] Omit this unsupported fixture prompt from beta. | Outside beta |
| `m3-cmd-env` | approval modal input | Generated environment select; value is added to simulated resolution (`js/modals/approval.js:99-104,503-506`). | [Proposed] Environment is an explicit bounded target on an authorized command.| Supported environment set. |
| `m3-command-payload` | generated content / copy | Displays a payload from escalation fixture (`js/modals/approval.js:91-94`). | [Proposed] Display only safe, server-issued command details.| Payload contract. |
| `m3-decision-notes` | approval modal input | Notes are read and put in simulated resolution (`js/modals/approval.js:154-160,511-517`). | [Proposed] Persist operator rationale with decision when contract supports it.| Required/optional and retention. |
| `m3-pm-clarifications` | approval modal input | Text is read and put in simulated resolution (`js/modals/approval.js:212-218,526-529`). | [Proposed] Submit clarified requirements as a guarded revision, not implicit approval.| Revision contract. |
| `m3-record-adr` | approval modal input | Checkbox controls a flag in simulated resolution (`js/modals/approval.js:158-163,514-517`). | [Proposed] Record decision only through approved ADR contract.| ADR format/ownership. |
| `m3-scope-notes` | approval modal input | Notes are read and put in simulated resolution (`js/modals/approval.js:374-379,551-557`). | [Decision] Omit generic scope override; scope revisions use the explicit assignment/plan contract. | Outside beta generic forms |
| `m3-sec-duration` | approval modal input | Choice is read as synthetic exception duration (`js/modals/approval.js:322-327,546-549`). | [Decision] Omit generic security exception form. | Outside beta |
| `m3-sec-justification` | approval modal input | Default justification is read into synthetic resolution (`js/modals/approval.js:329-333,546-549`). | [Decision] Omit generic security exception form. | Outside beta |
| `m3-secret-value` | approval modal input | Secret is read into fake resolution; scope defaults to session (`js/modals/approval.js:238-255,530-534`). | [Decision] Omit generic secret input; integrations use server-side credential references. | Resolved: decisions.md authentication |
| `main-sidebar` | sidebar controls | Collapse/open classes control layout (`js/layout/sidebar.js:64-79`). | [Proposed] Navigation container responds to sidebar controls.| - |
| `roles-list-container` | initial render | Injects nine role cards, counters, model text and a per-role routing checkbox; clicking a card filters board (`js/layout/sidebar.js:2-55`). | [Decision] Show the nine approved role names and remove role switches. Counts/model must use truthful available data.| Exact per-role count projection contract. |
| `sidebar-overlay` | click / menu | Click closes sidebar; menu toggles active state (`js/layout/sidebar.js:72-84`). | [Proposed] Responsive backdrop closes navigation.| - |
| `theme-icon` | theme render | Text says opposite available theme (`js/theme.js:4-13`). | [Proposed] Theme control communicates resulting/available theme accessibly.| Label wording. |

## Data this screen needs

| Field | Type | Source in mockup | Already in contracts? |
| --- | --- | --- | --- |
| theme | `dark|light` | localStorage key `role-console-theme` (`js/theme.js:2,14`) | UI preference contract not found; local only. |
| role key/name | string | `ROLES`, `ROLE_NAMES` and `state.roleSessions` (`js/layout/sidebar.js:6-15`) | Effective runtime role during M1/M3; business roster activation and mapping follow [roles-tools.md](../roles-tools.md) in M4. |
| role ticket counts | integer per state | `getRoleTicketCounts` (`js/layout/sidebar.js:7-8`) | Projected status contract required; no UI fabrication. |
| last model label | string | `getLastModelAttempt` (`js/layout/sidebar.js:8`) | Model attribution/config contract in M0/M5. |
| escalation action/payload | typed record | `esc` fixture and generated fields (`js/modals/approval.js:4-43,66-433`) | Command/approval contracts required; mockup fixture is not a contract. |

## Simulation boundary

- Sidebar role counts and last-model display derive from fixture state.
- Per-role checkbox mutates only `state.roleSessions` (`js/layout/sidebar.js:38-42`); owner decision removes role switches.
- Approval/escalation writes are simulated in-memory fixture changes (`js/modals/approval.js:495-583`).
- Clipboard and theme preference are browser-local effects.
- Battle Pass is fully excluded and deferred; preserve the reference unchanged. No beta behavior or design is specified.

## M0 resolution and owned follow-up

The nine-role roster and removal of per-role enable switches are owner decisions. The sidebar reports only effective existing runtime roles during M1/M3; [roles-tools.md](../roles-tools.md) maps those legacy roles and keeps unactivated business roles honest until M4. Guarded actions use the validated command contract in [contracts.md](../contracts.md#commands-and-atomic-effects); no separate Restart button is defined. Recovery uses Resume for a reconciled paused/interrupted run or explicit Submit for a new run ([contracts.md](../contracts.md#ticket-state-and-board-projection)).

Codex OAuth remains in the installed CLI/App Server; the UI shows account status/setup instructions and does not collect or store ChatGPT tokens. A general credentials vault/editor and generic secret approval form are outside beta; configured integrations may reference environment/OS secrets ([decisions.md, Browser and integration authentication](../decisions.md#browser-and-integration-authentication)). ADR and execution-specific operator action details are owned by M7.

| ID | Question | What it blocks |
| --- | --- | --- |
| `btn-escalation-confirm`, `btn-escalation-deny` | Map only supported guarded commands to explicit confirmation/denial results. | M7 |
| `m3-command-payload` | Decide safe display/copy fields for any retained M7 command. | M7; omit unsupported generic command preview |
| `m3-record-adr` | Render decision records under the durable decision contract; separate ADR presentation is a later owned choice. | M7 |
| `m3-secret-value`, `m3-cb-prompt`, `m3-sec-duration`, `m3-sec-justification`, `m3-scope-notes` | No beta UI; their prototype types remain excluded unless separately approved later. | Outside beta |

## Dynamic controls and selectors

`data-tab` buttons navigate six panes (`index.html:70-75`, `js/layout/header.js:2-14`); `.role-card`/`.role-toggle` are runtime-generated (`js/layout/sidebar.js:17-55`); `.esc-option-card`, `m3-q-${q.id}`, `m3-radio-${q.id}`, and `m3-chk-${q.id}` are generated from fixture data (`js/modals/approval.js:138-204,435-446`). Global `[data-close]` removes modal `open` (`js/app.js:13-18`). These selectors have no stable DOM ID inventory entry. Names for implementation components remain TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen '<app shell>' --list` - **PASS: 24/24 (100%)**. Identifier coverage checks literal ID mentions only; it does not assess semantic correctness or whether renamed component IDs preserve intent. Battle Pass is a deliberate excluded screen and remains red.
