---
name: saga-transaction-manager
description: Implements the distributed Saga Pattern for complex multi-step file mutations, refactoring, and tool execution, enforcing mandatory paired compensating actions, checkpoint journaling, and idempotent LIFO rollback on failure.
---

# SKILL: saga-transaction-manager

## 1. Overview & Domain Problem

A deterministic software engineering skill implementing the distributed Saga Pattern for autonomous agent workflows, multi-step file mutations, transactional refactoring, and distributed tool execution.

In complex multi-step agent workflows (e.g., scaffolding a new project, executing a multi-file architectural refactor, or modifying external environment resources), holding global locks via Two-Phase Commit across all steps is impossible or introduces catastrophic deadlocks. When an intermediate step fails without a Saga orchestrator, four failure modes emerge:
1. Dangling Partial Side Effects: Step 1 creates a directory, Step 2 mutates package.json, Step 3 modifies tsconfig.json, and Step 4 fails on syntax check. Aborting naively leaves broken configuration files and orphaned dependencies.
2. Untracked Rollback Order: Naively attempting to undo changes in random order causes dependency crashes (e.g., attempting to remove a parent directory before deleting child files).
3. Non-Idempotent Compensations: A network glitch during compensation causes a rollback script to fail halfway, leaving the system in an unrecoverable corrupted state.
4. Lack of Checkpoint Durability: If the agent crashes at Step 3, restarting from scratch cannot determine which forward actions already occurred, causing duplicate execution.

The saga-transaction-manager enforces:
- Paired Forward & Compensating Steps: Every mutating forward action T_i must declare an explicit, strictly paired compensating rollback action C_i that semantically undoes T_i.
- LIFO Compensating Rollback: If forward step T_k fails, the coordinator executes compensating actions in strict reverse chronological order: C_{k-1}, C_{k-2}, ..., C_1.
- Strict Idempotency of Compensations: Every compensating action C_i must be idempotent (C_i o C_i = C_i), permitting automatic retries if compensation encounters transient failures.
- Checkpoint Journaling: Every completed forward step is durably recorded in an append-only journal before T_{i+1} is initiated.

## 2. Trigger & Activation

### Positive Triggers
- Multi-step file modifications, dependency updates, and environment reconfigurations where partial writes destroy workspace integrity.
- Workflows spanning external tools (APIs, filesystem, git, docker) where distributed locks cannot be held.
- Operations requiring guaranteed semantic rollback to a clean baseline upon mid-flight error.
- Explicit invocation phrases: "saga transaction", "execute with compensating rollback", "atomic multi-step workflow", "rollback on failure", "transactional refactoring", "lifo rollback".

### Negative Triggers
- Single-file atomic operations where a simple in-memory undo buffer suffices.
- Low-latency database transactions supporting native ACID 2PC (two-phase-commit).
- Pure read-only queries or workspace inspections with zero state mutation.

## 3. Invariants & Non-Negotiable Rules

1. MANDATORY_COMPENSATING_PAIRS: Every forward step T_i must have an executable, registered compensating action C_i. Registering an uncompensated step triggers immediate rejection with MISSING_COMPENSATING_ACTION.
2. LIFO_ROLLBACK_ORDER = MANDATORY: Compensating actions must execute in strict reverse chronological order: C_{k-1} down to C_1.
3. IDEMPOTENT_COMPENSATION = MANDATORY: Compensating actions must safely tolerate duplicate execution without throwing errors or mutating unrelated state.
4. CHECKPOINT_BEFORE_ADVANCE = MANDATORY: The coordinator must record a durable checkpoint in the journal confirming T_i completed before executing T_{i+1}.
5. ZERO_UNCOMPENSATED_PARTIAL_STATE = MANDATORY: If a saga fails, all previously completed steps must be compensated. If a compensating action fails permanently, emit fatal alert COMPENSATION_ACTION_FAILED.

## 4. Rigid Data Contracts & Schemas

### 4.1. Saga Definition Schema (SagaDefinition)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SagaDefinition",
  "type": "object",
  "required": ["saga_id", "saga_name", "steps", "max_compensation_retries"],
  "properties": {
    "saga_id": { "type": "string", "pattern": "^saga-[a-zA-Z0-9_-]+$" },
    "saga_name": { "type": "string" },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "step_index",
          "name",
          "forward_action",
          "compensating_action"
        ],
        "properties": {
          "step_index": { "type": "integer", "minimum": 1 },
          "name": { "type": "string" },
          "forward_action": {
            "type": "object",
            "required": ["command", "target_path"],
            "properties": {
              "command": { "type": "string" },
              "target_path": { "type": "string" },
              "payload": { "type": "object" }
            },
            "additionalProperties": false
          },
          "compensating_action": {
            "type": "object",
            "required": ["command", "target_path"],
            "properties": {
              "command": { "type": "string" },
              "target_path": { "type": "string" },
              "payload": { "type": "object" }
            },
            "additionalProperties": false
          },
          "timeout_ms": { "type": "integer", "minimum": 500, "default": 15000 }
        },
        "additionalProperties": false
      },
      "minItems": 1
    },
    "max_compensation_retries": { "type": "integer", "minimum": 1, "default": 3 },
    "journal_path": { "type": "string", "default": ".agents/storage/saga/journal.jsonl" }
  },
  "additionalProperties": false
}
```

### 4.2. Saga Checkpoint Record Schema (SagaJournalRecord)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SagaJournalRecord",
  "type": "object",
  "required": [
    "entry_id",
    "saga_id",
    "step_index",
    "phase",
    "status",
    "timestamp_utc"
  ],
  "properties": {
    "entry_id": { "type": "string", "format": "uuid" },
    "saga_id": { "type": "string" },
    "step_index": { "type": "integer" },
    "phase": { "type": "string", "enum": ["FORWARD", "COMPENSATION"] },
    "status": { "type": "string", "enum": ["STARTED", "COMPLETED", "FAILED"] },
    "execution_output": { "type": ["object", "string", "null"] },
    "error_details": { "type": ["string", "null"] },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. Saga Defect Report Schema (SagaDefectReport)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SagaDefectReport",
  "type": "object",
  "required": [
    "defect_id",
    "saga_id",
    "failed_step_index",
    "violation_code",
    "error_message",
    "timestamp_utc"
  ],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "saga_id": { "type": "string" },
    "failed_step_index": { "type": "integer" },
    "violation_code": {
      "type": "string",
      "enum": [
        "SAGA_STEP_FAILED",
        "COMPENSATION_ACTION_FAILED",
        "MISSING_COMPENSATING_ACTION",
        "JOURNAL_CHECKPOINT_ERROR",
        "SAGA_PARTIAL_STATE_LEAK"
      ]
    },
    "error_message": { "type": "string" },
    "completed_compensations": { "type": "array", "items": { "type": "integer" } },
    "failed_compensation": { "type": ["object", "null"] },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

## 5. Formal State Machine

```text
       +--------------------+
       |   UNINITIALIZED    |
       +--------------------+
                 |
                 | Event: REGISTER_SAGA (Assert paired compensations)
                 v
       +--------------------+
+----->|  FORWARD_EXECUTING |
|      +--------------------+
|                |
|                | Forward Step T_k Success
|                v
|      +--------------------+
|      |  CHECKPOINT_LOGGED |
|      +--------------------+
|         /                |        / More steps       \ All N steps completed
|       v                    v
|   k < N               +--------------------+
+-------+               |   SAGA_COMMITTED   |
                        +--------------------+
        Forward Step T_k Fails
                 |
                 v
       +--------------------+
+----->| LIFO_COMPENSATION  |
|      +--------------------+
|                |
|                | Execute C_{k-1} down to C_1
|                v
|         Compensated all?
|          /          |         / Yes        \ Compensation error (Retries exhausted)
|        v              v
| +--------------+ +----------------------+
| | SAGA_ABORTED | | COMPENSATION_FAILED  |
| +--------------+ | (Human Intervention) |
|                  +----------------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `UNINITIALIZED` | `REGISTER` | 100% steps have valid compensating actions | `READY` | Initialize journal; set `current_step = 1`. |
| `UNINITIALIZED` | `REGISTER` | Missing compensating action | `FAILED` | Emit `MISSING_COMPENSATING_ACTION` Defect Report; halt. |
| `READY` | `EXECUTE_FORWARD` | current_step <= total_steps | `FORWARD_EXECUTING` | Invoke forward command T_k. |
| `FORWARD_EXECUTING` | `STEP_SUCCESS` | Command exits code 0 | `CHECKPOINT_LOGGED` | Append `COMPLETED` checkpoint for T_k to journal. |
| `CHECKPOINT_LOGGED` | `ADVANCE` | current_step < total_steps | `FORWARD_EXECUTING` | Set `current_step = current_step + 1`. |
| `CHECKPOINT_LOGGED` | `ADVANCE` | current_step == total_steps | `SAGA_COMMITTED` | Emit commit receipt; commit transaction. |
| `FORWARD_EXECUTING` | `STEP_FAILURE` | Command exits code != 0 or times out | `LIFO_COMPENSATION` | Record step failure; begin compensating from step k-1 down to 1. |
| `LIFO_COMPENSATION` | `COMP_SUCCESS` | More completed steps to rollback | `LIFO_COMPENSATION` | Execute C_{i-1}; log compensation checkpoint. |
| `LIFO_COMPENSATION` | `ALL_COMPENSATED` | Reached step 0 (all compensated) | `SAGA_ABORTED` | Workspace restored to baseline; emit Defect Report. |
| `LIFO_COMPENSATION` | `COMP_FAILURE` | Retries exhausted on compensation C_i | `COMPENSATION_FAILED` | Emit fatal alert `COMPENSATION_ACTION_FAILED`; halt. |

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Pre-Flight Verification & Saga Registration
1. Ingest `SagaDefinition` with steps `[S_1, S_2, ..., S_N]`.
2. For each step S_i:
   - Assert S_i has a non-empty `forward_action` AND non-empty `compensating_action`.
   - IF missing:
     - Emit Defect Report with `violation_code: "MISSING_COMPENSATING_ACTION"`. Halt immediately.
3. Initialize append-only saga journal at `journal_path`.
4. Transition state to `READY`.
5. Emit log marker: `=== SAGA REGISTERED: [saga_id] Steps: [N] ===`.

### Step 2: Forward Execution Loop
For `k = 1 to N`:
1. Transition state to `FORWARD_EXECUTING`.
2. Append journal entry: `(step_index=k, phase="FORWARD", status="STARTED")`.
3. Emit log marker: `[FORWARD_STEP_START] Saga: [saga_id] Step: [k]/[N] Name: [S_k.name]`.
4. Execute `S_k.forward_action`:
   - IF execution succeeds (exit code 0):
     - Append journal entry: `(step_index=k, phase="FORWARD", status="COMPLETED")`.
     - Emit log marker: `[FORWARD_STEP_SUCCESS] Saga: [saga_id] Step: [k]`.
   - ELSE (execution fails, throws error, or times out):
     - Append journal entry: `(step_index=k, phase="FORWARD", status="FAILED", error=details)`.
     - Emit log marker: `[FORWARD_STEP_FAILED] Saga: [saga_id] Step: [k] Error: [details]`.
     - Transition state to `LIFO_COMPENSATION`.
     - Initiate Step 3 (LIFO Compensating Rollback) starting from `k - 1`.
     - Break forward loop.
5. If `k == N` and all steps passed:
   - Transition state to `SAGA_COMMITTED`.
   - Emit log marker: `=== SAGA COMMITTED: [saga_id] TotalSteps: [N] ===`.
   - Return success receipt to caller.

### Step 3: LIFO Compensating Rollback Sequence
1. Set compensation pointer: `comp_index = k - 1`.
2. IF `comp_index == 0`:
   - No prior steps succeeded; zero compensation needed.
   - Transition state to `SAGA_ABORTED`. Proceed to Step 4.
3. While `comp_index >= 1`:
   a. Append journal entry: `(step_index=comp_index, phase="COMPENSATION", status="STARTED")`.
   b. Emit log marker: `[COMPENSATION_START] Saga: [saga_id] Step: [comp_index] Rolling back [S_{comp_index}.name]`.
   c. Execute `S_{comp_index}.compensating_action` with up to `max_compensation_retries` attempts:
      - IF compensation succeeds:
        - Append journal entry: `(step_index=comp_index, phase="COMPENSATION", status="COMPLETED")`.
        - Emit log marker: `[COMPENSATION_SUCCESS] Saga: [saga_id] Step: [comp_index]`.
        - Decrement `comp_index -= 1`.
      - ELSE (compensation fails across all retries):
        - Append journal entry: `(step_index=comp_index, phase="COMPENSATION", status="FAILED")`.
        - Emit log marker: `[COMPENSATION_FATAL] Saga: [saga_id] Step: [comp_index] Failed to undo changes`.
        - Transition state to `COMPENSATION_FAILED`.
        - Emit Defect Report: `COMPENSATION_ACTION_FAILED`.
        - Halt immediately (escalate to human operator).
4. Transition state to `SAGA_ABORTED`.
5. Emit log marker: `=== SAGA ABORTED & RESTORED: [saga_id] CompensatedSteps: [k-1 down to 1] ===`.

### Step 4: Final Certification
1. Construct and emit `SagaDefectReport` detailing failed forward step and list of compensated steps.
2. Return failure response to caller.

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== SAGA REGISTERED: [saga_id] Steps: [count] ===`
- `[FORWARD_STEP_START] Saga: [saga_id] Step: [idx] Name: [name]`
- `[FORWARD_STEP_SUCCESS] Saga: [saga_id] Step: [idx]`
- `[FORWARD_STEP_FAILED] Saga: [saga_id] Step: [idx] Error: [error]`
- `[COMPENSATION_START] Saga: [saga_id] Step: [idx] Rolling back [name]`
- `[COMPENSATION_SUCCESS] Saga: [saga_id] Step: [idx]`
- `[COMPENSATION_FATAL] Saga: [saga_id] Step: [idx] Failed to undo changes`
- `=== SAGA COMMITTED: [saga_id] TotalSteps: [N] ===`
- `=== SAGA ABORTED & RESTORED: [saga_id] CompensatedSteps: [k-1 down to 1] ===`

### 7.2. Defect Codes
- `SAGA_STEP_FAILED`: Forward step execution threw an unrecoverable error or timed out.
- `COMPENSATION_ACTION_FAILED`: Compensating rollback action failed across all retry attempts.
- `MISSING_COMPENSATING_ACTION`: Forward step declared without a paired compensating action.
- `JOURNAL_CHECKPOINT_ERROR`: Unable to write step completion checkpoint to journal store.
- `SAGA_PARTIAL_STATE_LEAK`: Incomplete rollback left uncompensated changes on disk.

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Multi-Step Refactor with Step 3 Failure & LIFO Rollback
- Proposed Steps:
  1. Step 1: Create directory `src/v2/` -> Compensate: Delete directory `src/v2/`.
  2. Step 2: Write `src/v2/client.py` -> Compensate: Remove file `src/v2/client.py`.
  3. Step 3: Run linter on `src/v2/client.py` -> Compensate: No-op.
- Execution Log:
```text
=== SAGA REGISTERED: saga-refactor-001 Steps: 3 ===
[FORWARD_STEP_START] Saga: saga-refactor-001 Step: 1/3 Name: create_dir
[FORWARD_STEP_SUCCESS] Saga: saga-refactor-001 Step: 1
[FORWARD_STEP_START] Saga: saga-refactor-001 Step: 2/3 Name: write_client
[FORWARD_STEP_SUCCESS] Saga: saga-refactor-001 Step: 2
[FORWARD_STEP_START] Saga: saga-refactor-001 Step: 3/3 Name: lint_client
[FORWARD_STEP_FAILED] Saga: saga-refactor-001 Step: 3 Error: SyntaxError at line 42
[COMPENSATION_START] Saga: saga-refactor-001 Step: 2 Rolling back write_client
[COMPENSATION_SUCCESS] Saga: saga-refactor-001 Step: 2
[COMPENSATION_START] Saga: saga-refactor-001 Step: 1 Rolling back create_dir
[COMPENSATION_SUCCESS] Saga: saga-refactor-001 Step: 1
=== SAGA ABORTED & RESTORED: saga-refactor-001 CompensatedSteps: [2 down to 1] ===
```

### 8.2. Scenario 2: Successful Multi-Step Execution & Commit (Happy Path)
- Execution Log:
```text
=== SAGA REGISTERED: saga-scaffold-002 Steps: 3 ===
[FORWARD_STEP_START] Saga: saga-scaffold-002 Step: 1/3 Name: init_config
[FORWARD_STEP_SUCCESS] Saga: saga-scaffold-002 Step: 1
[FORWARD_STEP_START] Saga: saga-scaffold-002 Step: 2/3 Name: generate_models
[FORWARD_STEP_SUCCESS] Saga: saga-scaffold-002 Step: 2
[FORWARD_STEP_START] Saga: saga-scaffold-002 Step: 3/3 Name: run_migrations
[FORWARD_STEP_SUCCESS] Saga: saga-scaffold-002 Step: 3
=== SAGA COMMITTED: saga-scaffold-002 TotalSteps: 3 ===
```

### 8.3. Scenario 3: Immediate Failure at Step 1 (Nothing to Roll Back)
- Execution Log:
```text
=== SAGA REGISTERED: saga-deploy-003 Steps: 3 ===
[FORWARD_STEP_START] Saga: saga-deploy-003 Step: 1/3 Name: create_namespace
[FORWARD_STEP_FAILED] Saga: saga-deploy-003 Step: 1 Error: Permission denied
=== SAGA ABORTED & RESTORED: saga-deploy-003 CompensatedSteps: [] ===
```

### 8.4. Scenario 4: Pre-flight Rejection on Missing Compensating Action
- Execution Log:
```text
{
  "defect_id": "8f8b80b2-3a52-4f30-802c-49a7852c92e1",
  "saga_id": "saga-invalid-004",
  "failed_step_index": 2,
  "violation_code": "MISSING_COMPENSATING_ACTION",
  "error_message": "Step 2 missing paired compensating_action in SagaDefinition",
  "completed_compensations": [],
  "failed_compensation": null,
  "timestamp_utc": "2026-09-12T17:00:00Z"
}
```

### 8.5. Scenario 5: Permanent Compensation Action Failure (Emergency Halt)
- Execution Log:
```text
=== SAGA REGISTERED: saga-cleanup-005 Steps: 2 ===
[FORWARD_STEP_START] Saga: saga-cleanup-005 Step: 1/2 Name: lock_resource
[FORWARD_STEP_SUCCESS] Saga: saga-cleanup-005 Step: 1
[FORWARD_STEP_START] Saga: saga-cleanup-005 Step: 2/2 Name: update_remote_state
[FORWARD_STEP_FAILED] Saga: saga-cleanup-005 Step: 2 Error: Remote connection timeout
[COMPENSATION_START] Saga: saga-cleanup-005 Step: 1 Rolling back lock_resource
[COMPENSATION_FATAL] Saga: saga-cleanup-005 Step: 1 Failed to undo changes
```
