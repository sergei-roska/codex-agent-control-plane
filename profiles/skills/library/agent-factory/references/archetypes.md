# Archetype Classification Reference

Reference for `agent-factory` (`factory-conductor`). Loaded by SKILL.md at every DAG stage to resolve which cognitive archetype a subagent belongs to before dispatch.

## Mandate

The orchestrator must never fail when encountering an unknown subagent name. It must classify any agent into one of six canonical Cognitive Archetypes. [grounded: sources/factory_conductor_skill_spec_prompt.md:L33]

## 6-Archetype Classification Table

| Archetype | Parenthetical Role | Cognitive Profile | Responsibilities | Exemplar |
| --- | --- | --- | --- | --- |
| `archetype:censor` | Filter / Normalizer / Auditor | Low entropy, strictly grounded pattern matching. | Strips fluff, verifies source truth, detects hallucinations, censors vague buzzwords. | `fidelity-skeptic` |
| `archetype:modeler` | Domain Architect / Systems Analyst | High abstraction, boundary mapping, conceptual taxonomy. | Scopes problem spaces, defines capabilities, outlines business requirements and user personas. | `domain-architect` |
| `archetype:specifier` | Contract Engineer / Protocol Author | High determinism, zero ambiguity, formal logic. | Authors I/O schemas, execution state machines, Technical Specifications (TZ), API contracts, algorithmic steps. | `contract-specifier` |
| `archetype:synthesizer` | Workflow Designer / Prompt Author / Coder | Cognitive workflow structuring, prompt optimization, artifact synthesis. | Authors system prompts (`AGENT.md`), few-shot pairs, implementation code, structured reports. | `workflow-designer` |
| `archetype:critic` | Feasibility Critic / Adversarial Tester / QA | Adversarial analysis, boundary stress-testing, defect discovery. | Uncovers circular dependencies, edge cases, deadlocks; authors Definition of Done (DoD) checklists and test suites (`evals.json`). | `executability-critic` |
| `archetype:executor` | Tool Runner / Environment Operator | Deterministic tool calling, command execution, environment inspection. | Running test suites, inspecting file trees, verifying build status. | none stated |

[grounded: sources/factory_conductor_skill_spec_prompt.md:L35-L57]

Note: `archetype:executor` is the only archetype for which the source names no exemplar subagent (compare L38, L42, L46, L50, L54 against L55-L57, which carry no exemplar line). [grounded: sources/factory_conductor_skill_spec_prompt.md:L55-L57] Do not fabricate one; when `archetype:executor` is required, dispatch by archetype tag alone (`target_role: "archetype:executor"`) until a named exemplar is registered. [extrapolated: L55-L57 gives only the archetype's cognitive profile and responsibilities, not this operational fallback instruction; dispatching by the literal archetype-tag string is the non-inventive default in the absence of a named exemplar]

## Classification Heuristic Algorithm (Unknown Subagents)

When an unlisted subagent is detected, apply these 3 steps in order: [grounded: sources/factory_conductor_skill_spec_prompt.md:L59-L60]

1. Inspect its declaration (`AGENT.md` or system prompt). [grounded: sources/factory_conductor_skill_spec_prompt.md:L61]
2. Extract verbs, declared tools, and output formats. [grounded: sources/factory_conductor_skill_spec_prompt.md:L62]
3. Map to the closest archetype above.
   - IF the mapping is unambiguous: assign that single archetype.
   - IF the mapping is ambiguous between two archetypes: assign a primary archetype and a secondary archetype (worked example from the source: `specifier` with `critic` audit). [grounded: sources/factory_conductor_skill_spec_prompt.md:L63]

### Deterministic Application Rule

- A subagent classified with only a primary archetype is dispatched, model-tiered, and tagged using that single archetype's row in `model_policy.md` and a single `archetype:<type>` tag per `blackboard.md`.
- A subagent classified with primary + secondary archetypes is dispatched using the primary archetype's model tier and reasoning depth, and is tagged with two `archetype:<type>` tags on its blackboard handoff (one per archetype), so downstream stage selection can match on either. [extrapolated: the source states the dual-assignment outcome (L63) but not how the dual assignment propagates into model tiering or blackboard tagging; using the primary archetype for tiering and both archetypes for tagging is the minimal rule consistent with "primary and secondary" naming without inventing a new tiering formula]

## Cross-References

- Concrete Factory team roles and operational modes: `roles.md`.
- Model tier and reasoning depth per archetype: `model_policy.md`.
- Which DAG stage each archetype is dispatched at: `pipelines.md`.
- Tag format used when persisting an archetype-classified handoff: `blackboard.md`.
