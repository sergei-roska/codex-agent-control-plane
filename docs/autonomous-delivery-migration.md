# Autonomous delivery backlog migration

Date: 2026-11-06. Baseline: `ab5c195`. The active development authority is
[autonomous-delivery-backlog.md](autonomous-delivery-backlog.md). The former
backlogs remain intact as historical records; their original IDs, wording,
statuses, evidence, and decisions are retained. This table records each open,
deferred, pending-activation, or unqualified item and its disposition. Items
outside the owner's autonomous-delivery objective are explicitly deferred, not
deleted or marked done. See
[autonomous-delivery-constraints.md](autonomous-delivery-constraints.md) for
source-backed restrictions and current gaps.

Disposition terms: **carry** means the open work remains in the new backlog;
**merge** means its objective is carried under a new ID; **split** means the
in-scope portion is carried and the stated out-of-scope portion is deferred;
**defer** means it remains historical open work outside this objective;
**supersede** means the
new owner requirement or current evidence replaces the former proposed behavior,
while its historical status remains unchanged.

## `docs/orchestrator-improvement-backlog.md`

| Old ID/family | Historical open status | Disposition | New ID or reason |
| --- | --- | --- | --- |
| HAR-01 | Live model-generated overlap measurement still pending | defer | Comparative throughput measurement is not a functional completion gate; retain for the already-scoped matched trial and its existing authorization. |
| HAR-02 | Incident repair recorded; current delivery loop still needs end-to-end proof | merge | AD-04, AD-06, AD-08 cover autonomous recovery and accepted completion; incident history remains evidence. |
| HAR-04 | Exact original crash cause unknown; current launcher readiness/diagnostics repaired | defer | Historical cause cannot be recovered from absent logs; do not claim it was established. |
| OPT-01..03 / full M2 routing-shadow criterion | Not started/incomplete | defer | Cost routing and shadow predictions are economy work, not a prerequisite for autonomous correctness. Preserve as open in the archived backlog. |
| ACT-02, ACT-03 | Deferred pending a named fault case, selected boundary, or evidenced queue demand | defer | No process-topology/mailbox change is required by the fire-and-forget objective; reopen on stated evidence. |
| DBC-06 | Deferred because no supported mandatory mutation interception route was demonstrated | defer | Retain the concrete enforcement-boundary reason; no bypassable proxy is added to the autonomy backlog. |
| WAL-04 | Deferred because no operation has qualified durable compensation semantics and mandatory mutation route | defer | Preserve as open; AD-05 reconciles supported effects and does not invent rollback. |
| PIP-05 | Deferred because no repeated CLI composition consumer was demonstrated | defer | Not required for objective completion; reopen with a real consumer. |
| OPT-04 | Deferred behind unstarted OPT-01..03 | defer | Keep economy routing separate from functional completion. |
| CA-01 | Queued after PW-3; competing writer approach undecided | defer | Competing writers are optional and do not establish fire-and-forget delivery. |
| EP-01 | Queued after CA-01; owner-selected execution-path catalog | defer | A path catalog is not required to preserve the accepted objective contract. |
| LL-7 | Implemented; browser check noted open | carry | AD-07 explicitly requires the LL-7 browser check for the decision/status card, evidence, recommendation, independent work, and option selection. |
| LL-8 | Locally qualified; activation pending | merge | AD-04/AD-08 carry healthy long-run recovery; old bounded recurrence behavior is not authority to ask for continuation or finish incomplete work. |
| LL-9 | Implemented on branch; activation pending | supersede | AD-04/AD-06 replace the default round-limit/summary pause as a completion policy. Reuse truthful partial ledger and checkpoint evidence; no arbitrary round limit may imply completion or owner continuation. |
| CTX-01 | Live cap effect, shared explorer map, and compact skill digests open | defer | Prompt efficiency/read discipline is not needed for functional acceptance; preserve as open measurement/quality work. |
| TOK-PROMPT-01 | Queued comparative prompt-compression study | defer | Economy trial only; must preserve acceptance and safety if separately resumed. |
| ROLE-01 | Source complete; browser modal check noted open | defer | Account/profile controls are existing infrastructure; this UI check is outside the autonomous-delivery acceptance scenario. |
| UI-01 | Idea; source of per-attempt skill/tool availability unresolved | defer | AD-07 covers objective delivery status; the skills/MCP inventory remains optional UI work and is not claimed as carried. |
| UI-02 | Idea; account-vs-shared integration credentials and profile ownership unresolved | defer | External integrations are not required to deliver the accepted objective; preserve owner decision questions in the historical record. |
| OPS-03 | Project-level lead guard false-positive repair request | defer | Separate harness command-guard issue; preserve its historical evidence and owner-approval note. |
| AUT-01 runtime enrollment/admission | Offline traceability pilot accepted; runtime enrollment remains unqualified | defer | No need to introduce a second requirements/task registry in this backlog; revisit only if current objective/checkpoint records fail traceability. |
| AUT-03 paired planning trial | Offline delivery qualified; paired live trial pending | defer | Comparative planning quality/economy trial, not functional release gate. |
| AUT-04 | Read-only evidence-tool idea | defer | Existing interfaces are to be evaluated first; no MCP tool is required by this objective. |
| AUT-05 live workflow/economy measures | Baseline accepted; live measures unavailable | defer | Separate comparative trial; unknown economy metrics remain unknown. |
| A2 external CI | Local preflight implemented; external runner absent/unqualified | carry | AD-06 requires configured mandatory checks; AD-08 must prove them. If required checks need an external credential/runner not available locally, investigate and ask for that specific owner-provided access; do not claim pass. |
| A3/A4 bounded planning recovery and typed owner boundary | Implemented and reviewed; autonomy still needs full-flow qualification | merge | AD-04 carries investigation-before-question and technical recovery; AD-06 preserves honest partial/acceptance outcomes. |
| BUD-1, BUD-2, ACC-01 | Historical implementation marked done; full two-account/restart/acceptance path not evidenced | merge | AD-02, AD-03, AD-08 extend/qualify the existing capability. Historical done statuses are not changed. |

## `docs/dashboard-ideas-backlog.md`

| Old ID/family | Historical open status | Disposition | Reason |
| --- | --- | --- | --- |
| UI-PERF-01 | Implemented in working tree; review and visual checks recorded | defer | Preserve its implementation/evidence record; richer performance/token metrics are not functional completion criteria. |
| UI-01 | Idea, design questions open | split | AD-07 carries current objective, account/wait, next action, and disposition status. Skills/MCP inventory and tool-availability design remain deferred optional UI work. |
| UI-02 | Idea, credential ownership and per-role policy open | defer | External-service integrations are outside this objective; the former data/write boundary questions remain unanswered and must be resolved before implementation. |

## `docs/architecture/concurrent-harness/implementation-backlog.json` and plans

All package statuses and qualification notes remain unchanged in the archived
JSON and markdown files. `source_accepted` and offline qualification mean the
documented local/source gate passed; they do not establish activation or
end-to-end objective autonomy.

| Old ID/family | Historical open status | Disposition | New ID or reason |
| --- | --- | --- | --- |
| CN-00..CN-13 | Local design/source accepted | merge | Reuse their contracts, stores, scheduler, steering, review, recovery, and acceptance components under AD-01..AD-07; do not repeat accepted package research. |
| CN-14 | Prerequisites qualified; whole composition/integration remains pending | merge | AD-01..AD-07 own required runtime wiring and AD-08 owns integrated qualification. Preserve legacy-run compatibility and engine exclusivity obligations. |
| CN-15 | Offline scenarios accepted; live/comparative qualification pending | split | AD-08 carries functional release qualification, including deterministic quota cases and scoped provider integration smoke checks where needed. Matched economy/comparative trials remain separate work. |
| SUCCESSOR-BASE-01 | Unqualified successor rebasing behavior | carry | AD-06 explicitly requires an executable successor-rebasing case proving that a dependent reads the accepted predecessor candidate and rejects a stale target. |
| CN15-L6 | Unqualified; live provider comparison separately scoped | defer | The matched real-provider comparison remains separate from functional release qualification; preserve its existing authorization and evidence tier, and infer no cost or model-quality result from AD-08. |

## Preservation and priority rules

The archived documents remain reachable from their original paths and anchors;
this migration does not rewrite their historical states. Old policy suggestions
that impose default round counts, continuation questions, blanket defers, or
feature activation gates are superseded where they conflict with the current
owner objective. Preserve a restriction only when an owner requirement, a
provider fact, or a demonstrated authorization/data-integrity invariant supports
it. Functional completion and economy/comparative trials stay separate.
