---
name: dead-letter-queue
description: Software engineering skill implementing the Dead-Letter Queue (DLQ) pattern for asynchronous multi-agent processing, batch task execution, and robust message routing, isolating failing tasks with complete diagnostic dumps to prevent pipeline stalls.
---

# Dead-Letter Queue Pattern (dead-letter-queue)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
In asynchronous, distributed, and multi-agent message-driven architectures, messages or tasks can fail to process due to corrupted inputs, unhandled exceptions, schema incompatibilities, or external dependency failures. Without a Dead-Letter Queue (DLQ), systems succumb to severe pathologies:
1. **Head-of-Line (HoL) Blocking**: A malformed "poison pill" message sits at the head of a FIFO queue, causing repeated crashes and preventing valid subsequent messages from ever being processed.
2. **Infinite Processing Loops**: Retrying transient failures endlessly without exponential backoff or circuit breaking, burning LLM tokens and API budgets.
3. **Silent Data Loss**: Dropping failing tasks into the ether without recording their original payload, failure context, or stack trace, rendering debugging and recovery impossible.
4. **Cascade of Partial State Corruption**: Repeatedly attempting execution of invalid tasks, causing partial side effects across systems.

### 1.2. Scope & Behavioral Boundaries
The `dead-letter-queue` pattern introduces a resilient quarantine isolation architecture:
- Segregates failing or unprocessable tasks into a dedicated, durable DLQ Storage Repository.
- Enforces strict classification: distinguishes between Transient / Retryable Errors (e.g., temporary network timeout) and Fatal / Non-Retryable Errors (e.g., schema validation failure).
- Packages failing messages into an immutable DLQ Diagnostic Envelope containing the complete original payload, full error diagnostics, attempt counters, and timeline telemetry.
- Unblocks the primary processing pipeline immediately, ensuring zero pipeline stalls.
- Provides a deterministic Triage & Redrive Protocol for inspecting, replaying, or safely purging quarantined messages.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Batch processing pipelines, message streams, or event-driven agent architectures where single-item failures must not halt the pipeline.
- Systems requiring guaranteed auditability and non-destructive handling of corrupted or rejected messages.
- Subagent task queues needing automatic quarantine after exhausting retry budgets.
- Keywords: "dead letter queue", "dlq routing", "quarantine failed tasks", "poison pill isolation", "prevent pipeline stall", "redrive dead letters".

### 2.2. Negative Triggers
- Synchronous request-response RPCs where the caller waits directly on a socket and errors must be returned immediately in-band.
- Ephemeral ping-pong heartbeat checks where dropped packets require zero audit trail or quarantine storage.
- Atomic all-or-nothing transactions across multiple files requiring `two-phase-commit`.

---

## 3. Invariants & Non-Negotiable Rules

1. **NON_BLOCKING_PRIMARY_PIPELINE = MANDATORY**: Quarantining an item to the DLQ must occur in a separate non-blocking branch. The primary consumer must immediately resume processing the next available message.
2. **DIAGNOSTIC_COMPLETENESS = MANDATORY**: Every quarantined entry must contain: (1) full unmodified original payload, (2) root cause error message, (3) exception stack or defect code, (4) total attempt count, and (5) timestamps. Failure code: `INCOMPLETE_DLQ_ENVELOPE`.
3. **FATAL_ERROR_FAST_TRACK = MANDATORY**: Messages failing invariant preconditions or schema validation must bypass the retry loop and route immediately to the DLQ on attempt 1.
4. **DETERMINISTIC_RETRY_BOUNDS = MANDATORY**: Retryable errors must adhere strictly to `max_retries` and exponential backoff bounds before transitioning to DLQ.
5. **DURABLE_STORAGE_ISOLATION = MANDATORY**: DLQ storage must be isolated from the primary working queue buffer to prevent shared storage exhaustion.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. DLQ Configuration Schema (`DlqConfig`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DlqConfig",
  "type": "object",
  "required": ["queue_name", "dlq_storage_path", "max_retries", "base_backoff_ms"],
  "properties": {
    "queue_name": { "type": "string" },
    "dlq_storage_path": { "type": "string", "default": ".agents/storage/dlq/" },
    "max_retries": { "type": "integer", "minimum": 0, "default": 3 },
    "base_backoff_ms": { "type": "integer", "minimum": 100, "default": 1000 },
    "max_backoff_ms": { "type": "integer", "minimum": 1000, "default": 30000 },
    "max_dlq_capacity": { "type": "integer", "minimum": 100, "default": 10000 }
  },
  "additionalProperties": false
}
```

### 4.2. DLQ Envelope Schema (`DlqEnvelope`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DlqEnvelope",
  "type": "object",
  "required": [
    "dlq_id",
    "original_message_id",
    "source_queue",
    "attempt_count",
    "last_error_code",
    "error_message",
    "first_failed_at_utc",
    "quarantined_at_utc",
    "original_payload",
    "status"
  ],
  "properties": {
    "dlq_id": { "type": "string", "format": "uuid" },
    "original_message_id": { "type": "string" },
    "source_queue": { "type": "string" },
    "attempt_count": { "type": "integer", "minimum": 1 },
    "last_error_code": {
      "type": "string",
      "enum": [
        "MAX_RETRIES_EXCEEDED",
        "FATAL_SCHEMA_VIOLATION",
        "EXECUTION_TIMEOUT",
        "UNHANDLED_EXCEPTION",
        "PRECONDITION_FAILED",
        "DEPENDENCY_UNAVAILABLE"
      ]
    },
    "error_message": { "type": "string" },
    "stack_trace": { "type": ["string", "null"] },
    "first_failed_at_utc": { "type": "string", "format": "date-time" },
    "quarantined_at_utc": { "type": "string", "format": "date-time" },
    "original_payload": { "type": "object", "additionalProperties": true },
    "status": { "type": "string", "enum": ["QUARANTINED", "TRIAGED", "REDISPATCHED", "PURGED"] }
  },
  "additionalProperties": false
}
```

### 4.3. DLQ Triage Operation Schema (`DlqTriageAction`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DlqTriageAction",
  "type": "object",
  "required": ["action_id", "dlq_id", "action_type", "operator_id", "timestamp_utc"],
  "properties": {
    "action_id": { "type": "string", "format": "uuid" },
    "dlq_id": { "type": "string", "format": "uuid" },
    "action_type": { "type": "string", "enum": ["REDRIVE", "PURGE", "INSPECT_NOTE", "MUTATE_AND_REDRIVE"] },
    "operator_id": { "type": "string" },
    "rejection_reason": { "type": ["string", "null"] },
    "mutated_payload": { "type": ["object", "null"] },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal State Machine

```text
       +--------------------+
       |  PRIMARY_ENQUEUED  |
       +--------------------+
                 |
                 | Event: DEQUEUE_TASK
                 v
       +--------------------+
+----->|     PROCESSING     |<-------------------------+
|      +--------------------+                          |
|                |                                     |
|                | Execution Error                     |
|                v                                     |
|      +--------------------+                          |
|      | CLASSIFY_FAILURE   |                          |
|      +--------------------+                          |
|        /                \                            |
|       / Fatal / Exceeded \ Retryable AND Attempts < N|
|      v                    v                          |
| +------------+     +-------------------+             |
| | ROUTE_DLQ  |     | SCHEDULE_BACKOFF  |-------------+
| +------------+     +-------------------+
|        |
|        | Event: PERSIST_ENVELOPE
|        v
| +--------------------+
| |    QUARANTINED     |
| +--------------------+
|   /        |       \
|  / Redrive | Purge  \ Inspect
| v          v         v
| [RE-QUEUE] [DELETED] [TRIAGED]
+----+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `PRIMARY_ENQUEUED` | `DEQUEUE_TASK` | Primary queue not empty | `PROCESSING` | Dequeue head message; set attempt counter. |
| `PROCESSING` | `EXECUTION_SUCCESS` | Task completes cleanly | `COMMITTED` | Acknowledge message in primary queue; purge tracking state. |
| `PROCESSING` | `EXECUTION_FAILURE` | Error is transient AND attempt < max_retries | `RETRY_SCHEDULED` | Increment attempt; compute exponential backoff; schedule re-enqueue. |
| `PROCESSING` | `EXECUTION_FAILURE` | Error is fatal OR attempt >= max_retries | `PACKAGING_DLQ` | Extract payload and stack trace; mint `dlq_id`. |
| `PACKAGING_DLQ` | `ENVELOPE_VALIDATED` | Envelope meets all required fields | `QUARANTINED` | Write envelope to durable DLQ store; emit alert telemetry. |
| `PACKAGING_DLQ` | `ENVELOPE_INVALID` | Missing diagnostic fields | `QUARANTINED` | Attach fallback metadata; emit `INCOMPLETE_DLQ_ENVELOPE`. |
| `QUARANTINED` | `OPERATOR_REDRIVE` | Operator or supervisor triggers redrive | `PRIMARY_ENQUEUED` | Move envelope payload back to primary queue; mark status `REDISPATCHED`. |
| `QUARANTINED` | `OPERATOR_PURGE` | Operator confirms permanent discard | `PURGED` | Delete envelope from DLQ store; log audit trace. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Task Consumption & Attempt Initialization
1. Consumer dequeues message from primary queue: `msg`.
2. Inspect or initialize attempt counter: `attempt = msg.attempt_count or 1`.
3. Record `first_attempt_timestamp` if not already present.
4. Transition state to `PROCESSING`.

### Step 2: Safe Execution Wrapper
1. Execute task handler within a monitored try/except block.
2. IF execution completes without exception:
   - Commit transaction / acknowledge primary queue removal.
   - Emit log marker: `[TASK_COMMITTED] MsgId: [msg.id] DurationMs: [ms]`.
   - Advance to next message immediately.
3. ELSE (exception captured as `exc`):
   - Proceed to Step 3 (Failure Classification).

### Step 3: Failure Classification & Branching
1. Evaluate exception type:
   - **Case A: Fatal / Non-Retryable Error** (e.g., `SchemaValidationError`, `PreconditionViolation`, `AuthorizationDenied`):
     - Emit log marker: `[FATAL_FAILURE_DETECTED] MsgId: [msg.id] Error: [exc.name] Fast-tracking to DLQ`.
     - Set `last_error_code = FATAL_SCHEMA_VIOLATION`.
     - Proceed to Step 5 (DLQ Packaging).
   - **Case B: Transient / Retryable Error** (e.g., `TimeoutError`, `ConnectionRefused`, `RateLimitExceeded`):
     - IF `attempt < max_retries`:
       - Increment `attempt += 1`.
       - Compute backoff: `backoff_ms = min(base_backoff_ms * (2 ** (attempt - 1)), max_backoff_ms)`.
       - Emit log marker: `[RETRY_SCHEDULED] MsgId: [msg.id] Attempt: [attempt]/[max_retries] BackoffMs: [backoff_ms]ms`.
       - Schedule message re-enqueue in primary queue after `backoff_ms`.
       - Exit step; consumer immediately pulls next message.
     - ELSE (`attempt >= max_retries`):
       - Emit log marker: `[RETRY_BUDGET_EXHAUSTED] MsgId: [msg.id] Final attempt [attempt] failed`.
       - Set `last_error_code = MAX_RETRIES_EXCEEDED`.
       - Proceed to Step 5 (DLQ Packaging).

### Step 5: DLQ Packaging & Durable Quarantine
1. Mint unique UUID: `dlq_id`.
2. Construct `DlqEnvelope`:
   - `dlq_id`: minted UUID
   - `original_message_id`: `msg.id`
   - `source_queue`: configured queue name
   - `attempt_count`: current `attempt`
   - `last_error_code`: categorized code
   - `error_message`: string representation of `exc`
   - `stack_trace`: formatted traceback string
   - `first_failed_at_utc`: recorded first failure time
   - `quarantined_at_utc`: current ISO-8601 UTC timestamp
   - `original_payload`: complete unmutated `msg.payload`
   - `status`: `QUARANTINED`
3. Persist envelope to `.agents/storage/dlq/<queue_name>/<dlq_id>.json`.
4. Acknowledge and remove failing message from primary queue.
5. Emit log marker: `=== TASK QUARANTINED TO DLQ: [dlq_id] MsgId: [msg.id] Code: [last_error_code] ===`.
6. Primary consumer immediately continues to next item.

### Step 6: Triage & Re-Drive Protocol (Optional / Operator Driven)
1. List all envelopes in `.agents/storage/dlq/<queue_name>/` with status `QUARANTINED`.
2. Upon operator command `REDRIVE`:
   - Load `DlqEnvelope` by `dlq_id`.
   - Re-enqueue `original_payload` into primary queue.
   - Update envelope `status = REDISPATCHED`.
   - Emit log marker: `[DLQ_REDISPATCHED] DlqId: [dlq_id] TargetQueue: [source_queue]`.
3. Upon operator command `PURGE`:
   - Update envelope `status = PURGED` or securely unlink file.
   - Emit log marker: `[DLQ_PURGED] DlqId: [dlq_id]`.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== DLQ INITIALIZED: Queue: [queue_name] Storage: [path] ===`
- `[TASK_DEQUEUED] MsgId: [msg_id] Queue: [queue_name]`
- `[TASK_COMMITTED] MsgId: [msg_id] DurationMs: [ms]`
- `[RETRY_SCHEDULED] MsgId: [msg_id] Attempt: [attempt] BackoffMs: [ms]`
- `=== TASK QUARANTINED TO DLQ: [dlq_id] MsgId: [msg_id] Code: [code] ===`
- `[DLQ_REDISPATCHED] DlqId: [dlq_id] TargetQueue: [queue_name]`
- `[DLQ_PURGED] DlqId: [dlq_id]`

### 7.2. Defect Codes
- `MAX_RETRIES_EXCEEDED`: Message failed processing across all allocated retry attempts.
- `FATAL_SCHEMA_VIOLATION`: Message payload failed schema validation and cannot be retried.
- `INCOMPLETE_DLQ_ENVELOPE`: Required diagnostic metadata was missing when packaging for quarantine.
- `DLQ_STORAGE_OVERFLOW`: DLQ disk storage or directory exceeded maximum configured quota.
- `REDRIVE_FAILED`: Attempt to re-enqueue a quarantined message back to primary queue failed.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Poison Pill Fast-Track to DLQ
**Message Payload**: `{"task_id": "T-101", "cmd": "UNKNOWN_OP"}`
1. Consumer dequeues message `T-101`.
2. Handler checks schema: `UNKNOWN_OP` is an unregistered operation.
3. Exception raised: `SchemaValidationError("Unknown command UNKNOWN_OP")`.
4. Classification detects `FATAL_SCHEMA_VIOLATION`. Retry loop is bypassed.
5. `DlqEnvelope` generated with `dlq_id: 11111111-2222-3333-4444-555555555555`, storing payload and stack trace.
6. Persisted to `.agents/storage/dlq/tasks/11111111-2222-3333-4444-555555555555.json`.
7. Message `T-101` removed from primary queue.
8. Telemetry emitted: `=== TASK QUARANTINED TO DLQ: 11111111-2222-3333-4444-555555555555 MsgId: T-101 Code: FATAL_SCHEMA_VIOLATION ===`.
9. Next message in primary queue (`T-102`) processes immediately without delay.

### 8.2. Scenario 2: Retry Exhaustion & Subsequent Redrive
1. Message `T-202` fails due to external API timeout (HTTP 504).
2. Attempt 1 fails -> Backoff 1000ms -> Re-enqueued.
3. Attempt 2 fails -> Backoff 2000ms -> Re-enqueued.
4. Attempt 3 fails -> Max retries (3) reached.
5. Classification routes to `PACKAGING_DLQ` with `last_error_code: MAX_RETRIES_EXCEEDED`.
6. Quarantined to `.agents/storage/dlq/tasks/22222222-3333-4444-5555-666666666666.json`.
7. Next day, external API comes back online. Operator issues `REDRIVE 22222222-3333-4444-5555-666666666666`.
8. Envelope marked `status: REDISPATCHED`; payload enqueued into primary queue.
9. Message processes successfully on redrive and commits.

### 8.3. Scenario 3: Clean Primary Commit
1. Message `T-303` arrives in primary queue `orders`.
2. Consumer dequeues: `[TASK_DEQUEUED] MsgId: T-303 Queue: orders`.
3. Handler executes order creation cleanly in 12ms.
4. Commit emitted: `[TASK_COMMITTED] MsgId: T-303 DurationMs: 12`.
5. Consumer immediately continues to next item.

### 8.4. Scenario 4: Incomplete Diagnostic Envelope Defect
1. Task `T-404` fails on attempt 3.
2. DLQ packaging runs, but payload extraction returns empty or unhandled null.
3. Envelope validation fails precondition: missing payload.
4. Packaging system attaches fallback metadata and emits defect: `INCOMPLETE_DLQ_ENVELOPE`.
5. Alert emitted, task quarantined with emergency fallback, consumer unblocked.

### 8.5. Scenario 5: Supervisory Purge
1. Quarantined envelope `33333333-4444-5555-6666-777777777777` has been reviewed by operator.
2. Root cause determined to be malicious attack payload that should never be replayed.
3. Operator triggers `PURGE 33333333-4444-5555-6666-777777777777`.
4. File unlinked from `.agents/storage/dlq/tasks/33333333-4444-5555-6666-777777777777.json`.
5. Audit telemetry emitted: `[DLQ_PURGED] DlqId: 33333333-4444-5555-6666-777777777777`.

---

## 9. Definition of Done (DoD)

- [ ] Every non-retryable fatal error or exhausted retry sequence results in a verified DlqEnvelope.
- [ ] No failing message blocks downstream processing in the primary pipeline (NON_BLOCKING_PRIMARY_PIPELINE).
- [ ] Any missing envelope field (payload, error message, stack trace, attempt counter) raises INCOMPLETE_DLQ_ENVELOPE.
- [ ] DLQ storage uses isolated durable storage path at .agents/storage/dlq/<queue_name>/<dlq_id>.json.
- [ ] Supervisory triage actions (REDRIVE, PURGE, INSPECT_NOTE, MUTATE_AND_REDRIVE) execute deterministically.
- [ ] All documentation, logs, and schemas are strictly 7-bit ASCII English.