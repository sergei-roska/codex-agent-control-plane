---
name: actor-model
description: A software engineering skill implementing the Concurrent Actor Model for decentralized multi-agent architectures, enforcing isolated message inboxes, strictly typed message passing, and zero shared mutable state.
---

# SKILL: actor-model

## 1. Overview

A deterministic software engineering skill implementing the Concurrent Actor Model for decentralized multi-agent architectures. In complex multi-agent workflows, agents frequently attempt coordination through shared in-memory dictionaries, concurrent global files, or shared databases without synchronization primitives, causing dirty reads, context collisions, and concurrency deadlocks.

The actor-model pattern establishes strict actor-isolated boundaries:
- Each autonomous subagent or logical process is an **Actor**.
- An Actor possesses **exclusive ownership** of its private state. No external agent may read or write another Actor private internal state directly.
- All inter-actor communication occurs strictly through **asynchronous, strongly typed message passing** directed to immutable **Mailboxes**.
- Upon processing a message, an Actor may execute only three deterministic actions (Hewitt-Agha axioms):
  1. Send a finite number of typed messages to other known Actor addresses.
  2. Create a finite number of new child Actors.
  3. Designate the replacement behavior or mutate its own private internal state for the next message.

## 2. Trigger & Activation

### Positive Triggers (MUST Run)
- Multi-agent coordination with concurrent, decentralized responsibilities.
- Workflows requiring decoupled asynchronous event processing between distinct agent roles.
- Scenarios mandating zero shared mutable memory and zero lock contention.
- Requests explicitly invoking "actor model", "concurrent actor messaging", "isolated agent inbox", or "message passing concurrency".

### Negative Triggers (MUST NOT Run)
- Tightly coupled synchronous RPC chains where blocking lockstep execution is mandatory and isolated message queues add excessive overhead.
- Purely functional, stateless batch transforms best handled by `pipes-and-filters`.
- Centralized hierarchical fault recovery better modeled directly by `supervisor-tree` (though supervisor trees build on actors, pure messaging logic alone does not require supervision).
- Single-threaded linear scripts without concurrency.

## 3. Invariants & Non-Negotiable Rules

1. **ZERO_SHARED_STATE = MANDATORY**: Direct object reference sharing or shared mutable memory across Actor boundaries is strictly prohibited. Violation code: `SHARED_STATE_VIOLATION`.
2. **ISOLATED_FIFO_MAILBOX = MANDATORY**: Every Actor owns exactly one isolated incoming mailbox queue. Messages are dequeued sequentially in FIFO order unless priority mailboxes are formally declared.
3. **STRICT_TYPED_MESSAGING = MANDATORY**: Every message payload must strictly conform to a declared JSON Schema or Pydantic model. Malformed messages must be rejected before behavior execution. Violation code: `MALFORMED_MESSAGE_PAYLOAD`.
4. **RUN_TO_COMPLETION = MANDATORY**: An Actor processes one message at a time to completion before dequeuing the next message. Message handling must be non-preemptive with respect to the Actor local state.
5. **FAIL_FAST_POISON_PILL = MANDATORY**: A message causing an unhandled execution exception or schema violation must be quarantined immediately to a Dead-Letter Queue (DLQ) rather than re-enqueued indefinitely. Violation code: `POISON_PILL_QUARANTINED`.
6. **BOUNDED_MAILBOX_CAPACITY = MANDATORY**: Mailboxes must enforce a maximum capacity (`max_queue_depth`). When exceeded, the Actor must execute backpressure or emit `MAILBOX_OVERFLOW`.

## 4. Rigid Data Contracts & Schemas

### 4.1. Message Envelope Schema (`ActorMessageEnvelope`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ActorMessageEnvelope",
  "type": "object",
  "required": [
    "message_id",
    "correlation_id",
    "sender_address",
    "recipient_address",
    "message_type",
    "payload",
    "timestamp_utc",
    "ttl_ms"
  ],
  "properties": {
    "message_id": { "type": "string", "format": "uuid" },
    "correlation_id": { "type": "string" },
    "reply_to": { "type": ["string", "null"] },
    "sender_address": { "type": "string", "pattern": "^actor://[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$" },
    "recipient_address": { "type": "string", "pattern": "^actor://[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$" },
    "message_type": { "type": "string", "pattern": "^[A-Z0-9_]+$" },
    "payload": { "type": "object", "additionalProperties": true },
    "timestamp_utc": { "type": "string", "format": "date-time" },
    "ttl_ms": { "type": "integer", "minimum": 1, "default": 30000 },
    "retry_count": { "type": "integer", "minimum": 0, "default": 0 }
  },
  "additionalProperties": false
}
```

### 4.2. Actor Address & Registry Schema (`ActorDescriptor`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ActorDescriptor",
  "type": "object",
  "required": ["actor_address", "actor_type", "state", "mailbox_depth", "max_queue_depth"],
  "properties": {
    "actor_address": { "type": "string", "pattern": "^actor://[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$" },
    "actor_type": { "type": "string" },
    "state": { "type": "string", "enum": ["UNINITIALIZED", "IDLE", "PROCESSING", "PAUSED", "TERMINATED", "FAULTED"] },
    "mailbox_depth": { "type": "integer", "minimum": 0 },
    "max_queue_depth": { "type": "integer", "minimum": 1, "default": 1000 },
    "created_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. Defect Report Schema (`ActorDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ActorDefectReport",
  "type": "object",
  "required": ["defect_id", "actor_address", "violation_code", "message_id", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "actor_address": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "SHARED_STATE_VIOLATION",
        "MALFORMED_MESSAGE_PAYLOAD",
        "MAILBOX_OVERFLOW",
        "MESSAGE_TTL_EXPIRED",
        "UNKNOWN_MESSAGE_TYPE",
        "POISON_PILL_QUARANTINED",
        "ACTOR_UNREACHABLE",
        "BEHAVIOR_EXECUTION_FAILURE"
      ]
    },
    "message_id": { "type": ["string", "null"] },
    "error_message": { "type": "string" },
    "stack_trace": { "type": ["string", "null"] },
    "quarantined_payload": { "type": ["object", "null"] },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

## 5. Formal State Machine & State Transition Matrix

```text
       +--------------------+
       |   UNINITIALIZED    |
       +--------------------+
                 |
                 | Event: SPAWN_ACTOR (Private state allocated, mailbox empty)
                 v
       +--------------------+
+----->|        IDLE        |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: ENQUEUE_MESSAGE (Mailbox receives valid envelope)
|                v                                         |
|      +--------------------+                              |
|      |     RECEIVING      |                              |
|      +--------------------+                              |
|                |                                         |
|                | Event: DEQUEUE_HEAD                     |
|                v                                         |
|      +--------------------+                              |
|      |     VALIDATING     |----+                         |
|      +--------------------+    |                         |
|                |               | Event: VALIDATION_FAIL  |
|                | Event: PASS   | (Quarantine to DLQ)     |
|                v               v                         |
|      +--------------------+  +--------------------+      |
|      |     PROCESSING     |  |     QUARANTINE     |------+
|      +--------------------+  +--------------------+
|                |
|                | Event: EXECUTE_COMPLETE (State updated, side effects ready)
|                v
|      +--------------------+
|      | EMIT_SIDE_EFFECTS  | (Send child messages / spawn actors)
|      +--------------------+
|                |
+----------------+
                 | Event: TERMINATE_ACTOR
                 v
       +--------------------+
       |     TERMINATED     |
       +--------------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `UNINITIALIZED` | `SPAWN_ACTOR` | Valid initial state and unique address | `IDLE` | Register address in ActorRegistry, allocate bounded FIFO queue. |
| `IDLE` | `ENQUEUE_MESSAGE` | Mailbox depth < max_queue_depth | `IDLE` | Enqueue message envelope into FIFO mailbox. |
| `IDLE` | `ENQUEUE_MESSAGE` | Mailbox depth >= max_queue_depth | `IDLE` | Emit `MAILBOX_OVERFLOW` defect report, reject message or apply backpressure. |
| `IDLE` | `DEQUEUE_HEAD` | Mailbox not empty | `VALIDATING` | Pop head message envelope; inspect headers. |
| `VALIDATING` | `INSPECT_ENVELOPE` | Current time > timestamp + ttl_ms | `IDLE` | Drop expired envelope; emit `MESSAGE_TTL_EXPIRED` log. |
| `VALIDATING` | `VALIDATE_PAYLOAD` | Payload conforms to Schema(message_type) | `PROCESSING` | Bind payload to declared handler. |
| `VALIDATING` | `VALIDATE_PAYLOAD` | Schema mismatch or unknown type | `QUARANTINE` | Route envelope to DLQ; emit `MALFORMED_MESSAGE_PAYLOAD`. |
| `PROCESSING` | `EXECUTE_HANDLER` | Handler execution succeeds | `EMIT_SIDE_EFFECTS` | Mutate private state; stage outgoing message dispatches. |
| `PROCESSING` | `EXECUTE_HANDLER` | Uncaught exception in handler | `FAULTED` | Quarantine message; trigger supervisor notice; emit `POISON_PILL_QUARANTINED`. |
| `EMIT_SIDE_EFFECTS` | `FLUSH_DISPATCH` | Outgoing recipient mailboxes exist | `IDLE` | Asynchronously enqueue staged messages into recipient inboxes. |
| `FAULTED` | `RECOVER_ACTOR` | Supervisor issues restart or resume | `IDLE` | Reset private state to last clean checkpoint or drop poison message. |
| `IDLE` | `TERMINATE_ACTOR` | Stop signal received | `TERMINATED` | Flush pending messages to DLQ or dead-letter inbox; de-register address. |

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Actor Lifecycle Initialization
1. Coordinator verifies `actor_address` is globally unique in `ActorRegistry`.
2. Allocate private state container `ActorState`. No reference to `ActorState` is exposed outside the actor boundary.
3. Allocate bounded FIFO queue `Mailbox` with capacity `max_queue_depth`.
4. Transition state to `IDLE`.
5. Emit log marker: `[ACTOR_SPAWNED] Address: [actor_address] Type: [actor_type]`.

### Step 2: Message Ingestion & Mailbox Enqueue
1. External sender or peer actor calls `send(envelope)`.
2. Coordinator evaluates preconditions:
   - Recipient address matches registered actor.
   - Mailbox current size < `max_queue_depth`.
3. IF mailbox is full:
   - Emit Defect Report: `MAILBOX_OVERFLOW`.
   - Return rejection response to sender or divert to DLQ. Halt enqueue.
4. Append envelope to recipient `Mailbox`.
5. Emit log marker: `[MESSAGE_ENQUEUED] MsgId: [message_id] Recipient: [recipient_address] Depth: [depth]`.

### Step 3: Run-to-Completion Dispatch Loop
1. While `Mailbox` is not empty and actor is `IDLE`:
   a. Dequeue head envelope: `current_msg = Mailbox.pop_left()`.
   b. Transition state to `VALIDATING`.
   c. **TTL Check**: Compute `elapsed = now() - current_msg.timestamp_utc`.
      - IF `elapsed > current_msg.ttl_ms`:
        Emit log: `[MESSAGE_EXPIRED] MsgId: [message_id] TTL: [ttl_ms]ms Elapsed: [elapsed]ms`.
        Transition to `IDLE`; continue loop.
   d. **Schema & Protocol Validation**:
      - Look up declared payload schema for `current_msg.message_type`.
      - IF unknown message type:
        Emit Defect Report: `UNKNOWN_MESSAGE_TYPE`.
        Divert `current_msg` to DLQ; transition to `IDLE`; continue loop.
      - Validate `current_msg.payload` against schema.
      - IF validation fails:
        Emit Defect Report: `MALFORMED_MESSAGE_PAYLOAD`.
        Divert `current_msg` to DLQ; transition to `IDLE`; continue loop.
   e. Transition state to `PROCESSING`.
   f. **Handler Invocation**:
      - Invoke registered handler `handle_<message_type>(current_msg.payload, private_state)`.
      - Handler executes purely against local `private_state`.
      - IF handler throws unhandled exception:
        Record defect: `BEHAVIOR_EXECUTION_FAILURE` / `POISON_PILL_QUARANTINED`.
        Route envelope to DLQ.
        Transition to `FAULTED` or report to Supervisor.
   g. Transition state to `EMIT_SIDE_EFFECTS`.
   h. **Side Effects & Outgoing Messages**:
      - For each child actor declared by handler: instantiate child with new address.
      - For each outgoing message envelope staged by handler:
        - Populate `sender_address = actor_address`.
        - Enqueue into recipient mailbox asynchronously.
   i. Transition state to `IDLE`.
   j. Emit log marker: `[MESSAGE_PROCESSED] MsgId: [message_id] Actor: [actor_address] DurationMs: [duration]`.

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== ACTOR SYSTEM INITIALIZED: [system_id] ===`
- `[ACTOR_SPAWNED] Address: [actor_address] Type: [actor_type]`
- `[MESSAGE_ENQUEUED] MsgId: [message_id] Recipient: [recipient_address] Depth: [count]`
- `[MESSAGE_DEQUEUED] MsgId: [message_id] Actor: [actor_address]`
- `[MESSAGE_EXPIRED] MsgId: [message_id] TTL: [ttl_ms]ms Elapsed: [elapsed]ms`
- `[MESSAGE_PROCESSED] MsgId: [message_id] Actor: [actor_address] DurationMs: [ms]`
- `[QUARANTINE_DLQ] MsgId: [message_id] Code: [violation_code] Reason: [reason]`
- `[ACTOR_TERMINATED] Address: [actor_address] ExitCode: [code]`

### 7.2. Defect Codes
- `SHARED_STATE_VIOLATION`: Attempt to read or write memory belonging to another Actor instance.
- `MALFORMED_MESSAGE_PAYLOAD`: Inbound message failed JSON Schema validation.
- `MAILBOX_OVERFLOW`: Inbound queue limit exceeded; backpressure triggered.
- `MESSAGE_TTL_EXPIRED`: Message remained in queue longer than configured TTL before processing.
- `UNKNOWN_MESSAGE_TYPE`: Recipient actor possesses no registered handler for message type.
- `POISON_PILL_QUARANTINED`: Message caused internal execution crash and was isolated into DLQ.
- `ACTOR_UNREACHABLE`: Message dispatched to an address not found in the registry.
- `BEHAVIOR_EXECUTION_FAILURE`: Uncaught exception encountered during handler execution.

## 8. Few-Shot Operational Walkthroughs

### Scenario 1: Decoupled Multi-Agent Data Ingestion (Happy Path)
**Actor Topology**:
- `actor://ingest/gateway`: Ingestion gateway actor.
- `actor://transform/normalizer`: Schema normalizer worker actor.

**Execution Trace**:
```text
=== ACTOR SYSTEM INITIALIZED: sys-01 ===
[ACTOR_SPAWNED] Address: actor://ingest/gateway Type: GatewayActor
[ACTOR_SPAWNED] Address: actor://transform/normalizer Type: WorkerActor
[MESSAGE_ENQUEUED] MsgId: 4a2b9e60-8c2f-4a30-bb82-1f48039c9101 Recipient: actor://ingest/gateway Depth: 1
[MESSAGE_DEQUEUED] MsgId: 4a2b9e60-8c2f-4a30-bb82-1f48039c9101 Actor: actor://ingest/gateway
[MESSAGE_PROCESSED] MsgId: 4a2b9e60-8c2f-4a30-bb82-1f48039c9101 Actor: actor://ingest/gateway DurationMs: 12
[MESSAGE_ENQUEUED] MsgId: 7c5d1e20-9e4a-4b11-aa90-2e59128d9202 Recipient: actor://transform/normalizer Depth: 1
[MESSAGE_DEQUEUED] MsgId: 7c5d1e20-9e4a-4b11-aa90-2e59128d9202 Actor: actor://transform/normalizer
[MESSAGE_PROCESSED] MsgId: 7c5d1e20-9e4a-4b11-aa90-2e59128d9202 Actor: actor://transform/normalizer DurationMs: 8
```

### Scenario 2: Poison Pill Handling & Isolation
**Execution Trace**:
```text
[MESSAGE_ENQUEUED] MsgId: b2f18391-7d9a-4c22-9f33-1a2b3c4d5e6f Recipient: actor://metrics/calculator Depth: 1
[MESSAGE_DEQUEUED] MsgId: b2f18391-7d9a-4c22-9f33-1a2b3c4d5e6f Actor: actor://metrics/calculator
[QUARANTINE_DLQ] MsgId: b2f18391-7d9a-4c22-9f33-1a2b3c4d5e6f Code: MALFORMED_MESSAGE_PAYLOAD Reason: Payload failed schema validation
```

### Scenario 3: Bounded Mailbox Overflow & Backpressure
**Execution Trace**:
```text
[MESSAGE_ENQUEUED] MsgId: c3d2e1f0-1a2b-4c5d-8e9f-0a1b2c3d4e5f Recipient: actor://worker/busy Depth: 1000
[QUARANTINE_DLQ] MsgId: d4e3f2a1-2b3c-4d5e-9f0a-1b2c3d4e5f6a Code: MAILBOX_OVERFLOW Reason: Mailbox capacity 1000 exceeded
```

## 9. Definition of Done (DoD)

- [ ] Every actor instance possesses fully isolated private state and dedicated bounded FIFO queue.
- [ ] No direct variable or memory mutation occurs between actors under any circumstance.
- [ ] All cross-actor communications use strictly typed ActorMessageEnvelope structures with valid correlation tokens.
- [ ] Message processing follows the strict sequence: Dequeue -> TTL Check -> Schema Validation -> Handler Execution -> Side Effects.
- [ ] Poison pills and malformed messages are quarantined immediately to the DLQ without crashing the actor loop.
- [ ] Zero deadlock risk: Actors communicate asynchronously without blocking synchronous RPC locks.
- [ ] All specification files maintain strictly ASCII-only English punctuation and formatting.
