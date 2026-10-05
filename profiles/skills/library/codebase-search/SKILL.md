---
name: codebase-search
description: Deep codebase intelligence skill using the local-memory-search MCP server. Performs hybrid vector and BM25 search, caller and callee dependency graph tracing, and context pack assembly.
---

# Codebase Search (`codebase-search`)

## Overview
This skill is the usage doctrine for the `local-memory-search` MCP server. Perform hybrid
semantic vector and exact BM25 keyword searches across indexed Drupal codebases. Resolves
caller/callee trees, import hierarchies, and token-bounded context packs.

## Activation Triggers
Activate this skill when:
- Finding service implementations, interface usages, and event subscribers across custom and
  core modules.
- Tracing all callers of a method before refactoring or changing method signatures.
- Assembling bounded context packs for subagent pointer dispatches.

## Input Contract (Draft-07 JSON Schema)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CodebaseSearchInput",
  "type": "object",
  "required": ["query", "project_path"],
  "additionalProperties": false,
  "properties": {
    "query": {"type": "string"},
    "project_path": {"type": "string"},
    "chunk_id": {"type": "string"},
    "symbol": {"type": "string"}
  }
}
```

## Output Contract (Draft-07 JSON Schema)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "CodebaseSearchOutput",
  "type": "object",
  "required": ["query", "results"],
  "additionalProperties": false,
  "properties": {
    "query": {"type": "string"},
    "results": {"type": "array", "items": {"type": "object"}},
    "context_pack": {"type": "object"}
  }
}
```

## Design-by-Contract (DbC)

### Preconditions (requires)
- `project_path` is always supplied and validated by the server before any search tool is
  called; a search skill that never scopes its project is under-specified.

### Postconditions (ensures)
- Every result set traces back to a `chunk_id` resolvable by `get_chunk`.

### Invariants
- The parameter name is always `query`, never `query_or_symbol`; the identifier
  `query_or_symbol` does not exist in the server.

## Procedure
1. Hybrid Search:
   - Call `local-memory-search:search_hybrid(query: <input.query>, project_path:
     <input.project_path>)`
2. Semantic Search:
   - Call `local-memory-search:search_semantic(query: <input.query>, project_path:
     <input.project_path>)`
3. Keyword Search:
   - Call `local-memory-search:search_keyword(query: <input.query>, project_path:
     <input.project_path>)`
4. Retrieve Context Pack:
   - Call `local-memory-search:retrieve_context_pack(query: <input.query>, project_path:
     <input.project_path>)`
5. Get Chunk:
   - Call `local-memory-search:get_chunk(chunk_id: <input.chunk_id>, project_path:
     <input.project_path>)`
6. Read Chunk Neighbors:
   - Call `local-memory-search:read_chunk_neighbors(chunk_id: <input.chunk_id>, project_path:
     <input.project_path>)`
7. Find Callers:
   - Call `local-memory-search:find_callers(symbol: <input.symbol>, project_path:
     <input.project_path>)`
8. Find Callees:
   - Call `local-memory-search:find_callees(symbol: <input.symbol>, project_path:
     <input.project_path>)`
9. Get Import Graph:
   - Call `local-memory-search:get_import_graph(project_path: <input.project_path>)`
10. Trace Path:
    - Call `local-memory-search:trace_path(symbol: <input.symbol>, project_path:
      <input.project_path>)`
11. Explain Match:
    - Call `local-memory-search:explain_match(chunk_id: <input.chunk_id>, project_path:
      <input.project_path>)`
12. Index Status:
    - Call `local-memory-search:index_status(project_path: <input.project_path>)`
13. Health Check:
    - Call `local-memory-search:health_check(project_path: <input.project_path>)`

## Failure Modes
| Code | Trigger | Detection | Recovery | Terminal? |
|------|---------|-----------|----------|-----------|
| PROJECT_PATH_MISSING | project_path not supplied | Precondition check | Reject request | yes |
| INDEX_NOT_READY | index_status reports incomplete indexing | Step 12 output | Delegate to codebase-indexing to complete indexing | no |
| CHUNK_NOT_FOUND | get_chunk cannot resolve chunk_id | Tool returns empty | Fall back to search_hybrid to relocate the chunk | no |
| SEARCH_SERVER_UNAVAILABLE | local-memory-search MCP server unreachable | Tool call error | Retry once, then escalate to circuit-breaker | yes |
