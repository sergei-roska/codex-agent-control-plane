---
name: copy-on-write
description: A software engineering skill implementing the Copy-on-Write (COW) virtualization pattern for speculative code editing, experimental refactoring, and isolated multi-agent sandboxing with lazy resource duplication and hypothesis validation gating.
---

# SKILL: copy-on-write

## 1. Overview

A deterministic software engineering skill implementing the Copy-on-Write (COW) memory and filesystem virtualization pattern for autonomous agents, speculative code editing, experimental refactoring, and isolated multi-agent sandboxing.

### 1.1. Context and Architectural Failure Modes
Autonomous agents performing complex, exploratory refactoring, architectural upgrades, or speculative bug fixes frequently pollute pristine codebases:
1. **Destructive Speculative Edits**: An agent modifying multiple core files during an experimental attempt, failing halfway, and leaving half-modified, broken source code on disk.
2. **Expensive Pre-emptive Duplication**: Cloning an entire multi-gigabyte repository for small three-line changes, causing disk bloat, extreme I/O overhead, and slow test loops.
3. **Dirty Rollbacks and Ghost Files**: Imperfect cleanup scripts leaving orphan scratch files, unstaged artifacts, and altered file modification timestamps in production trees.
4. **Concurrent Multi-Agent Collisions**: Multiple subagents attempting speculative experiments on the same workspace concurrently, clobbering each other files.

### 1.2. Scope and Behavioral Boundaries
The `copy-on-write` pattern implements lightweight virtualized filesystem layering:
- **Baseline Layer**: The host workspace is mounted strictly **read-only**. Zero writes, file creations, or deletions may touch the baseline directly.
- **Shadow Layer**: A dedicated, isolated directory structure created per experimental session (default: `.agents/staging/cow/<session_id>/`).
- **Lazy Duplication (Copy-on-Write)**: A baseline file is duplicated into the shadow layer only at the exact moment an agent attempts to write to or modify it. Read operations transparently query the shadow copy if modified, or pass through directly to the baseline if untouched.
- **Hypothesis Validation Gating**: Changes remain isolated until a deterministic validation suite passes. If tests fail, the shadow layer is obliterated in an atomic step with zero residual impact on baseline.

## 2. Trigger and Activation

### Positive Triggers
- Speculative code refactoring, performance tuning, or complex dependency migrations.
- Multi-agent sandboxing where each worker explores competing hypotheses in isolation.
- Exploratory prompt modifications or automated code-fix iterations with non-zero failure probabilities.
- Keywords: "copy on write", "cow workspace", "speculative editing", "sandbox modifications", "isolated patch experimentation", "lazy file copy".

### Negative Triggers
- Direct atomic writes with guaranteed correctness requiring `two-phase-commit`.
- Linear sequential batch operations across known documents requiring `serial-item-processor`.
- Pure read-only searches, grep queries, or static codebase indexing where no file modifications occur.

## 3. Invariants and Rules

1. **BASELINE_IMMUTABILITY = MANDATORY**: The baseline workspace must remain strictly read-only throughout the lifetime of the COW session. Any direct write to baseline triggers immediate abort with `BASELINE_MUTATION_BREACH`.
2. **LAZY_FILE_DUPLICATION = MANDATORY**: No file from baseline may be copied to shadow until an explicit write or edit operation targets it. Pure read operations must resolve against baseline with zero disk write overhead.
3. **TRANSPARENT_OVERLAY_RESOLUTION = MANDATORY**: The virtual layer lookup resolution order is:
   `Resolve(file_path) = shadow_path if exists(shadow_path) else baseline_path`.
4. **HYPOTHESIS_GATING_BEFORE_MERGE = MANDATORY**: Staged shadow changes can be merged into baseline if and only if 100 percent of declared acceptance tests pass.
5. **ATOMIC_DISCARD_GUARANTEE = MANDATORY**: If hypothesis validation fails, the entire shadow layer is recursively purged, guaranteeing zero uncommitted diffs, altered timestamps, or ghost files in the baseline.

## 4. Rigid Data Contracts and Schemas

### 4.1. COW Session Configuration (CowSessionConfig)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CowSessionConfig",
  "type": "object",
  "required": [
    "session_id",
    "baseline_dir",
    "shadow_root_dir",
    "hypothesis_criteria"
  ],
  "properties": {
    "session_id": { "type": "string", "pattern": "^cow-[a-zA-Z0-9_-]+$" },
    "baseline_dir": { "type": "string" },
    "shadow_root_dir": { "type": "string", "default": ".agents/staging/cow/" },
    "hypothesis_criteria": {
      "type": "object",
      "required": ["test_command", "max_allowed_regressions"],
      "properties": {
        "test_command": { "type": "string" },
        "timeout_ms": { "type": "integer", "minimum": 1000, "default": 60000 },
        "max_allowed_regressions": { "type": "integer", "default": 0 }
      },
      "additionalProperties": false
    },
    "auto_merge_on_pass": { "type": "boolean", "default": false }
  },
  "additionalProperties": false
}
```

### 4.2. Shadow File Descriptor (ShadowFileDescriptor)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ShadowFileDescriptor",
  "type": "object",
  "required": [
    "relative_path",
    "baseline_sha256",
    "shadow_sha256",
    "copied_at_utc",
    "mutation_count"
  ],
  "properties": {
    "relative_path": { "type": "string" },
    "baseline_sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "shadow_sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "copied_at_utc": { "type": "string", "format": "date-time" },
    "mutation_count": { "type": "integer", "minimum": 1 }
  },
  "additionalProperties": false
}
```

### 4.3. COW Defect Report (CowDefectReport)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CowDefectReport",
  "type": "object",
  "required": ["defect_id", "session_id", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "session_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "BASELINE_MUTATION_BREACH",
        "MERGE_VALIDATION_FAILED",
        "SHADOW_CORRUPTION",
        "UNRESOLVED_MERGE_CONFLICT",
        "DISCARD_PURGE_FAILED",
        "STAGING_DIRECTORY_COLLISION"
      ]
    },
    "error_message": { "type": "string" },
    "affected_files": { "type": "array", "items": { "type": "string" } },
    "validation_output": { "type": ["string", "null"] },
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
                 | Event: INIT_SESSION (Validate paths, allocate shadow layer)
                 v
       +--------------------+
+----->|   ACTIVE_SANDBOX   |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: INTERCEPT_WRITE (First write to file R)
|                v                                         |
|      +--------------------+                              |
|      |    COPY_ON_WRITE   |                              |
|      +--------------------+                              |
|                |                                         |
|                | Event: COPY_DONE (Mutate shadow copy)   |
|                +-----------------------------------------+
|
| Event: RUN_HYPOTHESIS_TESTS
v
+--------------------+
|    EVALUATING      |
+--------------------+
  /                 / Tests PASS       \ Tests FAIL / User Discard
v                    v                  v
+--------------------+               +--------------------+
|      MERGING       |               |     DISCARDING     |
+--------------------+               +--------------------+
  |                                    |
  | Flush to baseline                  | Purge shadow directory
  v                                    v
+--------------------+               +--------------------+
|     COMPLETED      |               |      ABORTED       |
+--------------------+               +--------------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `UNINITIALIZED` | `INIT_SESSION` | Baseline dir exists, shadow dir clean | `ACTIVE_SANDBOX` | Mint `session_id`, create isolated shadow staging directory. |
| `ACTIVE_SANDBOX` | `INTERCEPT_READ` | Path exists in shadow OR baseline | `ACTIVE_SANDBOX` | Return shadow file if exists, else return baseline file. |
| `ACTIVE_SANDBOX` | `INTERCEPT_WRITE` | Path already in shadow tracking table | `ACTIVE_SANDBOX` | Apply mutation directly to existing shadow file. |
| `ACTIVE_SANDBOX` | `INTERCEPT_WRITE` | Path NOT yet in shadow tracking table | `COPY_ON_WRITE` | Copy file from baseline to shadow; record baseline SHA-256. |
| `COPY_ON_WRITE` | `APPLY_MUTATION` | Shadow file copy verified | `ACTIVE_SANDBOX` | Apply proposed mutation to shadow file; update shadow SHA-256. |
| `ACTIVE_SANDBOX` | `RUN_HYPOTHESIS` | At least 1 file mutated in shadow | `EVALUATING` | Execute `test_command` targeting composite virtual view. |
| `EVALUATING` | `VALIDATION_PASS` | Test exit code == 0 AND regressions == 0 | `MERGING` | Begin atomic sync of shadow files into baseline. |
| `EVALUATING` | `VALIDATION_FAIL` | Test exit code != 0 OR regressions > 0 | `DISCARDING` | Emit `MERGE_VALIDATION_FAILED`; trigger purge. |
| `MERGING` | `MERGE_COMPLETE` | All mutated files synced and verified | `COMPLETED` | Purge shadow staging directory; emit `MergeReceipt`. |
| `DISCARDING` | `PURGE_COMPLETE` | Shadow directory removed, baseline pristine | `ABORTED` | Confirm baseline SHA-256 matches initial state. |

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Session Virtualization Setup
1. Validate `baseline_dir` exists and compute initial baseline state manifest.
2. Mint unique `session_id` (format: `cow-<timestamp>-<hash>`).
3. Create shadow directory `.agents/staging/cow/<session_id>/`.
4. Initialize in-memory lookup table `ShadowRegistry = {}`.
5. Transition state to `ACTIVE_SANDBOX`.
6. Emit log marker: `=== COW SESSION INITIALIZED: [session_id] Baseline: [baseline_dir] ===`.

### Step 2: Overlay Read and Write Interception
- **On Read Request (`read_file(path)`):**
  1. Determine relative path: `rel_path = normalize(path)`.
  2. IF `rel_path` in `ShadowRegistry`:
     - Read and return `.agents/staging/cow/<session_id>/<rel_path>`.
     - Emit log marker: `[COW_READ] Path: [rel_path] ResolvedLayer: SHADOW`.
  3. ELSE:
     - Read and return `<baseline_dir>/<rel_path>`.
     - Emit log marker: `[COW_READ] Path: [rel_path] ResolvedLayer: BASELINE`.
- **On Write Request (`write_file(path, new_content)`):**
  1. Determine relative path: `rel_path = normalize(path)`.
  2. IF path attempts to write directly into `baseline_dir` bypassing shadow:
     - Emit Defect Report: `violation_code: BASELINE_MUTATION_BREACH`.
     - Halt operation immediately.
  3. IF `rel_path` NOT in `ShadowRegistry`:
     - Transition state to `COPY_ON_WRITE`.
     - Read original file from `<baseline_dir>/<rel_path>`.
     - Record `baseline_sha256 = sha256(original_content)`.
     - Ensure parent directory exists in `.agents/staging/cow/<session_id>/<dir>`.
     - Write initial duplicate to `.agents/staging/cow/<session_id>/<rel_path>`.
     - Register in `ShadowRegistry`:
       `ShadowRegistry[rel_path] = {baseline_sha256, copied_at: now(), mutation_count: 0}`.
     - Emit log marker: `[COW_DUPLICATION] File: [rel_path] BaselineChecksum: [baseline_sha256]`.
     - Transition state to `ACTIVE_SANDBOX`.
  4. Write `new_content` to `.agents/staging/cow/<session_id>/<rel_path>`.
  5. Increment `ShadowRegistry[rel_path].mutation_count += 1`.
  6. Update `ShadowRegistry[rel_path].shadow_sha256 = sha256(new_content)`.
  7. Emit log marker: `[COW_MUTATION] File: [rel_path] MutationIndex: [ShadowRegistry[rel_path].mutation_count]`.
  8. Assert baseline file remains untouched:
     `ASSERT(sha256(<baseline_dir>/<rel_path>) == baseline_sha256)`.

### Step 3: Hypothesis Verification Gate
1. Agent completes experimental changes and triggers `RUN_HYPOTHESIS`.
2. Transition state to `EVALUATING`.
3. Dispatch verification suite targeting shadow layer (or virtual overlay).
4. Monitor test process execution within `timeout_ms`.
5. IF test suite succeeds (exit code 0 and regressions == 0):
   - Emit log marker: `[HYPOTHESIS_VERIFIED] Session: [session_id] Verdict: PASS`.
   - Transition state to `MERGING`. Proceed to Step 4A.
6. ELSE (tests fail or timeout):
   - Emit Defect Report: `MERGE_VALIDATION_FAILED`.
   - Emit log marker: `[HYPOTHESIS_VERIFIED] Session: [session_id] Verdict: FAIL`.
   - Transition state to `DISCARDING`. Proceed to Step 4B.

### Step 4A: Atomic Merge Sequence
1. For each `rel_path` in `ShadowRegistry`:
   - Copy `.agents/staging/cow/<session_id>/<rel_path>` to `<baseline_dir>/<rel_path>`.
   - Verify post-write checksum:
     `ASSERT(sha256(<baseline_dir>/<rel_path>) == ShadowRegistry[rel_path].shadow_sha256)`.
2. Recursively delete `.agents/staging/cow/<session_id>/`.
3. Transition state to `COMPLETED`.
4. Emit log marker: `=== COW SESSION MERGED: [session_id] ===`.

### Step 4B: Atomic Discard Sequence
1. Recursively delete `.agents/staging/cow/<session_id>/`.
2. Verify all files in `baseline_dir` remain 100 percent identical to baseline checksums.
3. Transition state to `ABORTED`.
4. Emit log marker: `=== COW SESSION DISCARDED: [session_id] ===`.

## 7. Concrete Telemetry and Defect Codes

### 7.1. Telemetry Log Markers
- `=== COW SESSION INITIALIZED: [session_id] ===`
- `[COW_READ] Path: [path] ResolvedLayer: [SHADOW | BASELINE]`
- `[COW_DUPLICATION] File: [path] BaselineChecksum: [sha256]`
- `[COW_MUTATION] File: [path] MutationIndex: [count]`
- `[HYPOTHESIS_VERIFIED] Session: [session_id] Verdict: [PASS | FAIL]`
- `=== COW SESSION MERGED: [session_id] ===`
- `=== COW SESSION DISCARDED: [session_id] ===`

### 7.2. Defect Codes
- `BASELINE_MUTATION_BREACH`: Baseline file altered directly without copy-on-write isolation.
- `MERGE_VALIDATION_FAILED`: Acceptance tests failed; merge blocked.
- `SHADOW_CORRUPTION`: File inside shadow buffer corrupted or missing.
- `UNRESOLVED_MERGE_CONFLICT`: Baseline file modified concurrently by another process during session.
- `DISCARD_PURGE_FAILED`: Inability to recursively delete shadow directory upon discard.
- `STAGING_DIRECTORY_COLLISION`: Staging directory already exists or collides with another session.

## 8. Few-Shot Operational Walkthroughs

### Scenario 1: Successful Hypothesis Refactor
**Goal**: Refactor `auth_provider.py` to use asynchronous tokens.
1. `COW` session initialized: `cow-2026-001`.
   Telemetry: `=== COW SESSION INITIALIZED: cow-2026-001 ===`
2. Agent reads `auth_provider.py` and `config.py` (resolved from baseline, zero shadow writes).
   Telemetry: `[COW_READ] Path: auth_provider.py ResolvedLayer: BASELINE`
   Telemetry: `[COW_READ] Path: config.py ResolvedLayer: BASELINE`
3. Agent writes updated `auth_provider.py`:
   - `auth_provider.py` duplicated to `.agents/staging/cow/cow-2026-001/auth_provider.py`.
   - Telemetry: `[COW_DUPLICATION] File: auth_provider.py BaselineChecksum: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
   - Changes written to shadow copy. Mutation index 1 recorded.
   - Telemetry: `[COW_MUTATION] File: auth_provider.py MutationIndex: 1`
   - Baseline `auth_provider.py` checksum verified unchanged.
4. Agent runs test command: `pytest tests/test_auth.py`.
5. Tests pass 100 percent.
   Telemetry: `[HYPOTHESIS_VERIFIED] Session: cow-2026-001 Verdict: PASS`
6. Merge executed: shadow `auth_provider.py` copied to baseline.
7. Shadow folder deleted.
   Telemetry: `=== COW SESSION MERGED: cow-2026-001 ===`

### Scenario 2: Failed Experiment Discard
**Goal**: Experimental algorithm upgrade in `engine.py`.
1. `COW` session initialized: `cow-2026-002`.
   Telemetry: `=== COW SESSION INITIALIZED: cow-2026-002 ===`
2. Agent modifies `engine.py`. Shadow copy created; changes applied.
   Telemetry: `[COW_DUPLICATION] File: engine.py BaselineChecksum: a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e`
   Telemetry: `[COW_MUTATION] File: engine.py MutationIndex: 1`
3. Agent runs tests: `pytest tests/test_perf.py`.
4. Tests fail with assertion error (regression detected).
   Telemetry: `[HYPOTHESIS_VERIFIED] Session: cow-2026-002 Verdict: FAIL`
5. State transitions to `DISCARDING`.
6. Shadow folder `.agents/staging/cow/cow-2026-002/` deleted.
7. Baseline `engine.py` retains original unmodified checksum. Zero residual files remain.
8. Telemetry: `=== COW SESSION DISCARDED: cow-2026-002 ===`

### Scenario 3: Pure Read-Only Passthrough with Zero Duplication
**Goal**: Inspect system status and configuration files without writes.
1. `COW` session initialized: `cow-2026-003`.
   Telemetry: `=== COW SESSION INITIALIZED: cow-2026-003 ===`
2. Agent reads `config.json` and `schema.sql`.
   Telemetry: `[COW_READ] Path: config.json ResolvedLayer: BASELINE`
   Telemetry: `[COW_READ] Path: schema.sql ResolvedLayer: BASELINE`
3. Zero files copied to shadow. Shadow directory remains completely empty.
4. Session closes cleanly.

### Scenario 4: Direct Baseline Write Intercepted and Aborted
**Goal**: Intercept rogue write attempting to bypass shadow isolation.
1. `COW` session initialized: `cow-2026-004`.
2. Agent or rogue process attempts direct write to `/workspace/project/src/index.py`.
3. Pre-write immutability guard detects target path resolves inside `baseline_dir`.
4. Operation halted immediately. Defect report emitted with `violation_code: BASELINE_MUTATION_BREACH`.
5. Baseline integrity preserved 100 percent.

### Scenario 5: Repeated Mutations to Already-Shadowed Resource
**Goal**: Perform iterative development with multiple edits to `parser.py`.
1. `COW` session initialized: `cow-2026-005`.
2. First write to `parser.py`: lazy copy triggered, mutation index 1 recorded.
   Telemetry: `[COW_DUPLICATION] File: parser.py BaselineChecksum: 7d1a54127b222502f5b79b5fb0803061152a44f92b37e23c65dd00417e42f323`
   Telemetry: `[COW_MUTATION] File: parser.py MutationIndex: 1`
3. Second write to `parser.py`: already present in `ShadowRegistry`. No duplicate copy made.
   Telemetry: `[COW_MUTATION] File: parser.py MutationIndex: 2`
4. Third write to `parser.py`: mutation index 3 recorded.
   Telemetry: `[COW_MUTATION] File: parser.py MutationIndex: 3`

## 9. Definition of Done and Quality Checklist

- [ ] Baseline workspace remains strictly read-only; zero direct writes permitted.
- [ ] Lazy duplication occurs only upon the first write operation targeting an unmodified resource.
- [ ] Pure read operations resolve against baseline without creating shadow duplicates.
- [ ] Virtual resolution order strictly enforces shadow over baseline.
- [ ] Staged shadow changes are merged into baseline if and only if 100 percent of validation tests pass.
- [ ] When validation fails, shadow directory is completely purged with zero baseline residue.
- [ ] All 8 formal states and transitions are strictly enforced with deterministic error recovery.
- [ ] Telemetry markers and defect codes strictly adhere to the specification.
- [ ] All artifacts and test cases use strictly 7-bit ASCII English.
