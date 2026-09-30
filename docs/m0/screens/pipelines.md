# M0 screen pass: Pipelines

Authority: `artifacts/dashboard/tabs/pipelines.html`, `js/tabs/pipelines.js`. A general visual pipeline editor is deferred. M0 requires versioned presets but does not infer strict DAG execution; current cyclic manager loop may retry/replan inside validated preset envelope.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `pipelines-container` | `tabs/pipelines.html` | `js/tabs/pipelines.js` |
| `tab-pipelines` | `tabs/pipelines.html` | none |

Controls: **2**; never referenced IDs: **1** (`tab-pipelines`, navigation target via `js/layout/header.js:2-14`).

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `pipelines-container` | initial render | Renders fixture pipeline cards with name, id, ordered role/status steps (`js/tabs/pipelines.js:2-35`). | [Decision] Distinguish a run's task-specific `PlanRevision`/`Stage` progress from reusable `Preset` definition/version. Show truthful progress; no visual pipeline editor in beta scope. | See M0 resolution. |
| `tab-pipelines` | nav click | Header activates pane (`js/layout/header.js:2-14`). | [Proposed] Navigation to truthful preset/status view.| - |

## Data this screen needs

| Field | Type | Source | Contract? |
| --- | --- | --- | --- |
| pipeline id/name/version/steps | typed preset | `state.pipelines` (`js/tabs/pipelines.js:6-34`) | Versioned preset contract M0. |
| step role/status | role key/status | `pipe.steps` (`js/tabs/pipelines.js:7-20`) | Nine-role and status contracts M0. |

## Simulation boundary

Cards are rendered from static in-memory fixtures; they are not persisted plans or live execution graphs. Prototype cards do not establish a DAG or editor requirement. Validate and persist preset revisions before dispatch per M0 plan.

## M0 resolution and owned follow-up

`PlanRevision` and `Stage` are per-run validated, immutable execution plan/progress records; a reusable preset is identified/versioned separately ([contracts.md, Identity and ownership](../contracts.md#identity-and-ownership)). M3 persists the initial validated plan before dispatch; M4 adds the versioned preset registry and initial feature/bugfix/docs/audit stage definitions ([decisions.md, D-07 and Initial presets](../decisions.md#engineering-decisions)). Bounded manager retries are not displayed as a strict preplanned DAG. These are proposed contracts, not implemented runtime guarantees.

No M0 preset choice remains open. M4 owns preset UI/detail and any further validated preset definitions/pilots.

| ID | Question | What it blocks |
| --- | --- | --- |
| `pipelines-container` | Render the initial versioned presets and current run plan/stage progress from the contracts. | M4 |

## Dynamic controls

`.pipeline-card`, `.pipeline-step`, `.chain-arrow` are display-only generated markup (`js/tabs/pipelines.js:7-33`). Component names TBD.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen pipelines.html --list` - **PASS: 2/2 (100%)**. Identifier gate checks literal mentions, not semantics.
