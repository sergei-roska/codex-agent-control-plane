# M0 screen pass: Decisions and Escalations

Authority: `artifacts/dashboard/tabs/decisions.html`, `js/tabs/decisions.js`. Operator controls must be guarded. Imported documents are evidence, not permission grants. Approval UI fixtures do not establish real authorization semantics.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `adr-count` | `tabs/decisions.html` | `js/tabs/decisions.js` |
| `adr-list` | `tabs/decisions.html` | `js/tabs/decisions.js` |
| `escalation-count` | `tabs/decisions.html` | `js/tabs/decisions.js` |
| `escalation-list` | `tabs/decisions.html` | `js/tabs/decisions.js` |
| `tab-decisions` | `tabs/decisions.html` | none |

Controls: **5**; never referenced IDs: **1** (`tab-decisions`, navigation target `js/layout/header.js:2-14`).

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `adr-count` | render | Displays fixture decision count (`js/tabs/decisions.js:48-71`). | [Proposed] Count durable approved decision records.| ADR data/ownership M0. |
| `adr-list` | render | Renders fixture id/title/role/summary and labels them \"Locked ADR - Permanent\" (`js/tabs/decisions.js:48-68`). | [Proposed] Display durable decisions with source, author, status, and history; permanence is not implied.| ADR revision/lock semantics. |
| `escalation-count` | render | Shows fixture pending count or zero and changes badge style (`js/tabs/decisions.js:73-80,133-135`). | [Proposed] Count actionable, unresolved operator decisions from backend.| Escalation status lifecycle M0. |
| `escalation-list` | render/click | Renders fixture summaries/previews; click opens approval modal by fixture ID (`js/tabs/decisions.js:73-141`). | [Proposed] Show actionable typed request; invoke explicit guarded command after authorization.| Supported escalation types and semantics M0/M7. |
| `tab-decisions` | nav click | Header activates pane (`js/layout/header.js:2-14`). | [Proposed] Navigate to durable decisions and pending actions.| - |

## Data this screen needs

| Field | Type | Source | Contract? |
| --- | --- | --- | --- |
| decision id/title/role/summary/date | record | `state.decisions` (`js/tabs/decisions.js:52-67`) | Decision record M0. |
| escalation id/type/role/reason/ticket/urgency | typed request | `state.escalations` (`js/tabs/decisions.js:81-129`) | Approval/action contract M0. |
| command/options/secret/CVE/baseline | type-specific evidence | renderer branches (`js/tabs/decisions.js:90-105`) | No contract; must be explicitly approved/deferred per type. |

## Simulation boundary

Decision and escalation records are in-memory fixtures. \"Permanent\", \"all agent pipelines running autonomously\", retry counts, secret prompts and command previews are fixture claims (`js/tabs/decisions.js:62-63,76-105`). Clicking only opens a synthetic modal. Never infer permission from imported content.

## M0 resolution and owned follow-up

Durable decisions are typed records bound to ticket, run, requirement revision and plan revision; they become stale when a bound revision changes ([contracts.md, Identity and ownership](../contracts.md#identity-and-ownership)). The fixture's "Locked ADR - Permanent" label is not a contract and must not imply immutability beyond the recorded revision/history. Escalations represent typed pending decisions or operator review; only supported validated commands can resolve them ([contracts.md, Commands and atomic effects](../contracts.md#commands-and-atomic-effects)).

M0 identity/ownership is settled. M1 does not define Decisions/approval read endpoints; show explicit unavailable state until M8 provides the full read projection. M7 owns review/action UI and guarded command execution.

| ID | Question | What it blocks |
| --- | --- | --- |
| `adr-list` | Until data is available, show explicit unavailable state; then render contract decisions with revision binding. | M8 read projection; M7 action UI |
| `escalation-list` | Until data is available, show explicit unavailable state; then render supported pending decisions/commands. | M8 read projection; M7 actions |

## Dynamic controls

`.escalation-card` opens modal; data attributes carry fixture id/type (`js/tabs/decisions.js:109-139`). `.adr-card` is display markup. Component names TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen decisions.html --list` - **PASS: 5/5 (100%)**. Identifier coverage does not assess behavior.
