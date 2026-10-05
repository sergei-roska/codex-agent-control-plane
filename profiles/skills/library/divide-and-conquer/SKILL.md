---
name: divide-and-conquer
description: Recursively decomposes complex, high-entropy tasks into independent, non-overlapping subproblems until reaching an atomic base-case threshold, executes deterministic resolution, and merges solutions bottom-up into a verified composite result.
---

# Recursive Divide-and-Conquer (divide-and-conquer)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
When an autonomous agent is confronted with a massive, high-entropy problem (e.g., refactoring a 20-module codebase, auditing 100 API endpoints, or synthesizing a multi-chapter technical specification), attempting monolithic resolution in a single pass triggers severe cognitive failures:
1. **Context Window Exhaustion & Attention Drift**: The LLM loses track of earlier requirements, forgets critical edge cases, and produces superficial or truncated outputs.
2. **Combinatorial State Explosion**: Interdependent variables create too many permutations for single-step reasoning, leading to hallucinated shortcuts.
3. **Unbounded Recursive Sprawl**: Without a formal base-case threshold, recursive decomposition routines spawn infinite subtasks and nested loops, burning execution budgets.
4. **Incoherent Merging**: Splitting a task without formal partition boundaries results in overlapping, conflicting sub-artifacts that cannot be cleanly stitched back together.

### 1.2. Scope & Behavioral Boundaries
The `divide-and-conquer` pattern enforces rigid, deterministic recursive decomposition:
- **Divide**: Analyzes problem entropy and size. If the problem exceeds the **Base-Case Threshold**, it is partitioned into `K` orthogonal, disjoint, non-overlapping subproblems.
- **Conquer**: When a subproblem reaches the atomic base-case threshold, it is solved directly and deterministically without further decomposition.
- **Combine**: Bottom-up aggregation merges child resolutions strictly according to declared associative reduction rules (e.g., topological merge, monoidal union, ordered concatenation).
- **Depth Bound**: Enforces a strict maximum recursion depth (`max_depth = 3`) to bound cognitive tree complexity.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Complex architectural refactorings spanning multiple disjoint modules or layers.
- Large-scale document or codebase generation requiring recursive section breakdown.
- Multi-component audits where individual units can be inspected independently.
- Keywords: "divide and conquer", "recursive task decomposition", "partition into atomic subtasks", "bottom-up solution merge", "hierarchical decomposition".

### 2.2. Negative Triggers
- Inherently sequential workflows where step N strictly requires the final output of step N-1 (`pipes-and-filters` or `serial-item-processor`).
- Iterative state convergence tasks better suited for a `finite-state-machine`.
- Simple linear scripts or atomic single-file edits.

---

## 3. Invariants & Non-Negotiable Rules

1. **DETERMINISTIC_BASE_CASE = MANDATORY**: Every branch must evaluate an explicit predicate `is_base_case(subproblem)`. If `TRUE`, decomposition ceases immediately and the atomic solver is invoked.
2. **MAXIMUM_RECURSION_DEPTH = MANDATORY**: Recursion depth must never exceed `max_depth` (default: 3). If `current_depth == max_depth`, the subproblem is forced into base-case execution. Violation code: `MAX_DEPTH_EXCEEDED`.
3. **ORTHOGONAL_PARTITIONING = MANDATORY**: Subproblems must be mathematically disjoint:
   `Intersection(Scope(Subproblem[i]), Scope(Subproblem[j])) == EMPTY for all i != j`. Violation code: `PARTITION_OVERLAP_DETECTED`.
4. **ASSOCIATIVE_DETERMINISTIC_MERGE = MANDATORY**: The combine operator must be well-defined and deterministic, guaranteeing reproducible outputs regardless of worker completion order. Violation code: `MERGE_CONFLICT_UNRESOLVED`.
5. **ZERO_ORPHAN_SUBPROBLEMS = MANDATORY**: Every partitioned subproblem must be accounted for in the composite merge. Dropped or missing leaf outputs trigger `COMPOSITE_VALIDATION_FAILED`.
6. **STRICT_ASCII_ONLY = MANDATORY**: All generated artifacts, telemetry markers, defect reports, and schemas must use strictly 7-bit ASCII characters.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Decomposition Node Schema (`SubProblemNode`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SubProblemNode",
  "type": "object",
  "required": [
    "node_id",
    "parent_id",
    "depth",
    "scope_boundary",
    "is_atomic",
    "status"
  ],
  "properties": {
    "node_id": { "type": "string", "pattern": "^node-[0-9a-fA-F-]+$" },
    "parent_id": { "type": ["string", "null"] },
    "depth": { "type": "integer", "minimum": 0, "maximum": 3 },
    "scope_boundary": {
      "type": "object",
      "required": ["entity_type", "identifiers"],
      "properties": {
        "entity_type": { "type": "string" },
        "identifiers": { "type": "array", "items": { "type": "string" } }
      },
      "additionalProperties": false
    },
    "is_atomic": { "type": "boolean" },
    "payload": { "type": "object", "additionalProperties": true },
    "status": { "type": "string", "enum": ["PENDING", "DIVIDED", "CONQUERED", "MERGED", "FAILED"] }
  },
  "additionalProperties": false
}
```

### 4.2. Composite Merge Result Schema (`CompositeMergeResult`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CompositeMergeResult",
  "type": "object",
  "required": [
    "root_id",
    "total_leaf_nodes",
    "conquered_leaf_nodes",
    "merge_strategy",
    "composite_artifact",
    "integrity_checksum",
    "merged_at_utc"
  ],
  "properties": {
    "root_id": { "type": "string" },
    "total_leaf_nodes": { "type": "integer", "minimum": 1 },
    "conquered_leaf_nodes": { "type": "integer", "minimum": 1 },
    "merge_strategy": { "type": "string", "enum": ["ORDERED_CONCATENATION", "STRUCTURAL_UNION", "TOPOLOGICAL_JOIN"] },
    "composite_artifact": { "type": "object", "additionalProperties": true },
    "integrity_checksum": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "merged_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. Divide-and-Conquer Defect Report (`DacDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DacDefectReport",
  "type": "object",
  "required": ["defect_id", "node_id", "depth", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "node_id": { "type": "string" },
    "depth": { "type": "integer" },
    "violation_code": {
      "type": "string",
      "enum": [
        "MAX_DEPTH_EXCEEDED",
        "PARTITION_OVERLAP_DETECTED",
        "BASE_CASE_EXECUTION_FAILURE",
        "MERGE_CONFLICT_UNRESOLVED",
        "COMPOSITE_VALIDATION_FAILED",
        "ZERO_SUBPROBLEMS_GENERATED"
      ]
    },
    "error_message": { "type": "string" },
    "subproblem_context": { "type": ["object", "null"] },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal State Machine

```text
       +--------------------+
       |     INGESTION      |
       +--------------------+
                 |
                 | Event: EVALUATE_SIZE
                 v
       +--------------------+
       |   CHECK_ATOMICITY  |
       +--------------------+
         /                  \
        / is_atomic == TRUE  \ is_atomic == FALSE AND depth < 3
       v                      v
+---------------+     +---------------+
| CONQUER_LEAF  |     | DIVIDE_NODE   |
+---------------+     +---------------+
       |                    |
       | Leaf solved        | Subproblems generated
       |                    v
       |              +---------------+
       |              | DISPATCH_SUBS |
       |              +---------------+
       |                    |
       |                    | (Recursive resolution of children)
       |                    v
       |              +---------------+
       +------------->| COMBINE_MERGE |
                      +---------------+
                            |
                            | All children merged
                            v
                      +---------------+
                      | VERIFY_RESULT |
                      +---------------+
                            |
                            | Validation PASS
                            v
                      +---------------+
                      |   COMPLETED   |
                      +---------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `INGESTION` | `INIT_NODE` | Problem payload valid | `CHECK_ATOMICITY` | Set `depth = parent_depth + 1`. Evaluate base case rules. |
| `CHECK_ATOMICITY` | `EVALUATE` | problem_size <= base_case_threshold OR depth >= max_depth | `CONQUER_LEAF` | Mark `is_atomic = TRUE`. Prepare atomic solver. |
| `CHECK_ATOMICITY` | `EVALUATE` | problem_size > base_case_threshold AND depth < max_depth | `DIVIDE_NODE` | Partition problem into `K` disjoint subproblems. |
| `DIVIDE_NODE` | `PARTITION_DONE` | K >= 2 AND partitions non-overlapping | `DISPATCH_SUBS` | Instantiate child `SubProblemNode`s with `parent_id = node_id`. |
| `DIVIDE_NODE` | `PARTITION_DONE` | Overlap detected OR K < 2 | `FAILED` | Emit `PARTITION_OVERLAP_DETECTED` Defect Report; halt. |
| `CONQUER_LEAF` | `SOLVE_ATOMIC` | Atomic execution succeeds | `COMBINE_MERGE` | Emit verified leaf artifact; mark status `CONQUERED`. |
| `CONQUER_LEAF` | `SOLVE_ATOMIC` | Execution throws exception | `FAILED` | Emit `BASE_CASE_EXECUTION_FAILURE` Defect Report; halt. |
| `DISPATCH_SUBS`| `CHILDREN_RESOLVED`| 100% of child nodes have status CONQUERED | `COMBINE_MERGE` | Gather child outputs in declared sequence order. |
| `COMBINE_MERGE`| `EXECUTE_MERGE`| Merge operator succeeds without conflict | `VERIFY_RESULT` | Synthesize composite artifact; calculate integrity checksum. |
| `VERIFY_RESULT`| `VALIDATION_PASS`| Composite satisfies original problem requirements | `COMPLETED` | Return verified composite result up the tree. |
| `VERIFY_RESULT`| `VALIDATION_FAIL`| Composite missing elements or malformed | `FAILED` | Emit `COMPOSITE_VALIDATION_FAILED`; halt. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Ingestion & Complexity Assessment
1. Ingest problem payload `P` at current recursion depth `depth` (initially `0`).
2. Evaluate `is_base_case(P)`:
   - Check atomic criteria (e.g., lines of code <= 150, single class/module, single endpoint).
   - Check depth constraint: `IF depth >= 3: is_base_case = TRUE`.
3. IF `is_base_case == TRUE`:
   - Proceed directly to Step 3 (Conquer Atomic Base Case).
4. ELSE:
   - Proceed to Step 2 (Recursive Divide).

### Step 2: Recursive Divide Phase
1. Select partitioning dimension (e.g., architectural layer, file boundary, endpoint cluster).
2. Decompose `P` into `K` subproblems: `[P_1, P_2, ... P_K]`.
3. Validate orthogonal partitioning:
   - Assert `Scope(P_i) intersected with Scope(P_j) == EMPTY` for all `i != j`.
   - IF overlap detected:
     - Emit Defect Report: `PARTITION_OVERLAP_DETECTED`.
     - Transition state to `FAILED` and halt execution.
4. For each subproblem `P_i`:
   - Mint child node `node_i` with `depth = current_depth + 1`.
   - Recursively call `execute_divide_and_conquer(P_i, depth + 1)`.
5. Await completion of all `K` child subproblems.
6. IF any child returns `FAILED`:
   - Emit Defect Report: `CHILD_BRANCH_FAILED`.
   - Halt execution.
7. Proceed to Step 4 (Bottom-Up Combine Phase).

### Step 3: Conquer Atomic Base Case
1. Transition state to `CONQUER_LEAF`.
2. Invoke atomic deterministic solver on base-case node.
3. Validate that atomic output satisfies base-case acceptance criteria.
4. IF solver fails:
   - Emit Defect Report: `BASE_CASE_EXECUTION_FAILURE`.
   - Transition state to `FAILED` and halt execution.
5. Return solved leaf artifact `A_leaf`.

### Step 4: Bottom-Up Combine Phase
1. Transition state to `COMBINE_MERGE`.
2. Collect child artifacts `[A_1, A_2, ... A_K]` preserving initial partition index ordering.
3. Apply declared `merge_strategy`:
   - **ORDERED_CONCATENATION**: Stitch sections in strict sequence 1..K.
   - **STRUCTURAL_UNION**: Merge disjoint dictionary keys or AST nodes.
   - **TOPOLOGICAL_JOIN**: Link interdependent nodes along declared interface edges.
4. Verify composite integrity:
   - Check that all original problem requirements are covered.
   - Verify no duplicate identifiers or contradictory definitions.
5. Calculate composite SHA-256 checksum.
6. Emit log marker: `=== NODE MERGED: [node_id] Depth: [depth] Children: [K] ===`.
7. Return `CompositeMergeResult` to parent caller.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== DIVIDE-AND-CONQUER INITIALIZED: Root: [root_id] ===`
- `[NODE_EVALUATION] Node: [node_id] Depth: [depth] IsAtomic: [TRUE | FALSE]`
- `[NODE_PARTITIONED] Node: [node_id] Subproblems: [count] Depth: [depth]`
- `[LEAF_CONQUERED] Node: [node_id] Depth: [depth] DurationMs: [ms]`
- `=== NODE MERGED: [node_id] Depth: [depth] Children: [count] ===`
- `[COMPOSITE_VERIFIED] Root: [root_id] Checksum: [sha256]`

### 7.2. Defect Codes
- `MAX_DEPTH_EXCEEDED`: Recursion attempted beyond configured depth ceiling (3).
- `PARTITION_OVERLAP_DETECTED`: Decomposed subproblems share mutable scope or colliding IDs.
- `BASE_CASE_EXECUTION_FAILURE`: Atomic leaf solver threw an uncaught error.
- `MERGE_CONFLICT_UNRESOLVED`: Collision or inconsistency during bottom-up combine.
- `COMPOSITE_VALIDATION_FAILED`: Merged composite failed top-level validation requirements.
- `ZERO_SUBPROBLEMS_GENERATED`: Partitioning routine produced empty child set.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Multi-Module Code Audit
**Input**: Comprehensive security audit of 4 modules (`auth`, `billing`, `api`, `storage`).
- `depth = 0`: Monolithic problem (4 modules > base threshold of 1 module). `is_base_case = FALSE`.
- **Divide**: Partition into 4 disjoint subproblems:
  - Node 1: Audit `auth` (depth 1)
  - Node 2: Audit `billing` (depth 1)
  - Node 3: Audit `api` (depth 1)
  - Node 4: Audit `storage` (depth 1)
- **Conquer**:
  - Each Node 1..4 is atomic (1 module). Solved independently in sequence.
  - Leaves emit 4 structured vulnerability tables.
- **Combine**:
  - Merge strategy: `ORDERED_CONCATENATION`.
  - Composite report synthesized with unified executive summary and deduplicated risk matrix.
  - Telemetry marker: `=== NODE MERGED: root Depth: 0 Children: 4 ===`.

### 8.2. Scenario 2: Large-Scale API Specification Decomposition
**Input**: Authoring OpenAPI spec for 20 endpoints split across `users`, `orders`, and `inventory`.
- `depth = 0`: 20 endpoints > base threshold (5 endpoints). `is_base_case = FALSE`.
- **Divide**: Partition into 3 domain clusters:
  - Cluster 1: `users` (depth 1, 6 endpoints > threshold -> sub-partitioned into read and write at depth 2)
  - Cluster 2: `orders` (depth 1, 8 endpoints > threshold -> sub-partitioned into checkout and history at depth 2)
  - Cluster 3: `inventory` (depth 1, 4 endpoints <= threshold -> base case)
- **Conquer**:
  - Leaves solved at depth 1 and depth 2 generating valid OpenAPI path items.
- **Combine**:
  - Merge strategy: `STRUCTURAL_UNION`.
  - Merged recursively from leaves to depth 1, then depth 1 to root.
  - Integrity checksum calculated; composite verified with zero orphaned routes.

### 8.3. Scenario 3: Recursive Refactoring with Partition Overlap Defect
**Input**: Refactor database models across services A and B.
- `depth = 0`: Decompose service A models and service B models.
- **Partition Check**:
  - Service A scope includes table `shared_credentials`.
  - Service B scope includes table `shared_credentials`.
  - Intersection is non-empty (`{"shared_credentials"}`).
- **Defect Emission**:
  - Invariant breach: `ORTHOGONAL_PARTITIONING` violated.
  - Emits `DacDefectReport` with `violation_code: "PARTITION_OVERLAP_DETECTED"`.
  - Transitions state to `FAILED` and halts immediately without modifying files.
