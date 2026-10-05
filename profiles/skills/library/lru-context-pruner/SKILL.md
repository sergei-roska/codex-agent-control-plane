---
name: lru-context-pruner
description: A software engineering skill implementing Least Recently Used (LRU) cache eviction algorithms for LLM working context pruning and prompt window budget optimization.
---

# Least Recently Used Context Pruner (lru-context-pruner)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
Autonomous agents executing long multi-turn trajectories, large codebase refactoring, or iterative tool loops rapidly accumulate massive message histories and tool outputs. Without a rigorous context pruning strategy, agents suffer severe degradation:
1. **Hard Token Window Explosions**: Context exceeds model maximum token capacity, causing sudden API crashes (e.g., HTTP 400 "context_length_exceeded") that completely abort active workflows.
2. **Attention Dilution & Hallucinatory Noise**: Ingestion of thousands of tokens of obsolete tool outputs (e.g., raw grep results from 15 steps ago) dilutes LLM focus, leading to degraded instruction following.
3. **Runaway Inference Latency & Cost**: Passing 150k+ tokens on every single turn dramatically increases latency and cost per step.
4. **Naive Truncation Disasters**: Blindly dropping the oldest messages cuts off core system rules, architectural boundaries, or pinned contracts, corrupting agent reasoning.

### 1.2. Scope & Behavioral Boundaries
The `lru-context-pruner` pattern implements a deterministic Least Recently Used (LRU) memory eviction and compaction engine:
- **Watermark Threshold Monitoring**: Continuously tracks context token footprint T. When T crosses the **High Watermark** (W_high, e.g., 80% capacity), the pruner activates.
- **Topological Dependency & Pinning Protection**: System instructions, active contracts, and memory blocks referenced as active dependencies by current tasks are strictly non-evictable, regardless of age.
- **LRU Access Ledger**: Tracks explicit access timestamps (`last_accessed_at_utc`). Candidates are evaluated in ascending recency order.
- **Semantic Stub Substitution**: Evicted blocks are not silently erased; they are substituted with compact, structured cryptographic stubs:
  `[PRUNED_BLOCK: id=<block_id>, sha256=<hash>, summary="<1-line summary>"]`.
- **Target Low Watermark**: Eviction proceeds iteratively until token consumption drops below the **Low Watermark** (W_low, e.g., 60% capacity).

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Long-running autonomous agent sessions spanning multiple tool invocations and subagent delegations.
- Context window utilization reaching or exceeding configured high-watermark thresholds.
- Workflows accumulating large tool outputs (AST dumps, git diffs, directory trees) needing selective compression.
- Explicit keywords: "lru context pruner", "prune context window", "evict least recently used memory", "context compression", "prevent context overflow", "watermark token pruning".

### 2.2. Negative Triggers
- Short single-turn prompts well within comfortable token limits (< 10% capacity).
- External disk database pruning (this pattern specifically optimizes LLM prompt working memory).
- Stateless pipes with zero conversation history.

---

## 3. Invariants & Non-Negotiable Rules

1. **PINNED_INTEGRITY_IMMUNITY = MANDATORY**: Blocks tagged as `PINNED` (e.g., system prompts, core rules, active goals) must never be evicted. Any attempt triggers `PINNED_BLOCK_EVICTION_ATTEMPT`.
2. **DEPENDENCY_GRAPH_PRESERVATION = MANDATORY**: If memory block A is referenced as an active dependency or uncompleted task input by block B, block A cannot be evicted while B is active. Violation code: `ORPHANED_REFERENCE_PREVENTION`.
3. **SEMANTIC_STUB_SUBSTITUTION = MANDATORY**: Evicted context blocks must be replaced by a standardized tombstone/stub record retaining block ID, SHA-256 hash, and concise summary to preserve cognitive continuity.
4. **HARD_WINDOW_CEILING = MANDATORY**: Active context tokens must never exceed `max_capacity_tokens`. Pruning must drive usage down to `target_capacity_tokens`.
5. **DETERMINISTIC_RECENCY_SORT = MANDATORY**: In the absence of dependency locks, eviction candidate priority is strictly governed by `last_accessed_at_utc` ascending.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Pruner Configuration Schema (`PrunerConfig`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PrunerConfig",
  "type": "object",
  "required": [
    "session_id",
    "max_capacity_tokens",
    "high_watermark_ratio",
    "low_watermark_ratio"
  ],
  "properties": {
    "session_id": { "type": "string" },
    "max_capacity_tokens": { "type": "integer", "minimum": 1000, "default": 128000 },
    "high_watermark_ratio": { "type": "number", "minimum": 0.5, "maximum": 0.95, "default": 0.80 },
    "low_watermark_ratio": { "type": "number", "minimum": 0.2, "maximum": 0.80, "default": 0.60 },
    "stub_token_allowance": { "type": "integer", "minimum": 10, "default": 40 }
  },
  "additionalProperties": false
}
```

### 4.2. Context Block Descriptor (`ContextBlock`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ContextBlock",
  "type": "object",
  "required": [
    "block_id",
    "role",
    "token_count",
    "is_pinned",
    "last_accessed_at_utc",
    "content_hash"
  ],
  "properties": {
    "block_id": { "type": "string", "pattern": "^ctx-[a-zA-Z0-9_-]+$" },
    "role": { "type": "string", "enum": ["SYSTEM", "USER", "ASSISTANT", "TOOL_OUTPUT", "SCRATCHPAD"] },
    "token_count": { "type": "integer", "minimum": 1 },
    "is_pinned": { "type": "boolean", "default": false },
    "dependent_block_ids": { "type": "array", "items": { "type": "string" } },
    "created_at_utc": { "type": "string", "format": "date-time" },
    "last_accessed_at_utc": { "type": "string", "format": "date-time" },
    "summary": { "type": "string" },
    "content_hash": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
  },
  "additionalProperties": false
}
```

### 4.3. Pruner Defect Report Schema (`PrunerDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PrunerDefectReport",
  "type": "object",
  "required": ["defect_id", "session_id", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "session_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "CONTEXT_BUDGET_OVERRUN",
        "ORPHANED_REFERENCE_PREVENTION",
        "PINNED_BLOCK_EVICTION_ATTEMPT",
        "PRUNING_TARGET_UNREACHABLE",
        "TOKEN_MEASUREMENT_ERROR"
      ]
    },
    "current_token_count": { "type": "integer" },
    "target_token_count": { "type": "integer" },
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
       |     MONITORING     |
       +--------------------+
                 |
                 | Event: MEASURE_FOOTPRINT
                 v
       +--------------------+
       |  EVAL_WATERMARK    |
       +--------------------+
         /                \
        / T < HighWatermark \ T >= HighWatermark
       v                    v
+--------------+     +-------------------+
|  MAINTAIN    |     | SELECT_CANDIDATES |
+--------------+     +-------------------+
                            |
                            | Build LRU list sorted by recency
                            v
                     +-------------------+
                     | FILTER_IMMUNE     | (Exclude Pinned & Dependencies)
                     +-------------------+
                            |
                            | Evictable set ready
                            v
                     +-------------------+
+------------------->|  EVICT_AND_STUB   |
|                    +-------------------+
|                           |
| Check remaining tokens    | Substitute stub, reclaim tokens
+-- T > LowWatermark -------+
                            |
                            | T <= LowWatermark
                            v
                     +-------------------+
                     |  VERIFY_REDUCTION |
                     +-------------------+
                            |
                            | Budget Confirmed
                            v
                     +-------------------+
                     |    COMPLETED      |
                     +-------------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `MONITORING` | `SAMPLE_TOKENS` | Tokens calculated | `EVAL_WATERMARK` | Compare `current_tokens` against `high_watermark`. |
| `EVAL_WATERMARK` | `BELOW_THRESHOLD` | current_tokens < max_capacity * high_watermark_ratio | `MONITORING` | No pruning required; retain active context. |
| `EVAL_WATERMARK` | `BREACH_THRESHOLD`| current_tokens >= max_capacity * high_watermark_ratio | `SELECT_CANDIDATES` | Trigger pruning routine; emit alert log. |
| `SELECT_CANDIDATES`| `SORT_RECENCY` | Candidates sorted | `FILTER_IMMUNE` | Order blocks ascending by `last_accessed_at_utc`. |
| `FILTER_IMMUNE` | `EXCLUDE_PROTECTED`| Non-pinned, unreferenced identified | `EVICT_AND_STUB` | Discard pinned and active dependency blocks from eviction set. |
| `EVICT_AND_STUB` | `EVICT_NEXT` | T > target_capacity AND candidates available | `EVICT_AND_STUB` | Replace oldest block with stub; subtract reclaimed tokens. |
| `EVICT_AND_STUB` | `TARGET_REACHED` | T <= target_capacity | `VERIFY_REDUCTION` | Confirm token budget satisfied. |
| `EVICT_AND_STUB` | `CANDIDATES_EXHAUSTED`| T > target_capacity AND 0 candidates left | `FAILED` | Emit `PRUNING_TARGET_UNREACHABLE` Defect Report; halt. |
| `VERIFY_REDUCTION`| `BUDGET_CONFIRMED` | Final tokens <= target_capacity | `MONITORING` | Emit `PruningDecisionManifest`; return to monitoring. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Token Usage Measurement & Watermark Check
1. Compute total active tokens: `T = sum(b.token_count for b in active_blocks)`.
2. Compute thresholds:
   - `high_watermark_tokens = max_capacity_tokens * high_watermark_ratio`
   - `target_capacity_tokens = max_capacity_tokens * low_watermark_ratio`
3. IF `T < high_watermark_tokens`:
   - Emit debug log: `[CONTEXT_OK] Tokens: [T]/[max_capacity_tokens] Ratio: [T / max_capacity]`.
   - Exit routine; continue normal agent execution.
4. ELSE:
   - Emit log marker: `=== CONTEXT HIGH WATERMARK BREACHED: Tokens: [T] Ceiling: [high_watermark_tokens] ===`.
   - Transition state to `SELECT_CANDIDATES`.

### Step 2: LRU Candidate Selection & Sorting
1. Collect all blocks in working memory: `blocks`.
2. Sort blocks in ascending order of `last_accessed_at_utc`:
   `sorted_candidates = sort(blocks, key=lambda b: b.last_accessed_at_utc, order=ASCENDING)`.
3. Transition state to `FILTER_IMMUNE`.

### Step 3: Topological Immunity & Dependency Filtering
1. Build active dependency set:
   `active_dep_ids = union(b.dependent_block_ids for b in active_blocks if not b.is_pruned)`.
2. Filter `sorted_candidates`:
   `evictable_queue = []`
   For each `b` in `sorted_candidates`:
     - IF `b.is_pinned == TRUE`: skip (immune).
     - IF `b.block_id in active_dep_ids`: skip (active dependency).
     - IF `b.is_already_stub == TRUE`: skip (already pruned).
     - ELSE: `evictable_queue.append(b)`.
3. IF `len(evictable_queue) == 0`:
   - Emit Defect Report: `PRUNING_TARGET_UNREACHABLE`.
   - Error: All blocks are pinned or locked by dependencies. Halt.
4. Transition state to `EVICT_AND_STUB`.

### Step 4: Iterative Eviction & Stub Substitution
1. While `T > target_capacity_tokens` AND `len(evictable_queue) > 0`:
   a. Dequeue oldest block: `victim = evictable_queue.pop(0)`.
   b. Construct lightweight stub:
      `stub_text = f"[PRUNED_BLOCK: id={victim.block_id}, sha256={victim.content_hash[:16]}, summary='{victim.summary}']"`.
   c. Estimate stub tokens: `stub_tokens = count_tokens(stub_text)`.
   d. Replace `victim.content` with `stub_text` in working context.
   e. Mark `victim.is_pruned = TRUE`.
   f. Update running token total:
      `T = T - victim.token_count + stub_tokens`.
   g. Emit log marker: `[BLOCK_EVICTED] BlockId: [victim.block_id] Reclaimed: [victim.token_count - stub_tokens] CurrentTokens: [T]`.
2. IF `T > target_capacity_tokens` AND `len(evictable_queue) == 0`:
   - Emit Defect Report: `PRUNING_TARGET_UNREACHABLE`.
   - Halt execution.
3. Transition state to `VERIFY_REDUCTION`.

### Step 5: Pruning Certification
1. Re-measure active context tokens: `final_tokens = measure_tokens(working_context)`.
2. Assert `final_tokens <= target_capacity_tokens`.
3. Emit log marker: `=== CONTEXT PRUNING COMPLETE: ReclaimedTokens: [initial_T - final_tokens] FinalFootprint: [final_tokens] ===`.
4. Transition state to `MONITORING`.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== CONTEXT MONITOR: Tokens: [current] HighWatermark: [limit] ===`
- `=== CONTEXT HIGH WATERMARK BREACHED: Tokens: [current] ===`
- `[PRUNING_FILTER_APPLIED] TotalBlocks: [total] Evictable: [count] Protected: [count]`
- `[BLOCK_EVICTED] BlockId: [id] ReclaimedTokens: [tokens] NewTotal: [total]`
- `=== CONTEXT PRUNING COMPLETE: FinalTokens: [count] TargetBudget: [target] ===`

### 7.2. Defect Codes
- `CONTEXT_BUDGET_OVERRUN`: Active context tokens breached maximum hard window capacity.
- `ORPHANED_REFERENCE_PREVENTION`: Block protected from eviction because an active task depends on it.
- `PINNED_BLOCK_EVICTION_ATTEMPT`: Attempted to evict a system prompt or pinned rule.
- `PRUNING_TARGET_UNREACHABLE`: Unable to reach low watermark because remaining tokens are all pinned/immune.
- `TOKEN_MEASUREMENT_ERROR`: Token count calculation failed or threw an exception.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Evicting Old Grep Output to Satisfy High Watermark
**Setup**:
- `max_capacity_tokens`: 100,000
- `high_watermark_ratio`: 0.80 (80,000 tokens)
- `low_watermark_ratio`: 0.60 (60,000 tokens)
- Current token count: 85,000 tokens (Breached!)
- Blocks:
  - `ctx-01`: System Prompt (Pinned, 1,500 tokens)
  - `ctx-02`: Large Grep Output from Step 2 (Tool Output, 30,000 tokens, accessed 25 mins ago)
  - `ctx-03`: Current User Prompt (User, 500 tokens, accessed 10 secs ago)
  - `ctx-04`: Active Refactoring Plan (Assistant, 53,000 tokens, accessed 10 secs ago)
- Execution:
  1. High watermark breached (85,000 > 80,000). Target: <= 60,000 tokens.
  2. Sorting by recency: `[ctx-02, ctx-01, ctx-03, ctx-04]`.
  3. Filter immune: `ctx-01` is pinned. `ctx-03` and `ctx-04` are recent.
  4. Evictable candidate selected: `ctx-02` (30,000 tokens).
  5. `ctx-02` replaced with stub: `[PRUNED_BLOCK: id=ctx-02, sha256=a1b2c3d4e5f60718, summary='Grep search results for AuthService']` (35 tokens).
  6. Reclaimed: 29,965 tokens.
  7. New token total: 55,035 tokens (<= 60,000 target).
  8. Pruning halts successfully. Context reduced cleanly with zero broken references.

### 8.2. Scenario 2: Active Dependency Protects Historical Block
**Setup**:
- Current token count: 90,000 tokens in a 100,000 ceiling window. High watermark: 80,000. Target: 60,000.
- Oldest block: `ctx-05` (AST Dump, 25,000 tokens, accessed 40 mins ago).
- Active block: `ctx-08` (Refactoring Worker) declares `dependent_block_ids: ["ctx-05"]`.
- Next oldest block: `ctx-06` (Unit Test Run Output, 32,000 tokens, accessed 35 mins ago, no dependents).
- Execution:
  1. High watermark breached (90,000 > 80,000). Target: <= 60,000 tokens.
  2. Candidate sorting lists `ctx-05` first, then `ctx-06`.
  3. Topological filter inspects `active_dep_ids = {"ctx-05"}`. `ctx-05` is protected by `ORPHANED_REFERENCE_PREVENTION` logic and excluded from evictable queue.
  4. `ctx-06` is evaluated: unpinned, unreferenced. Selected as eviction victim.
  5. `ctx-06` replaced with stub pointer (35 tokens). Reclaimed: 31,965 tokens.
  6. New token total: 58,035 tokens (<= 60,000 target).
  7. Active task retaining `ctx-05` continues uninterrupted. Zero orphaned reference defects.

### 8.3. Scenario 3: All Blocks Pinned or Dependent (Target Unreachable)
**Setup**:
- Current token count: 88,000 tokens. High watermark: 80,000. Target: 60,000.
- Blocks:
  - `ctx-10`: System Rules & Schema (Pinned, 20,000 tokens).
  - `ctx-11`: Architecture Contracts (Pinned, 30,000 tokens).
  - `ctx-12`: Active Task Input (Referenced by active worker, 38,000 tokens).
- Execution:
  1. High watermark breached (88,000 > 80,000). Target: <= 60,000 tokens.
  2. Candidate sorting evaluates `[ctx-10, ctx-11, ctx-12]`.
  3. Topological filter excludes `ctx-10` and `ctx-11` (is_pinned == true) and `ctx-12` (in active_dep_ids).
  4. Evictable queue length is 0.
  5. System trips state transition to `FAILED` and emits `PrunerDefectReport` with `violation_code: "PRUNING_TARGET_UNREACHABLE"`.
  6. Pipeline halts cleanly without corrupting memory or entering an infinite eviction loop.
