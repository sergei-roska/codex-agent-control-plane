# M0 contract and readiness record

Date: 2026-09-30. M0 establishes implementation boundaries for
[beta-master-plan.md](../beta-master-plan.md); it does not implement the dashboard.
The next increment is M1, the real read-only Board. No M1 work is claimed here.

## Artifacts

| Artifact | Purpose |
| --- | --- |
| [contracts.md](contracts.md) | Identity/ownership, lifecycle, acceptance, commands, effective settings and M1 API/legacy projection |
| [decisions.md](decisions.md) | Owner decisions, engineering defaults, auth/attachments/presets/repository isolation and owned future choices |
| [roles-tools.md](roles-tools.md) | Nine role contracts, PM/lead and legacy mapping, bounded repair routing, reuse inventory and activation gates |
| [prototype-inventory.md](prototype-inventory.md) | Source-based screen passes, orphan/generated controls, simulations and identifier gates |
| [baseline-pilots.md](baseline-pilots.md) | Existing test baseline, independent working copy/integrity and representative real pilot repositories/tasks |
| [backlog.md](backlog.md) | Initial scoped M1 sequence and later milestone backlog, all planned |
| [reference-integrity.sha256.txt](reference-integrity.sha256.txt) | Protected reference baseline for future checks |

## Requirement-by-requirement completion audit

| M0 requirement from master | Evidence and disposition |
| --- | --- |
| Ticket/run/assignment identity, projected statuses, field ownership, acceptance and command contracts | contracts.md specifies entities, immutable revisions, product-vs-execution success, guarded commands and legacy cards; proposed implementation explicitly labeled |
| Nine role contracts, PM/lead mapping, tools/skills, repair and repository isolation | roles-tools.md defines inputs/outputs/authority, interim M3 and M4 pack mapping, candidates vs active tools and stronger repair policy; decisions D-04/D-05 define checkout lease/branch/candidate ownership |
| Explicit owner Jira write scope | O-06: read-only Jira/Confluence plus internal tracking; all writes deferred. Master and product notes updated |
| Beta Jira types/actions, authentication, attachments, initial presets and config pinning | decisions defines deployment-mapped read types, pairing/session and credential strategy, explicit format/limit defaults and four presets; contracts pins run/attempt configuration |
| Every prototype screen/control, handlers, simulation replacement, data gaps and exclusions | Eleven in-scope passes cover shell, six tabs and four overlays; dynamic selectors covered separately; Battle Pass explicit owner exclusion. Source file:line accompanies behavior |
| Independent application copy and protected baseline | 46 files in each tree; no shared inode/symlink; contents equal; 46 protected SHA256 entries verified. No protected build/edit |
| Existing relevant suite with honest counts and environment distinction | Approved full npm test: 317/317, zero failures/skips; initial EPERM limitations documented separately; no live-provider claim |
| Representative pilot repositories/tasks, read-only planning | Two canonical Git roots/state recorded, three local fixture objectives and known check evidence; real Jira keys/access owned U-02 at M6 |
| Contract artifacts and initial backlog | Linked artifacts above; M1-01 through M1-07 with dependencies/acceptance plus M2-M9 planned |
| Unresolved decisions have owners and milestones | decisions U-01 through U-06; screen presentation/protocol checks assigned to their implementation milestones. No unresolved M0 choice blocks M1 |

## Verification and limits

The identifier gate starts at 0/158 and ends at 155/158 (98%). All 155 in-scope
IDs are accounted for. The three intentionally uncovered Battle Pass IDs keep
the full gate red; exclusion is explicitly recorded, not claimed as complete
implementation. The gate tests literal mentions only, not semantic correctness.
Source-based screen review and an independent read-only audit additionally
checked dynamic controls, lifecycle consistency, provider/cost/hidden-reasoning
claims and proposed-vs-existing behavior. Corrections reconcile screen questions
with settled contracts and retain owned implementation choices.

The successful existing suite verifies current code with fake protocol fixtures,
not the new contracts. Runtime/API/session/role-pack changes and live OpenAI/Jira
pilots need milestone-specific evidence. Protected-source hashes prove integrity
since capture, not an unrecorded earlier history. The master release checklist
remains pending for M1-M9; no release, merge or publication is performed by M0.
