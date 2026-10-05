# Model Selection and Reasoning Depth Policy

Reference for `agent-factory` (`factory-conductor`). Loaded by SKILL.md at Execution Algorithm Step 5 (Stage Execution Loop) to resolve which model tier and reasoning depth a dispatch uses.

## Allocation Basis

The orchestrator dynamically assigns the model tier (`Model` parameter in `invoke_subagent`) and cognitive reasoning mode based on three factors: Archetype Risk, Task Ambiguity, and User Overrides. [grounded: sources/factory_conductor_skill_spec_prompt.md:L69]

## Model Selection Matrix

| Archetype | Default Model Tier | Rationale | Reasoning Depth |
| --- | --- | --- | --- |
| `archetype:censor` | `flash` | Pattern matching, fluff removal, token-level grounding | Low / Standard scratchpad |
| `archetype:modeler` | `pro` or `inherit` | High-dimensional reasoning, domain abstraction | High / Multi-step decomposition |
| `archetype:specifier` | `pro` or `inherit` | Rigid schema correctness, zero-drift algorithmic logic | High / Explicit boundary validation |
| `archetype:synthesizer` | `inherit` or `pro` | Production prompt synthesis, cognitive workflow structure | Medium / Structured few-shot crafting |
| `archetype:critic` | `pro` | Adversarial edge-case discovery, stress-testing | High / Extended adversarial critique |
| `archetype:executor` | `flash_lite` or `flash` | Deterministic tool execution and status checking | Minimal / Direct execution |

[grounded: sources/factory_conductor_skill_spec_prompt.md:L75-L80]

### Resolving a Two-Option Row

Rows for `modeler`, `specifier`, `synthesizer`, and `executor` list two candidate tiers. The source states no selection rule between the two options for a given dispatch. [grounded: sources/factory_conductor_skill_spec_prompt.md:L76-L78,L80] Deterministic default until the source clarifies further: at `attempt:0`, use the first-listed tier in the row (`pro` for modeler/specifier, `inherit` for synthesizer, `flash_lite` for executor); this is a fixed, reproducible tie-break, not free judgment. [extrapolated: the source lists two options without a selection rule; picking the first-listed option consistently is the only deterministic reading that adds no new criterion]

### `inherit` Resolution

`inherit` means: use the model tier of the process that invoked `factory-conductor` for this task, unchanged. [extrapolated: dictionary sense of "inherit" applied literally; the source uses the word without defining it and no other referent for the tier exists in the spec]

## Policy Rules

[grounded: sources/factory_conductor_skill_spec_prompt.md:L82-L88]

1. **User Flag Override**: An explicit CLI flag (`--model pro` or `--model fast`) overrides all default assignments. [grounded: sources/factory_conductor_skill_spec_prompt.md:L83]
   - Deterministic application: when `--model` is present on the invoking CLI command, every stage of that invocation, at every attempt, uses the flag's literal value in place of the Model Selection Matrix lookup and in place of the two-option tie-break above. The flag's vocabulary (`pro`, `fast`) is treated as an opaque override string, not mapped onto the four internal tier names (`flash`, `pro`, `inherit`, `flash_lite`) from the matrix above, since the source never states that mapping. [extrapolated: minimal non-inventive resolution - the override replaces tier selection outright rather than requiring an invented name-to-name mapping table; see Open Questions in SKILL.md for the unresolved vocabulary mismatch]
2. **Escalation on Failure**: If a step fails verification on `attempt:0` using `flash`, the retry (`attempt:1`) must automatically escalate to `pro`. [grounded: sources/factory_conductor_skill_spec_prompt.md:L84]
   - Deterministic extension for stages already at `pro` (or `inherit` resolving to `pro`) on `attempt:0`: since no tier above `pro` is defined anywhere in the Model Selection Matrix, a failed `attempt:0` or `attempt:1` at `pro` holds at `pro` for the next retry rather than escalating further. [extrapolated: absence of a higher tier in the matrix forces a hold, not an invented tier]
   - This rule does not apply when a `--model` override (Rule 1) is active for the task; the override value is held fixed across all attempts.
3. **Reasoning Enforcement**: Every subagent assigned to `pro` must structure its response using mandatory markdown tags: [grounded: sources/factory_conductor_skill_spec_prompt.md:L85]
   - `<scratchpad>`: Internal trade-off analysis and validation. [grounded: sources/factory_conductor_skill_spec_prompt.md:L86]
   - `<decision_log>`: Frozen choices made during execution. [grounded: sources/factory_conductor_skill_spec_prompt.md:L87]
   - `<handoff_payload>`: Final structured output stored to Blackboard. [grounded: sources/factory_conductor_skill_spec_prompt.md:L88]

## Reasoning Tag Enforcement Specification

### Emission Template (`pro`-tier dispatches only)

Tags MUST appear exactly once each, in this fixed order, with no other content before, between, or after them:

```
<scratchpad>
CONTEXT: <one-line restatement of task_id + action_mode being executed>
OPTIONS_CONSIDERED:
  1. <option> - TRADE-OFF: <cost/benefit statement>
  2. <option> - TRADE-OFF: <cost/benefit statement>
VALIDATION_CHECKS:
  - <check-name>: PASS|FAIL - <one-line evidence>
</scratchpad>
<decision_log>
DECISION-1: <frozen choice> | RATIONALE: <why> | REVERSIBLE: yes|no
</decision_log>
<handoff_payload>
{
  "task_id": "<string>",
  "role": "<subagent name>",
  "archetype": "<archetype:type>",
  "attempt": <n>,
  "verdict": "PASS" | "FAIL",
  "scope": "<context>",
  "output": { "<action_mode-specific structured result>": "..." }
}
</handoff_payload>
```

Tag content maps to the L86-L88 definitions above [grounded: sources/factory_conductor_skill_spec_prompt.md:L86-L88]. The requirement that tags appear exactly once, in this order, with no stray content outside them, is the deterministic parsing contract the conductor enforces; the source mandates the three tags (L85-88) but does not itself specify ordering or cardinality. [extrapolated: a deterministic parser requires one fixed choice; "exactly once, in listed order, nothing else" is the only zero-ambiguity reading]

### Conductor-Side Validation Procedure

```
VALIDATE_PRO_RESPONSE(response_text):
1. Count occurrences of "<scratchpad>", "<decision_log>", "<handoff_payload>".
   IF any count != 1 -> verdict:FAIL ("tag cardinality violation").
2. Confirm the three opening tags appear in the order scratchpad, decision_log,
   handoff_payload.
   IF out of order -> verdict:FAIL ("tag order violation").
3. Confirm every opened tag has a matching closing tag.
   IF any tag unclosed -> verdict:FAIL ("unclosed tag").
4. Confirm no non-whitespace content exists before <scratchpad> or after
   </handoff_payload>.
   IF stray content found -> verdict:FAIL ("content outside mandated tags").
5. Parse the <handoff_payload> block content as JSON.
   IF parse fails -> verdict:FAIL ("handoff_payload not valid JSON").
6. Confirm the parsed JSON has keys: task_id, role, archetype, attempt, verdict, scope.
   IF any key missing -> verdict:FAIL ("incomplete handoff_payload schema").
7. IF all checks 1-6 pass -> ACCEPT; conductor persists the handoff_payload to
   Blackboard per blackboard.md, deriving the 8 mandatory tags from its fields.
8. IF any check fails -> the dispatch attempt is recorded as verdict:FAIL
   regardless of any verdict value claimed inside the payload, and is routed
   through the Circuit Breaker and Retry Protocol in pipelines.md.
```

[extrapolated: the source mandates the tags (L85-88) but specifies no parser; this procedure operationalizes that mandate into a checkable, deterministic gate]

### When the Tag Format Is NOT Required

```
IF resolved model tier (after Policy Rules 1 and 2) IN {"flash", "flash_lite"}:
    the mandatory tag format is NOT required.
    The subagent's entire response body IS the handoff_payload JSON object alone
    (same six required keys as validation step 6), with no wrapper tags.
ELSE (resolved tier == "pro"):
    the mandatory tag format IS required, per the Emission Template above.
```

[grounded rule basis: the requirement in L85-88 is stated only for `pro`; `archetype:censor` is fixed at `flash` (L75) and `archetype:executor` at `flash_lite` or `flash` (L80), so the flash/flash_lite exemption below is the direct logical complement of the pro-only requirement, not an added feature] [extrapolated: exemption itself is derived, not literally stated]

A consequence, not a matter of judgment: an `attempt:0` dispatch at `flash` that fails and escalates to `pro` per Policy Rule 2 flips from tag-exempt to tag-required for the retry at `attempt:1`, for that same `task_id`.

## Cross-References

- Which archetype a subagent maps to: `archetypes.md`.
- Where dispatches and their verdicts are recorded: `blackboard.md`.
- Circuit breaker behavior when a `pro`-tier attempt still fails: `pipelines.md`.
