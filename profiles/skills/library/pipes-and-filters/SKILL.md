---
name: pipes-and-filters
description: A software engineering skill implementing the Pipes-and-Filters architectural pattern for autonomous agent data transformations, code generation pipelines, and multi-stage document processing, enforcing decoupled stateless filters and strict JSON Schema boundary validation across typed pipes.
---

# Pipes-and-Filters Architecture (pipes-and-filters)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
In complex multi-stage agent workflows (e.g., source code analysis, document ingestion, artifact sanitization, and code compilation), monolithic transformation functions lead to critical systemic defects:
1. **Schema Drift Across Transformations**: Stage 2 silently alters JSON keys or data types that Stage 4 expects, causing late-stage runtime crashes with obscure stack traces.
2. **Untraceable Boundary Corruptions**: When a multi-step transformation produces corrupt output, identifying which intermediate step corrupted the payload requires tedious manual debugging.
3. **Zero Component Reusability**: Tightly coupling parser, sanitizer, analyzer, and formatter logic into a single function prevents reusing any individual step in other pipelines.
4. **Cascading Failure Propagation**: An invalid intermediate output propagates through subsequent stages before finally failing, wasting LLM token and computation budgets.

### 1.2. Scope & Behavioral Boundaries
The `pipes-and-filters` pattern enforces strict modularity and typed boundary verification:
- **Stateless Filters**: Each filter is an isolated, single-responsibility transformation unit with strictly zero knowledge of upstream or downstream filters.
- **Typed Pipes**: Communication between filters occurs exclusively over typed pipes that execute rigid JSON Schema validation before and after every single filter invocation:
  `InputSchema(Filter[k]) -> Filter[k] -> OutputSchema(Filter[k]) -> Pipe -> InputSchema(Filter[k+1])`.
- **Pre-Flight Topology Compatibility**: Before ingesting data, the pipeline engine statically verifies that each filter's output schema is compatible with the next filter's input schema.
- **Fail-Fast Boundary Halting**: If any filter emits a payload violating its declared output schema, the pipeline halts immediately with a structured boundary Defect Report.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Multi-step data processing: sanitizing raw text, tokenizing, extracting ASTs, enriching metadata, and generating final code.
- Pipelines requiring hot-swappable, recombinable filters and independent stage audits.
- Multi-stage document generation where each section undergoes distinct linting and normalization gates.
- Explicit keywords: "pipes and filters", "pipeline architecture", "stream processing filters", "typed pipeline transformation", "multi-stage data filter", "pipe boundary validation".

### 2.2. Negative Triggers
- Cyclic iterative state convergence requiring a `finite-state-machine`.
- Peer-to-peer decentralized agent messaging with private mailboxes (`actor-model`).
- Speculative refactoring with rollbacks requiring `copy-on-write`.
- Stateful workflows requiring shared mutable memory across transformation steps.

---

## 3. Invariants & Non-Negotiable Rules

1. **FILTER_STATELESSNESS = MANDATORY**: Filters must not maintain hidden mutable state or external shared memory between executions. Given identical input, a filter must produce identical output.
2. **STRICT_BOUNDARY_VALIDATION = MANDATORY**: Every pipe boundary must assert that the payload matches `InputSchema(Filter[k+1])`. Failure to validate triggers immediate halt with `PIPE_SCHEMA_MISMATCH`.
3. **PRE_FLIGHT_TOPOLOGY_LINTING = MANDATORY**: Pipelines cannot execute until the orchestrator has verified schema compatibility across all adjacent pairs: `OutputSchema(F[k])` is assignable to `InputSchema(F[k+1])`.
4. **FAIL_FAST_ON_SCHEMA_VIOLATION = MANDATORY**: A filter emitting an invalid payload halts the pipeline immediately; dirty intermediate data is never passed to downstream stages.
5. **DETERMINISTIC_STAGE_PROVENANCE = MANDATORY**: Every stage transition must be tagged with a unique stage index, execution duration, and payload checksum.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Pipeline Definition Schema (`PipelineDefinition`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PipelineDefinition",
  "type": "object",
  "required": ["pipeline_id", "pipeline_name", "filters"],
  "properties": {
    "pipeline_id": { "type": "string", "pattern": "^pipe-[a-zA-Z0-9_-]+$" },
    "pipeline_name": { "type": "string" },
    "description": { "type": "string" },
    "filters": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "filter_id",
          "filter_name",
          "handler_function",
          "input_schema",
          "output_schema"
        ],
        "properties": {
          "filter_id": { "type": "string" },
          "filter_name": { "type": "string" },
          "handler_function": { "type": "string" },
          "input_schema": { "type": "object" },
          "output_schema": { "type": "object" },
          "timeout_ms": { "type": "integer", "minimum": 100, "default": 10000 }
        },
        "additionalProperties": false
      },
      "minItems": 1
    }
  },
  "additionalProperties": false
}
```

### 4.2. Pipe Transition Envelope Schema (`PipeTransitionEnvelope`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PipeTransitionEnvelope",
  "type": "object",
  "required": [
    "transition_id",
    "pipeline_id",
    "from_filter_id",
    "to_filter_id",
    "stage_index",
    "payload_checksum",
    "payload",
    "timestamp_utc"
  ],
  "properties": {
    "transition_id": { "type": "string", "format": "uuid" },
    "pipeline_id": { "type": "string" },
    "from_filter_id": { "type": ["string", "null"] },
    "to_filter_id": { "type": "string" },
    "stage_index": { "type": "integer", "minimum": 0 },
    "payload_checksum": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "payload": { "type": "object", "additionalProperties": true },
    "duration_ms": { "type": "integer", "minimum": 0 },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. Pipeline Defect Report Schema (`PipelineDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PipelineDefectReport",
  "type": "object",
  "required": [
    "defect_id",
    "pipeline_id",
    "stage_index",
    "failed_filter_id",
    "violation_code",
    "error_message",
    "timestamp_utc"
  ],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "pipeline_id": { "type": "string" },
    "stage_index": { "type": "integer" },
    "failed_filter_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "PIPE_SCHEMA_MISMATCH",
        "FILTER_EXECUTION_FAILED",
        "INCOMPATIBLE_PIPELINE_TOPOLOGY",
        "INITIAL_INPUT_REJECTED",
        "FILTER_TIMEOUT_EXCEEDED",
        "EMPTY_PIPELINE_ERROR"
      ]
    },
    "error_message": { "type": "string" },
    "schema_validation_errors": { "type": "array", "items": { "type": "string" } },
    "raw_payload_snippet": { "type": ["string", "null"] },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal State Machine

```text
       +--------------------+
       |   UNINITIALIZED    |
       +--------------------+
                 |
                 | Event: ASSEMBLE_PIPELINE (Pre-flight schema topology check)
                 v
       +--------------------+
       |  TOPOLOGY_VERIFIED |
       +--------------------+
                 |
                 | Event: INGEST_INITIAL_PAYLOAD
                 v
       +--------------------+
+----->|   CHECK_IN_SCHEMA  |----+
|      +--------------------+    |
|                |               | Schema Mismatch
|                | PASS          v
|                v      +--------------------+
|      +----------------+  PIPELINE_HALT     |
|      | EXECUTE_FILTER |  +--------------------+
|      +----------------+
|                |
|                | Filter execution OK
|                v
|      +--------------------+
|      | CHECK_OUT_SCHEMA   |----+
|      +--------------------+    |
|                |               | Output Schema Mismatch
|                | PASS          v
|                v      +--------------------+
|      +----------------+  PIPELINE_HALT     |
|      | PIPE_DELIVERY  |  +--------------------+
|      +----------------+
|                |
| Has more stages?
|   /        \
|  / Yes      \ No (Terminal Filter Completed)
+--+           v
       +--------------------+
       |    COMPLETED       |
       +--------------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `UNINITIALIZED` | `ASSEMBLE` | Filters count >= 1 AND schemas valid | `TOPOLOGY_VERIFIED` | Validate output-to-input schema chain compatibility. |
| `UNINITIALIZED` | `ASSEMBLE` | Schema incompatibility or empty filters | `PIPELINE_HALT` | Emit `INCOMPATIBLE_PIPELINE_TOPOLOGY` or `EMPTY_PIPELINE_ERROR` Defect Report; halt. |
| `TOPOLOGY_VERIFIED` | `INGEST` | Initial input satisfies Filter[1].input_schema | `CHECK_IN_SCHEMA` | Bind initial payload; set `stage_index = 1`. |
| `TOPOLOGY_VERIFIED` | `INGEST` | Initial input violates Filter[1].input_schema | `PIPELINE_HALT` | Emit `INITIAL_INPUT_REJECTED` Defect Report; halt. |
| `CHECK_IN_SCHEMA` | `INPUT_VALID` | Payload matches InputSchema(F[k]) | `EXECUTE_FILTER` | Invoke filter transformation handler. |
| `CHECK_IN_SCHEMA` | `INPUT_INVALID`| Payload violates InputSchema(F[k]) | `PIPELINE_HALT` | Emit `PIPE_SCHEMA_MISMATCH` Defect Report; halt. |
| `EXECUTE_FILTER` | `EXEC_SUCCESS` | Handler finishes within timeout | `CHECK_OUT_SCHEMA` | Ingest raw output payload from filter. |
| `EXECUTE_FILTER` | `EXEC_FAILURE` | Handler throws uncaught error or times out | `PIPELINE_HALT` | Emit `FILTER_EXECUTION_FAILED` or `FILTER_TIMEOUT_EXCEEDED` Defect Report; halt. |
| `CHECK_OUT_SCHEMA` | `OUTPUT_VALID` | Output matches OutputSchema(F[k]) | `PIPE_DELIVERY` | Wrap in `PipeTransitionEnvelope`; calculate checksum. |
| `CHECK_OUT_SCHEMA` | `OUTPUT_INVALID`| Output violates OutputSchema(F[k]) | `PIPELINE_HALT` | Emit `PIPE_SCHEMA_MISMATCH` Defect Report; halt. |
| `PIPE_DELIVERY` | `ADVANCE_STAGE`| stage_index < total_filters | `CHECK_IN_SCHEMA` | Increment `stage_index += 1`; route payload to next filter. |
| `PIPE_DELIVERY` | `ADVANCE_STAGE`| stage_index == total_filters | `COMPLETED` | Emit final validated pipeline output artifact. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Pre-Flight Pipeline Topology Verification
1. Ingest `PipelineDefinition` containing filters `[F_1, F_2, ... F_N]`.
2. IF `len(filters) == 0`:
   - Emit Defect Report: `EMPTY_PIPELINE_ERROR`. Halt.
3. For `k = 1 to N - 1`:
   - Inspect `F_k.output_schema` and `F_{k+1}.input_schema`.
   - Perform static JSON Schema compatibility analysis:
     Assert `is_compatible(F_k.output_schema, F_{k+1}.input_schema) == TRUE`.
   - IF incompatibility detected:
     - Emit Defect Report: `INCOMPATIBLE_PIPELINE_TOPOLOGY`.
     - Halt immediately before data ingestion.
4. Transition state to `TOPOLOGY_VERIFIED`.
5. Emit log marker: `=== PIPELINE TOPOLOGY VERIFIED: [pipeline_id] Filters: [N] ===`.

### Step 2: Initial Ingestion & Pre-Check
1. Ingest initial payload `D_0`.
2. Validate `D_0` against `F_1.input_schema`.
3. IF validation fails:
   - Emit Defect Report: `INITIAL_INPUT_REJECTED`. Halt.
4. Initialize `current_payload = D_0`, `stage_index = 1`.
5. Transition state to `CHECK_IN_SCHEMA`.

### Step 3: Sequential Filter Execution Loop
For `k = 1 to N`:
1. **Input Boundary Assertion**:
   - Assert `validate_json_schema(current_payload, F_k.input_schema) == TRUE`.
   - IF assertion fails:
     - Emit Defect Report: `PIPE_SCHEMA_MISMATCH`. Halt.
2. **Filter Invocation**:
   - Transition state to `EXECUTE_FILTER`.
   - Record `start_time = now()`.
   - Invoke `F_k.handler(current_payload)`.
   - IF execution exceeds `F_k.timeout_ms`:
     - Emit Defect Report: `FILTER_TIMEOUT_EXCEEDED`. Halt.
   - IF execution throws exception:
     - Emit Defect Report: `FILTER_EXECUTION_FAILED`. Halt.
   - Record `raw_out = result`, `duration_ms = now() - start_time`.
3. **Output Boundary Assertion**:
   - Transition state to `CHECK_OUT_SCHEMA`.
   - Assert `validate_json_schema(raw_out, F_k.output_schema) == TRUE`.
   - IF assertion fails:
     - Emit Defect Report:
       - `violation_code: PIPE_SCHEMA_MISMATCH`
       - `failed_filter_id: F_k.filter_id`
       - `error_message: "Output failed schema validation"`
     - Halt pipeline execution immediately.
4. **Pipe Packaging**:
   - Transition state to `PIPE_DELIVERY`.
   - Compute `checksum = sha256(canonical_json(raw_out))`.
   - Mint `PipeTransitionEnvelope`:
     - `from_filter_id`: `F_k.filter_id`
     - `to_filter_id`: `F_{k+1}.filter_id if k < N else "TERMINAL"`
     - `stage_index`: `k`
     - `payload_checksum`: `checksum`
     - `duration_ms`: `duration_ms`
   - Emit log marker: `[STAGE_COMPLETED] Pipeline: [pipeline_id] Stage: [k]/[N] Filter: [F_k.filter_id] Duration: [duration_ms]ms Checksum: [checksum]`.
   - Update `current_payload = raw_out`.

### Step 4: Pipeline Finalization
1. Transition state to `COMPLETED`.
2. Emit log marker: `=== PIPELINE EXECUTION COMPLETED: [pipeline_id] TotalDurationMs: [ms] ===`.
3. Return `current_payload` and full execution trace envelope to caller.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== PIPELINE INITIALIZED: [pipeline_id] Stages: [count] ===`
- `[STAGE_STARTED] Pipeline: [pipeline_id] Stage: [idx] Filter: [filter_id]`
- `[STAGE_COMPLETED] Pipeline: [pipeline_id] Stage: [idx] DurationMs: [ms] Checksum: [sha256]`
- `=== PIPELINE EXECUTION COMPLETED: [pipeline_id] TotalDurationMs: [ms] ===`
- `=== PIPELINE HALTED: [pipeline_id] FailedAtStage: [idx] Code: [code] ===`

### 7.2. Defect Codes
- `PIPE_SCHEMA_MISMATCH`: Payload at a pipe boundary failed JSON Schema validation.
- `FILTER_EXECUTION_FAILED`: Filter handler threw an unhandled exception.
- `INCOMPATIBLE_PIPELINE_TOPOLOGY`: Adjacent filters have incompatible schema definitions.
- `INITIAL_INPUT_REJECTED`: Raw input payload failed input contract of Filter[1].
- `FILTER_TIMEOUT_EXCEEDED`: Filter execution exceeded configured per-stage timeout.
- `EMPTY_PIPELINE_ERROR`: Attempted to assemble a pipeline with zero registered filters.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Successful 3-Stage Ingestion Pipeline
**Pipeline**: `pipe-ingest-source`
1. `F_1 (Sanitizer)`: Ingests raw markdown, strips non-ASCII characters -> Emits `SanitizedTextSchema`.
2. `F_2 (Parser)`: Ingests `SanitizedTextSchema`, parses AST headers and sections -> Emits `ParsedSectionsSchema`.
3. `F_3 (SpecFormatter)`: Ingests `ParsedSectionsSchema`, compiles formal JSON schema specification -> Emits `CompiledSpecSchema`.

**Execution Trace**:
- Pre-flight lint: `Out(F_1) == In(F_2)` (MATCH), `Out(F_2) == In(F_3)` (MATCH). Topology valid.
- `=== PIPELINE INITIALIZED: pipe-ingest-source Stages: 3 ===`
- Stage 1 runs: 45ms. Emits sanitized text. Boundary schema checks: PASS.
- Stage 2 runs: 80ms. Emits parsed AST. Boundary schema checks: PASS.
- Stage 3 runs: 110ms. Emits final spec. Terminal boundary check: PASS.
- `=== PIPELINE EXECUTION COMPLETED: pipe-ingest-source TotalDurationMs: 235 ===`
- Pipeline completes with verified trace and zero schema drift.

### 8.2. Scenario 2: Intermediate Schema Violation Halted Immediately
- `F_2` parser accidentally emits `sections: null` instead of required `sections: array`.
- Pipe boundary between `F_2` and `F_3` intercepts output.
- Schema validator catches violation: `Field "sections" cannot be null`.
- Pipeline immediately halts at Stage 2.
- `=== PIPELINE HALTED: pipe-ingest-source FailedAtStage: 2 Code: PIPE_SCHEMA_MISMATCH ===`
- `F_3` is never invoked.
- `PipelineDefectReport` emitted with `violation_code: PIPE_SCHEMA_MISMATCH`, preserving stack trace and raw payload snippet.

### 8.3. Scenario 3: Pre-Flight Topology Incompatibility
- Attempting to assemble pipeline `pipe-data-sync` where `F_1.output_schema` emits `{ "user_id": "string" }`, but `F_2.input_schema` requires `{ "user_id": "integer" }`.
- Step 1 static schema compatibility check detects mismatch between string and integer types.
- Pipeline halts before running or accepting any input.
- `=== PIPELINE HALTED: pipe-data-sync FailedAtStage: 1 Code: INCOMPATIBLE_PIPELINE_TOPOLOGY ===`
- `PipelineDefectReport` emitted with `violation_code: INCOMPATIBLE_PIPELINE_TOPOLOGY`.

---

## 9. Definition of Done (DoD) Checklist

- [ ] Every filter is completely stateless and possesses zero references to shared mutable global state.
- [ ] Every filter declares an explicit JSON Schema Draft 2020-12 for both input and output contracts.
- [ ] Pre-flight topology check statically validates adjacent filter schema compatibility before ingestion.
- [ ] Every pipe boundary asserts payload schema validity before and after execution, halting on failure with `PIPE_SCHEMA_MISMATCH`.
- [ ] Defect reports conform to `PipelineDefectReport` with exact violation codes (`PIPE_SCHEMA_MISMATCH`, `FILTER_EXECUTION_FAILED`, `INCOMPATIBLE_PIPELINE_TOPOLOGY`, `INITIAL_INPUT_REJECTED`, `FILTER_TIMEOUT_EXCEEDED`, `EMPTY_PIPELINE_ERROR`).
- [ ] All 5 telemetry log markers are emitted deterministically at appropriate lifecycle checkpoints.
- [ ] Content contains strictly 7-bit ASCII English text with straight quotes and hyphens.
- [ ] Zero TODO or placeholder tokens present anywhere in the specification.
