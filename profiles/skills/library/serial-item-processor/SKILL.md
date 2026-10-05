---
name: serial-item-processor
description: Iterates through a collection of items sequentially, enforcing strict state transitions and absolute context isolation between items. Prevents cross-pollution and lookahead by processing one item completely before initiating the next.
---

# Serial Item Processor (serial-item-processor)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
When an autonomous agent or LLM is tasked with processing a collection of items (e.g., refactoring 15 files, evaluating 10 specifications, or auditing 12 database tables), default LLM generation exhibits severe batching defects:
1. **Batch Hallucination & Attention Fatigue**: Grouping all items into a single generation causes the LLM to provide deep analysis for items 1-2, but superficial, truncated, or hallucinated one-liners for items 8-15.
2. **Context Cross-Pollution & State Bleed**: Variables, errors, or domain assumptions from Item N bleed into the reasoning for Item N+1, leading to incorrect classifications and invalid code edits.
3. **Lookahead Bias**: Analyzing Item N with premature knowledge of Item N+1, violating independent causal reasoning and creating hidden inter-item coupling.
4. **All-or-Nothing Batch Failures**: If an uncaught exception occurs on Item 9 of 10, an unbuffered batch script crashes completely, losing all progress from Items 1 through 8.

### 1.2. Scope & Behavioral Boundaries
The `serial-item-processor` pattern enforces absolute, non-negotiable **Context Isolation** and **Strict Serial Execution**:
- **Strict Serial Order**: Exactly one item undergoes the complete lifecycle (`VALIDATING -> PROCESSING -> VERIFYING`) before the next item begins.
- **No Lookahead**: Reading, inspecting, or reasoning about Item N+1 while Item N is active is strictly prohibited.
- **No Batching**: Aggregating items into shared multi-item summaries or parallel executions is forbidden.
- **Zero Cross-Pollution & Context Purge**: Local variables, scratchpad buffers, and cognitive focus are explicitly purged between items.
- **Deterministic Step Logging**: Explicit log markers (`=== START: [item] ===`, `[VALIDATION]`, `[PROCESSING]`, `[VERIFICATION]`, `=== END: [item] ===`, `*Context purged.*`) anchor agent attention.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Processing arrays or lists of heterogeneous tasks, files, specifications, or subagent outputs.
- Tasks requiring rigorous, uniform, non-degraded quality across every single item without fatigue.
- Workflows explicitly demanding step-by-step unbatched execution.
- Explicit keywords: "execute step by step", "process one by one", "sequentially through the list", "do not do everything at once", "for each item separately", "serial item processor".

### 2.2. Negative Triggers
- High-throughput parallel embarrassingly-parallel tasks with zero state contamination risk (`fork-join`).
- Pipelines where item N strictly transforms data for item N+1 (`pipes-and-filters`).
- Single atomic tasks not involving a collection.
- Decentralized peer-to-peer message-passing agents (`actor-model`).

---

## 3. Invariants & Non-Negotiable Rules

1. **STRICT_SERIAL_EXECUTION = MANDATORY**: Item N must reach `END_ITEM` and complete `CONTEXT_PURGE` before Item N+1 may transition to `START_ITEM`.
2. **NO_LOOKAHEAD_RULE = MANDATORY**: Inspecting, reading, or referencing Item N+1 while Item N is active triggers immediate fatal defect `LOOKAHEAD_VIOLATION`.
3. **NO_BATCHING_RULE = MANDATORY**: Processing multiple items simultaneously or generating joint summaries prior to Phase 3 is strictly forbidden. Failure code: `BATCH_POLLUTION_DETECTED`.
4. **MANDATORY_STEP_MARKERS = MANDATORY**: Every item lifecycle must emit all six standard log markers:
   `=== START: [name] ===`, `[VALIDATION]`, `[PROCESSING]`, `[VERIFICATION]`, `=== END: [name] ===`, and `*Context purged.*`.
5. **ISOLATED_FAILURE_RECOVERY = MANDATORY**: A failure during validation, processing, or verification of Item N must be logged, but must not halt the processing of subsequent items unless `abort_on_first_error == TRUE`.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Processor Configuration Schema (`SerialProcessorConfig`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SerialProcessorConfig",
  "type": "object",
  "required": ["batch_id", "input_items", "abort_on_first_error"],
  "properties": {
    "batch_id": { "type": "string", "pattern": "^serial-[a-zA-Z0-9_-]+$" },
    "input_items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["item_id", "name"],
        "properties": {
          "item_id": { "type": "string" },
          "name": { "type": "string" },
          "payload": { "type": "object" }
        },
        "additionalProperties": true
      },
      "minItems": 1
    },
    "abort_on_first_error": { "type": "boolean", "default": false },
    "verification_strictness": { "type": "string", "enum": ["LENIENT", "STRICT", "PARANOID"], "default": "STRICT" }
  },
  "additionalProperties": false
}
```

### 4.2. Item Execution Record Schema (`ItemExecutionRecord`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ItemExecutionRecord",
  "type": "object",
  "required": [
    "item_index",
    "item_name",
    "status",
    "validation_details",
    "processing_details",
    "verification_details",
    "duration_ms"
  ],
  "properties": {
    "item_index": { "type": "integer", "minimum": 1 },
    "item_name": { "type": "string" },
    "status": { "type": "string", "enum": ["SUCCESS", "FAIL", "SKIPPED"] },
    "validation_details": { "type": "string" },
    "processing_details": { "type": "string" },
    "verification_details": { "type": "string" },
    "error_message": { "type": ["string", "null"] },
    "artifact_reference": { "type": ["string", "null"] },
    "duration_ms": { "type": "integer", "minimum": 0 }
  },
  "additionalProperties": false
}
```

### 4.3. Serial Processor Defect Report Schema (`SerialProcessorDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SerialProcessorDefectReport",
  "type": "object",
  "required": ["defect_id", "batch_id", "item_name", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "batch_id": { "type": "string" },
    "item_name": { "type": "string" },
    "item_index": { "type": "integer" },
    "violation_code": {
      "type": "string",
      "enum": [
        "LOOKAHEAD_VIOLATION",
        "BATCH_POLLUTION_DETECTED",
        "ITEM_VALIDATION_FAILED",
        "ITEM_PROCESSING_FAILED",
        "VERIFICATION_CRITERIA_FAILED",
        "EMPTY_INPUT_ARRAY"
      ]
    },
    "error_message": { "type": "string" },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal State Machine

```text
       +--------------------+
       |        IDLE        |
       +--------------------+
                 |
                 | Event: INGEST_ARRAY (Verify non-empty, index = 0)
                 v
       +--------------------+
+----->|     START_ITEM     |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: VALIDATE_INPUT                   |
|                v                                         |
|      +--------------------+                              |
|      |     VALIDATING     |                              |
|      +--------------------+                              |
|         /                \                               |
|        / OK               \ FAIL                         |
|       v                    v                             |
| +------------+     +-------------------+                 |
| | PROCESSING |     | RECORD_FAIL       |                 |
| +------------+     +-------------------+                 |
|       |                      |                           |
|       | Processing OK        |                           |
|       v                      |                           |
| +------------+               |                           |
| | VERIFYING  |               |                           |
| +------------+               |                           |
|       |                      |                           |
|       | Verified PASS/FAIL   |                           |
|       v                      |                           |
| +------------+               |                           |
| |  END_ITEM  |<--------------+                           |
| +------------+                                           |
|       |                                                  |
|       | Event: CONTEXT_PURGE                             |
|       v                                                  |
| +---------------+                                        |
| | CONTEXT_PURGE |                                        |
| +---------------+                                        |
|       |                                                  |
| Has more items?                                          |
|   /        \                                             |
|  / Yes      \ No                                         |
+--+           v                                           |
       +--------------------+                              |
       |  TERMINAL_SUMMARY  |                              |
       +--------------------+                              |
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `IDLE` | `INGEST_ARRAY` | len(input_items) >= 1 | `START_ITEM` | Set `index = 0`; isolate first item `item[0]`. |
| `IDLE` | `INGEST_ARRAY` | len(input_items) == 0 | `TERMINAL_SUMMARY` | Emit empty summary table; halt. |
| `START_ITEM` | `EMIT_START` | Item pointer valid | `VALIDATING` | Emit `=== START: [item.name] ===`. |
| `VALIDATING` | `VALIDATION_OK` | Input preconditions satisfied | `PROCESSING` | Emit `[VALIDATION] Status: OK, Details: ...`. |
| `VALIDATING` | `VALIDATION_ERR`| Input preconditions violated | `END_ITEM` | Emit `[VALIDATION] Status: FAIL`; record failure. |
| `PROCESSING` | `EXEC_COMPLETE` | Core operation succeeds | `VERIFYING` | Emit `[PROCESSING] Action: ..., Result: ...`. |
| `PROCESSING` | `EXEC_ERROR` | Core operation throws error | `END_ITEM` | Emit `[PROCESSING] Status: FAIL`; record error. |
| `VERIFYING` | `VERIFY_PASS` | Definition of Done satisfied | `END_ITEM` | Emit `[VERIFICATION] Status: PASS, Note: ...`. |
| `VERIFYING` | `VERIFY_FAIL` | Criteria violated | `END_ITEM` | Emit `[VERIFICATION] Status: FAIL, Note: ...`. |
| `END_ITEM` | `EMIT_END` | Execution recorded | `CONTEXT_PURGE` | Emit `=== END: [item.name] ===`. |
| `CONTEXT_PURGE`| `PURGE_DONE` | index + 1 < total_items | `START_ITEM` | Emit `*Context purged.*`; increment `index += 1`. |
| `CONTEXT_PURGE`| `PURGE_DONE` | index + 1 == total_items | `TERMINAL_SUMMARY` | Emit `*Context purged.*`; generate consolidated markdown table. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Array Ingestion & Initialization
1. Ingest `INPUT_ARRAY = [item_1, item_2, ... item_K]`.
2. Assert `len(INPUT_ARRAY) > 0`:
   - IF empty: Emit empty summary table; halt immediately.
3. Initialize execution state:
   - `current_index = 0`
   - `execution_records = []`
4. Advance to Step 2 for `item = INPUT_ARRAY[0]`.

### Step 2: Item Lifecycle Execution
For each `item` in `INPUT_ARRAY`:
1. **START_ITEM**:
   - Emit log marker: `=== START: [item.name] ===`.
   - Record `item_start_time = now()`.
2. **VALIDATING**:
   - Inspect input parameters, file existence, and structural preconditions strictly for `item`.
   - IF validation fails:
     - Emit structured log: `[VALIDATION] Status: FAIL, Details: [deterministic rationale]`.
     - Store record: `status = FAIL`, `validation_details = rationale`.
     - Skip directly to sub-step 5 (END_ITEM).
   - ELSE:
     - Emit structured log: `[VALIDATION] Status: OK, Details: [deterministic rationale]`.
3. **PROCESSING**:
   - Execute core task (refactor, synthesize, fix, or compile) strictly within the boundary of `item`.
   - Assert no lookahead or mutation of subsequent items.
   - IF execution throws an unrecoverable error:
     - Emit structured log: `[PROCESSING] Status: FAIL, Error: [details]`.
     - Store record: `status = FAIL`, `error_message = details`.
     - Skip directly to sub-step 5 (END_ITEM).
   - ELSE:
     - Emit structured log: `[PROCESSING] Action: [action description], Result: [operational result]`.
4. **VERIFYING**:
   - Check produced artifact against Definition of Done and strict criteria (e.g., 7-bit ASCII check, lint pass, test pass).
   - IF verification fails:
     - Emit structured log: `[VERIFICATION] Status: FAIL, Note: [criteria check failure summary]`.
     - Store record: `status = FAIL`, `verification_details = failure summary`.
   - ELSE:
     - Emit structured log: `[VERIFICATION] Status: PASS, Note: [criteria check success summary]`.
     - Store record: `status = SUCCESS`.
5. **END_ITEM**:
   - Record `duration_ms = now() - item_start_time`.
   - Append to `execution_records`.
   - Emit log marker: `=== END: [item.name] ===`.
6. **CONTEXT_PURGE**:
   - Clear all local temporary variables, scratchpad buffers, and working memory references for `item`.
   - Emit boundary trace: `*Context purged.*`.
7. **ABORT_CHECK**:
   - IF `abort_on_first_error == TRUE` AND `record.status == FAIL`:
     - Halt sequence immediately; advance to Step 3.

### Step 3: Terminal Summary Consolidation
1. Format consolidated markdown summary table:
```markdown
| ITEM_IDENTIFIER | STATUS | SUMMARY |
|---|---|---|
| <item.name> | <SUCCESS | FAIL> | <concise outcome> |
```
2. Compute totals: `Total`, `Successful`, `Failed`, `Skipped`.
3. Deliver verified terminal summary table to caller.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== START: [item_name] ===`
- `[VALIDATION] Status: [OK | FAIL], Details: [rationale]`
- `[PROCESSING] Action: [action], Result: [result]`
- `[VERIFICATION] Status: [PASS | FAIL], Note: [note]`
- `=== END: [item_name] ===`
- `*Context purged.*`

### 7.2. Defect Codes
- `LOOKAHEAD_VIOLATION`: Inspected or referenced item N+1 before completing item N.
- `BATCH_POLLUTION_DETECTED`: Grouped multiple items into shared processing or summary.
- `ITEM_VALIDATION_FAILED`: Preconditions for individual item were not satisfied.
- `ITEM_PROCESSING_FAILED`: Core task execution threw an unhandled error.
- `VERIFICATION_CRITERIA_FAILED`: Output artifact failed Definition of Done verification.
- `EMPTY_INPUT_ARRAY`: Supplied input collection contains zero elements.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Processing Two Accounts Sequentially (Happy Path)
**Input**: `[{"name": "alpha"}, {"name": "beta"}]`
```text
=== START: alpha ===
[VALIDATION] Status: OK, Details: Account schema valid and active.
[PROCESSING] Action: Scaffolding user directory, Result: Directory /users/alpha initialized.
[VERIFICATION] Status: PASS, Note: Verified directory permissions and quota.
=== END: alpha ===
*Context purged.*

=== START: beta ===
[VALIDATION] Status: OK, Details: Account schema valid and active.
[PROCESSING] Action: Scaffolding user directory, Result: Directory /users/beta initialized.
[VERIFICATION] Status: PASS, Note: Verified directory permissions and quota.
=== END: beta ===
*Context purged.*

| ITEM_IDENTIFIER | STATUS | SUMMARY |
|---|---|---|
| alpha | SUCCESS | Directory /users/alpha created and verified |
| beta | SUCCESS | Directory /users/beta created and verified |
```

### 8.2. Scenario 2: Item Failure with Isolated Recovery & Continuation
**Input**: `[{"name": "corrupt_item"}, {"name": "valid_item"}]`
```text
=== START: corrupt_item ===
[VALIDATION] Status: FAIL, Details: Missing required header metadata.
=== END: corrupt_item ===
*Context purged.*

=== START: valid_item ===
[VALIDATION] Status: OK, Details: Header metadata verified.
[PROCESSING] Action: Parsing sections, Result: 4 sections parsed.
[VERIFICATION] Status: PASS, Note: Output structure conforms to schema.
=== END: valid_item ===
*Context purged.*

| ITEM_IDENTIFIER | STATUS | SUMMARY |
|---|---|---|
| corrupt_item | FAIL | Validation failed: Missing header metadata |
| valid_item | SUCCESS | 4 sections parsed and verified |
```

### 8.3. Scenario 3: Abort on First Error Policy Execution
**Input**: `[{"name": "broken_item"}, {"name": "pending_item"}]` with `abort_on_first_error: true`
```text
=== START: broken_item ===
[VALIDATION] Status: OK, Details: Preconditions met.
[PROCESSING] Action: Compilation, Result: Internal syntax error.
=== END: broken_item ===
*Context purged.*

| ITEM_IDENTIFIER | STATUS | SUMMARY |
|---|---|---|
| broken_item | FAIL | Compilation failed: Internal syntax error |
| pending_item | SKIPPED | Aborted due to prior failure |
```
