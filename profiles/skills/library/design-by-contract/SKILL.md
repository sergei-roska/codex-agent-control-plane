---
name: design-by-contract
description: Enforces Bertrand Meyer's Design by Contract (DbC) principles for autonomous agent workflows and tool invocations, requiring explicit Preconditions (requires), Postconditions (ensures), and Invariants with fail-fast defect reporting.
---

# Design by Contract Pattern (design-by-contract)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
In autonomous agent architectures, tasks and tool invocations often rely on unstated assumptions about environment state, argument types, file existence, and output structures. When these implicit assumptions fail, agents exhibit severe operational defects:
1. **Silent Precondition Assumptions**: An agent invokes a code-formatting tool expecting a clean git tree, but the working directory is dirty, resulting in silent clobbering of uncommitted work.
2. **Ungrounded Output Acceptance**: An agent claims a task succeeded without verifying that output files exist, match declared JSON schemas, or contain non-zero content.
3. **Workspace Invariant Corruption**: An operation succeeds in writing an output artifact but silently mutates a read-only configuration file or exceeds memory/token budgets.
4. **Late-Stage Crash Cascades**: Errors originating from malformed inputs surface deep inside execution pipelines, making root-cause diagnostics difficult and expensive.

### 1.2. Scope & Behavioral Boundaries
The `design-by-contract` (DbC) pattern applies Bertrand Meyer formal contractual engineering to autonomous agent workflows:
- **Preconditions (`requires`)**: Rigid assertions that the caller or orchestrator must satisfy before operation start.
- **Postconditions (`ensures`)**: Rigid guarantees that the executing agent or tool guarantees upon successful termination.
- **Invariants (`invariants`)**: Universal system properties that must hold true before invocation, during quiescence, and after execution.
- **Fail-Fast Defect Reporting**: If any contractual predicate evaluates to `FALSE`, execution halts immediately with a structured `DbcDefectReport`, preventing defective state propagation.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Critical tool invocations, code mutations, and multi-agent handoffs requiring formal verification gates.
- Workflows where inputs and outputs must strictly satisfy declared schemas, filesystem paths, and environment preconditions.
- Quality gate enforcement before promoting artifacts or committing workspace changes.
- Explicit keywords: "design by contract", "verify preconditions and postconditions", "enforce contract invariants", "validate execution contract", "precondition failed".

### 2.2. Negative Triggers
- Open-ended creative brainstorming where inputs and outputs are intentionally unstructured.
- Low-risk read operations that perform zero state mutations and have no invariants to uphold.
- Transient conversational chitchat.

---

## 3. Invariants & Non-Negotiable Rules

1. **FAIL_FAST_PRECONDITIONS = MANDATORY**: Preconditions must be evaluated before initiating any operational side effects. If any precondition evaluates to `FALSE`, the operation must immediately abort with `PRECONDITION_FAILED`.
2. **MANDATORY_POSTCONDITION_VERIFICATION = MANDATORY**: An operation cannot be reported as `SUCCESS` until all postconditions are explicitly evaluated and confirmed `TRUE`. Failure code: `POSTCONDITION_FAILED`.
3. **INVARIANT_PRESERVATION = MANDATORY**: System invariants (e.g., read-only directories, uncorrupted git index, resource limits) must be validated before and after execution. Any discrepancy triggers `INVARIANT_VIOLATION`.
4. **NO_CONTRACT_MUTATION_MID_FLIGHT = MANDATORY**: A contract definition is immutable once execution begins. Contracts cannot be weakened or dynamically skipped.
5. **ZERO_UNCORRECTED_DIRTY_STATE = MANDATORY**: If postconditions or invariants fail, the coordinator must trigger compensating rollbacks or fail-safe isolation before emitting the defect report.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Contract Definition Schema (`ContractDefinition`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ContractDefinition",
  "type": "object",
  "required": ["contract_id", "operation_name", "requires", "ensures", "invariants"],
  "properties": {
    "contract_id": { "type": "string", "pattern": "^dbc-[a-zA-Z0-9_-]+$" },
    "operation_name": { "type": "string" },
    "requires": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["predicate_id", "description", "assertion_expression"],
        "properties": {
          "predicate_id": { "type": "string" },
          "description": { "type": "string" },
          "assertion_expression": { "type": "string" }
        },
        "additionalProperties": false
      }
    },
    "ensures": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["predicate_id", "description", "assertion_expression"],
        "properties": {
          "predicate_id": { "type": "string" },
          "description": { "type": "string" },
          "assertion_expression": { "type": "string" }
        },
        "additionalProperties": false
      }
    },
    "invariants": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["invariant_id", "description", "assertion_expression"],
        "properties": {
          "invariant_id": { "type": "string" },
          "description": { "type": "string" },
          "assertion_expression": { "type": "string" }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

### 4.2. Contract Evaluation Result Schema (`ContractEvaluationResult`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ContractEvaluationResult",
  "type": "object",
  "required": [
    "evaluation_id",
    "contract_id",
    "phase",
    "verdict",
    "evaluated_predicates",
    "evaluated_at_utc"
  ],
  "properties": {
    "evaluation_id": { "type": "string", "format": "uuid" },
    "contract_id": { "type": "string" },
    "phase": { "type": "string", "enum": ["PRECONDITION", "POSTCONDITION", "INVARIANT_PRE", "INVARIANT_POST"] },
    "verdict": { "type": "string", "enum": ["PASS", "FAIL"] },
    "evaluated_predicates": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "verdict", "actual_value", "expected_expression"],
        "properties": {
          "id": { "type": "string" },
          "verdict": { "type": "string", "enum": ["PASS", "FAIL"] },
          "actual_value": { "type": "string" },
          "expected_expression": { "type": "string" },
          "error_details": { "type": ["string", "null"] }
        },
        "additionalProperties": false
      }
    },
    "evaluated_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. DbC Defect Report Schema (`DbcDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DbcDefectReport",
  "type": "object",
  "required": [
    "defect_id",
    "contract_id",
    "violation_code",
    "failed_predicate_id",
    "description",
    "diagnostic_context",
    "timestamp_utc"
  ],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "contract_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "PRECONDITION_FAILED",
        "POSTCONDITION_FAILED",
        "INVARIANT_VIOLATION",
        "UNCONTRACTED_OPERATION_DETECTED",
        "CONTRACT_EVALUATION_ERROR"
      ]
    },
    "failed_predicate_id": { "type": "string" },
    "description": { "type": "string" },
    "diagnostic_context": { "type": "object", "additionalProperties": true },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal State Machine

```text
       +--------------------+
       |     DECLARED       |
       +--------------------+
                 |
                 | Event: EVALUATE_PRECONDITIONS
                 v
       +--------------------+
       |   CHECKING_PRE     |----+
       +--------------------+    |
         |                       | Predicate FAIL
         | All PASS              v
         v             +--------------------+
       +------------+  |  PRE_BREACH_HALT   |
       | CHECK_INV  |  +--------------------+
       +------------+
         |
         | Invariants Baseline OK
         v
       +--------------------+
       |     EXECUTING      |----+
       +--------------------+    |
         |                       | Tool / Op Exception
         | Op Complete           v
         v             +--------------------+
       +------------+  |  OPERATION_FAILED  |
       | CHECK_POST |  +--------------------+
       +------------+
         |
         | Postconditions PASS
         v
       +--------------------+
       |  CHECK_INV_POST    |----+
       +--------------------+    |
         |                       | Invariant Corrupted
         | Invariants Preserved  v
         v             +--------------------+
       +------------+  |  INVARIANT_BREACH  |
       | FULFILLED  |  +--------------------+
       +------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `DECLARED` | `START_EVALUATION` | Contract schema valid | `CHECKING_PRE` | Begin evaluating all `requires` predicates. |
| `CHECKING_PRE` | `PRE_PASS` | 100% preconditions evaluate to TRUE | `CHECK_INV_PRE` | Snapshot invariant baseline (checksums, limits). |
| `CHECKING_PRE` | `PRE_FAIL` | At least 1 precondition evaluates to FALSE | `PRE_BREACH_HALT` | Emit `PRECONDITION_FAILED` Defect Report; halt execution. |
| `CHECK_INV_PRE` | `INV_PRE_PASS` | Invariant baselines match expected bounds | `EXECUTING` | Invoke protected operation. |
| `EXECUTING` | `OP_COMPLETE` | Operation returns without unhandled error | `CHECKING_POST` | Ingest operation output artifact and metadata. |
| `EXECUTING` | `OP_ERROR` | Operation throws unhandled exception | `OPERATION_FAILED` | Capture stack trace; emit Defect Report; halt. |
| `CHECKING_POST` | `POST_PASS` | 100% postconditions evaluate to TRUE | `CHECK_INV_POST` | Re-evaluate invariants against baseline. |
| `CHECKING_POST` | `POST_FAIL` | At least 1 postcondition evaluates to FALSE | `POST_BREACH_HALT` | Trigger rollback; emit `POSTCONDITION_FAILED`; halt. |
| `CHECK_INV_POST`| `INV_POST_PASS`| Invariants preserved 100% | `FULFILLED` | Emit Contract Fulfillment certificate; return result. |
| `CHECK_INV_POST`| `INV_POST_FAIL`| Invariant discrepancy detected | `INVARIANT_BREACH`| Trigger rollback; emit `INVARIANT_VIOLATION`; halt. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Contract Registration & Invariant Baselining
1. Load `ContractDefinition` for target operation.
2. Mint `evaluation_id`.
3. Snapshot invariant baseline state:
   - File hashes of protected read-only paths.
   - Resource metrics (token usage, active child processes).
4. Transition state to `CHECKING_PRE`.
5. Emit log marker: `=== CONTRACT EVALUATION INITIALIZED: [contract_id] Op: [operation_name] ===`.

### Step 2: Precondition Gate (`requires`)
1. For each predicate in `requires`:
   - Evaluate expression: `result = evaluate(assertion_expression, input_context)`.
   - Record predicate verdict: `PASS` or `FAIL`.
   - IF `result == FAIL`:
     - Construct `DbcDefectReport`:
       - `violation_code: PRECONDITION_FAILED`
       - `failed_predicate_id: predicate.predicate_id`
       - `description: predicate.description`
       - `diagnostic_context: {actual: result.actual, expected: assertion_expression}`
     - Emit log marker: `[PRECONDITION_FAILED] Contract: [contract_id] Predicate: [predicate.predicate_id]`.
     - Emit log marker: `=== CONTRACT BREACHED: [contract_id] Code: PRECONDITION_FAILED ===`.
     - Transition state to `PRE_BREACH_HALT`. Halt immediately without executing operation.
2. Emit log marker: `[PRECONDITIONS_VERIFIED] Contract: [contract_id] Count: [len(requires)] Verdict: PASS`.
3. Transition state to `CHECK_INV_PRE`.
4. Verify baseline bounds and transition state to `EXECUTING`.

### Step 3: Operation Execution
1. Emit log marker: `[OPERATION_EXECUTING] Contract: [contract_id] Target: [operation_name]`.
2. Execute protected operation within monitored execution context.
3. Capture output artifact, return code, and execution metadata.
4. IF operation raises unhandled exception:
   - Construct `DbcDefectReport`:
     - `violation_code: CONTRACT_EVALUATION_ERROR`
     - `failed_predicate_id: "OPERATION_EXECUTION"`
     - `description: "Operation execution threw unhandled exception"`
     - `diagnostic_context: {error: exception.message, stack: exception.stack_trace}`
   - Emit log marker: `=== CONTRACT BREACHED: [contract_id] Code: CONTRACT_EVALUATION_ERROR ===`.
   - Transition state to `OPERATION_FAILED`. Halt execution.
5. Transition state to `CHECKING_POST`.

### Step 4: Postcondition Gate (`ensures`)
1. For each predicate in `ensures`:
   - Evaluate expression: `result = evaluate(assertion_expression, output_context)`.
   - Record predicate verdict: `PASS` or `FAIL`.
   - IF `result == FAIL`:
     - Construct `DbcDefectReport`:
       - `violation_code: POSTCONDITION_FAILED`
       - `failed_predicate_id: predicate.predicate_id`
       - `description: predicate.description`
       - `diagnostic_context: {actual: result.actual, expected: assertion_expression}`
     - Emit log marker: `[POSTCONDITION_FAILED] Contract: [contract_id] Predicate: [predicate.predicate_id]`.
     - Emit log marker: `=== CONTRACT BREACHED: [contract_id] Code: POSTCONDITION_FAILED ===`.
     - Trigger compensating cleanup of any generated dirty artifacts.
     - Transition state to `POST_BREACH_HALT`. Halt execution.
2. Emit log marker: `[POSTCONDITIONS_VERIFIED] Contract: [contract_id] Count: [len(ensures)] Verdict: PASS`.
3. Transition state to `CHECK_INV_POST`.

### Step 5: Invariant Verification Gate (`invariants`)
1. For each predicate in `invariants`:
   - Compare current state against initial baseline snapshot.
   - IF state diff violates invariant:
     - Construct `DbcDefectReport`:
       - `violation_code: INVARIANT_VIOLATION`
       - `failed_predicate_id: invariant.invariant_id`
       - `description: invariant.description`
       - `diagnostic_context: {baseline: baseline_val, current: current_val}`
     - Emit log marker: `[INVARIANT_VIOLATION] Contract: [contract_id] Invariant: [invariant.invariant_id]`.
     - Emit log marker: `=== CONTRACT BREACHED: [contract_id] Code: INVARIANT_VIOLATION ===`.
     - Trigger emergency rollback of mutated files.
     - Transition state to `INVARIANT_BREACH`. Halt execution.
2. Emit log marker: `[INVARIANTS_VERIFIED] Contract: [contract_id] Verdict: PASS`.
3. Transition state to `FULFILLED`.
4. Emit log marker: `=== CONTRACT FULFILLED: [contract_id] Op: [operation_name] Status: CERTIFIED ===`.
5. Return verified result to caller.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== CONTRACT EVALUATION INITIALIZED: [contract_id] Op: [operation_name] ===`
- `[PRECONDITIONS_VERIFIED] Contract: [contract_id] Count: [count] Verdict: [PASS | FAIL]`
- `[PRECONDITION_FAILED] Contract: [contract_id] Predicate: [predicate_id]`
- `[OPERATION_EXECUTING] Contract: [contract_id] Target: [operation_name]`
- `[POSTCONDITIONS_VERIFIED] Contract: [contract_id] Count: [count] Verdict: [PASS | FAIL]`
- `[POSTCONDITION_FAILED] Contract: [contract_id] Predicate: [predicate_id]`
- `[INVARIANTS_VERIFIED] Contract: [contract_id] Verdict: [PASS | FAIL]`
- `[INVARIANT_VIOLATION] Contract: [contract_id] Invariant: [invariant_id]`
- `=== CONTRACT FULFILLED: [contract_id] Op: [operation_name] Status: CERTIFIED ===`
- `=== CONTRACT BREACHED: [contract_id] Code: [violation_code] ===`

### 7.2. Defect Codes
- `PRECONDITION_FAILED`: One or more preconditions evaluated to FALSE prior to execution.
- `POSTCONDITION_FAILED`: Generated output failed to satisfy postcondition assertions.
- `INVARIANT_VIOLATION`: System invariant was corrupted during operation execution.
- `UNCONTRACTED_OPERATION_DETECTED`: Operation attempted without a declared contract definition.
- `CONTRACT_EVALUATION_ERROR`: Syntax error or missing variable while evaluating contract expression.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Precondition Failure Stops Bad Execution
**Contract**: `dbc-file-write`
- `requires`:
  1. `PRE-1`: `file_path.endswith(".json") == True`
  2. `PRE-2`: `os.path.exists(parent_dir(file_path)) == True`
- Execution:
  1. Caller attempts write with `file_path = "/nonexistent/dir/config.yaml"`.
  2. Evaluation of `PRE-1` fails (`config.yaml` does not end with `.json`).
  3. Coordinator immediately halts before filesystem access.
  4. Telemetry: `[PRECONDITION_FAILED] Contract: dbc-file-write Predicate: PRE-1`.
  5. `DbcDefectReport` emitted with `violation_code: PRECONDITION_FAILED`.
  6. Disk remains untouched.

### 8.2. Scenario 2: Successful Contract Fulfillment
**Contract**: `dbc-build-artifact`
- `requires`: `git_status == clean`, `toolchain == ready`
- `ensures`: `artifact_size > 1024`, `exit_code == 0`
- `invariants`: `src_checksums == unchanged`
- Execution:
  1. Preconditions pass (clean git, toolchain ready).
  2. Baseline snapshot of `src/` computed.
  3. Build command executes; exits code 0, artifact size = 45000 bytes.
  4. Postconditions evaluated: `artifact_size > 1024` (PASS), `exit_code == 0` (PASS).
  5. Invariant check: `src/` checksums compared with baseline; 100% match.
  6. Final marker: `=== CONTRACT FULFILLED: dbc-build-artifact Op: make_build Status: CERTIFIED ===`.

### 8.3. Scenario 3: Postcondition Breach and Dirty State Rollback
**Contract**: `dbc-gen-report`
- `requires`: `input_template_valid == True`
- `ensures`: `output_file_exists == True`, `output_file_size > 0`
- `invariants`: `config_files == unchanged`
- Execution:
  1. Preconditions evaluate to PASS.
  2. Operation executes and generates `report.pdf`.
  3. Postcondition evaluation finds `report.pdf` has size 0 bytes.
  4. Telemetry: `[POSTCONDITION_FAILED] Contract: dbc-gen-rep Predicate: POST-NON-EMPTY`.
  5. Coordinator triggers compensating rollback: deletes empty `report.pdf`.
  6. `DbcDefectReport` emitted with `violation_code: POSTCONDITION_FAILED`.
  7. State transitions to `POST_BREACH_HALT`; zero dirty state remains.

### 8.4. Scenario 4: Invariant Violation Triggers Emergency Restoration
**Contract**: `dbc-batch-cleanup`
- `requires`: `disk_usage_above_threshold == True`
- `ensures`: `temp_files_count == 0`
- `invariants`: `protected_data_dirs_checksum == unchanged`
- Execution:
  1. Preconditions evaluate to PASS; baseline snapshot recorded.
  2. Cleanup operation purges temp files, but inadvertently writes a log file into protected data directory.
  3. Postconditions evaluate to PASS.
  4. Invariant check detects sha256 checksum discrepancy in protected data directory.
  5. Telemetry: `[INVARIANT_VIOLATION] Contract: dbc-batch-clean Invariant: INV-DATA-PROTECTED`.
  6. Coordinator triggers emergency rollback from backup snapshot.
  7. `DbcDefectReport` emitted with `violation_code: INVARIANT_VIOLATION`.
  8. State transitions to `INVARIANT_BREACH`.
