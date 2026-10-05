---
name: codebase-indexing
description: Local codebase AST and semantic vector indexing skill using the local-memory-indexer MCP server. Builds and maintains LanceDB embeddings and symbol indexes for rapid offline search and code navigation.
---

# Codebase Indexing (`codebase-indexing`)

## Overview
This skill is the usage doctrine for the `local-memory-indexer` MCP server. Coordinates
background parsing and vector indexing of the Drupal codebase into LanceDB and SQLite.
Extracts PHP AST symbols, classes, services, hooks, and YAML definitions for instantaneous
offline semantic and keyword search.

## Activation Triggers
Activate this skill when:
- Navigating an unindexed or newly cloned Drupal project repository.
- Re-indexing after significant cross-module refactoring or Drupal core major upgrades.
- Diagnosing corrupted symbol caches or missing semantic chunk embeddings.

## Input Contract (Draft-07 JSON Schema)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CodebaseIndexingInput",
  "type": "object",
  "required": ["operation", "project_path"],
  "additionalProperties": false,
  "properties": {
    "operation": {"type": "string", "enum": ["start_indexing", "pause_indexing",
                   "resume_indexing", "get_indexing_status", "doctor_index",
                   "delete_project_index"]},
    "project_path": {"type": "string"}
  }
}
```

## Output Contract (Draft-07 JSON Schema)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CodebaseIndexingOutput",
  "type": "object",
  "required": ["operation", "status"],
  "additionalProperties": false,
  "properties": {
    "operation": {"type": "string"},
    "status": {"type": "object"},
    "doctor_report": {"type": "object"}
  }
}
```

## Design-by-Contract (DbC)

### Preconditions (requires)
- `operation` is one of the 6 registered tool names: `start_indexing`, `pause_indexing`,
  `resume_indexing`, `get_indexing_status`, `doctor_index`, `delete_project_index`.

### Postconditions (ensures)
- Index storage is confined to the indexer's configured data root
  (`LOCAL_VECTOR_SEARCH_DATA_ROOT`, default `~/.agent-forge/local-memory-search`), laid out as
  `<dataRoot>/<slugified project path>/{state.db, lancedb/}`, and never inside the Drupal
  project tree.

### Invariants
- `codebase-indexing` and `codebase-search` share the same data root; a one-sided override of
  either server's data root yields an empty index for the other.

## Procedure
1. Start Indexing:
   - Call `local-memory-indexer:start_indexing(project_path: <input.project_path>)`
2. Pause Indexing:
   - Call `local-memory-indexer:pause_indexing(project_path: <input.project_path>)`
3. Resume Indexing:
   - Call `local-memory-indexer:resume_indexing(project_path: <input.project_path>)`
4. Get Indexing Status:
   - Call `local-memory-indexer:get_indexing_status(project_path: <input.project_path>)`
5. Doctor Index:
   - Call `local-memory-indexer:doctor_index(project_path: <input.project_path>)`
6. Delete Project Index:
   - Call `local-memory-indexer:delete_project_index(project_path: <input.project_path>)`

## Failure Modes
| Code | Trigger | Detection | Recovery | Terminal? |
|------|---------|-----------|----------|-----------|
| INDEXING_STALLED | get_indexing_status shows no progress across repeated polls | Poll comparison | Call doctor_index, then resume_indexing | no |
| CORRUPTED_INDEX | doctor_index reports integrity failure | Step 5 output | delete_project_index then start_indexing | no |
| PROJECT_PATH_MISSING | project_path not supplied | Precondition check | Reject request | yes |
| INDEXER_UNAVAILABLE | local-memory-indexer MCP server unreachable | Tool call error | Retry once, then escalate to circuit-breaker | yes |
