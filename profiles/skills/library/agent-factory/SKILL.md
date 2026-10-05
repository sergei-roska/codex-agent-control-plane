---
name: agent-factory
description: "Master orchestration skill for factory-conductor: parses /factory (init|create|skill|prompt|review) and /doc (<type>|brainstorm|review) commands, classifies subagents into 6 cognitive archetypes, allocates model tier and reasoning depth, drives the universal 6-stage DAG pipeline over an A2A Blackboard protocol with a 2-retry circuit breaker, and compiles the final artifact only after a passing Adversarial Audit quality gate."
---

# Agent Factory (factory-conductor)

Master orchestration skill for `factory-conductor`, the heuristic cognitive decision engine that coordinates a multi-agent workforce across agent synthesis, system audits, product architecture (PRD, Technical Specifications / TZ), prompt engineering, and structured brainstorming. [grounded: sources/factory_conductor_skill_spec_prompt.md:L12] It does not rely on hardcoded agent names: it dynamically classifies any encountered subagent by archetype, allocates model tiers and reasoning depths, and synthesizes DAG execution pipelines. [grounded: sources/factory_conductor_skill_spec_prompt.md:L6]

Detail tables, algorithms, and worked examples referenced below live in `references/roles.md`, `references/archetypes.md`, `references/model_policy.md`, `references/pipelines.md`, and `references/blackboard.md`. This file owns only the master runbook: intent parsing, workspace resolution, the execution loop, and the pre-write quality gate.

## Decisions (frozen)

- All multi-agent communication occurs over MCP `agent-memory` as pointer dispatches; subagent prompt context never contains serialized file dumps. [grounded: sources/factory_conductor_skill_spec_prompt.md:L144]
- All command routes execute the full 6-stage universal pipeline (Stage 1 through Stage 6). [extrapolated: the source states the universal pattern applies to "every robust analytical or synthesis task" with no stated exception (L96-L97) and only `/factory create` is explicitly confirmed as full 6-stage (L121); no source line states this for the other routes, so this is an inference from the "every ... task" wording, not an enumerated fact - see Open questions] Whether any route is intended to run a narrower subset remains an open question (see Open questions).
- `--model pro|fast` (L83) is applied as an opaque override string that replaces the Model Selection Matrix tier lookup outright for every attempt of the invocation, rather than being mapped onto the four internal tier names `flash`/`pro`/`inherit`/`flash_lite` (L75-L80), since the source never reconciles the flag's two literals with the matrix's four tier names. [extrapolated: minimal non-inventive resolution; see `references/model_policy.md` and Open questions]
- A stage whose `attempt:0` (or later) model tier is already `pro` (or `inherit` resolved to `pro`) holds at `pro` on any further retry, since no tier above `pro` is defined anywhere in the Model Selection Matrix. [extrapolated: absence of a higher tier forces a hold, not an invented tier]
- Maximum retries per stage: 2, expressed as `attempt:0`, `attempt:1`, `attempt:2` (3 total dispatch attempts, 2 of which are retries). [grounded: sources/factory_conductor_skill_spec_prompt.md:L134]
- On the third failing attempt (`attempt:2` FAIL) of any stage, the circuit breaker trips: status is set to `BLOCKED`, the pipeline pauses, and the exact blocker is reported to the user gateway. [grounded: sources/factory_conductor_skill_spec_prompt.md:L138]
- Stage 5 (Adversarial Audit, `archetype:critic`) is the mandatory pre-write quality gate. It sits immediately before Compile & Persist in the pipeline order and Module 5 requires verification checklists before writing any file to disk. [grounded: sources/factory_conductor_skill_spec_prompt.md:L111-L114,L177] Gating the write on `verdict:PASS` specifically composes this ordering fact with the verdict/retry mechanics (a stage only advances on `verdict:PASS`, per the circuit breaker protocol). [grounded: sources/factory_conductor_skill_spec_prompt.md:L133-L138,L165]
- Authored output for this skill and its references is strictly English, ASCII-only punctuation (straight quotes, hyphens, literal `...`), with no em-dashes, en-dashes, typographic quotes, or ellipsis glyphs; instructions are deterministic (no "analyze thoroughly"-style vague language); deliverables are complete production content with no TODOs. [grounded: sources/factory_conductor_skill_spec_prompt.md:L184-L192]

## Trigger & Activation

### Positive Triggers (MUST Run)

- A raw command beginning with `/factory ` followed by one of: `init`, `create`, `skill`, `prompt`, `review`.
- A raw command beginning with `/doc ` followed by one of: `prd`, `tz`, `adr`, `task`, `brainstorm`, `review`.
- Any request to synthesize a new subagent, attach a skill to an existing agent, audit an external agent/prompt/spec for fidelity or executability, generate `prd`/`tz`/`adr`/`task` documentation, synthesize a production prompt from requirements, or run structured multi-perspective brainstorming, when the request should be routed through classified subagents rather than answered directly.
- Any request to classify an unfamiliar subagent into a cognitive archetype, or to determine model tier/reasoning depth for a dispatch.

### Negative Triggers (MUST NOT Run)

- A single, already-scoped specialist task where the caller has already selected the exact subagent and no archetype classification, model-tier allocation, or DAG assembly is needed (dispatch the specialist directly instead).
- Direct file edits or tool execution requested outside the `/factory` and `/doc` command grammar with no synthesis/audit/documentation intent.

## Input Contract

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AgentFactoryConductorInput",
  "type": "object",
  "required": ["command"],
  "additionalProperties": false,
  "properties": {
    "command": { "type": "string", "enum": ["init", "create", "skill", "review", "doc", "prompt", "brainstorm"] },
    "target_dir": { "type": "string", "minLength": 1 },
    "profile": { "type": "string", "enum": ["core", "full"] },
    "name": { "type": "string", "minLength": 1 },
    "source": { "type": "string", "minLength": 1 },
    "target": { "type": "string", "minLength": 1 },
    "target_path": { "type": "string", "minLength": 1 },
    "mode": { "type": "string", "enum": ["fidelity", "executability", "all"] },
    "fix": { "type": "boolean", "default": false },
    "doc_type": { "type": "string", "enum": ["prd", "tz", "adr", "task"] },
    "subject": { "type": "string", "minLength": 1 },
    "output": { "type": "string", "minLength": 1 },
    "reqs": { "type": "string", "minLength": 1 },
    "topic": { "type": "string", "minLength": 1 },
    "model": { "type": "string", "enum": ["pro", "fast"] }
  },
  "allOf": [
    { "if": { "properties": { "command": { "const": "init" } } }, "then": { "required": ["target_dir"] } },
    { "if": { "properties": { "command": { "const": "create" } } }, "then": { "required": ["name", "source"] } },
    { "if": { "properties": { "command": { "const": "skill" } } }, "then": { "required": ["name", "target", "source"] } },
    { "if": { "properties": { "command": { "const": "review" } } }, "then": { "required": ["target_path"] } },
    { "if": { "properties": { "command": { "const": "doc" } } }, "then": { "required": ["doc_type", "subject"] } },
    { "if": { "properties": { "command": { "const": "prompt" } } }, "then": { "required": ["name", "reqs"] } },
    { "if": { "properties": { "command": { "const": "brainstorm" } } }, "then": { "required": ["topic"] } }
  ]
}
```

Field grounding: `command`/`target_dir`/`profile` from `/agent init <target_dir> [--profile <core|full>]` [grounded: sources/factory_conductor_skill_spec_prompt.md:L118-L119]; `name`/`source`/`target_dir` (create) from L120-L121; `name`/`target`/`source`/`target_dir` (skill) from L122-L123; `target_path`/`mode`/`fix` from L124-L125; `doc_type`/`subject`/`source`/`output` (doc) from L126-L127; `name`/`reqs`/`output` (prompt) from L128-L129; `topic`/`source`/`output` (brainstorm) from L130-L131; `model` enum from L83.

## Execution Algorithm

1. **Intent Parsing** [grounded: sources/factory_conductor_skill_spec_prompt.md:L174]
   1. Tokenize the raw `/factory <verb> ...` or `/doc <verb> ...` invocation into `command` plus positional arguments and `--flag value` / `--flag` pairs, using the route grammars as valid grammars.
   2. Validate the tokenized object against the Input Contract, including its per-command conditional `required` rules.
   3. IF the verb is unrecognized, OR a required field for that command is missing, OR an enum field holds an out-of-set value: set `status = "INPUT_INVALID"` and return the output object (Stop Condition 1). ELSE proceed to Step 2.
2. **Workspace Resolution** [grounded: sources/factory_conductor_skill_spec_prompt.md:L175]
   1. Resolve every path-typed field present (`target_dir`, `source`, `output`, `reqs`, `target_path`) to an absolute path. Absolute paths into an external target project are valid per the pointer-dispatch example's `target_dir` field. [grounded: sources/factory_conductor_skill_spec_prompt.md:L154] Paths inside the local skill-team repo (matching the layout at L15-L23) are also treated as valid, since the source itself locates the skill's own artifacts there and gives no rule excluding local paths. [extrapolated: L154 shows only one external-path example; local-path validity is inferred from the source's own file-tree location, not stated as a rule]
   2. For each field required for reading (`source`, `reqs`, `target_path`), verify the resolved path exists and is readable. For each field required for writing (`target_dir`, `output`), verify its parent directory exists and is writable (creating the target file itself happens only in Step 7).
   3. IF any required-for-reading path is missing/unreadable, OR any required-for-writing parent is missing/not writable: set `status = "INPUT_INVALID"` and return the output object (Stop Condition 2). ELSE proceed to Step 3.
3. **Preflight Checks** (Fail-Fast)
   Verify runtime environment before creating any state. IF any check fails: set `status = "PREFLIGHT_FAILED"`, set `blocker = {check: <name>, detail: <reason>}`, and return the output object immediately (Stop Condition 2a). ELSE proceed to Step 4.
   1. **Blackboard probe**: attempt a minimal `store_memory` write to `agent-memory` with tag `preflight:probe` and immediately delete it (`delete_memory`). If the MCP server is unreachable, locked, or returns an error: fail with `check: "blackboard"`.
   2. **Subagent dispatch capability**: verify the runtime exposes a provider-native subagent invocation capability. If the current execution environment does not support delegating to sub-agents: fail with `check: "subagent_dispatch"`.
   3. **Target path structure**: for commands that write (`init`, `create`, `skill`, `prompt`, `doc`) verify that `target_dir` (resolved in Step 2) either already contains a valid `.agents/` directory, or that the parent directory is writable and the path does not point to a system root. Fail with `check: "target_path"` otherwise.
4. **Task Initialization**
   1. Mint `task_id` in the form `FACT-<year>-<seq>`, matching the shape of the source's literal example value `FACT-2026-001`. [extrapolated: L149 gives one literal example value, not a stated format rule or generation algorithm]
   2. Write a root Blackboard entry to `agent-memory` tagged `work-item`, `wi:<task_id>` (see `references/blackboard.md`). Store the `memory_id` returned by this write as `root_work_item_memory_id` for use at terminal transition steps. [grounded: sources/factory_conductor_skill_spec_prompt.md:L159,L163; `root_work_item_memory_id` storage is [extrapolated]: required by the Work-Item Terminal-State Protocol in `references/blackboard.md`]
   3. Set `stage_trace = []`.
5. **Pipeline Assembly**
   1. Select the ordered stage list for `command`: the universal 6-stage lifecycle (Sanitize & Ground -> Model & Scope -> Specify & Contract -> Synthesize & Assemble -> Adversarial Audit -> Compile & Persist), per the Decisions section's command-route coverage rule and `references/pipelines.md`. [grounded: sources/factory_conductor_skill_spec_prompt.md:L96-L115]

6. **Stage Execution Loop** (covers Stages 1-5; Stage 6 is Step 8)
   For each stage `S` in the Step 5 list, in order:
   1. Set `attempt = 0`.
   2. Classify the target subagent's archetype per `references/archetypes.md` and `references/roles.md`. Set `archetype` to the resulting primary archetype and `secondary_archetype` to the resulting secondary archetype if the classification heuristic assigned one, else `null`. [grounded: sources/factory_conductor_skill_spec_prompt.md:L63] Then select model tier and reasoning depth per `references/model_policy.md` (Model Selection Matrix, two-option tie-break, `--model` override, escalation-on-failure, and pro-tier-hold rules from the Decisions section), using `archetype` (the primary) for tiering. [extrapolated: see `references/archetypes.md`'s Deterministic Application Rule]
   3. Set `pro_validated = false`. IF the selected tier is `pro`: require the dispatched subagent to structure its response with `<scratchpad>`, `<decision_log>`, `<handoff_payload>` per `references/model_policy.md`. [grounded: sources/factory_conductor_skill_spec_prompt.md:L85-L88]
   4. Dispatch: write a pointer-dispatch object (`task_id`, `memory_id`, `caller_role: "factory-conductor"`, `target_role`, `action_mode`, `target_dir`, and optional `assigned_skills`) to `agent-memory`, per the pointer dispatch format in `references/blackboard.md`. Conductor resolves authorized skills for `target_role` per the Role-Based Skill Access Control Matrix in `references/roles.md` and passes them via `assigned_skills` so the target subagent loads only relevant skills Just-in-Time. [extrapolated: implements JIT skill allocation to prevent context bloat as catalog expands]
   5. Await the subagent's returned `verdict:PASS` or `verdict:FAIL`. IF the selected tier was `pro`: run `references/model_policy.md`'s validation procedure and set `pro_validated = true` if it completed (regardless of PASS/FAIL outcome, since `pro_validated` records that the check ran, not that it passes); a validation failure is treated as `verdict:FAIL` regardless of the payload's claimed verdict. Once the verdict is determined, persist a stage-level handoff record per the following two-step sequence (see `references/blackboard.md` Handoff Conflict Resolution for full protocol):
      - IF `attempt > 0`: first call `search_memories(tags=["handoff", "wi:<task_id>", "stage:<S>"])`, identify the non-obsolete record with the highest prior `attempt` value as `prev_memory_id`, then call `update_memory(memory_id=prev_memory_id, tags=[...its existing tags..., "status:obsolete"])` to retract it. IF this `update_memory` call fails: treat the failure as a `verdict:FAIL` for the current attempt and route through the circuit-breaker retry logic in Step 6.7 without writing the new record.
      - Write the new handoff record to `agent-memory` tagged `handoff`, `role:<name>`, `archetype:<type>` (one tag per archetype in `{archetype, secondary_archetype}` that is non-null), `wi:<task_id>`, `stage:<S>`, `attempt:<n>`, `verdict:PASS`/`verdict:FAIL`, `scope:<context>`, per `references/blackboard.md`. For retry records (`attempt > 0`) include `supersedes:<prev_memory_id>` in the record content. [grounded: sources/factory_conductor_skill_spec_prompt.md:L158-L166; `stage:<S>` tag and retract-then-supersede sequence are [extrapolated]: mechanically required for the Handoff Conflict Resolution read rule in `references/blackboard.md`]
      Append `{stage: S, archetype, secondary_archetype, attempt, model_used, verdict, pro_validated}` to `stage_trace`.
   6. IF `verdict == PASS`: advance to the next stage in the Step 5 list, or to Step 7 if `S` was the last stage.
   7. IF `verdict == FAIL`: log the defect trace to `agent-memory`. [grounded: sources/factory_conductor_skill_spec_prompt.md:L136]
      - IF `attempt < 2`: set `attempt = attempt + 1`, re-dispatch `S` with the defect pointer attached [grounded: sources/factory_conductor_skill_spec_prompt.md:L137], go to 6.2.
      - ELSE (this FAIL is at `attempt == 2`): set `status = "BLOCKED"`, set `blocker = {stage: S, attempts_exhausted: true, defect_trace_memory_id: <last logged id>}`. Before returning, apply the Pipeline-State Record Protocol terminal transition: retract all non-obsolete `pipeline-state` records for this `wi:<task_id>` (see `references/blackboard.md`) and write a final `pipeline-state` record tagged `[pipeline-state, wi:<task_id>, status:blocked]`; then call `update_memory(memory_id=root_work_item_memory_id, tags=[...existing tags..., "status:blocked"])` to stamp the root entry. If these calls fail, log the failure to `agent-memory` but do not alter the BLOCKED return. [extrapolated: extends Stop Condition 3 with the terminal-state controller flush mandated by `references/blackboard.md` Pipeline-State Record Protocol and Work-Item Terminal-State Protocol] Return the output object (Stop Condition 3).
7. **Quality Gate** [grounded: sources/factory_conductor_skill_spec_prompt.md:L177]
   1. Stage 5 (Adversarial Audit / DoD, `archetype:critic`), executed inside Step 6, is the pre-write quality-gate checklist: it runs immediately before Compile & Persist. [grounded: sources/factory_conductor_skill_spec_prompt.md:L111-L114]
   2. No file write is authorized unless the `stage_trace` entry for Stage 5 recorded `verdict:PASS`. The only way to reach Step 8 is via a PASS at every prior stage including Stage 5, since any FAIL path already returned at Stop Condition 3. Proceed to Step 8.
8. **Compile & Persist (Stage 6)** [grounded: sources/factory_conductor_skill_spec_prompt.md:L114]
   1. Write the final artifact(s) to the resolved workspace path(s) from Step 2 (`target_dir` and/or `output`). IF this write fails (e.g. disk error, permission revoked since Step 2.2's check): set `status = "BLOCKED"`, set `blocker = {stage: "compile_persist", attempts_exhausted: false, defect_trace_memory_id: <internal-error id logged to agent-memory>}`, return the output object (Stop Condition 4). [extrapolated: the source defines the retry/BLOCKED mechanism only for stage verdict failures (L133-L138); a post-Stage-5 write failure is not itself a stage verdict and is not retriable, so it is treated as a second, non-retrying route to `BLOCKED`, distinguished from the circuit-breaker route by `attempts_exhausted: false`]
   2. Write a final Blackboard entry tagged `handoff` recording completion. [extrapolated: L160 defines `handoff` as "Output delivered by any subagent"; Stage 6 is performed by factory-conductor itself, not a subagent (L114), so applying `handoff` to the Conductor's own completion entry stretches the literal definition rather than restating it verbatim] IF this write fails: apply the same Stop Condition 4 handling as 7.1.
   2a. Apply the Pipeline-State Record Protocol terminal transition for SUCCESS: retract all non-obsolete `pipeline-state` records for this `wi:<task_id>` (see `references/blackboard.md`) and write a single new `pipeline-state` record tagged `[pipeline-state, wi:<task_id>, status:success]`; then call `update_memory(memory_id=root_work_item_memory_id, tags=[...existing tags..., "status:success"])` to stamp the root entry. IF any of these calls fail: apply Stop Condition 4 handling (same as 8.1/8.2 write failure). [extrapolated: required by `references/blackboard.md` Pipeline-State Record Protocol and Work-Item Terminal-State Protocol]
   3. Append `{stage: "compile_persist", archetype: null, secondary_archetype: null, attempt: 0, model_used: "n/a", verdict: "PASS", pro_validated: false}` to `stage_trace` (Stage 6 is performed by factory-conductor itself and carries no `archetype:*` tag). [grounded: sources/factory_conductor_skill_spec_prompt.md:L114, cross-referenced against `references/pipelines.md`'s note on Stage 6's role-only tagging]
   4. Set `status = "SUCCESS"`, `output_paths` = every file path written in 8.1, `memory_pointers` = every pointer-dispatch object written in Steps 4-8.
9. **Self-Verification and Return**
   1. Assert the constructed output object validates against the Output Schema below. IF validation fails: this is an implementation defect in the conductor itself, not a new caller-facing status value; set `status = "BLOCKED"`, set `blocker = {stage: "self_verification", attempts_exhausted: false, defect_trace_memory_id: <internal-error id logged to agent-memory>}`, discard any partial `task_id`/`stage_trace`/`output_paths` from the failed construction, and return this fixed fallback object instead (Stop Condition 5) - do not attempt self-validation a second time, to keep this step bounded. [extrapolated: the source assigns Module 5 a duty to combine the modules into a runbook (L172-L177) but states no self-validation-failure procedure; reusing `BLOCKED` with `attempts_exhausted: false` avoids inventing a 4th status value while keeping the fallback deterministic and distinguishable from a circuit-breaker BLOCKED]
   2. Return the output object.

## Output Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AgentFactoryConductorOutput",
  "type": "object",
  "required": ["status"],
  "properties": {
    "status": { "type": "string", "enum": ["SUCCESS", "BLOCKED", "INPUT_INVALID"] },
    "command": { "type": "string", "enum": ["init", "create", "skill", "review", "doc", "prompt", "brainstorm"] },
    "task_id": { "type": ["string", "null"] },
    "stage_trace": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["stage", "archetype", "secondary_archetype", "attempt", "model_used", "verdict", "pro_validated"],
        "properties": {
          "stage": { "type": "string", "enum": ["sanitize_ground", "model_scope", "specify_contract", "synthesize_assemble", "adversarial_audit", "compile_persist"] },
          "archetype": { "type": ["string", "null"], "enum": ["censor", "modeler", "specifier", "synthesizer", "critic", "executor", null] },
          "secondary_archetype": { "type": ["string", "null"], "enum": ["censor", "modeler", "specifier", "synthesizer", "critic", "executor", null] },
          "attempt": { "type": "integer", "minimum": 0, "maximum": 2 },
          "model_used": { "type": "string" },
          "verdict": { "type": "string", "enum": ["PASS", "FAIL"] },
          "pro_validated": { "type": "boolean" }
        }
      }
    },
    "blocker": {
      "type": ["object", "null"],
      "properties": {
        "stage": { "type": "string" },
        "attempts_exhausted": { "type": "boolean" },
        "defect_trace_memory_id": { "type": "string" }
      }
    },
    "output_paths": { "type": "array", "items": { "type": "string" } },
    "memory_pointers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["task_id", "memory_id", "caller_role", "target_role", "action_mode"],
        "properties": {
          "task_id": { "type": "string" },
          "memory_id": { "type": "string" },
          "caller_role": { "type": "string" },
          "target_role": { "type": "string" },
          "action_mode": { "type": "string" },
          "target_dir": { "type": "string" }
        }
      }
    }
  },
  "allOf": [
    { "if": { "properties": { "status": { "const": "INPUT_INVALID" } } },
      "then": { "properties": { "task_id": { "const": null }, "stage_trace": { "type": "array", "maxItems": 0 } } } },
    { "if": { "properties": { "status": { "enum": ["SUCCESS", "BLOCKED"] } } },
      "then": { "required": ["task_id", "stage_trace"] } }
  ]
}
```

Grounding: `stage` enum from the 6-stage pipeline [grounded: sources/factory_conductor_skill_spec_prompt.md:L96-L115]; `archetype`/`secondary_archetype` enum values from the 6 archetypes [grounded: sources/factory_conductor_skill_spec_prompt.md:L35-L57], `null` for `compile_persist` entries because Stage 6 carries no `archetype:*` tag [grounded: sources/factory_conductor_skill_spec_prompt.md:L114] and `secondary_archetype` itself is `[extrapolated: L63's dual-assignment outcome, surfaced as a caller-visible field so it is mechanically checkable rather than only an internal Blackboard tag]`; `attempt` range 0-2 from "Maximum retries per stage: 2" [grounded: sources/factory_conductor_skill_spec_prompt.md:L134]; `verdict` enum from L165; `pro_validated` is `[extrapolated: makes the DoD's tag-validation requirement checkable from the output object alone; the source mandates the validation act (L85-L88) but defines no reporting field for it]`; `status: BLOCKED`/`blocker` from L138, extended with `attempts_exhausted: false` for the non-retrying write-failure and self-verification-failure routes added in Execution Algorithm Steps 7.1/7.2/8.1 `[extrapolated: source only defines the circuit-breaker route to BLOCKED; the write-failure and self-verification routes are this skill's own non-inventive fallback, reusing the existing enum value instead of adding a 4th]`; `memory_pointers` item shape from the pointer dispatch example L147-L155. `status: SUCCESS` names the positive terminal outcome of Stage 6 (Compile & Persist, L114) opposite of BLOCKED; no literal source string names it. `status: INPUT_INVALID` is `[extrapolated: Module 5 mandates deterministic Intent Parsing (L174) and Workspace Resolution (L175) rules; a rule is not testable unless malformed input has a defined, reachable halt outcome; no literal source status name exists for this case]`. The `allOf` conditional keeps `task_id`/`stage_trace` unrequired (and, for `INPUT_INVALID`, fixed to `null`/empty) when the algorithm halts before Task Initialization (Steps 1.3, 2.3), so an `INPUT_INVALID` return is always schema-valid rather than failing its own Output Schema. `[extrapolated: mechanical fix ensuring the schema matches what Steps 1.3/2.3 actually produce]` Reachability: `INPUT_INVALID` from Execution Algorithm Steps 1.3 and 2.3; `BLOCKED` from Step 5.7's else-branch (circuit breaker, `attempts_exhausted: true`) and from Steps 7.1/7.2/8.1's failure branches (non-retrying, `attempts_exhausted: false`); `SUCCESS` from Step 7.4. No other status values exist.

## Edge Cases & Failure Modes

1. Unrecognized `/factory` or `/doc` verb or malformed flag syntax: Step 1.3 halts with `status = "INPUT_INVALID"` before any dispatch occurs; no partial `stage_trace` is produced.
2. Missing or unreadable `source`/`reqs`/`target_path`, or unwritable `target_dir`/`output` parent: Step 2.3 halts with `status = "INPUT_INVALID"` before Task Initialization; no `task_id` is minted.
3. A `pro`-tier subagent response fails tag cardinality, ordering, closure, or JSON-parse validation (per `references/model_policy.md`): treated as `verdict:FAIL` for that attempt regardless of any verdict claimed inside a malformed payload, and routed through the retry/circuit-breaker logic in Step 5.7.
4. A stage fails 3 consecutive attempts (`attempt:0`, `attempt:1`, `attempt:2` all FAIL): circuit breaker trips, `status = "BLOCKED"`, pipeline pauses and reports the exact blocker. [grounded: sources/factory_conductor_skill_spec_prompt.md:L133-L138] No further stage runs and no file is written, since Step 5.7's else-branch returns immediately (Stop Condition 3) instead of proceeding to Step 6/7. [extrapolated: composes the L138 "pause pipeline" instruction with this skill's own Execution Algorithm control flow, which the source does not itself spell out at instruction-level]
5. A subagent cannot be classified into a single unambiguous archetype: assign primary and secondary archetypes per `references/archetypes.md`'s classification heuristic, per the source's stated outcome. [grounded: sources/factory_conductor_skill_spec_prompt.md:L63] Tag the handoff with both `archetype:<type>` tags rather than halting. [extrapolated: L63 states the dual-assignment outcome but not how it propagates into Blackboard tagging; tagging both is the minimal rule consistent with "primary and secondary" naming]
6. `archetype:executor` is required but no exemplar subagent is registered (the source names no exemplar for this archetype, unlike the other 5). [grounded: sources/factory_conductor_skill_spec_prompt.md:L55-L57] Dispatch by `target_role: "archetype:executor"` literal, per `references/archetypes.md`; do not fabricate an exemplar name. [extrapolated: the source's silence on an exemplar is grounded, but the operational instruction to dispatch by the literal archetype-tag string is this skill's own non-inventive fallback, not a stated source rule]
7. The constructed output object fails self-validation against the Output Schema (Step 8.1): this is an implementation defect in the conductor itself, not a new status value; return the fixed `status = "BLOCKED"` fallback object defined in Step 8.1 (`blocker.stage = "self_verification"`, `attempts_exhausted: false`) instead of a non-conforming object, without a second self-validation attempt.
8. Stage 5 passed but the Step 7.1 file write or Step 7.2 final Blackboard write fails (e.g. a disk or permissions error after Step 2.2's earlier writability check): return `status = "BLOCKED"` with `blocker.stage = "compile_persist"`, `attempts_exhausted: false`, per Step 7.1/7.2. This is not retried, since the circuit breaker's retry mechanism (L133-L138) applies only to stage verdict failures, not to the terminal write step.
9. The `update_memory` retraction call in Step 6.5 fails (MCP error, network, or permission issue): do NOT write the new handoff record; treat the failure as `verdict:FAIL` for the current attempt and route through the circuit-breaker retry logic (Step 6.7). If all three attempts (attempt:0, 1, 2) fail due to retraction errors, the circuit breaker trips with `status = "BLOCKED"` and `blocker.stage = S`. This ensures that a partially-completed retraction never leaves two simultaneously active non-obsolete records for the same (wi, stage) pair. [extrapolated: extends the existing BLOCKED/circuit-breaker mechanism to the retract-then-supersede write protocol in references/blackboard.md]

## Definition of Done (DoD)

- [ ] Every returned `status` value is one of `SUCCESS`, `BLOCKED`, `INPUT_INVALID`, each traceable to exactly one named Execution Algorithm step.
- [ ] `stage_trace` contains one entry per (stage, attempt) dispatch, plus exactly one `compile_persist` entry on a `SUCCESS` return; each entry has `attempt` in `[0, 2]` and exactly one of `verdict: PASS`/`FAIL`.
- [ ] No stage was dispatched more than 3 times (attempt:0, attempt:1, attempt:2).
- [ ] `status: BLOCKED` is returned if and only if `blocker` is non-null; `blocker.attempts_exhausted == true` marks the circuit-breaker route (some stage's `attempt:2` recorded `verdict:FAIL`), `blocker.attempts_exhausted == false` marks the non-retrying write-failure or self-verification-failure route.
- [ ] `status: SUCCESS` is returned if and only if `stage_trace`'s last entry is `{stage: "compile_persist", verdict: "PASS"}` and `output_paths` is non-empty.
- [ ] `status: INPUT_INVALID` is returned if and only if Step 1.3 or Step 2.3 halted before Task Initialization; in that case `task_id` is `null` and `stage_trace` is empty, matching the Output Schema's conditional requirement.
- [ ] Every `stage_trace` entry for a stage dispatched at `pro` tier has `pro_validated: true`.
- [ ] No file was written to `target_dir`/`output` unless Stage 5 (Adversarial Audit) recorded `verdict:PASS`.
- [ ] On `status: SUCCESS`: exactly one non-obsolete `pipeline-state` record exists in `agent-memory` for this `wi:<task_id>`, tagged `status:success`; the root `work-item` entry carries tag `status:success`.
- [ ] On `status: BLOCKED`: exactly one non-obsolete `pipeline-state` record exists in `agent-memory` for this `wi:<task_id>`, tagged `status:blocked`; the root `work-item` entry carries tag `status:blocked`.

## Candidates

- `candidate_action_mode_enum`: Formalize a full `action_mode` enum per archetype/command pairing once the source or a maintainer confirms values beyond the single literal example `DECOMPOSE_DOMAIN`, replacing the illustrative `[extrapolated]` values in `references/blackboard.md`'s few-shot examples.
- `candidate_profile_mode_semantics`: Define the behavioral difference between `--profile core` vs `full` (init) and `--mode fidelity` vs `executability` vs `all` plus `--fix` (review) beyond their enum labels, once the source or a maintainer specifies it.
- `candidate_partial_pipeline_routes`: If confirmed that some command routes should run a narrower stage subset instead of the full 6-stage pipeline, add per-command stage-subset rules to `references/pipelines.md`'s command-route table.

## Open questions

1. `--model pro|fast` (L83) vocabulary does not map cleanly onto the four internal tier names `flash`/`pro`/`inherit`/`flash_lite` used by the Model Selection Matrix (L75-L80); the source never reconciles this. This skill treats the flag as an opaque override rather than inventing a name-to-name mapping (see Decisions); a maintainer ruling would let a mapping be encoded with confidence instead.
2. Whether any of the command routes is intended to enter the 6-stage DAG below Stage 1, or skip a stage entirely (e.g. `/factory review` running only Stage 5), is not stated in the source beyond `/factory create`'s explicit "Full 6-stage synthesis" (L121). This skill currently runs the full pipeline for all routes (see Decisions); this is the most literal reading of the "every ... task" universal-pattern language (L96-L97) but is not itself confirmed per-route.
3. No default is stated for `/factory init`'s `--profile` flag (L118); the Input Contract leaves it optional with no default rather than inventing one.
4. `--profile <core|full>` and `--mode <fidelity|executability|all>`/`--fix` name enum values with no stated behavioral definition beyond the labels themselves (L118, L124); behavior for each value is not specified in the source.
5. The source's own worked pointer-dispatch example (L147-L155) and tagging schema (L158-L166) provide no ID-generation rule for `task_id`/`memory_id` beyond one literal shape each; sequencing/uniqueness is left to the `agent-memory` MCP implementation.
6. `inherit` (used for `modeler`/`specifier`/`synthesizer` tier rows, L76-L78) is resolved in `references/model_policy.md` as "the invoking context's own model tier" by the literal dictionary sense of the word; the source does not itself define this term.
7. Step 5.5's "Await the subagent's returned verdict" defines no timeout or hang-detection behavior; the source is silent on this and this skill does not invent one, since a fabricated timeout duration or retry-vs-abort rule would not be grounded and would affect the circuit breaker's attempt counting. A maintainer ruling is needed before an autonomous, unattended run can be guaranteed to terminate if a dispatched subagent never responds.
