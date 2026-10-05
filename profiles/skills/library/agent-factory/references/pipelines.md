# Dynamic DAG Pipeline Assembly

Reference for `agent-factory` (`factory-conductor`). Loaded by SKILL.md at Execution Algorithm Step 4 (Pipeline Assembly) and Step 5 (Stage Execution Loop).

## Translation Mandate

The orchestrator translates commands or user intents into an executable Directed Acyclic Graph (DAG) of subagent handoffs. [grounded: sources/factory_conductor_skill_spec_prompt.md:L94]

## Universal Pipeline Pattern

Every robust analytical or synthesis task follows the 6-stage lifecycle: [grounded: sources/factory_conductor_skill_spec_prompt.md:L96-L97]

```text
Stage 1: Sanitize & Ground       (archetype:censor)
             |
             v
Stage 2: Model & Scope           (archetype:modeler)
             |
             v
Stage 3: Specify & Contract      (archetype:specifier)
             |
             v
Stage 4: Synthesize & Assemble   (archetype:synthesizer)
             |
             v
Stage 5: Adversarial Audit (DoD) (archetype:critic)
             |
             v
Stage 6: Compile & Persist       (factory-conductor)
```

[grounded: sources/factory_conductor_skill_spec_prompt.md:L98-L115]

Note: Stage 6 is annotated `(factory-conductor)`, the conductor's own literal role, not an `archetype:*` tag like Stages 1-5. [grounded: sources/factory_conductor_skill_spec_prompt.md:L114] Stage 6 is therefore tagged on the Blackboard with `role:factory-conductor` and no `archetype:<type>` tag. [extrapolated: direct reading of the asymmetry between L99/102/105/108/111 (archetype-tagged) and L114 (role-named, not archetype-tagged)]

### Command-Route Coverage Rule

The source states the universal pattern applies to "every robust analytical or synthesis task" with no stated exception. [grounded: sources/factory_conductor_skill_spec_prompt.md:L96-L97] Only `/factory create` is explicitly confirmed in the route list as "Full 6-stage synthesis." [grounded: sources/factory_conductor_skill_spec_prompt.md:L121] No route description states a narrower stage subset for any of the other routes, and no route description states a fuller-than-default subset either. Resolution: all command routes execute the full 6-stage pipeline (Stage 1 through Stage 6) in order. [extrapolated: this applies the source's own universal-pattern wording (L96-L97) uniformly to all routes instead of inventing per-command stage-skip logic, but the source never states this per-route; it is an inference from "every ... task", not an enumerated fact] See SKILL.md Open Questions for the residual ambiguity this resolution does not remove.

## Supported Core Command Routes

[grounded: sources/factory_conductor_skill_spec_prompt.md:L118-L131]

| Category | Command | Syntax | Description |
| --- | --- | --- | --- |
| Factory | init | `/factory init <target_dir> [--profile <core\|full>]` | Scaffolds external projects with tailored agent suites. |
| Factory | create | `/factory create <name> --source <path> [--target-dir <path>]` | Full 6-stage synthesis from raw materials to `.agents/agents/<name>/`. |
| Factory | skill | `/factory skill <name> --target <agent> --source <path> [--target-dir <path>]` | Extracts and attaches a deterministic skill to an existing agent. |
| Factory | prompt | `/factory prompt <name> --reqs <path> [--output <path>]` | Synthesizes zero-drift production prompts from ambiguous or complex requirements. |
| Factory | review | `/factory review <target_path> [--mode fidelity\|executability\|all] [--fix]` | Runs targeted verification or in-place refactoring on external agents, skills, or prompts. |
| Doc | doc | `/doc <type> <subject> [--source <path>] [--output <path>]` | Generates `prd`, `tz` (Technical Specification), `adr`, or `task` documentation. |
| Doc | brainstorm | `/doc brainstorm <topic> [--source <path>] [--output <path>]` | Runs multi-perspective ideation, attack on assumptions, and trade-off matrix compilation. |
| Doc | review | `/doc review <target_path> [--mode fidelity\|executability\|all] [--fix]` | Runs targeted verification or audit on formal documentation and specifications. |

`--profile <core|full>` (init) and `--mode <fidelity|executability|all>` / `--fix` (review) name their enum values in the source with no stated behavioral definition beyond the enum labels themselves. [grounded: sources/factory_conductor_skill_spec_prompt.md:L118,L124] Do not fabricate behavioral detail beyond the labels; see SKILL.md Open Questions.

## Circuit Breaker and Retry Protocol

[grounded: sources/factory_conductor_skill_spec_prompt.md:L133-L138]

- Maximum retries per stage: 2 (`attempt:0`, `attempt:1`, `attempt:2`). [grounded: sources/factory_conductor_skill_spec_prompt.md:L134]
- On `verdict:FAIL`: [grounded: sources/factory_conductor_skill_spec_prompt.md:L135]
  1. Conductor logs defect trace to `agent-memory`. [grounded: sources/factory_conductor_skill_spec_prompt.md:L136]
  2. Dispatches task back to target archetype with `attempt:<n+1>` and defect pointer. [grounded: sources/factory_conductor_skill_spec_prompt.md:L137]
  3. If 2 retries fail, trip circuit breaker: set status to `BLOCKED`, pause pipeline, and report exact blocker to user gateway. [grounded: sources/factory_conductor_skill_spec_prompt.md:L138]

### Deterministic State Machine

```
attempt = 0
LOOP:
  dispatch stage S at attempt:<attempt>, model tier per model_policy.md
  await verdict
  IF verdict == PASS:
      EXIT LOOP, advance to next stage (or Stage 6 if S was Stage 5)
  IF verdict == FAIL:
      log defect trace to agent-memory                         [grounded: L136]
      IF attempt < 2:
          attempt = attempt + 1
          re-dispatch S with defect pointer attached            [grounded: L137]
          CONTINUE LOOP
      ELSE:  -- this FAIL occurred at attempt == 2
          status = BLOCKED                                      [grounded: L138]
          pause pipeline
          report exact blocker (stage, task_id, defect trace memory_id)
              to the user gateway                                [grounded: L138]
          HALT (no further stages execute)
```

This state machine terminates in at most 3 dispatch attempts per stage (attempt:0, attempt:1, attempt:2) and either exits forward on PASS or halts the whole pipeline on the third FAIL - no unbounded loop is possible.

## Cross-References

- Concrete Factory team roles and operational modes: `roles.md`.
- Model tier and reasoning-tag requirement per stage/attempt: `model_policy.md`.
- Archetype-to-subagent classification used to pick `target_role`: `archetypes.md`.
- Blackboard tags applied to each dispatch and handoff: `blackboard.md`.
- Master execution loop that drives this state machine per command: `SKILL.md` Execution Algorithm.
