# M0 screen pass: Monitor

Authority: `artifacts/dashboard/tabs/monitor.html`, `js/tabs/monitor.js`. Monitor must show truthful correlated events; no fabricated executions. Clear Log is a destructive local fixture action and has no agreed real deletion semantics.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `btn-clear-logs` | `tabs/monitor.html` | `js/tabs/monitor.js` |
| `monitor-level-filter` | `tabs/monitor.html` | `js/tabs/monitor.js`, `js/app.js` |
| `monitor-logs` | `tabs/monitor.html` | `js/tabs/monitor.js` |
| `monitor-role-filter` | `tabs/monitor.html` | `js/tabs/monitor.js`, `js/app.js` |
| `monitor-type-filter` | `tabs/monitor.html` | `js/tabs/monitor.js` |
| `tab-monitor` | `tabs/monitor.html` | none |

Controls: **6**; never referenced IDs: **1** (`tab-monitor`, routing target `js/layout/header.js:2-14`).

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `btn-clear-logs` | click | Empties `state.logs` in memory and rerenders (`js/tabs/monitor.js:51-56`). | [Decision] Clear the visible log buffer/view while preserving durable append-only event records; preserve filters if desired. | See M0 resolution. |
| `monitor-level-filter` | change | Filters fixture logs by exact `level` or all (`js/tabs/monitor.js:8-18,42-50`). | [Proposed] Filter events only by severity provided in the M8 projection; show unavailable before then.| M8 event projection. |
| `monitor-logs` | render | Displays timestamp, type, role, ticket, and message from fixture records (`js/tabs/monitor.js:2-40`). | [Proposed] Render correlated durable events with honest unavailable/empty state.| M8 full read projection; M1 correlation only. |
| `monitor-role-filter` | change | Filters by exact fixture role (`js/tabs/monitor.js:7,10,16,42-50`). | [Proposed] Filter by nine-role set plus system where relevant.| System-vs-role filter model. |
| `monitor-type-filter` | change | Filters agent/system; infers type from `role === system` when missing (`js/tabs/monitor.js:6,9,13-18,42-50`). | [Proposed] Filter event category only when M8 provides an explicit event type.| M8 event projection. |
| `tab-monitor` | nav click | Header activates pane (`js/layout/header.js:2-14`). | [Proposed] Navigate to event monitor.| - |

## Data this screen needs

| Field | Type | Source | Contract? |
| --- | --- | --- | --- |
| timestamp, type, role, ticket id, level, message | event fields | `state.logs` renderer (`js/tabs/monitor.js:13-39`) | Event identity/payload is in the M0 contract; full Monitor projection is M8. |

## Simulation boundary

Logs are fixture-only. `Clear Log` deletes browser memory, not a durable event record. Missing event type is guessed from role. UI must not assert complete event coverage before runtime sources are correlated.

## M0 resolution and owned follow-up

Events are append-only diagnostic records; execution tables/checkpoints remain authoritative ([contracts.md, Identity and ownership](../contracts.md#identity-and-ownership), `Event`). M1 provides runtime event correlation only where supported; Monitor's full event read projection is M8. Until M8, show explicit unavailable/empty states. Clear Log clears the visible log buffer/view while preserving durable event records; filters may remain. These are proposed application contracts, not existing implementation behavior.

M0 event ownership and clear semantics are settled. M1 owns runtime event correlation; M8 owns the Monitor read projection, available category/severity mapping and expanded telemetry quality.

| ID | Question | What it blocks |
| --- | --- | --- |
| `btn-clear-logs` | Clear the visible log buffer/view only; preserve durable journal records and optionally preserve active filters. | M8 Monitor |
| `monitor-type-filter`, `monitor-level-filter` | Until Monitor projection exists, show explicit unavailable state; then filter only categories/severity actually provided. | M8 Monitor |

## Dynamic controls

`.log-line`, `.log-type-badge`, `.log-role`, `.log-ticket`, `.log-msg` are generated render classes (`js/tabs/monitor.js:21-38`). Component names TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen monitor.html --list` - **PASS: 6/6 (100%)**. Identifier coverage does not assess semantic correctness.
