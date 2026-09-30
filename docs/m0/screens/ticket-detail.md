# M0 screen pass: ticket detail

Authority: `artifacts/dashboard/modals/ticket-detail.html` and `js/modals/ticket-modal.js`. M1 is read-only kanban; detail is a real projection. Operator controls are guarded commands; execution state stays backend-authoritative. Do not promise cost when unavailable or expose hidden reasoning. Button behavior here is fixture behavior, not authorization.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `m1-ac-wrapper` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-attempts` | `modals/ticket-detail.html` | none |
| `m1-attempts-body` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-btn-cancel` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-btn-edit-ticket` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-btn-pause` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-btn-pause-icon` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-btn-pause-text` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-btn-return-backlog` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-btn-stop` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-created-text` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-files-wrapper` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-links-wrapper` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metric-cache` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metric-cache-sub` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metric-cost` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metric-cost-sub` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metric-runs` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metric-runs-sub` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metric-tokens` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metric-tokens-sub` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-metrics` | `modals/ticket-detail.html` | none |
| `m1-metrics-role-body` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-overview` | `modals/ticket-detail.html` | none |
| `m1-priority-text` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-role-breakdown-count` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-role-progress-bar` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-role-text` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-runlog` | `modals/ticket-detail.html` | none |
| `m1-runlog-list` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-status-badge` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-ticket-ac` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-ticket-desc` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-ticket-title` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-title` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `m1-turns` | `modals/ticket-detail.html` | none |
| `m1-turns-list` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js` |
| `modal-ticket-detail` | `modals/ticket-detail.html` | `js/modals/ticket-modal.js`, `js/app.js` |

Controls in this screen: **38**; IDs never referenced by script: **5**. `m1-overview`, `m1-runlog`, `m1-turns`, `m1-attempts`, `m1-metrics` are panes toggled by selector, not ID-specific lookup (`js/modals/ticket-modal.js:501-514,220-226`).

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `m1-ac-wrapper` | detail render | Shown only when acceptance criteria exists (`js/modals/ticket-modal.js:58-68`). | [Proposed] Render criteria from ticket revision, hide only when genuinely absent.| - |
| `m1-attempts` | subtab selection | Pane is toggled by generated tab selector (`js/modals/ticket-modal.js:501-514`; markup `modals/ticket-detail.html:51-69`). | [Proposed] Display the explicit assignment/attempt/runtime relations and outcomes from the read projection. | See M0 resolution. |
| `m1-attempts-body` | detail render | Renders attempts fixture rows or \"No attempts recorded\" (`js/modals/ticket-modal.js:147-166`). | [Proposed] Render truthful correlated attempts; unavailable/empty distinction.| - |
| `m1-btn-cancel` | click | Sets fixture status cancelled, appends local log and rerenders (`js/modals/ticket-modal.js:590-606`). | [Proposed] Use the guarded Cancel ticket command after active effects settle. | M7 UI integration |
| `m1-btn-edit-ticket` | click | Closes detail and opens edit form (`js/modals/ticket-modal.js:538-547`). | [Proposed] Use Edit draft only for backlog tickets without an active run; write a new revision. | M2 form integration |
| `m1-btn-pause` | click | Toggles `in_progress`/`paused`, appends local log (`js/modals/ticket-modal.js:549-569`). | [Proposed] Use validated Pause/Resume commands; show pending control request separately from settled run state. | M7 UI integration |
| `m1-btn-pause-icon` | status render | Shows pause or play glyph from fixture status (`js/modals/ticket-modal.js:168-190`). | [Proposed] Communicate available guarded action.| - |
| `m1-btn-pause-text` | status render | Says Pause/Resume (`js/modals/ticket-modal.js:176-190`). | [Proposed] Label according to allowed command and state.| - |
| `m1-btn-return-backlog` | click | Mutates ticket to backlog, logs, closes detail, opens edit (`js/modals/ticket-modal.js:516-535`). | [Proposed] Use Return to Backlog only after any live run has settled through Stop; preserve history. | M7 UI integration |
| `m1-btn-stop` | click | Sets fixture status stopped, logs, rerenders (`js/modals/ticket-modal.js:572-588`). | [Proposed] Use Stop run to inhibit dispatch, settle attempts, and mark ticket blocked; distinct from Cancel ticket. | M7 UI integration |
| `m1-created-text` | detail render | Displays `ticket.created` (`js/modals/ticket-modal.js:38-56`). | [Proposed] Display persisted timestamp with timezone/source contract.| - |
| `m1-files-wrapper` | detail render | Lists fixture filenames or hides wrapper (`js/modals/ticket-modal.js:118-127`). | [Proposed] Show real stored attachment/reference metadata and format/read availability from the approved attachment contract. | M2 |
| `m1-links-wrapper` | detail render | Parses Jira, parent, Confluence, Figma, CTA strings and creates links (`js/modals/ticket-modal.js:70-116`). | [Proposed] Preserve source provenance; link safely; no implied integration authorization.| Safe URL policy / per-source status. |
| `m1-metric-cache` | detail render | Displays supplied/fallback cache tokens; fallback invents 35% (`js/modals/ticket-modal.js:232-305,308-356`). | [Proposed] Show only available measured cache use; otherwise unavailable.| Cache event contract M8. |
| `m1-metric-cache-sub` | detail render | Shows cached prompt reads or computed percent (`js/modals/ticket-modal.js:325-356`). | [Proposed] Show measured value or unavailable; never infer.| M8. |
| `m1-metric-cost` | detail render | Uses fallback model price table and synthetic token counts (`js/modals/ticket-modal.js:232-305,323-345`). | [Decision] Show only actual available usage/cost; unknown cost stays unavailable and never becomes zero. | M8 usage quality |
| `m1-metric-cost-sub` | detail render | Displays fallback prompt/completion pricing (`js/modals/ticket-modal.js:325-343`). | [Proposed] Show actual measured split or unavailable.| M8. |
| `m1-metric-runs` | detail render | Uses role-breakdown list length as run count (`js/modals/ticket-modal.js:358-365`). | [Proposed] Count actual correlated attempts/runs, not role rows. | M8 telemetry |
| `m1-metric-runs-sub` | detail render | Shows computed average cost/role (`js/modals/ticket-modal.js:358-365`). | [Proposed] Show only supported measured metric or omit.| Metric definition M8. |
| `m1-metric-tokens` | detail render | Displays supplied or synthetic token totals (`js/modals/ticket-modal.js:232-305,323-348`). | [Decision] Show actual available usage from configured OpenAI/Codex protocol or unavailable. | M8 usage quality |
| `m1-metric-tokens-sub` | detail render | Splits prompt/completion supplied or synthetic counts (`js/modals/ticket-modal.js:325-348`). | [Proposed] Show measured split or unavailable.| M8. |
| `m1-metrics` | subtab selection | Pane is toggled by selector (`js/modals/ticket-modal.js:501-514`; markup `modals/ticket-detail.html:71-124`). | [Proposed] Provide truthful telemetry only; beta avoids fabricated costs.| M8 data availability. |
| `m1-metrics-role-body` | detail render | Renders role cost/token rows from supplied or fallback values (`js/modals/ticket-modal.js:308-321,384-413`). | [Proposed] Render evidence-backed metrics; no invented zero/cost.| M8 schema. |
| `m1-overview` | initial/subtab selection | Active pane reset on open; selected by data-subtab (`js/modals/ticket-modal.js:220-226,501-514`). | [Proposed] Open on overview.| - |
| `m1-priority-text` | detail render | Displays fixture priority (`js/modals/ticket-modal.js:38-56`). | [Proposed] Display persisted priority.| - |
| `m1-role-breakdown-count` | detail render | Displays role count from metric breakdown (`js/modals/ticket-modal.js:358-369`). | [Proposed] Display only if correlated role contribution data exists.| Role attribution M8. |
| `m1-role-progress-bar` | detail render | Visualizes fallback/supplied role cost percentage (`js/modals/ticket-modal.js:371-382`). | [Proposed] Visualize only measured data; hide when unavailable.| M8. |
| `m1-role-text` | detail render | Displays role label from fixture role map (`js/modals/ticket-modal.js:38-56`). | [Decision] For legacy executions show the effective current runtime role; requested specialty on a product ticket does not imply assignment. | See [roles-tools.md](../roles-tools.md). |
| `m1-runlog` | subtab selection | Pane is toggled by selector (`js/modals/ticket-modal.js:501-514`; markup `modals/ticket-detail.html:43-45`). | [Proposed] Display durable correlated event history.| Event projection M1. |
| `m1-runlog-list` | detail render | Shows fixture strings or 'No log entries' (`js/modals/ticket-modal.js:129-134`). | [Proposed] Show correlated runtime events with actor/time/type when available; otherwise state unavailable/empty honestly. | M1 event correlation |
| `m1-status-badge` | detail render | Displays fixture status and status CSS class (`js/modals/ticket-modal.js:38-50`). | [Decision] Display the settled backend-authoritative ticket/run status projection. | See M0 resolution. |
| `m1-ticket-ac` | detail render | Shows acceptance criteria or hides parent (`js/modals/ticket-modal.js:58-68`). | [Proposed] Show immutable requirement revision criteria.| - |
| `m1-ticket-desc` | detail render | Shows description or \"No description.\" (`js/modals/ticket-modal.js:38-56`). | [Proposed] Show persisted revision description.| - |
| `m1-ticket-title` | detail render | Shows fixture title (`js/modals/ticket-modal.js:38-56`). | [Proposed] Show persisted ticket title.| - |
| `m1-title` | detail render | Set to ticket ID (`js/modals/ticket-modal.js:38-46`). | [Proposed] Identify stable ticket.| - |
| `m1-turns` | subtab selection | Pane is toggled by selector (`js/modals/ticket-modal.js:501-514`; markup `modals/ticket-detail.html:47-49`). | [Proposed] Reveal only approved event/attempt detail; no hidden reasoning promise.| Which safe turn metadata beta exposes. |
| `m1-turns-list` | detail render | Shows fixture turn `type` and `content` or no-turn message (`js/modals/ticket-modal.js:136-145`). | [Decision] Expose only approved operational metadata; no hidden reasoning is promised or displayed. | M1 detail contract |
| `modal-ticket-detail` | open/close | Populates modal and adds `open`; close selector removes it (`js/modals/ticket-modal.js:32-230`; `js/app.js:13-18`). | [Proposed] Display selected ticket projection; stable component name TBD.| - |

## Data this screen needs

| Field | Type | Source in mockup | Already in contracts? |
| --- | --- | --- | --- |
| ticket ID/title/description/priority/status | scalar fields | detail renderer (`js/modals/ticket-modal.js:32-56`) | Ticket identity and settled status projection ([contracts.md](../contracts.md#identity-and-ownership), [Ticket state and board projection](../contracts.md#ticket-state-and-board-projection)). |
| requirement revision/acceptance criteria | text/version | detail renderer (`js/modals/ticket-modal.js:58-68`) | Immutable requirement revision and acceptance fields ([contracts.md](../contracts.md#identity-and-ownership)). |
| role | role key | detail renderer (`js/modals/ticket-modal.js:42-55`) | Effective current runtime role for legacy runs; nine-role activation follows [roles-tools.md](../roles-tools.md) in M4. |
| created timestamp | timestamp | `ticket.created` (`js/modals/ticket-modal.js:44-56`) | UTC timestamp in the ticket contract; UI formats local time ([contracts.md](../contracts.md#identity-and-ownership)). |
| source links/files | references/files + provenance | link/attachment renderers (`js/modals/ticket-modal.js:70-127`) | Source provenance ([contracts.md](../contracts.md#identity-and-ownership)); file limits/formats ([decisions.md](../decisions.md#attachments-and-limits)); external sources are read-only ([decisions.md](../decisions.md#confirmed-owner-decisions)). |
| events, turns, attempts | correlated typed records | detail renderer (`js/modals/ticket-modal.js:129-166`) | Event, assignment and attempt records ([contracts.md](../contracts.md#identity-and-ownership)); hidden reasoning is not assumed ([Effective configuration and measurements](../contracts.md#effective-configuration-and-measurements)). |
| usage/cost/cache | measured values + availability | metric renderer/fallback (`js/modals/ticket-modal.js:232-413`) | Unknown usage/cost is unavailable, never zero ([contracts.md](../contracts.md#effective-configuration-and-measurements)); expanded UI quality in M8. |

## Simulation boundary

Fallback pricing table, synthetic per-attempt token counts and 35% cache rate are invented (`js/modals/ticket-modal.js:232-305`). Empty metrics currently become literal `$0`/zero, which falsely implies measurement (`js/modals/ticket-modal.js:325-337`). Status controls mutate local ticket state and local runLog only (`js/modals/ticket-modal.js:516-606`). Attempts, turns, links and files are fixture records. Hidden reasoning is not a promised product output.

## M0 resolution and owned follow-up

Identity, revision, status and the Board mapping are settled in [contracts.md](../contracts.md#identity-and-ownership) and [Ticket state and board projection](../contracts.md#ticket-state-and-board-projection). Pause, resume, stop, cancel, return to backlog and edit use the matching validated command definitions in [Commands and atomic effects](../contracts.md#commands-and-atomic-effects); command requests and actual settled state must remain distinct. Recovery uses Resume for a reconciled paused/interrupted run or explicit Submit for a new run; no separate Restart button exists. Detail must present measured telemetry as unavailable when unknown and never promise hidden reasoning ([contracts.md, Effective configuration and measurements](../contracts.md#effective-configuration-and-measurements)). These are proposed application contracts, not proof that runtime support exists.

M0 semantics are settled. M1 owns the read projection and correlated event detail; M7 owns guarded operator command execution and evidence; M8 owns usage/cache attribution and completeness.

| ID | Question | What it blocks |
| --- | --- | --- |
| `m1-btn-pause`, `m1-btn-stop`, `m1-btn-cancel`, `m1-btn-return-backlog` | Implement the linked command preconditions/effects; distinguish command request from settled result. | M7 guarded controls |
| `m1-turns-list` | Select only safe operational metadata; no hidden reasoning is promised. | M1 detail projection |
| `m1-metric-cost`, `m1-metric-tokens`, `m1-metric-cache` | Render known values with source/coverage; keep unknown values unavailable, never zero. | M8 telemetry UI |

## Dynamic controls

`.sub-tab-btn[data-subtab]` toggles panes; `[data-close="modal-ticket-detail"]` closes modal; generated anchor badges represent linked references (`modals/ticket-detail.html:9,13-19,70-116`). No stable IDs for these selectors. Component names TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen ticket-detail.html --list` - **PASS: 38/38 (100%)**. Identifier gate does not verify semantic correctness or renamed application identifiers.
