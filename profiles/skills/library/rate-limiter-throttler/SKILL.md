---
name: rate-limiter-throttler
description: Software engineering skill implementing deterministic Token Bucket and Sliding Window RPM rate limiting, context window budget control, and operational throttling for autonomous agents.
---

# Rate Limiter & Trajectory Throttler (rate-limiter-throttler)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
Autonomous agents executing multi-step tool calls and model queries operate without human micro-pacing. Without deterministic rate limiting and trajectory budgeting, agents trigger critical operational catastrophes:
1. **API Rate Limit Bans (HTTP 429)**: Hammering external LLM or tool APIs with burst requests exceeding Requests-Per-Minute (RPM) or Tokens-Per-Minute (TPM) limits, causing cascading outages.
2. **Runaway Financial Cost Overruns**: An agent stuck in an undetected loop consuming millions of prompt tokens in minutes, exhausting company API quotas or financial budgets.
3. **Thundering Herd Contention**: Multiple concurrent subagents dispatching simultaneous tool queries to a single local server, crashing the server process.
4. **Lack of Adaptive Backoff**: Failing to slow down when API response headers indicate 80%+ quota utilization, precipitating hard threshold lockouts.

### 1.2. Scope & Behavioral Boundaries
The `rate-limiter-throttler` pattern provides dual-layer pacing and budget control:
- **Token Bucket Algorithm**: Smooths request pacing and allows controlled bursts up to `token_bucket_capacity`, refilling tokens continuously at a deterministic rate:
  `AvailableTokens(t) = min(capacity, prev_tokens + delta_t * refill_rate)`.
- **Sliding Window RPM Counter**: Enforces a rigid ceiling on the absolute number of requests initiated within any rolling 60-second window.
- **Global Trajectory Budget**: Tracks cumulative token consumption and financial expenditure across the entire session lifecycle. If cumulative usage reaches `max_trajectory_tokens`, execution halts permanently.
- **Adaptive Jittered Backoff**: Enforces non-blocking asynchronous pauses when tokens are depleted or when upstream providers report quota throttling.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Interfacing with third-party rate-limited APIs (e.g., GitHub, LLM providers, search APIs).
- Orchestrating high-concurrency multi-agent swarms where aggregate throughput must be capped.
- Trajectories requiring strict cost caps and token expenditure ceilings.
- Explicit keywords: "rate limiter", "throttle operations", "context window budget control", "token budget throttling", "enforce rate limits", "rpm tpm limiter".

### 2.2. Negative Triggers
- Pure in-memory local data manipulations with zero external resource constraints.
- Real-time hard-deadline interrupt handlers where queuing or sleeping violates safety requirements.
- Read-only static queries inside an isolated container.

---

## 3. Invariants & Non-Negotiable Rules

1. **ZERO_QUOTA_OVERAGE = MANDATORY**: No tool invocation or LLM call may proceed without first obtaining an explicit permit from the rate limiter.
2. **GLOBAL_BUDGET_CEILING = MANDATORY**: When cumulative session consumption reaches `max_trajectory_tokens`, all subsequent mutating calls must halt with `TRAJECTORY_BUDGET_EXHAUSTED`.
3. **CONTINUOUS_FRACTIONAL_REFILL = MANDATORY**: The token bucket must refill proportionally to elapsed real time (`delta_t`) before evaluating permit requests.
4. **ADAPTIVE_JITTERED_BACKOFF = MANDATORY**: When capacity is temporarily depleted, the throttler must calculate the precise wait duration (`t_wait = tokens_needed / refill_rate + jitter`) rather than busy-polling.
5. **ATOMIC_PERMIT_RESERVATION = MANDATORY**: Permit checks and token deductions must be atomic to prevent concurrent race conditions across subagents.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Throttler Configuration Schema (`RateLimiterConfig`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "RateLimiterConfig",
  "type": "object",
  "required": [
    "limiter_id",
    "target_resource",
    "token_bucket_capacity",
    "refill_tokens_per_second",
    "max_rpm",
    "max_trajectory_tokens"
  ],
  "properties": {
    "limiter_id": { "type": "string", "pattern": "^rate-[a-zA-Z0-9_-]+$" },
    "target_resource": { "type": "string" },
    "token_bucket_capacity": { "type": "integer", "minimum": 1, "default": 60 },
    "refill_tokens_per_second": { "type": "number", "minimum": 0.01, "default": 1.0 },
    "max_rpm": { "type": "integer", "minimum": 1, "default": 60 },
    "max_trajectory_tokens": { "type": "integer", "minimum": 1000, "default": 500000 },
    "max_allowed_wait_ms": { "type": "integer", "minimum": 500, "default": 30000 }
  },
  "additionalProperties": false
}
```

### 4.2. Permit Receipt Schema (`PermitReceipt`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PermitReceipt",
  "type": "object",
  "required": [
    "permit_id",
    "limiter_id",
    "status",
    "tokens_granted",
    "wait_duration_ms",
    "remaining_bucket_tokens",
    "cumulative_trajectory_tokens",
    "granted_at_utc"
  ],
  "properties": {
    "permit_id": { "type": "string", "format": "uuid" },
    "limiter_id": { "type": "string" },
    "status": { "type": "string", "enum": ["GRANTED_IMMEDIATELY", "GRANTED_AFTER_THROTTLE", "REJECTED"] },
    "tokens_granted": { "type": "integer", "minimum": 1 },
    "wait_duration_ms": { "type": "integer", "minimum": 0 },
    "remaining_bucket_tokens": { "type": "number", "minimum": 0.0 },
    "cumulative_trajectory_tokens": { "type": "integer", "minimum": 0 },
    "granted_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. Throttler Defect Report Schema (`ThrottlerDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ThrottlerDefectReport",
  "type": "object",
  "required": ["defect_id", "limiter_id", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "limiter_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "RATE_LIMIT_EXCEEDED",
        "TRAJECTORY_BUDGET_EXHAUSTED",
        "BACKOFF_TIMEOUT_EXCEEDED",
        "RPM_QUOTA_BREACHED",
        "NEGATIVE_TOKEN_REQUEST_ERROR"
      ]
    },
    "tokens_requested": { "type": "integer" },
    "cumulative_consumed": { "type": "integer" },
    "trajectory_ceiling": { "type": "integer" },
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
                 | Event: INIT_LIMITER (Allocate capacity, reset counters)
                 v
       +--------------------+
+----->|       READY        |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: REQUEST_PERMIT(tokens)           |
|                v                                         |
|      +--------------------+                              |
|      | REFILL_BUCKET_TIME |                              |
|      +--------------------+                              |
|                |                                         |
|                | Check Trajectory Budget                 |
|                v                                         |
|         Exhausted?                                       |
|          /        \                                      |
|    Yes  /          \ No                                  |
|        v            v                                    |
| +------------+  +--------------------+                   |
| | BUDGET_HALT|  | CHECK_BUCKET_TOKENS|                   |
| +------------+  +--------------------+                   |
|                    /              \                      |
|                   / Enough Tokens  \ Tokens Depleted     |
|                  v                  v                    |
|          +------------+     +-------------------+        |
|          | DEDUCT_TOK |     | COMPUTE_BACKOFF   |        |
|          +------------+     +-------------------+        |
|                 |                     |                  |
|                 | Permit granted      | Wait <= max_wait |
|                 |                     v                  |
|                 |           +-------------------+        |
|                 |           |   ASYNC_SLEEP     |--------+
|                 |           +-------------------+
|                 |                     | Wait > max_wait
|                 |                     v
|                 |           +-------------------+
|                 |           | REJECT_OVERFLOW   |
|                 |           +-------------------+
|                 v
|          +------------+
|          |  EXECUTE   |
|          +------------+
|                 |
|                 | Reconcile exact observed usage
+-----------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `UNINITIALIZED` | `INIT` | Valid config parameters | `READY` | Set `bucket = capacity`, `cumulative = 0`, `last_refill = now()`. |
| `READY` | `REQUEST_PERMIT` | tokens > 0 | `EVAL_BUDGET` | Calculate refill: `bucket += delta_t * refill_rate`. |
| `EVAL_BUDGET` | `CHECK_BUDGET` | cumulative + tokens > max_trajectory_tokens | `BUDGET_HALT` | Emit `TRAJECTORY_BUDGET_EXHAUSTED` Defect Report; halt. |
| `EVAL_BUDGET` | `CHECK_BUDGET` | cumulative + tokens <= max_trajectory_tokens | `CHECK_CAPACITY` | Check bucket tokens and sliding RPM window. |
| `CHECK_CAPACITY` | `PERMIT_AVAILABLE` | bucket >= tokens AND rpm_calls < max_rpm | `READY` | Deduct `bucket -= tokens`; emit `GRANTED_IMMEDIATELY`. |
| `CHECK_CAPACITY` | `TOKENS_DEPLETED` | bucket < tokens OR rpm_calls >= max_rpm | `COMPUTE_BACKOFF` | Calculate required wait duration t_wait. |
| `COMPUTE_BACKOFF` | `WAIT_PERMITTED` | wait_ms <= max_allowed_wait_ms | `THROTTLING` | Execute asynchronous non-blocking sleep for wait_ms. |
| `COMPUTE_BACKOFF` | `WAIT_EXCESSIVE` | wait_ms > max_allowed_wait_ms | `READY` | Emit `BACKOFF_TIMEOUT_EXCEEDED` Defect Report; reject. |
| `THROTTLING` | `WAKE_UP` | Sleep duration elapsed | `READY` | Re-evaluate capacity; grant `GRANTED_AFTER_THROTTLE`. |
| `BUDGET_HALT` | `RESET_SESSION` | Session explicitly re-initialized | `READY` | Reset cumulative usage counters. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Pre-Invocation Token Refill & Budget Gate
1. Incoming request demands `requested_tokens` (default: 1 for RPM, or estimated tokens for LLM).
2. IF `requested_tokens <= 0`:
   - Emit Defect Report: `NEGATIVE_TOKEN_REQUEST_ERROR`. Halt.
3. Compute fractional refill:
   - `delta_t = now() - last_refill_timestamp`
   - `new_tokens = delta_t * refill_tokens_per_second`
   - `bucket_tokens = min(token_bucket_capacity, bucket_tokens + new_tokens)`
   - `last_refill_timestamp = now()`
4. Prune sliding RPM window:
   - Remove timestamp entries older than `now() - 60 seconds`.
5. Check global trajectory ceiling:
   - IF `cumulative_trajectory_tokens + requested_tokens > max_trajectory_tokens`:
     - Emit Defect Report: `TRAJECTORY_BUDGET_EXHAUSTED`.
     - Halt trajectory execution permanently.
6. Proceed to Step 2 (Capacity Assessment & Backoff Pacing).

### Step 2: Capacity Assessment & Backoff Pacing
1. Check permit condition:
   - `has_bucket_capacity = (bucket_tokens >= requested_tokens)`
   - `has_rpm_capacity = (len(rpm_timestamps) < max_rpm)`
2. **Case A: Both Conditions Satisfied (Immediate Grant)**:
   - Deduct bucket: `bucket_tokens -= requested_tokens`.
   - Append to RPM log: `rpm_timestamps.append(now())`.
   - Update cumulative: `cumulative_trajectory_tokens += requested_tokens`.
   - Emit log marker: `[PERMIT_GRANTED] Limiter: [limiter_id] Tokens: [requested_tokens] Status: GRANTED_IMMEDIATELY`.
   - Return `PermitReceipt(status="GRANTED_IMMEDIATELY", wait_duration_ms=0)`.
3. **Case B: Capacity Depleted (Throttled Backoff Required)**:
   - Compute required token deficit: `deficit = max(0.0, requested_tokens - bucket_tokens)`.
   - Compute wait time:
     - `token_wait_seconds = deficit / refill_tokens_per_second if deficit > 0 else 0.0`
     - `rpm_wait_seconds = (60.0 - (now() - rpm_timestamps[0])) if not has_rpm_capacity else 0.0`
     - `wait_seconds = max(token_wait_seconds, rpm_wait_seconds)`
   - Add jitter: `wait_ms = int(wait_seconds * 1000) + random_jitter(10, 50)`.
   - IF `wait_ms > max_allowed_wait_ms`:
     - Emit Defect Report: `BACKOFF_TIMEOUT_EXCEEDED`.
     - Reject request immediately.
   - Emit log marker: `[THROTTLE_ENGAGED] Limiter: [limiter_id] WaitMs: [wait_ms] Reason: [TOKENS | RPM]`.
   - Execute non-blocking sleep: `await sleep(wait_ms)`.
   - Upon wake up:
     - Deduct tokens and record timestamps.
     - Return `PermitReceipt(status="GRANTED_AFTER_THROTTLE", wait_duration_ms=wait_ms)`.

### Step 3: Post-Execution Reconciliation (Optional for LLM calls)
1. If actual observed token usage differs from estimated reservation:
   - Calculate delta: `delta = actual_tokens - requested_tokens`.
   - Adjust `cumulative_trajectory_tokens += delta`.
   - Adjust `bucket_tokens = max(0.0, bucket_tokens - delta)`.
2. Emit log marker: `[USAGE_RECONCILED] Limiter: [limiter_id] Delta: [delta] Cumulative: [cumulative_trajectory_tokens]`.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== RATE LIMITER INITIALIZED: [limiter_id] Target: [resource] ===`
- `[PERMIT_GRANTED] Limiter: [limiter_id] Tokens: [count] Status: [status]`
- `[THROTTLE_ENGAGED] Limiter: [limiter_id] WaitMs: [ms] Reason: [TOKENS | RPM]`
- `[USAGE_RECONCILED] Limiter: [limiter_id] Delta: [delta] Cumulative: [total]`
- `=== TRAJECTORY BUDGET EXHAUSTED: Limiter: [limiter_id] Ceiling: [ceiling] ===`

### 7.2. Defect Codes
- `RATE_LIMIT_EXCEEDED`: Upstream provider returned HTTP 429 despite local throttling.
- `TRAJECTORY_BUDGET_EXHAUSTED`: Cumulative tokens breached session cost ceiling.
- `BACKOFF_TIMEOUT_EXCEEDED`: Required throttle delay exceeded maximum wait threshold.
- `RPM_QUOTA_BREACHED`: Rolling 60-second request count exceeded maximum allowable RPM.
- `NEGATIVE_TOKEN_REQUEST_ERROR`: Invalid non-positive token permit requested.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Burst Pacing with Smooth Refill
**Configuration**:
- `limiter_id`: `rate-llm-primary`
- `target_resource`: `gpt-4o`
- `token_bucket_capacity`: 10
- `refill_tokens_per_second`: 2.0 (1 token every 500ms)
- `max_rpm`: 60
- `max_trajectory_tokens`: 50000

**Execution Trace**:
1. Initial bucket: 10 tokens.
2. Request 1 arrives: demands 8 tokens -> Granted immediately (2 tokens remaining).
   - Log: `[PERMIT_GRANTED] Limiter: rate-llm-primary Tokens: 8 Status: GRANTED_IMMEDIATELY`
3. Request 2 arrives 100ms later: demands 4 tokens.
   - Deficit: `4 - 2 = 2` tokens.
   - Wait time: `2 / 2.0 = 1.0s` (1000ms).
   - Throttler pauses for 1030ms (including jitter).
   - Log: `[THROTTLE_ENGAGED] Limiter: rate-llm-primary WaitMs: 1030 Reason: TOKENS`
   - Wakes up: bucket refilled to 4 tokens.
   - Granted: `GRANTED_AFTER_THROTTLE`.
   - Log: `[PERMIT_GRANTED] Limiter: rate-llm-primary Tokens: 4 Status: GRANTED_AFTER_THROTTLE`
4. Zero 429 errors encountered.

### 8.2. Scenario 2: Hard Trajectory Budget Halt
**Configuration**:
- `limiter_id`: `rate-search-agent`
- `max_trajectory_tokens`: 50000

**Execution Trace**:
1. Session has accumulated 49,500 tokens across 12 turns.
2. Turn 13 attempts to execute prompt requiring 1,200 tokens.
3. Check trajectory ceiling: `49500 + 1200 = 50700 > 50000`.
4. Throttler halts immediately without sending query to LLM.
5. Defect Report emitted: `TRAJECTORY_BUDGET_EXHAUSTED`.
6. Telemetry emitted: `=== TRAJECTORY BUDGET EXHAUSTED: Limiter: rate-search-agent Ceiling: 50000 ===`.
7. Trajectory halts permanently; runaway spend prevented.

### 8.3. Scenario 3: RPM Quota Exhaustion and Throttled Wait
**Configuration**:
- `limiter_id`: `rate-github-api`
- `max_rpm`: 10
- `max_allowed_wait_ms`: 30000

**Execution Trace**:
1. 10 requests dispatched within a 15-second burst.
2. Request 11 arrives demanding 1 token at second 20.
3. Bucket has capacity, but `rpm_timestamps` has 10 entries (at capacity).
4. Oldest entry is at `now() - 45s`, expiring in 15s (15000ms <= 30000ms).
5. Throttler engages backoff for `15000ms + jitter`.
6. Log: `[THROTTLE_ENGAGED] Limiter: rate-github-api WaitMs: 15035 Reason: RPM`.
7. Wakes up, oldest entry pruned, request granted with `GRANTED_AFTER_THROTTLE`.

### 8.4. Scenario 4: Maximum Wait Timeout Breach (Rejection)
**Configuration**:
- `limiter_id`: `rate-batch-worker`
- `refill_tokens_per_second`: 0.1
- `max_allowed_wait_ms`: 10000

**Execution Trace**:
1. Request arrives demanding 2000 tokens when bucket has 0 tokens.
2. Deficit: `2000` tokens.
3. Wait calculation: `2000 / 0.1 = 20000s = 20,000,000ms`.
4. `wait_ms > max_allowed_wait_ms` (10,000ms).
5. Request is rejected immediately without sleep.
6. Defect Report emitted: `BACKOFF_TIMEOUT_EXCEEDED`.
7. Client informed immediately of unfeasible demand.
