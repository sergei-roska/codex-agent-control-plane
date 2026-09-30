# M0 screen pass: Board

Authority: `artifacts/dashboard/tabs/board.html` and `js/tabs/board.js`. Beta decisions require an initial real read-only kanban, then ticket creation, then Intake; drag/drop cannot declare success or bypass backend lifecycle rules. Roles are the approved nine-role roster; status, search, filters, counts and ticket data must be truthful.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `board-role-filter` | `tabs/board.html` | `js/tabs/board.js`, `js/layout/sidebar.js`, `js/app.js` |
| `board-search` | `tabs/board.html` | `js/tabs/board.js` |
| `btn-view-role` | `tabs/board.html` | `js/tabs/board.js` |
| `btn-view-status` | `tabs/board.html` | `js/tabs/board.js` |
| `cards-backlog` | `tabs/board.html` | none |
| `cards-closed` | `tabs/board.html` | none |
| `cards-in_progress` | `tabs/board.html` | none |
| `cards-needs_attention` | `tabs/board.html` | none |
| `cards-pending` | `tabs/board.html` | none |
| `count-backlog` | `tabs/board.html` | none |
| `count-closed` | `tabs/board.html` | none |
| `count-in_progress` | `tabs/board.html` | none |
| `count-needs_attention` | `tabs/board.html` | none |
| `count-pending` | `tabs/board.html` | none |
| `role-view-container` | `tabs/board.html` | `js/tabs/board.js` |
| `status-view-container` | `tabs/board.html` | `js/tabs/board.js` |
| `tab-board` | `tabs/board.html` | none |

Controls in this screen: **17**; IDs never referenced by script: **12**. Those 12 are rendered targets rather than inert controls: the renderer constructs dynamic IDs and looks them up (`js/tabs/board.js:103-115`); `tab-board` is routing target only (`js/layout/header.js:2-14`).

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `board-role-filter` | change | Filters in-memory tickets by exact role; role options are populated from `ROLES` (`js/tabs/board.js:79-88,186-187`; `js/app.js:3-10`). | [Proposed] Filter real ticket projection by approved nine roles.| - |
| `board-search` | input | Case-insensitive substring match on ticket title or ID (`js/tabs/board.js:79-88,186`). | [Proposed] Search real ticket title/ID.| - |
| `btn-view-role` | click | Switches to role lanes and rerenders (`js/tabs/board.js:177-184`). | [Proposed] Provide role grouping over same real ticket set.| - |
| `btn-view-status` | click | Switches to five status columns and rerenders (`js/tabs/board.js:168-175`). | [Proposed] Provide status grouping over same real ticket set.| - |
| `cards-backlog` | render | Receives generated cards or 'No tickets' (`js/tabs/board.js:103-115`). | [Proposed] Render truthful backlog projection.| - |
| `cards-closed` | render | Receives generated cards or 'No tickets' (`js/tabs/board.js:103-115`). | [Proposed] Render truthful terminal/done projection.| - |
| `cards-in_progress` | render | Receives generated cards or 'No tickets' (`js/tabs/board.js:103-115`). | [Proposed] Render truthful active projection.| - |
| `cards-needs_attention` | render | Receives generated cards or 'No tickets' (`js/tabs/board.js:103-115`). | [Proposed] Render truthful attention-required projection.| - |
| `cards-pending` | render | Receives generated cards or 'No tickets' (`js/tabs/board.js:103-115`). | [Proposed] Render truthful pending projection.| - |
| `count-backlog` | render | Set to count of filtered group (`js/tabs/board.js:103-107`). | [Proposed] Display count from same authoritative projection as cards.| - |
| `count-closed` | render | Set to count of filtered group (`js/tabs/board.js:103-107`). | [Proposed] Display count from same authoritative projection as cards.| - |
| `count-in_progress` | render | Set to count of filtered group (`js/tabs/board.js:103-107`). | [Proposed] Display count from same authoritative projection as cards.| - |
| `count-needs_attention` | render | Set to count of filtered group (`js/tabs/board.js:103-107`). | [Proposed] Display count from same authoritative projection as cards.| - |
| `count-pending` | render | Set to count of filtered group (`js/tabs/board.js:103-107`). | [Proposed] Display count from same authoritative projection as cards.| - |
| `role-view-container` | render | Generates a lane for each `ROLES` entry, with ticket count and 'No tickets assigned' (`js/tabs/board.js:118-145`). | [Decision] M1 legacy cards use effective current runtime roles; do not activate nine new business roles. M4 may use the approved nine-role delivery pack. Empty states stay truthful. | See M0 resolution. |
| `status-view-container` | render | Shows grid for status mode, hidden for role mode (`js/tabs/board.js:90-95,118-123`). | [Proposed] Switch views without changing ticket lifecycle.| - |
| `tab-board` | nav click | Header routing adds active class to pane (`js/layout/header.js:2-14`). | [Decision] Board is the initial/available tab; initial load is read-only.| - |

## Data this screen needs

| Field | Type | Source in mockup | Already in contracts? |
| --- | --- | --- | --- |
| ticket ID/title | strings | card, search (`js/tabs/board.js:5-14,84-87`) | Product ticket projection needed. |
| role | role key | card/filter/lane (`js/tabs/board.js:3,8,85,125-135`) | M1 uses effective current runtime roles; nine-role activation is M4 ([roles-tools.md](../roles-tools.md)). |
| status | enum | card grouping and drag map (`js/tabs/board.js:12,56-65,96-101`) | Settled ticket and legacy status mapping ([contracts.md](../contracts.md#ticket-state-and-board-projection)). |
| model chip | optional model metadata | card renderer (`js/tabs/board.js:11-14`) | Configured OpenAI/Codex model when available; hide/label unknown. No fabricated cost ([contracts.md](../contracts.md#effective-configuration-and-measurements)). |
| lifecycle events | timestamp, prior/new state, actor | mockup appends local runLog (`js/tabs/board.js:66-71`) | Durable event correlation is M1; no local-only claims. |

## Simulation boundary

- `state.tickets` is in-memory fixture data; renders do not fetch the server (`js/tabs/board.js:84-88`).
- Drag/drop directly mutates status and appends a local runLog (`js/tabs/board.js:48-72`). Real beta lifecycle transitions are backend-authoritative; dragging cannot declare success or bypass acceptance.
- `formatModelChip` may display fixture model/cost/cache information (`js/tabs/board.js:11-14`); beta must not fabricate costs.
- Cards are draggable and open edit for backlog/new, detail otherwise (`js/tabs/board.js:19-33,148-159`); these are prototype shortcuts, not authorization rules.

## M0 resolution and owned follow-up

Ticket identity and status mapping are settled in [contracts.md, Ticket state and board projection](../contracts.md#ticket-state-and-board-projection): legacy run completion never implies product-ticket success. M1 renders existing legacy runs under their effective current runtime roles, not as nine activated business roles; see [decisions.md, D-06](../decisions.md#engineering-decisions) and [roles-tools.md](../roles-tools.md). M0 ticket/run identity is covered by [contracts.md, Identity and ownership](../contracts.md#identity-and-ownership).

M0 has no open Board identity/status/role question. M1 owns the exact legacy event projection and M1 cards API; M4 owns enabling the nine-role delivery pack.

| ID | Question | What it blocks |
| --- | --- | --- |
| `cards-*`, `count-*`, `role-view-container` | Render the settled ticket and legacy-run projection, including unknown/unavailable states. | M1 dashboard integration |
| dynamic ticket card | Keep initial Board observation read-only; later mutations use validated commands in `contracts.md`, never a drag-only state write. | M1 read-only; M7 guarded controls |

## Dynamic controls

`.ticket-card` is generated per fixture and clickable/draggable; `.board-column` accepts drops; data attributes `data-col` encode five visual groups (`board.html:17-54`, `js/tabs/board.js:5,19-75,148-159`). Role lanes are generated for `ROLES` (`js/tabs/board.js:124-145`). `data-tab` is in shell navigation. Implementation component names remain TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen board.html --list` - **PASS: 17/17 (100%)**. The gate checks literal identifier mentions, not semantic correctness or replacement component-name equivalence.
