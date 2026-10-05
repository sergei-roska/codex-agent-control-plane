---
name: fork-join
description: A software engineering skill implementing the Fork-Join and Barrier Synchronization pattern for parallel subagent execution and asynchronous batch processing. Spawns concurrent worker branches, blocks at an explicit barrier until resolution or timeout, and deterministically merges outputs in initial branch sequence order.
---

# Fork-Join & Barrier Synchronization (fork-join)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
When an orchestrator must execute a collection of independent tasks concurrently across multiple subagents or background worker processes, naive parallelism causes catastrophic synchronization defects:
1. **Non-Deterministic Arrival Order Scrambling**: Subagent A finishes in 2 seconds, Subagent B finishes in 10 seconds, and Subagent C finishes in 4 seconds. Naively appending outputs in arrival order scrambles document chapters, code patches, or analysis tables non-deterministically across runs.
2. **Infinite Orchestrator Hangs**: A single hanging worker or deadlocked tool holds the orchestrator indefinitely in an open wait loop without timeout or cancellation primitives.
3. **Premature Barrier Release**: The orchestrator advances to downstream synthesis phases before 100% of workers have completed, causing downstream agents to operate on partial or corrupted data.
4. **Uncoordinated Zombie Workers**: When a batch job fails or times out, orphaned background subagents continue running, consuming CPU, memory, and LLM token budgets in the background.

### 1.2. Scope & Behavioral Boundaries
The `fork-join` pattern establishes rigid barrier synchronization semantics:
- **Fork Phase**: Decomposes an input collection into M orthogonal tasks, mints indexed branch descriptors (`branch-1`..`branch-M`), and dispatches them concurrently up to configured `max_concurrency`.
- **Barrier Wait Phase**: The orchestrator blocks at an explicit **Synchronization Barrier**. A countdown latch monitors all worker branches until all terminate.
- **Timeout & Cancellation**: A bounded `barrier_timeout_ms` prevents infinite waiting. If timeout occurs, all in-flight workers are immediately cancelled and marked `TIMED_OUT`.
- **Deterministic Join Phase**: Results are gathered and sorted strictly according to the initial input sequence (1..M), guaranteeing identical output ordering across runs regardless of arrival timing.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Parallel batch file processing, independent unit test execution, or multi-chapter document synthesis.
- Spawning a squad of specialist subagents to evaluate independent aspects of a codebase concurrently.
- Operations requiring an explicit synchronization barrier before advancing to downstream stages.
- Explicit keywords: "fork join", "barrier synchronization", "parallel subagent execution", "spawn and await all", "concurrent branch aggregation".

### 2.2. Negative Triggers
- Strictly sequential pipelines where task N depends directly on intermediate outputs of task N-1 (use `serial-item-processor` or `pipes-and-filters`).
- Long-lived persistent actors communicating via peer-to-peer message passing (use `actor-model`).
- Single-threaded atomic file operations.

---

## 3. Invariants & Non-Negotiable Rules

1. **BARRIER_SYNCHRONIZATION_LOCK = MANDATORY**: The orchestrator must block at the barrier until 100% of branches have terminated (`SUCCESS`, `FAILED`, or `CANCELLED`). Advancing early triggers fatal defect `BARRIER_PREMATURE_RELEASE`.
2. **INDEX_PRESERVING_JOIN = MANDATORY**: The consolidated output must assemble branch outputs in strict ascending order of original branch index (1, 2, ... M). Arrival timing must never alter output topology.
3. **BOUNDED_BARRIER_TIMEOUT = MANDATORY**: A barrier must never wait indefinitely. When `barrier_timeout_ms` expires, in-flight workers must be reaped and marked `TIMED_OUT`.
4. **TASK_ORTHOGONALITY = MANDATORY**: Forked branches must be mutually independent with zero shared mutable state or cross-branch dependencies.
5. **DETERMINISTIC_ERROR_POLICY = MANDATORY**: The orchestrator must enforce an explicit policy on branch failure: `FAIL_ALL_ON_ANY_ERROR`, `COLLECT_PARTIAL_RESULTS`, or `QUORUM_THRESHOLD`.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Fork-Join Configuration Schema (`ForkJoinConfig`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ForkJoinConfig",
  "type": "object",
  "required": ["batch_id", "barrier_timeout_ms", "error_policy", "aggregation_strategy"],
  "properties": {
    "batch_id": { "type": "string", "pattern": "^batch-[a-zA-Z0-9_-]+$" },
    "max_concurrency": { "type": "integer", "minimum": 1, "default": 8 },
    "barrier_timeout_ms": { "type": "integer", "minimum": 500, "default": 60000 },
    "error_policy": {
      "type": "string",
      "enum": ["FAIL_ALL_ON_ANY_ERROR", "COLLECT_PARTIAL_RESULTS", "QUORUM_THRESHOLD"]
    },
    "quorum_percentage": { "type": "number", "minimum": 0.0, "maximum": 1.0, "default": 1.0 },
    "aggregation_strategy": {
      "type": "string",
      "enum": ["ORDERED_LIST_CONCAT", "KEY_MERGE", "MONOIDAL_REDUCE"]
    }
  },
  "additionalProperties": false
}
```

### 4.2. Fork Branch Descriptor & Result Schema (`BranchExecutionResult`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BranchExecutionResult",
  "type": "object",
  "required": [
    "branch_index",
    "branch_id",
    "status",
    "execution_time_ms",
    "timestamp_completed_utc"
  ],
  "properties": {
    "branch_index": { "type": "integer", "minimum": 1 },
    "branch_id": { "type": "string" },
    "worker_id": { "type": "string" },
    "status": { "type": "string", "enum": ["SUCCESS", "FAILED", "TIMED_OUT", "CANCELLED"] },
    "output_payload": { "type": ["object", "string", "null"] },
    "error_message": { "type": ["string", "null"] },
    "execution_time_ms": { "type": "integer", "minimum": 0 },
    "timestamp_completed_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. Fork-Join Defect Report Schema (`ForkJoinDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ForkJoinDefectReport",
  "type": "object",
  "required": ["defect_id", "batch_id", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "batch_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "BARRIER_TIMEOUT_EXPIRED",
        "BARRIER_PREMATURE_RELEASE",
        "BRANCH_EXECUTION_FAILURE",
        "NON_ORTHOGONAL_TASKS_DETECTED",
        "JOIN_REDUCTION_ERROR",
        "WORKER_CANCEL_FAILED"
      ]
    },
    "failed_branches": { "type": "array", "items": { "type": "integer" } },
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
       |   UNINITIALIZED    |
       +--------------------+
                 |
                 | Event: INGEST_TASKS (Validate orthogonality, assign 1..M)
                 v
       +--------------------+
       |     FORKING        |
       +--------------------+
                 |
                 | Event: DISPATCH_ALL (Spawn M workers concurrently)
                 v
       +--------------------+
+----->|  BARRIER_WAITING   |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: BRANCH_RESOLVED (Worker finishes)|
|                v                                         |
|      +--------------------+                              |
|      | COUNTDOWN_LATCH    |                              |
|      +--------------------+                              |
|                |                                         |
|                | Pending > 0 AND Elapsed < Timeout       |
|                +-----------------------------------------+
|
| All Resolved OR Timeout Expired
v
+--------------------+
|  EVAL_COMPLETION   |
+--------------------+
  /                 / Policy Satisfied \ Policy Failed (or Timeout Breach)
v                    v
+--------------------+  +--------------------+
|   JOINING_REDUCE   |  |   CANCEL_IN_FLIGHT |
+--------------------+  +--------------------+
  |                       |
  | Order 1..M reduction  | Harvest partials, mark fail
  v                       v
+--------------------+  +--------------------+
|     COMPLETED      |  |      FAILED        |
+--------------------+  +--------------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `UNINITIALIZED` | `INGEST_TASKS` | Tasks count >= 1 AND orthogonal | `FORKING` | Assign `branch_index = 1..M`; initialize latch = M. |
| `FORKING` | `DISPATCH_ALL` | Worker pool ready | `BARRIER_WAITING` | Concurrently spawn M branch tasks; start barrier timer. |
| `BARRIER_WAITING` | `BRANCH_COMPLETED` | remaining_branches > 0 | `BARRIER_WAITING` | Store result at `results[branch_index]`; decrement latch. |
| `BARRIER_WAITING` | `ALL_COMPLETED` | remaining_branches == 0 | `EVAL_COMPLETION` | Stop barrier timer; evaluate batch success policy. |
| `BARRIER_WAITING` | `TIMEOUT_EXPIRED` | elapsed_time >= barrier_timeout_ms | `CANCEL_IN_FLIGHT` | Send cancel signal to remaining workers; mark `TIMED_OUT`. |
| `CANCEL_IN_FLIGHT`| `REAP_COMPLETE` | All workers acknowledged or killed | `EVAL_COMPLETION` | Gather final status matrix; emit `BARRIER_TIMEOUT_EXPIRED`. |
| `EVAL_COMPLETION` | `POLICY_MET` | Success rate satisfies error_policy | `JOINING_REDUCE` | Sort results by `branch_index` (1..M); execute aggregation. |
| `EVAL_COMPLETION` | `POLICY_BREACH` | Error policy violated | `FAILED` | Emit `BRANCH_EXECUTION_FAILURE` Defect Report; halt. |
| `JOINING_REDUCE` | `REDUCE_DONE` | Composite output schema valid | `COMPLETED` | Emit final consolidated artifact and branch execution table. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Ingestion & Fork Preparation
1. Ingest input task list `T = [t_1, t_2, ... t_M]`.
2. Verify task orthogonality:
   - Ensure distinct target files, parameters, or isolated subagent contexts.
   - Assert zero shared mutable variables.
   - If collisions detected, emit `NON_ORTHOGONAL_TASKS_DETECTED` and halt.
3. Assign deterministic branch metadata:
   - For `i = 1 to M`: `task[i].branch_index = i`, `task[i].branch_id = "branch-" + str(i)`.
4. Initialize synchronization latch: `latch = M`, `results = array_of_size(M)`.
5. Transition state to `FORKING`.
6. Emit log marker: `=== FORK-JOIN DISPATCH INITIALIZED: Batch: [batch_id] Branches: [M] ===`.

### Step 2: Concurrent Fork Dispatch
1. For each `task[i]` in parallel (up to `max_concurrency`):
   - Spawn subagent or background execution worker.
   - Record worker process/task handle.
   - Emit log marker: `[BRANCH_DISPATCHED] BranchIndex: [i] WorkerId: [worker_id]`.
2. Record `start_time = now()`.
3. Transition state to `BARRIER_WAITING`.

### Step 3: Synchronization Barrier Loop
1. Orchestrator enters blocking wait on synchronization latch.
2. As each worker completes:
   - Capture `output_payload`, `error_message`, and `status`.
   - Store record: `results[branch_index] = BranchExecutionResult(...)`.
   - Decrement `latch -= 1`.
   - Emit log marker: `[BRANCH_RESOLVED] BranchIndex: [i] Status: [status] DurationMs: [ms]`.
3. Monitor elapsed time:
   - IF `now() - start_time >= barrier_timeout_ms`:
     - Transition state to `CANCEL_IN_FLIGHT`.
     - For all branches where `results[branch_index]` is missing:
       - Issue cancel/kill signal to worker.
       - Store: `results[branch_index] = BranchExecutionResult(status="TIMED_OUT")`.
     - Emit log marker: `[BARRIER_TIMEOUT] Batch: [batch_id] StragglersCancelled: [count]`.
     - Transition state to `EVAL_COMPLETION`.
     - Break barrier loop.
4. When `latch == 0`:
   - Stop barrier timer.
   - Transition state to `EVAL_COMPLETION`.

### Step 4: Completion Policy Evaluation
1. Count statuses:
   - `success_count = count(results, status="SUCCESS")`
   - `failure_count = count(results, status in ["FAILED", "TIMED_OUT", "CANCELLED"])`
2. Evaluate `error_policy`:
   - **FAIL_ALL_ON_ANY_ERROR**:
     - IF `failure_count > 0`:
       - Emit Defect Report: `BRANCH_EXECUTION_FAILURE`.
       - Transition state to `FAILED`. Halt.
   - **QUORUM_THRESHOLD**:
     - IF `(success_count / M) < quorum_percentage`:
       - Emit Defect Report: `BRANCH_EXECUTION_FAILURE`.
       - Transition state to `FAILED`. Halt.
   - **COLLECT_PARTIAL_RESULTS**:
     - Allow progression to Step 5 with available successful outputs.
3. Transition state to `JOINING_REDUCE`.

### Step 5: Deterministic Join & Output Reduction
1. Iterate through `results` strictly in ascending order of `branch_index` (1, 2, ... M).
2. Emit log marker: `[JOIN_AGGREGATION_START] Strategy: [strategy] OutputCount: [count]`.
3. Apply `aggregation_strategy`:
   - **ORDERED_LIST_CONCAT**: Append payload into flat array: `[r_1.payload, r_2.payload, ... r_M.payload]`.
   - **KEY_MERGE**: Merge dictionaries using key prefixing: `{r_1.key: r_1.val, ...}`.
   - **MONOIDAL_REDUCE**: Sequentially fold child payloads with declared binary operator: `reduce(combine_func, payloads)`.
   - IF error occurs during reduction: emit `JOIN_REDUCTION_ERROR` and transition to `FAILED`. Halt.
4. Generate final consolidated artifact.
5. Calculate composite SHA-256 hash.
6. Transition state to `COMPLETED`.
7. Emit log marker: `=== FORK-JOIN BATCH COMPLETED: Batch: [batch_id] Checksum: [sha256] ===`.
8. Return consolidated output and branch execution telemetry table.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== FORK-JOIN DISPATCH INITIALIZED: Batch: [batch_id] Branches: [count] ===`
- `[BRANCH_DISPATCHED] BranchIndex: [idx] WorkerId: [worker_id]`
- `[BRANCH_RESOLVED] BranchIndex: [idx] Status: [status] DurationMs: [ms]`
- `[BARRIER_TIMEOUT] Batch: [batch_id] StragglersCancelled: [count]`
- `[JOIN_AGGREGATION_START] Strategy: [strategy] OutputCount: [count]`
- `=== FORK-JOIN BATCH COMPLETED: Batch: [batch_id] Checksum: [sha256] ===`

### 7.2. Defect Codes
- `BARRIER_TIMEOUT_EXPIRED`: Barrier wait exceeded `barrier_timeout_ms` before all branches completed.
- `BARRIER_PREMATURE_RELEASE`: Orchestrator continued to join phase while latch > 0.
- `BRANCH_EXECUTION_FAILURE`: A branch failed under `FAIL_ALL_ON_ANY_ERROR` or `QUORUM_THRESHOLD` policy.
- `NON_ORTHOGONAL_TASKS_DETECTED`: Tasks share colliding target paths or shared mutable references.
- `JOIN_REDUCTION_ERROR`: Error during ordered aggregation of branch payloads.
- `WORKER_CANCEL_FAILED`: Inability to kill or reap a timed-out worker process.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Parallel Linter Across 3 Packages
**Input Configuration:**
```json
{
  "batch_id": "batch-lint-001",
  "max_concurrency": 4,
  "barrier_timeout_ms": 30000,
  "error_policy": "FAIL_ALL_ON_ANY_ERROR",
  "aggregation_strategy": "ORDERED_LIST_CONCAT"
}
```

**Execution Trace:**
```text
=== FORK-JOIN DISPATCH INITIALIZED: Batch: batch-lint-001 Branches: 3 ===
[BRANCH_DISPATCHED] BranchIndex: 1 WorkerId: worker-core
[BRANCH_DISPATCHED] BranchIndex: 2 WorkerId: worker-api
[BRANCH_DISPATCHED] BranchIndex: 3 WorkerId: worker-utils
[BRANCH_RESOLVED] BranchIndex: 2 Status: SUCCESS DurationMs: 120
[BRANCH_RESOLVED] BranchIndex: 1 Status: SUCCESS DurationMs: 350
[BRANCH_RESOLVED] BranchIndex: 3 Status: SUCCESS DurationMs: 410
[JOIN_AGGREGATION_START] Strategy: ORDERED_LIST_CONCAT OutputCount: 3
=== FORK-JOIN BATCH COMPLETED: Batch: batch-lint-001 Checksum: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ===
```

**Branch Execution Telemetry Table:**
| BRANCH_INDEX | BRANCH_ID | STATUS | DURATION_MS | ERROR |
|---|---|---|---|---|
| 1 | branch-1 | SUCCESS | 350 | - |
| 2 | branch-2 | SUCCESS | 120 | - |
| 3 | branch-3 | SUCCESS | 410 | - |

Output assembled strictly in ascending branch index order: `[Result_1, Result_2, Result_3]`.

### 8.2. Scenario 2: Straggler Worker Timed Out and Cancelled
**Input Configuration:**
```json
{
  "batch_id": "batch-fetch-002",
  "max_concurrency": 4,
  "barrier_timeout_ms": 5000,
  "error_policy": "COLLECT_PARTIAL_RESULTS",
  "aggregation_strategy": "ORDERED_LIST_CONCAT"
}
```

**Execution Trace:**
```text
=== FORK-JOIN DISPATCH INITIALIZED: Batch: batch-fetch-002 Branches: 4 ===
[BRANCH_DISPATCHED] BranchIndex: 1 WorkerId: fetcher-1
[BRANCH_DISPATCHED] BranchIndex: 2 WorkerId: fetcher-2
[BRANCH_DISPATCHED] BranchIndex: 3 WorkerId: fetcher-3
[BRANCH_DISPATCHED] BranchIndex: 4 WorkerId: fetcher-4
[BRANCH_RESOLVED] BranchIndex: 1 Status: SUCCESS DurationMs: 1200
[BRANCH_RESOLVED] BranchIndex: 2 Status: SUCCESS DurationMs: 1800
[BRANCH_RESOLVED] BranchIndex: 4 Status: SUCCESS DurationMs: 1950
[BARRIER_TIMEOUT] Batch: batch-fetch-002 StragglersCancelled: 1
[JOIN_AGGREGATION_START] Strategy: ORDERED_LIST_CONCAT OutputCount: 3
=== FORK-JOIN BATCH COMPLETED: Batch: batch-fetch-002 Checksum: a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e ===
```

**Branch Execution Telemetry Table:**
| BRANCH_INDEX | BRANCH_ID | STATUS | DURATION_MS | ERROR |
|---|---|---|---|---|
| 1 | branch-1 | SUCCESS | 1200 | - |
| 2 | branch-2 | SUCCESS | 1800 | - |
| 3 | branch-3 | TIMED_OUT | 5000 | Barrier timeout expired (5000ms) |
| 4 | branch-4 | SUCCESS | 1950 | - |

### 8.3. Scenario 3: Quorum Threshold Evaluation
**Input Configuration:**
```json
{
  "batch_id": "batch-audit-003",
  "max_concurrency": 5,
  "barrier_timeout_ms": 10000,
  "error_policy": "QUORUM_THRESHOLD",
  "quorum_percentage": 0.8,
  "aggregation_strategy": "KEY_MERGE"
}
```

**Execution Trace:**
```text
=== FORK-JOIN DISPATCH INITIALIZED: Batch: batch-audit-003 Branches: 5 ===
[BRANCH_DISPATCHED] BranchIndex: 1 WorkerId: auditor-1
[BRANCH_DISPATCHED] BranchIndex: 2 WorkerId: auditor-2
[BRANCH_DISPATCHED] BranchIndex: 3 WorkerId: auditor-3
[BRANCH_DISPATCHED] BranchIndex: 4 WorkerId: auditor-4
[BRANCH_DISPATCHED] BranchIndex: 5 WorkerId: auditor-5
[BRANCH_RESOLVED] BranchIndex: 1 Status: SUCCESS DurationMs: 220
[BRANCH_RESOLVED] BranchIndex: 2 Status: SUCCESS DurationMs: 250
[BRANCH_RESOLVED] BranchIndex: 3 Status: SUCCESS DurationMs: 310
[BRANCH_RESOLVED] BranchIndex: 4 Status: SUCCESS DurationMs: 290
[BRANCH_RESOLVED] BranchIndex: 5 Status: FAILED DurationMs: 180
[JOIN_AGGREGATION_START] Strategy: KEY_MERGE OutputCount: 4
=== FORK-JOIN BATCH COMPLETED: Batch: batch-audit-003 Checksum: c2b7f33d7b81b2382101344400cf67cf92305a463e260907d8b5252b47372225 ===
```