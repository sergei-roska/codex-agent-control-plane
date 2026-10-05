---
name: supervisor-tree
description: A software engineering skill implementing Erlang/OTP Actor Supervision trees for autonomous multi-agent systems, enforcing restart intensity bounds, deterministic recovery strategies (one-for-one, one-for-all, rest-for-one), and zero-zombie process reaping.
---

# Specification: Supervisor Tree Architecture (supervisor-tree)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
In complex multi-agent architectures, worker subagents and background tool processes crash due to unexpected exceptions, memory exhaustion, network timeouts, or malformed inputs. Without an Erlang/OTP-style supervision tree, systems suffer fatal operational failures:
1. **Runaway Zombie Processes**: A subagent crashes or is aborted, but its spawned child subtasks or background shell commands remain running as orphaned zombie processes, consuming memory, locks, and CPU indefinitely.
2. **Infinite Respawn Death Spirals**: A worker crashes immediately on startup due to a malformed configuration file; an unconstrained supervisor continuously respawns it 10,000 times per minute, locking the host machine and exhausting token quotas.
3. **Interdependent Sibling Desynchronization**: In a pipeline where Worker B depends on an in-memory queue fed by Worker A, Worker A crashes and restarts with an empty queue, but Worker B continues running with stale state, producing silent corruptions.
4. **Lack of Controlled Failure Escalation**: When a subsystem experiences catastrophic unrecoverable failure, errors are silently swallowed rather than cleanly escalating up the hierarchy to human operators or parent supervisors.

### 1.2. Scope & Behavioral Boundaries
The `supervisor-tree` pattern implements Erlang/OTP fault-tolerant Actor Supervision:
- **Hierarchical Tree Structure**: Supervisors manage the complete lifecycle (start, monitor, terminate, restart) of declared child processes (workers or nested sub-supervisors).
- **Deterministic Recovery Strategies**:
  - `one-for-one`: If a child crashes, only that specific child is terminated and restarted.
  - `one-for-all`: If any child crashes, all sibling children in the pool are terminated, and all are restarted in order.
  - `rest-for-one`: If child k crashes, any sibling child started after k in topological order (k+1..M) is terminated, and child k through M are restarted.
- **Restart Intensity Boundaries**: Enforces a strict limit on restart frequency: `max_restarts` within `time_window_seconds`. If the intensity ceiling is breached, the supervisor halts all children and crashes itself (`SUPERVISOR_CRASH`), escalating failure to its parent.
- **Zero Zombie Process Guarantee**: Before respawning any worker, all existing process handles, open sockets, and temporary locks belonging to the child are explicitly terminated and verified reaped.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Multi-agent topologies with long-running background workers, queue consumers, and monitoring agents.
- Critical services requiring guaranteed self-healing, crash isolation, and deterministic lifecycle restarts.
- Clusters with interdependent worker processes requiring coordinated resets (`one-for-all` or `rest-for-one`).
- Explicit keywords: "supervisor tree", "actor supervision", "manage agent lifecycle", "restart failed agents", "fault tolerant agent hierarchy", "erlang otp supervision".

### 2.2. Negative Triggers
- Short-lived, linear single-step scripts without background lifecycles.
- Stateless batch tasks with no persistent workers (`fork-join`).
- Workflows where crashed operations must simply be quarantined without respawning (`dead-letter-queue`).

---

## 3. Invariants & Non-Negotiable Rules

1. **RESTART_INTENSITY_CEILING = MANDATORY**: Cumulative restarts within `time_window_seconds` must strictly not exceed `max_restarts`. Breaching this threshold causes the supervisor to crash and terminate all children. Violation code: `RESTART_INTENSITY_EXCEEDED`.
2. **DETERMINISTIC_STRATEGY_ENFORCEMENT = MANDATORY**: When a worker fails, the supervisor must execute the declared recovery strategy (`one-for-one`, `one-for-all`, or `rest-for-one`) without improvisation.
3. **ZERO_ZOMBIE_TASKS = MANDATORY**: Terminating a worker must explicitly reap all child processes and subtasks before a replacement is spawned.
4. **TOPOLOGICAL_START_ORDER = MANDATORY**: Children must be started in declared specification order (1..M) and terminated in reverse order (M..1).
5. **RESTART_POLICY_CLASSIFICATION = MANDATORY**: Every child must declare an explicit restart policy:
   - `PERMANENT`: Always restarted regardless of exit reason.
   - `TRANSIENT`: Restarted only if exiting with an error/abnormal code.
   - `TEMPORARY`: Never restarted, regardless of exit status.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Supervisor Configuration Schema (`SupervisorConfig`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SupervisorConfig",
  "type": "object",
  "required": [
    "supervisor_id",
    "strategy",
    "max_restarts",
    "time_window_seconds",
    "children"
  ],
  "properties": {
    "supervisor_id": { "type": "string", "pattern": "^sup-[a-zA-Z0-9_-]+$" },
    "strategy": { "type": "string", "enum": ["one-for-one", "one-for-all", "rest-for-one"] },
    "max_restarts": { "type": "integer", "minimum": 1, "default": 3 },
    "time_window_seconds": { "type": "integer", "minimum": 1, "default": 60 },
    "children": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["child_id", "start_command", "restart_policy", "shutdown_timeout_ms"],
        "properties": {
          "child_id": { "type": "string" },
          "start_command": { "type": "string" },
          "restart_policy": { "type": "string", "enum": ["PERMANENT", "TRANSIENT", "TEMPORARY"] },
          "shutdown_timeout_ms": { "type": "integer", "minimum": 100, "default": 5000 },
          "type": { "type": "string", "enum": ["WORKER", "SUPERVISOR"], "default": "WORKER" }
        },
        "additionalProperties": false
      },
      "minItems": 1
    }
  },
  "additionalProperties": false
}
```

### 4.2. Child State Record Schema (`ChildStateRecord`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ChildStateRecord",
  "type": "object",
  "required": [
    "child_id",
    "pid_or_handle",
    "status",
    "start_order",
    "restart_count",
    "last_started_at_utc"
  ],
  "properties": {
    "child_id": { "type": "string" },
    "pid_or_handle": { "type": ["string", "integer", "null"] },
    "status": { "type": "string", "enum": ["RUNNING", "TERMINATING", "TERMINATED", "CRASHED", "RESTARTING"] },
    "start_order": { "type": "integer", "minimum": 1 },
    "restart_count": { "type": "integer", "minimum": 0 },
    "last_started_at_utc": { "type": "string", "format": "date-time" },
    "last_exit_code": { "type": ["integer", "null"] },
    "last_exit_reason": { "type": ["string", "null"] }
  },
  "additionalProperties": false
}
```

### 4.3. Supervisor Defect Report Schema (`SupervisorDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SupervisorDefectReport",
  "type": "object",
  "required": ["defect_id", "supervisor_id", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "supervisor_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "SUPERVISOR_CRASH",
        "RESTART_INTENSITY_EXCEEDED",
        "ZOMBIE_PROCESS_LEAK",
        "INVALID_CHILD_SPEC",
        "SHUTDOWN_TIMEOUT_EXCEEDED"
      ]
    },
    "failed_child_id": { "type": ["string", "null"] },
    "restart_history": { "type": "array", "items": { "type": "string" } },
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
                 | Event: START_SUPERVISOR (Spawn children in topological order 1..M)
                 v
       +--------------------+
+----->|      RUNNING       |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: CHILD_CRASHED(child_k)           |
|                v                                         |
|      +--------------------+                              |
|      | EVAL_INTENSITY     |                              |
|      +--------------------+                              |
|         /                \                               |
|        / Intensity <= Max \ Intensity > Max (Threshold)  |
|       v                    v                             |
| +------------+     +-------------------+                 |
| | APPLY_STRAT|     | SUPERVISOR_CRASH  |                 |
| +------------+     +-------------------+                 |
|       |                                                  |
|       | Strategy selects victims to stop                 |
|       v                                                  |
| +------------+                                           |
| | REAP_TARGET| (Graceful stop + SIGKILL fallback)        |
| +------------+                                           |
|       |                                                  |
|       | Zero zombies verified                            |
|       v                                                  |
| +------------+                                           |
| | RESPAWN    |-------------------------------------------+
| +------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `UNINITIALIZED` | `START_SUP` | Children specs valid | `RUNNING` | Spawn children sequentially 1..M; start monitoring. |
| `RUNNING` | `CHILD_EXIT_NORMAL` | child.restart_policy == TEMPORARY or TRANSIENT | `RUNNING` | Mark child TERMINATED; do not restart. |
| `RUNNING` | `CHILD_EXIT_ERROR` | child.restart_policy in [PERMANENT, TRANSIENT] | `EVAL_INTENSITY` | Ingest exit event; append timestamp to restart window. |
| `EVAL_INTENSITY` | `WITHIN_LIMIT` | restarts_in_window <= max_restarts | `APPLY_STRAT` | Select children to terminate based on strategy. |
| `EVAL_INTENSITY` | `LIMIT_BREACHED`| restarts_in_window > max_restarts | `SUPERVISOR_CRASH`| Kill all children; emit `RESTART_INTENSITY_EXCEEDED`; halt. |
| `APPLY_STRAT` | `RESOLVE_VICTIMS`| strategy == "one-for-one" | `REAP_TARGET` | Victims = [failed_child]. |
| `APPLY_STRAT` | `RESOLVE_VICTIMS`| strategy == "one-for-all" | `REAP_TARGET` | Victims = [all_children]. Terminate in reverse order M..1. |
| `APPLY_STRAT` | `RESOLVE_VICTIMS`| strategy == "rest-for-one" | `REAP_TARGET` | Victims = [failed_child + subsequent siblings]. Reverse stop. |
| `REAP_TARGET` | `REAP_CONFIRMED` | All victims dead, zero zombies | `RESPAWN` | Start replacement instances in declared order 1..M. |
| `RESPAWN` | `ALL_RUNNING` | Heartbeat verified on all children | `RUNNING` | Resume normal monitoring loop. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Supervisor Topology Initialization
1. Ingest `SupervisorConfig`.
2. Validate child specifications:
   - Ensure unique `child_id` strings.
   - Verify commands and timeouts.
3. Initialize restart tracking sliding window: `restart_timestamps = []`.
4. For each child in `config.children` (order 1 to M):
   - Invoke `start_command`.
   - Record process handle/PID in `ChildStateRecord`.
   - Assert child becomes healthy before starting next child.
   - Emit log marker: `[CHILD_STARTED] ChildId: [child.child_id] Order: [i]/[M]`.
5. Transition state to `RUNNING`.
6. Emit log marker: `=== SUPERVISOR RUNNING: [supervisor_id] Strategy: [strategy] Children: [M] ===`.

### Step 2: Child Failure Interception & Intensity Check
1. Monitor child process events.
2. When child k exits:
   - Record `exit_code` and `timestamp = now()`.
   - IF exit is normal (code 0) AND policy is `TRANSIENT` or `TEMPORARY`:
     - Mark `status = TERMINATED`. Do not restart. Continue monitoring.
3. Child requires restart. Transition state to `EVAL_INTENSITY`.
4. Prune `restart_timestamps` older than `now() - time_window_seconds`.
5. Append `now()` to `restart_timestamps`.
6. IF `len(restart_timestamps) > max_restarts`:
   - Emit log marker: `=== SUPERVISOR INTENSITY BREACHED: Restarts: [len] Window: [time_window_seconds]s ===`.
   - Transition state to `SUPERVISOR_CRASH`.
   - For each active child in reverse order (M..1):
     - Forcefully terminate child process.
   - Emit Defect Report: `RESTART_INTENSITY_EXCEEDED`.
   - Crash supervisor process and escalate to parent.
7. Intensity verified within limits. Transition state to `APPLY_STRAT`.

### Step 3: Strategy-Driven Victim Selection
Inspect `config.strategy`:
- **one-for-one**:
  - `victims = [child_k]`
- **one-for-all**:
  - `victims = all_children_in_reverse_order(M downto 1)`
- **rest-for-one**:
  - `victims = children_started_at_or_after_k_in_reverse_order(M downto k)`
Transition state to `REAP_TARGET`.

### Step 4: Graceful Stopping & Zombie Reaping
1. For each `victim` in `victims`:
   - Emit log marker: `[TERMINATING_CHILD] ChildId: [victim.child_id]`.
   - Send termination signal (SIGTERM).
   - Wait up to `victim.shutdown_timeout_ms`.
   - IF process has not exited:
     - Issue hard kill (SIGKILL).
     - Verify process unlinked from OS process table.
   - Clean up temporary files, port bindings, and locks.
   - Assert zero zombie processes exist.
2. Transition state to `RESPAWN`.

### Step 5: Topological Respawn
1. Sort `victims` back into forward topological order (1..M).
2. For each `child` in `victims`:
   - Spawn fresh instance using `child.start_command`.
   - Increment `child.restart_count += 1`.
   - Verify health check / heartbeat.
   - Emit log marker: `[CHILD_RESPAWNED] ChildId: [child.child_id] RestartCount: [child.restart_count]`.
3. Transition state to `RUNNING`.
4. Emit log marker: `[TOPOLOGY_RESTORED] Supervisor: [supervisor_id] All children healthy`.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== SUPERVISOR INITIALIZED: [sup_id] Strategy: [strategy] ===`
- `[CHILD_STARTED] Child: [id] Order: [idx]`
- `[CHILD_CRASHED] Child: [id] ExitCode: [code] Reason: [reason]`
- `[TERMINATING_CHILD] Child: [id] TimeoutMs: [ms]`
- `[CHILD_RESPAWNED] Child: [id] Restarts: [count]`
- `[TOPOLOGY_RESTORED] Supervisor: [sup_id]`
- `=== SUPERVISOR CRASHED: [sup_id] Reason: INTENSITY_BREACHED ===`

### 7.2. Defect Codes
- `SUPERVISOR_CRASH`: The supervisor itself failed or terminated all workers due to unrecoverable fault.
- `RESTART_INTENSITY_EXCEEDED`: Children crashed more times than `max_restarts` within `time_window_seconds`.
- `ZOMBIE_PROCESS_LEAK`: Child process failed to terminate within shutdown timeout and resisted kill signal.
- `INVALID_CHILD_SPEC`: Malformed child specification schema or unexecutable start command.
- `SHUTDOWN_TIMEOUT_EXCEEDED`: Child required forceful SIGKILL after exceeding graceful shutdown window.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: One-for-One Recovery of a Stateless Worker
**Topology**:
- Strategy: `one-for-one`
- Children: `worker_parser`, `worker_indexer`
- `worker_indexer` encounters Out-Of-Memory exception and exits code 137.
- Execution:
  1. Supervisor intercepts crash of `worker_indexer`.
  2. Intensity check: 1 restart in 60s (Limit is 3). Permitted.
  3. Strategy `one-for-one`: Only `worker_indexer` is selected. `worker_parser` continues running uninterrupted.
  4. Memory and socket handles for `worker_indexer` purged.
  5. Replacement `worker_indexer` spawned. Heartbeat verified.
  6. Telemetry: `[CHILD_RESPAWNED] Child: worker_indexer Restarts: 1`.

### 8.2. Scenario 2: Rest-for-One Coordinated Reset
**Topology**:
- Strategy: `rest-for-one`
- Children: `1: db_connection_pool`, `2: auth_cache`, `3: http_api_gateway`
- Child 2 (`auth_cache`) crashes.
- Execution:
  1. Supervisor detects `auth_cache` crash.
  2. `rest-for-one` evaluates dependencies:
     - `db_connection_pool` (started before child 2) remains running.
     - `http_api_gateway` (started after child 2) must be terminated because it depends on the cache.
  3. Reverse stop: `http_api_gateway` stopped first, then `auth_cache` reaped.
  4. Forward respawn: `auth_cache` spawned, then `http_api_gateway` spawned.
  5. State consistency preserved; zero stale cache lookups in gateway.
