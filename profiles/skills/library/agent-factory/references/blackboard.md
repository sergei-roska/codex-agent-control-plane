# A2A Blackboard Memory Protocol

Reference for `agent-factory` (`factory-conductor`). Loaded by SKILL.md at every dispatch and every handoff-persistence step.

## Transport Mandate

All multi-agent communication occurs over MCP `agent-memory`. Subagent prompt context must never contain serialized file dumps. [grounded: sources/factory_conductor_skill_spec_prompt.md:L144]

## Pointer Dispatch Format

```json
{
  "task_id": "FACT-2026-001",
  "memory_id": "mem_01JH8Q72XYZ",
  "caller_role": "factory-conductor",
  "target_role": "domain-architect",
  "action_mode": "DECOMPOSE_DOMAIN",
  "target_dir": "/absolute/path/to/target/project",
  "assigned_skills": ["divide-and-conquer", "actor-model"]
}
```

[grounded: sources/factory_conductor_skill_spec_prompt.md:L147-L155]

### Field Definitions

| Field | Type | Meaning |
| --- | --- | --- |
| `task_id` | string | Work-item identifier for the whole task, format `<PREFIX>-<year>-<seq>` (literal example `FACT-2026-001`). |
| `memory_id` | string | Opaque identifier of this pointer record inside `agent-memory`, returned by the MCP write call, format `mem_<opaque>` (literal example `mem_01JH8Q72XYZ`). |
| `caller_role` | string | Role issuing the dispatch. At the top level this is always `factory-conductor`. |
| `target_role` | string | Subagent name or `archetype:<type>` literal receiving the dispatch. |
| `action_mode` | string | Verb naming the unit of work for the target (source's only literal example: `DECOMPOSE_DOMAIN`). |
| `target_dir` | string | Absolute path of the workspace the dispatched work operates on. |
| `assigned_skills` | string[] | Optional JIT skill names assigned to target subagent for this specific stage execution per the Role-Based Skill Access Control Matrix. |

`task_id` and `memory_id` formats above are shape-only patterns inferred from the source's single literal example; no ID-generation rule is stated in the source. [extrapolated: format shape matches L149-150, generation/sequencing rule is not in the source]

`action_mode` has no enumerated value list in the source beyond the one literal example `DECOMPOSE_DOMAIN` for a modeler-archetype target. [grounded: sources/factory_conductor_skill_spec_prompt.md:L153] Do not present any other `action_mode` string as grounded; construct new ones only as `[extrapolated]` values that name the unit of work being dispatched (see worked examples below), never invented as unlabeled fact.

## Mandatory Tagging Schema

[grounded: sources/factory_conductor_skill_spec_prompt.md:L158-L166]

| Tag | Meaning | Source Line |
| --- | --- | --- |
| `work-item` | Root task item created by Conductor. | L159 |
| `handoff` | Output delivered by any subagent. | L160 |
| `role:<name>` | Specific agent name (e.g. `role:fidelity-skeptic`). | L161 |
| `archetype:<type>` | Functional archetype (e.g. `archetype:censor`). | L162 |
| `wi:<task_id>` | Unique work-item identifier. | L163 |
| `attempt:<n>` | Retry index. | L164 |
| `verdict:PASS` / `verdict:FAIL` | Validation gate outcome. | L165 |
| `scope:<context>` | Operational context (e.g. `scope:prd`, `scope:external-agent`). | L166 |
| `stage:<name>` | Pipeline stage that produced this handoff (e.g. `stage:sanitize_ground`). Enables per-(wi,stage) lookup required by the conflict resolution read rule. | [extrapolated: mechanically required for the Handoff Conflict Resolution read rule; no source line names this tag] |
| `status:obsolete` | Applied by `update_memory` to a superseded handoff record. Marks it as no longer authoritative without deleting it. | [extrapolated] |
| `catalog:skill` | Skill catalog registration node in Blackboard. | [extrapolated] |
| `skill:<name>` | Specific architectural skill identifier. | [extrapolated] |

### Deterministic Tag Application

- `work-item` and `wi:<task_id>` are applied once, at task creation, to the root Blackboard entry the Conductor writes for the whole task. [grounded: sources/factory_conductor_skill_spec_prompt.md:L159,L163]
- `handoff`, `role:<name>`, `archetype:<type>`, `wi:<task_id>`, `stage:<name>`, `attempt:<n>`, `verdict:PASS`/`verdict:FAIL`, `scope:<context>` are applied together to every stage-level subagent output record. [grounded: sources/factory_conductor_skill_spec_prompt.md:L160-L166; `stage:<name>` is [extrapolated] as mechanically required for conflict resolution lookup] A subagent classified with a primary and a secondary archetype (per `archetypes.md`) carries two `archetype:<type>` tags on the same handoff record. [extrapolated: L63 states the dual-assignment outcome but not how it propagates into Blackboard tagging; tagging both is the minimal rule consistent with "primary and secondary" naming, not an added feature]
- Exactly one of `verdict:PASS` or `verdict:FAIL` is present on every stage-level handoff record; never both, never neither. [grounded: sources/factory_conductor_skill_spec_prompt.md:L165]
- `status:obsolete` is applied only by the conductor's `update_memory` retraction call (see Handoff Conflict Resolution below); it is never present on a freshly written handoff record. [extrapolated]

## Reasoning-Tag Envelope to Blackboard Mapping

A `pro`-tier subagent's `<handoff_payload>` JSON (see `model_policy.md`) is the source of the `role`, `archetype`, `attempt`, `verdict`, `scope` values the conductor writes into the tag set above at persistence time; the `work-item`/`handoff` labels are conductor-assigned structural tags, not something the subagent emits. [extrapolated: L159-160 describe these as "Root task item created by Conductor" and "Output delivered by any subagent," i.e. conductor-side bookkeeping]

## Handoff Conflict Resolution

[extrapolated: the source defines the append-only Blackboard and the retry/circuit-breaker protocol (L133-L138) but specifies no conflict resolution rule; this section is this skill's own non-inventive extension to make retried verdicts deterministically queryable]

### Problem

The Blackboard is append-only. When stage S retries (attempt:0 then attempt:1 or higher), multiple handoff records exist under the same `wi:<task_id>` + `stage:<S>` tag pair with potentially contradictory verdicts. Without a resolution rule, any `search_memories` call for that (wi, stage) pair returns all records and the consumer cannot identify the authoritative verdict.

### Write Protocol: Retract-Then-Supersede

Before writing a retry handoff record (i.e., `attempt > 0` for stage S within the same pipeline run), the conductor MUST execute the following two-step sequence:

1. **Lookup**: call `search_memories` with tags `["handoff", "wi:<task_id>", "stage:<S>"]` to retrieve all prior handoff records for that (wi, stage) pair. From the results, identify the record with the highest `attempt` value; record its `memory_id` as `prev_memory_id`. Exclude any record already tagged `status:obsolete` from this selection.
2. **Retract**: call `update_memory(memory_id=prev_memory_id, tags=[...all existing tags of that record..., "status:obsolete"])` to mark the prior record as superseded. If this call fails, do NOT write the new record; treat the failure as a stage execution error subject to the circuit-breaker retry logic (SKILL.md Step 6.7).
3. **Write**: write the new handoff record to `agent-memory` with all mandatory tags plus `supersedes:<prev_memory_id>` included in the record content. The `supersedes` field value is `prev_memory_id` from step 1; it is `null` (and the field may be omitted) for `attempt:0` records that have no predecessor.

This sequence is the atomic invalidation unit for one (wi, stage, attempt) transition. Steps 2 and 3 are not transactionally atomic at the MCP level; the ordering (retract first, write second) guarantees that a partially-completed sequence leaves at most one `status:obsolete` record and at most zero new records, never two simultaneously active non-obsolete records for the same (wi, stage) pair.

### Read Rule: Latest-Attempt-Wins

To determine the authoritative verdict for stage S of task `wi:<task_id>`:

1. Call `search_memories` with `tags=["handoff", "wi:<task_id>", "stage:<S>"]`.
2. Discard every result that carries the tag `status:obsolete`.
3. From the remaining results, select the record with the highest `attempt` value.
4. The selected record's `verdict` (PASS or FAIL) is the sole authoritative outcome for that (wi, stage) pair.
5. If step 3 yields zero records: the Blackboard is in a corrupt state (all records for this stage were retracted but no replacement was written); treat as a `BLOCKED` condition and halt.
6. If step 3 yields multiple records sharing the same maximum `attempt` value: this is a duplicate-write defect; treat as `BLOCKED` and halt.

The read rule is deterministic: exactly one non-obsolete record with the maximum attempt index is always the authoritative verdict, provided the write protocol above was followed.

## Pipeline-State Record Protocol

[extrapolated: the source defines no lifecycle protocol for records tagged `pipeline-state`; this section is this skill's own non-inventive extension, mirroring the Handoff Conflict Resolution retract-then-supersede pattern to give any reader a deterministic single-truth for the running/terminal state of a task]

### Problem

When a pipeline progresses through phases (e.g. PAUSED at a budget boundary, then RESUMED, then SUCCESS or BLOCKED), multiple `pipeline-state` records accumulate in `agent-memory` for the same `wi:<task_id>`. Without a retraction protocol, all of them remain active simultaneously and a fresh reader cannot determine which is authoritative.

### Write Protocol: Retract-Then-Supersede for Pipeline-State

Whenever the conductor writes a new `pipeline-state` record for a given `wi:<task_id>` (e.g. on PAUSED, RESUMED, or terminal transition), it MUST execute the following sequence:

1. **Lookup**: call `search_memories` with `tags=["pipeline-state", "wi:<task_id>"]`. Collect all results not already tagged `status:obsolete`.
2. **Retract**: for each result from step 1, call `update_memory(memory_id=<id>, tags=[...existing tags..., "status:obsolete"])`. If any `update_memory` call fails, do NOT write the new record; treat the failure as a stage execution error and route through the circuit-breaker retry logic (SKILL.md Step 6.7).
3. **Write**: write a single new `pipeline-state` record to `agent-memory` with the updated status tag. Include `supersedes:[list of memory_ids retracted in step 2]` in the record content.

### Terminal Transition (SUCCESS or BLOCKED)

Immediately before returning the output object at any Stop Condition that produces `status:SUCCESS` or `status:BLOCKED`, the conductor MUST apply the retract-then-supersede write protocol above with the terminal status tag (`status:success` or `status:blocked`). This is mandatory even if no prior `pipeline-state` record exists for the task (step 1 would return zero results; step 2 is a no-op; step 3 writes the single terminal record). If the retraction or write fails during a BLOCKED termination, log the failure to `agent-memory` but do not change the BLOCKED return; the task is already in a terminal error state.

### Read Rule: Single Non-Obsolete Record

To determine the current pipeline state for task `wi:<task_id>`:

1. Call `search_memories` with `tags=["pipeline-state", "wi:<task_id>"]`.
2. Discard every result that carries the tag `status:obsolete`.
3. From the remaining results, assert exactly one record exists.
4. That record's `status:*` tag is the sole authoritative pipeline state.
5. If step 3 yields zero records: no pipeline-state record has been written yet (task not yet initialized) or the Blackboard is in a corrupt state; treat as `BLOCKED` if the task_id is known to have been initialized.
6. If step 3 yields multiple records: this is a duplicate-write defect (step 2 of the write protocol was not executed or failed silently); treat as `BLOCKED` and halt.

## Work-Item Terminal-State Protocol

[extrapolated: the source defines the root `work-item` entry at task creation (L159, L163) but specifies no terminal update; this section is this skill's own non-inventive extension to make the root entry queryable as a single-truth terminal-state indicator]

### Write Protocol: Terminal Tag Update

The root work-item entry is written once at Task Initialization (SKILL.md Step 4.2) and is never replaced or deleted. Instead, on pipeline termination the conductor appends a terminal status tag to the existing entry via `update_memory`:

- **On SUCCESS**: call `update_memory(memory_id=<root_work_item_memory_id>, tags=[...existing tags..., "status:success"])`. Store `root_work_item_memory_id` at Step 4.2 for use here.
- **On BLOCKED**: call `update_memory(memory_id=<root_work_item_memory_id>, tags=[...existing tags..., "status:blocked"])`. If this call fails during a BLOCKED termination, log the failure but do not change the BLOCKED return.

The root entry must never carry more than one `status:*` tag. Exactly one of `status:success` or `status:blocked` is added exactly once, at the moment of terminal transition.

### Read Rule

To determine whether a task has terminated and with what outcome:

1. Call `search_memories` with `tags=["work-item", "wi:<task_id>"]`.
2. The result is the single root entry for that task.
3. If it carries `status:success`: the task completed successfully.
4. If it carries `status:blocked`: the task terminated with a BLOCKED error.
5. If it carries neither: the task is still running or was interrupted before a terminal transition was written.

## Few-Shot Dispatch Examples

Each example below fills the literal pointer-dispatch shape (L147-L155) with illustrative values; only the shape and the field names are grounded, illustrative values (task IDs, memory IDs, directory paths, non-literal `action_mode` strings) are `[extrapolated]` unless noted as reused from the source's own example.

### Example 1: `/factory create`, Stage 3 (Specify & Contract, archetype:specifier)

Command: `/factory create pricing-engine --source sources/pricing_spec.md --target-dir /home/projects/acme-app`

```json
{
  "task_id": "FACT-2026-014",
  "memory_id": "mem_01JHA3K9QRS",
  "caller_role": "factory-conductor",
  "target_role": "contract-specifier",
  "action_mode": "DRAFT_CONTRACT",
  "target_dir": "/home/projects/acme-app"
}
```

Tags persisted once the handoff resolves with a passing verdict:

```
handoff, role:contract-specifier, archetype:specifier, wi:FACT-2026-014, attempt:0, verdict:PASS, scope:pricing-engine
```

`action_mode: "DRAFT_CONTRACT"` is constructed by parallel construction with Stage 3's name "Specify & Contract" (L105) and the `archetype:specifier` exemplar `contract-specifier` (L46). [extrapolated]

### Example 2: `/factory skill`, Stage 4 (Synthesize & Assemble, archetype:synthesizer)

Command: `/factory skill extractor --target pricing-engine --source sources/methodology.md`

```json
{
  "task_id": "FACT-2026-015",
  "memory_id": "mem_01JHA3M2VWX",
  "caller_role": "factory-conductor",
  "target_role": "workflow-designer",
  "action_mode": "SYNTHESIZE_SKILL",
  "target_dir": "/home/projects/acme-app/.agents/agents/pricing-engine"
}
```

Tags persisted, showing a failing verdict (first attempt before a retry):

```
handoff, role:workflow-designer, archetype:synthesizer, wi:FACT-2026-015, attempt:0, verdict:FAIL, scope:skill-attach
```

The `--target pricing-engine` CLI flag names the existing agent receiving the new skill, which resolves `target_dir` to that agent's own directory; this is distinct from `target_role`, the specialist performing the synthesis work at this stage. [extrapolated: the source states the `skill` route "attaches a deterministic skill to an existing agent" (L123) but never spells out this exact directory-resolution mechanics]

### Example 3: `/factory review --mode executability`, Stage 5 (Adversarial Audit / DoD, archetype:critic)

Command: `/factory review /home/projects/acme-app/.agents/agents/legacy-billing-agent.md --mode executability`

```json
{
  "task_id": "FACT-2026-016",
  "memory_id": "mem_01JHA3P7LMN",
  "caller_role": "factory-conductor",
  "target_role": "executability-critic",
  "action_mode": "AUDIT_EXECUTABILITY",
  "target_dir": "/home/projects/acme-app/.agents/agents/legacy-billing-agent.md"
}
```

Tags persisted, at `attempt:1` (a retry) with a passing verdict, reusing the source's own literal `scope:external-agent` value:

```
handoff, role:executability-critic, archetype:critic, wi:FACT-2026-016, attempt:1, verdict:PASS, scope:external-agent
```

`target_role`/`archetype:critic` follow the exemplar `executability-critic` given in the source [grounded: sources/factory_conductor_skill_spec_prompt.md:L54]. `action_mode: "AUDIT_EXECUTABILITY"` is [extrapolated: constructed as "AUDIT_" + the --mode flag value; no action_mode string is given anywhere in the source for the review route]. `scope:external-agent` reuses the source's own literal scope example verbatim [grounded: sources/factory_conductor_skill_spec_prompt.md:L166].

## Cross-References

- Archetype-to-subagent mapping used to fill `target_role`: `archetypes.md`.
- Model tier and reasoning-tag envelope that produces the `handoff_payload` these tags are derived from: `model_policy.md`.
- Retry/attempt semantics and circuit breaker behavior: `pipelines.md`.
