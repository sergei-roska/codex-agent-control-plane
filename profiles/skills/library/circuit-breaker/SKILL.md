---
name: circuit-breaker
description: Software engineering skill implementing the classic Circuit Breaker pattern for autonomous agent tool invocations, external API calls, and subagent dispatches, featuring failure threshold monitoring, cooldown canary probes, and automatic fallback diversion.
---

# Circuit Breaker Pattern (circuit-breaker)

## 1. Domain Problem & Scope

### 1.1. Context & Cascading Failure Modes
Autonomous agents interacting with external environments (MCP tools, remote REST APIs, databases, subagent orchestrations) face transient and sustained external degradation. Without a circuit breaker, agentic workflows manifest critical failure patterns:
1. **Infinite Retry Storms**: An agent repeatedly calling a failing tool (e.g., 500 Internal Server Error or rate-limit HTTP 429), consuming context window tokens and API budget without making forward progress.
2. **Cascading Outages**: Slow or hung downstream tools holding connection pools and execution threads, propagating latency up the agent call chain until the entire workflow deadlocks.
3. **Uncontrolled Hallucinatory Compensations**: When tools fail without deterministic error signals, LLM agents often invent synthetic responses or hallucinate successful tool completions.

### 1.2. Scope & Behavioral Boundaries
The `circuit-breaker` pattern provides a stateful protective wrapper around sensitive tool invocations, network operations, or subagent tasks:
- Intercepts every outgoing call to the protected target.
- Tracks consecutive failures, error rates, and latency anomalies.
- Fast-fails requests when the protected dependency is unhealthy (`OPEN` state), immediately invoking a deterministic fallback without calling the degraded dependency.
- Periodically executes a controlled canary probe (`HALF_OPEN` state) to verify dependency recovery before resuming normal operations (`CLOSED` state).

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Wrapping external network APIs, LLM API calls, or MCP server tools prone to intermittent outages or throttling.
- Subagent delegation pipelines where repeated subagent failures must trip to a simplified local fallback.
- Commands or operations demanding protection against cascading failure and runaway token expenditure.
- Explicit keywords: "circuit breaker", "trip circuit", "handle cascading failures", "fail-fast on repeated errors", "cooldown canary probe".

### 2.2. Negative Triggers
- Pure in-memory deterministic operations (e.g., regex matching, local mathematical computations) that cannot fail due to environmental degradation.
- Idempotent single-retry operations where a simple immediate retry policy with jitter is sufficient.
- Multi-phase transactional rollbacks across multiple files requiring `two-phase-commit` or `saga-transaction-manager`.

---

## 3. Invariants & Non-Negotiable Rules

1. **FAIL_FAST_WHEN_OPEN = MANDATORY**: When the circuit is in the `OPEN` state and cooldown has not elapsed, calls to the protected dependency must be blocked immediately without network or tool invocation. Defect code: `CIRCUIT_OPEN_REJECT`.
2. **DETERMINISTIC_FALLBACK = MANDATORY**: Every protected invocation must specify an executable fallback procedure (e.g., return cached value, return graceful degraded stub, or trigger an alternative provider). If the fallback fails, emit `FALLBACK_EXECUTION_FAILED`.
3. **CONSECUTIVE_FAILURE_ACCOUNTING = MANDATORY**: Consecutive failures must be tracked monotonically. If `consecutive_failures >= failure_threshold`, the circuit must transition to `OPEN` immediately.
4. **COOLDOWN_CANARY_PROBING = MANDATORY**: Once in `OPEN`, the circuit must remain closed to requests for `cooldown_period_ms`. Upon expiration, exactly one request transitions the circuit to `HALF_OPEN` as a canary probe.
5. **ZERO_SILENT_FAILURES = MANDATORY**: All state transitions (`CLOSED -> OPEN`, `OPEN -> HALF_OPEN`, `HALF_OPEN -> CLOSED`, `HALF_OPEN -> OPEN`) must emit structured telemetry logs.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Circuit Configuration Schema (`CircuitBreakerConfig`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CircuitBreakerConfig",
  "type": "object",
  "required": ["circuit_id", "target_name", "failure_threshold", "cooldown_period_ms"],
  "properties": {
    "circuit_id": { "type": "string", "pattern": "^cb-[a-zA-Z0-9_-]+$" },
    "target_name": { "type": "string" },
    "failure_threshold": { "type": "integer", "minimum": 1, "default": 3 },
    "cooldown_period_ms": { "type": "integer", "minimum": 100, "default": 30000 },
    "half_open_success_threshold": { "type": "integer", "minimum": 1, "default": 1 },
    "call_timeout_ms": { "type": "integer", "minimum": 50, "default": 10000 },
    "fallback_strategy": {
      "type": "string",
      "enum": ["CACHED_VALUE", "STATIC_STUB", "SECONDARY_PROVIDER", "FAIL_FAST_ERROR"]
    }
  },
  "additionalProperties": false
}
```

### 4.2. Circuit State Snapshot Schema (`CircuitStateSnapshot`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CircuitStateSnapshot",
  "type": "object",
  "required": [
    "circuit_id",
    "state",
    "consecutive_failures",
    "consecutive_successes",
    "last_state_change_utc",
    "total_calls",
    "total_fallbacks"
  ],
  "properties": {
    "circuit_id": { "type": "string" },
    "state": { "type": "string", "enum": ["CLOSED", "OPEN", "HALF_OPEN"] },
    "consecutive_failures": { "type": "integer", "minimum": 0 },
    "consecutive_successes": { "type": "integer", "minimum": 0 },
    "last_failure_timestamp_utc": { "type": ["string", "null"], "format": "date-time" },
    "last_state_change_utc": { "type": "string", "format": "date-time" },
    "total_calls": { "type": "integer", "minimum": 0 },
    "total_fallbacks": { "type": "integer", "minimum": 0 }
  },
  "additionalProperties": false
}
```

### 4.3. Circuit Breaker Defect Report (`CircuitBreakerDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "CircuitBreakerDefectReport",
  "type": "object",
  "required": ["defect_id", "circuit_id", "violation_code", "current_state", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "circuit_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "CIRCUIT_OPEN_REJECT",
        "CIRCUIT_TRIPPED",
        "CANARY_PROBE_FAILED",
        "CALL_TIMEOUT_EXCEEDED",
        "FALLBACK_EXECUTION_FAILED",
        "CONFIG_VALIDATION_ERROR"
      ]
    },
    "current_state": { "type": "string", "enum": ["CLOSED", "OPEN", "HALF_OPEN"] },
    "error_message": { "type": "string" },
    "target_invocation": { "type": ["object", "null"] },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal State Machine

```text
       +--------------------+
       |       CLOSED       |<----------------------------+
       +--------------------+                             |
         |                ^                               |
         | Failures >= N  | Success in HALF_OPEN          |
         | (Trip)         | (Recovered)                   |
         v                |                               |
       +--------------------+                             |
       |        OPEN        |                             |
       +--------------------+                             |
         |                                                |
         | Cooldown elapsed                               |
         v                                                |
       +--------------------+                             |
       |     HALF_OPEN      |-----------------------------+
       +--------------------+
         |
         | Failure during canary probe
         v
       (Trip back to OPEN, reset cooldown)
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `CLOSED` | `EXECUTE_SUCCESS` | Operation completes without error | `CLOSED` | Reset `consecutive_failures = 0`, increment `total_calls`. |
| `CLOSED` | `EXECUTE_FAILURE` | consecutive_failures + 1 < failure_threshold | `CLOSED` | Increment `consecutive_failures += 1`. Record error. |
| `CLOSED` | `EXECUTE_FAILURE` | consecutive_failures + 1 >= failure_threshold | `OPEN` | Set `state = OPEN`, record `last_state_change_utc = now()`. Emit `CIRCUIT_TRIPPED`. |
| `OPEN` | `CALL_ATTEMPT` | elapsed_time < cooldown_period_ms | `OPEN` | Reject call immediately. Execute fallback. Emit `CIRCUIT_OPEN_REJECT`. |
| `OPEN` | `CALL_ATTEMPT` | elapsed_time >= cooldown_period_ms | `HALF_OPEN` | Transition to `HALF_OPEN`. Dispatch call as single canary probe. |
| `HALF_OPEN` | `CANARY_SUCCESS` | consecutive_successes + 1 >= half_open_success_threshold | `CLOSED` | Reset `consecutive_failures = 0`, reset `consecutive_successes = 0`. Emit `CIRCUIT_RECOVERED`. |
| `HALF_OPEN` | `CANARY_FAILURE` | Canary probe throws error or times out | `OPEN` | Record `last_state_change_utc = now()`. Reset cooldown timer. Emit `CANARY_PROBE_FAILED`. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Pre-Invocation Guard Evaluation
1. Intercept request for target tool or function `invoke(params)`.
2. Inspect current circuit state:
   - **Case A: State is CLOSED**:
     - Allow invocation to proceed to Step 2.
   - **Case B: State is OPEN**:
     - Compute `elapsed_ms = now() - last_state_change_utc`.
     - IF `elapsed_ms < cooldown_period_ms`:
       - Increment `total_fallbacks += 1`.
       - Emit log: `[CIRCUIT_BLOCKED] Circuit: [circuit_id] Reason: Circuit is OPEN (cooldown remaining: [cooldown - elapsed]ms)`.
       - Execute Step 4 (Fallback Dispatch).
     - ELSE (`elapsed_ms >= cooldown_period_ms`):
       - Transition `state = HALF_OPEN`.
       - Emit log: `[CIRCUIT_CANARY_INIT] Circuit: [circuit_id] State: HALF_OPEN probing target`.
       - Proceed to Step 2 (as canary probe).
   - **Case C: State is HALF_OPEN**:
     - IF another canary probe is already in-flight:
       - Reject concurrent request; execute Step 4 (Fallback Dispatch).
     - ELSE:
       - Proceed to Step 2.

### Step 2: Target Execution Wrapper
1. Set call execution deadline: `deadline = now() + call_timeout_ms`.
2. Execute target operation within try/except block.
3. IF execution exceeds `call_timeout_ms`:
   - Raise `CALL_TIMEOUT_EXCEEDED`.
4. Capture outcome: `SUCCESS` or `FAILURE(error_details)`.
5. Proceed to Step 3 (Outcome Accounting).

### Step 3: Outcome Accounting & State Update
- **If Outcome == SUCCESS**:
  - IF current state was `CLOSED`:
    - Set `consecutive_failures = 0`.
    - Return target result to caller.
  - IF current state was `HALF_OPEN`:
    - Increment `consecutive_successes += 1`.
    - IF `consecutive_successes >= half_open_success_threshold`:
      - Transition `state = CLOSED`.
      - Reset `consecutive_failures = 0`, `consecutive_successes = 0`.
      - Emit log marker: `[CIRCUIT_RECOVERED] Circuit: [circuit_id] Target: [target_name] resumed normal operation`.
    - Return target result to caller.
- **If Outcome == FAILURE**:
  - IF current state was `CLOSED`:
    - Increment `consecutive_failures += 1`.
    - Record `last_failure_timestamp_utc = now()`.
    - IF `consecutive_failures >= failure_threshold`:
      - Transition `state = OPEN`.
      - Set `last_state_change_utc = now()`.
      - Emit log marker: `=== CIRCUIT TRIPPED TO OPEN: [circuit_id] ConsecutiveFailures: [consecutive_failures] ===`.
      - Emit Defect Report: `CIRCUIT_TRIPPED`.
    - Execute Step 4 (Fallback Dispatch).
  - IF current state was `HALF_OPEN`:
    - Transition `state = OPEN`.
    - Set `last_state_change_utc = now()`.
    - Reset `consecutive_successes = 0`.
    - Emit log marker: `[CANARY_PROBE_FAILED] Circuit: [circuit_id] Probe failed: [error_details]. Re-tripping to OPEN`.
    - Emit Defect Report: `CANARY_PROBE_FAILED`.
    - Execute Step 4 (Fallback Dispatch).

### Step 4: Fallback Dispatch
1. Increment `total_fallbacks += 1`.
2. Inspect configured `fallback_strategy`:
   - `CACHED_VALUE`: Retrieve last verified valid response from local cache.
   - `STATIC_STUB`: Return declared deterministic default stub response.
   - `SECONDARY_PROVIDER`: Dispatch request to configured standby secondary provider.
   - `FAIL_FAST_ERROR`: Return structured error envelope to caller immediately.
3. IF fallback execution raises an exception:
   - Emit Defect Report: `FALLBACK_EXECUTION_FAILED`.
   - Return fatal error envelope to caller.
4. Return fallback response with header `X-Circuit-Fallback: TRUE`.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== CIRCUIT BREAKER REGISTERED: [circuit_id] Target: [target_name] ===`
- `[CIRCUIT_INVOKE] Circuit: [circuit_id] State: [state]`
- `[CIRCUIT_BLOCKED] Circuit: [circuit_id] Reason: OPEN CooldownRemaining: [ms]`
- `=== CIRCUIT TRIPPED TO OPEN: [circuit_id] Failures: [count] ===`
- `[CIRCUIT_CANARY_INIT] Circuit: [circuit_id] State: HALF_OPEN`
- `[CANARY_PROBE_FAILED] Circuit: [circuit_id] Target: [target_name]`
- `[CIRCUIT_RECOVERED] Circuit: [circuit_id] State: CLOSED`
- `[FALLBACK_EXECUTED] Circuit: [circuit_id] Strategy: [strategy]`

### 7.2. Defect Codes
- `CIRCUIT_OPEN_REJECT`: Call rejected immediately because circuit is OPEN and cooldown has not expired.
- `CIRCUIT_TRIPPED`: Consecutive failure threshold reached; circuit tripped from CLOSED to OPEN.
- `CANARY_PROBE_FAILED`: Canary probe failed in HALF_OPEN state; circuit returned to OPEN.
- `CALL_TIMEOUT_EXCEEDED`: Protected call failed to respond within `call_timeout_ms`.
- `FALLBACK_EXECUTION_FAILED`: The fallback procedure threw an uncaught error.
- `CONFIG_VALIDATION_ERROR`: Invalid parameters provided in `CircuitBreakerConfig`.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Tripping on 3 Consecutive MCP Tool Timeouts
**Configuration**:
- `circuit_id`: `cb-mcp-weather`
- `target_name`: `mcp-weather`
- `failure_threshold`: 3
- `cooldown_period_ms`: 15000
- `fallback_strategy`: `CACHED_VALUE`

**Trace**:
1. Call 1 to `mcp-weather` times out (10000ms). `consecutive_failures = 1`. State remains `CLOSED`. Fallback returns cache.
2. Call 2 times out (10000ms). `consecutive_failures = 2`. State remains `CLOSED`. Fallback returns cache.
3. Call 3 times out (10000ms). `consecutive_failures = 3`. Threshold met!
   - State transitions to `OPEN`.
   - Telemetry emitted: `=== CIRCUIT TRIPPED TO OPEN: cb-mcp-weather ConsecutiveFailures: 3 ===`.
   - Fallback returns cached weather data.
4. Call 4 arrives 2 seconds later (elapsed 2000ms < 15000ms):
   - Blocked immediately in 0ms without invoking MCP tool.
   - Telemetry: `[CIRCUIT_BLOCKED] Circuit: cb-mcp-weather Reason: OPEN CooldownRemaining: 13000ms`.
   - Fallback returns cache immediately.

### 8.2. Scenario 2: Successful Recovery via Canary Probe
**Trace (continued from Scenario 1)**:
1. Call 5 arrives at elapsed time 16000ms (> 15000ms cooldown).
2. Circuit transitions from `OPEN` to `HALF_OPEN`.
3. Telemetry: `[CIRCUIT_CANARY_INIT] Circuit: cb-mcp-weather State: HALF_OPEN probing target`.
4. Canary probe executes against `mcp-weather`. Tool responds with HTTP 200 in 150ms.
5. Outcome == `SUCCESS`. `consecutive_successes = 1 >= 1`.
6. Circuit transitions from `HALF_OPEN` to `CLOSED`.
7. Telemetry: `[CIRCUIT_RECOVERED] Circuit: cb-mcp-weather Target: mcp-weather resumed normal operation`.
8. Fresh live response returned to caller. Subsequent calls route normally.
