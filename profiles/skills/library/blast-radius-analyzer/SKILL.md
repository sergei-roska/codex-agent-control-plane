---
name: blast-radius-analyzer
description: Computes the structural dependency graph and allowed write surface for an incoming feature ticket, producing the authoritative Blast-Radius Matrix that constrains developer file mutations.
---

# Blast Radius Analyzer (blast-radius-analyzer)

## 1. Domain Problem & Scope

### 1.1. Context & Mutation Surface Runaway Modes
When autonomous developers receive a task without strict boundaries on which files they are permitted to modify, they make speculative changes across unrelated components. Without pre-implementation blast-radius analysis:
1. **Unbounded Mutation Surface**: A localized bugfix touches shared base classes or system configuration files, causing wide-ranging system instability.
2. **Cascading Downstream Breakages**: Changing a utility signature silently breaks dozens of unaffected consuming modules.
3. **Multi-Agent Collision Chaos**: Parallel agents working on different tickets inadvertently edit the same files, creating unresolvable git merge conflicts.
4. **Untracked Core Config Exposure**: Agents inadvertently modify root configurations (`tsconfig.json`, `package.json`, `.env`) to silence linter or typecheck errors.
5. **Context Window Token Bloat**: Downstream reviewers are forced to review hundreds of lines of out-of-scope modifications.

### 1.2. Scope & Behavioral Boundaries
The `blast-radius-analyzer` skill establishes mathematical containment boundaries before code is written:
- Analyzes the codebase dependency graph (imports, exports, call hierarchies) relative to the ticket requirements.
- Partitions project files into three rigid sets: `allowed_write_files`, `read_only_files`, and `forbidden_files`.
- Calculates structural impact depth (callees, callers, and transitive dependents).
- Computes a maximum line mutation budget (`max_lines_changed`).
- Authors the authoritative `BlastRadiusMatrix` and publishes it to Blackboard for enforcement by `diff-blast-verifier`.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Architectural specification phase executed by `architect` prior to developer dispatch.
- Ingestion of a sliced user story (`invest-story-slicer`).
- Re-evaluating blast radius when a ticket encounters an unexpected technical blocker.
- Explicit keywords: "analyze blast radius", "compute write surface", "blast radius matrix", "isolate file mutations", "allowed write files".

### 2.2. Negative Triggers
- Verifying git diffs against an already published matrix (delegated to `diff-blast-verifier`).
- Writing application code (delegated to `developer`).
- Structural AST pattern searching (delegated to `ast-grep-analyzer`).
- Auditing sprint scope baseline (delegated to `scope-baseline-auditor`).

---

## 3. Invariants & Non-Negotiable Rules

1. **LEAST_PRIVILEGE_SURFACE = MANDATORY**: The `allowed_write_files` set must contain the absolute minimum number of files required to implement the ticket. Blanket directory wildcards are prohibited. Defect code: `UNBOUNDED_SURFACE_REJECTED`.
2. **FORBIDDEN_PATHS_EXPLICIT = MANDATORY**: Core system files (`package.json`, `tsconfig.json`, root dotfiles, database migration registries) must be explicitly placed in `forbidden_files`. Defect code: `CORE_CONFIG_EXPOSURE`.
3. **DEPENDENCY_CLOSURE_CALCULATED = MANDATORY**: Transitive dependents within depth 2 must be identified and marked as `read_only_files` to verify non-breakage.
4. **MUTATION_BUDGET_CAPPED = MANDATORY**: Every matrix must specify `max_lines_changed` capped at 500 lines for standard stories (default: 300 lines). Defect code: `BLAST_RADIUS_OVERFLOW`.
5. **IMMUTABLE_POST_CREATION = MANDATORY**: Once published on Blackboard for a ticket, the matrix cannot be altered without an explicit architecture review.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Blast Radius Matrix Schema (`BlastRadiusMatrix`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BlastRadiusMatrix",
  "type": "object",
  "required": [
    "matrix_id",
    "ticket_id",
    "allowed_write_files",
    "read_only_files",
    "forbidden_files",
    "max_lines_changed",
    "impact_depth",
    "created_at_utc"
  ],
  "properties": {
    "matrix_id": { "type": "string", "pattern": "^BRM-[a-zA-Z0-9_-]+$" },
    "ticket_id": { "type": "string", "pattern": "^(STORY|TICKET)-[0-9]+$" },
    "allowed_write_files": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "read_only_files": {
      "type": "array",
      "items": { "type": "string" }
    },
    "forbidden_files": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "max_lines_changed": { "type": "integer", "minimum": 1, "maximum": 500, "default": 300 },
    "impact_depth": { "type": "integer", "minimum": 1, "maximum": 3 },
    "created_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.2. Dependency Impact Graph Schema (`DependencyImpactGraph`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DependencyImpactGraph",
  "type": "object",
  "required": ["root_symbols", "directly_impacted_files", "transitive_dependents_count"],
  "properties": {
    "root_symbols": {
      "type": "array",
      "items": { "type": "string" }
    },
    "directly_impacted_files": {
      "type": "array",
      "items": { "type": "string" }
    },
    "transitive_dependents_count": { "type": "integer", "minimum": 0 },
    "circular_dependencies_detected": { "type": "boolean" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal Execution Algorithm

### Step 1: Ingest Ticket & Identify Root Entry Points
1. Load ticket acceptance criteria and technical description from Blackboard.
2. Identify target domain entities, route handlers, or service classes.

### Step 2: Dependency Graph Traversal
1. Traverse import/export graphs from root symbols up to depth 2.
2. Identify direct dependencies (modules imported by target).
3. Identify direct consumers (modules that import target).

### Step 3: Partitioning Files into Boundary Sets
1. Assign target implementation file(s) and accompanying test file(s) to `allowed_write_files`.
2. Assign direct consumers and shared interfaces to `read_only_files`.
3. Assign global configs, independent domain modules, and root manifests to `forbidden_files`.

### Step 4: Line Budget Calculation
1. Assess ticket story points:
   - 1 point: 100 lines.
   - 2-3 points: 250 lines.
   - 5 points: 400 lines (max 500).
2. Set `max_lines_changed`.

### Step 5: Invariant Verification & Matrix Assembly
1. Verify `allowed_write_files` contains no wildcards or parent folder tokens (`..`).
2. Verify `package.json`, `tsconfig.json` exist in `forbidden_files`.
3. Construct `BlastRadiusMatrix` object.

### Step 6: Blackboard Publication
1. Write matrix to Blackboard (`agent-memory`) tagged `["blast-radius", "ticket:<ticket_id>", "role:architect"]`.
2. Dispatch matrix pointer to `developer` and `reviewer`.
3. Emit terminal telemetry marker.

---

## 6. Concrete Telemetry & Defect Codes

### 6.1. Telemetry Log Markers
- `=== BLAST RADIUS ANALYZER INITIATED: [ticket_id] ===`
- `[BRM_GRAPH_WALK] Traversed dependency graph: [count] nodes visited`
- `[BRM_PARTITION] Allowed: [allowed_count] ReadOnly: [ro_count] Forbidden: [forbid_count]`
- `[BRM_BUDGET] Assigned max_lines_changed: [lines]`
- `=== BLAST RADIUS MATRIX PUBLISHED: [matrix_id] Ticket: [ticket_id] ===`

### 6.2. Defect Codes
- `UNBOUNDED_SURFACE_REJECTED`: Matrix attempted to allow entire directory wildcards.
- `CORE_CONFIG_EXPOSURE`: Root configuration files omitted from forbidden list.
- `BLAST_RADIUS_OVERFLOW`: Calculated impact surface exceeds architecture threshold.
- `GRAPH_CYCLE_DETECTED`: Circular dependencies prevented deterministic isolation.

---

## 7. Few-Shot Operational Walkthroughs

### 7.1. Scenario 1: Authoring Blast Radius for Telemetry Streaming Feature
**Ticket**: `STORY-103` (SSE Telemetry Streaming Endpoint).
**Execution Trace**:
1. Roots: `TelemetryController.ts`, `sseStreamer.ts`.
2. Graph traversal: consumers = `routes.ts`, contracts = `telemetry.ts`.
3. Partitioning:
   - `allowed_write_files`: `["src/controllers/TelemetryController.ts", "src/services/sseStreamer.ts", "tests/services/sseStreamer.test.ts"]`
   - `read_only_files`: `["src/routes.ts", "src/contracts/telemetry.ts"]`
   - `forbidden_files`: `["package.json", "tsconfig.json", "src/domain/orders/*", ".env*"]`
4. Points = 3 -> `max_lines_changed`: 300.
5. Matrix `BRM-STORY-103` saved to Blackboard.

### 7.2. Scenario 2: Rejecting Overly Permissive Write Request
**Ticket**: `STORY-105` (Fix date utility bug).
**Attempted Boundary**: Developer requests write permission to `src/utils/**`.
**Execution Trace**:
1. Analyzer detects wildcard pattern `src/utils/**` spanning 24 utility files.
2. Invariant 1 trips: `UNBOUNDED_SURFACE_REJECTED`.
3. Analyzer inspects graph, isolates exact bug location to `src/utils/dateFormat.ts`.
4. Restricts `allowed_write_files` strictly to `["src/utils/dateFormat.ts", "tests/utils/dateFormat.test.ts"]`. Wildcard denied.