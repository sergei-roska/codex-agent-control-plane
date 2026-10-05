---
name: event-sourcing
description: Software engineering skill implementing the Event Sourcing pattern for autonomous agent decision-making, immutable audit trails, and workspace versioning via append-only domain event streams and deterministic replay.
---

# Event Sourcing Pattern (event-sourcing)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
Traditional software architectures and agent state managers mutate state in-place (e.g., overwriting a database row, overwriting a workspace file, or mutating a configuration setting). For autonomous multi-agent systems, in-place mutation causes devastating operational failure modes:
1. **Loss of Causal Provenance**: When an agent overwrites a file or setting, the previous state, the triggering event, and the cognitive rationale behind the mutation are permanently lost.
2. **Untraceable Trajectory Divergence**: If an agentic workflow diverges or fails at step 45, it is impossible to reconstruct the exact workspace state that existed at step 20 without full event history.
3. **Irreversible Corruptions**: A faulty tool execution that directly mutates workspace files destroys the baseline, rendering rollback speculative and error-prone.
4. **Audit Impossibility**: The absence of an immutable, chronologically ordered ledger violates compliance, safety, and security mandates for autonomous systems.

### 1.2. Scope & Behavioral Boundaries
The `event-sourcing` pattern replaces in-place mutation with an append-only sequence of immutable domain events:
- **State as a Left-Fold**: Current system state is never treated as the primary source of truth; it is a derived materialized projection computed by sequentially applying domain events:
  `State(t) = fold(apply_event, InitialState, Events[0..t])`
- **Append-Only Event Store**: An append-only persistence log where events are recorded with strict monotonic sequence numbering, UTC timestamps, and SHA-256 cryptographic integrity hashes.
- **Deterministic Time-Travel Replay**: The system reconstructs its exact state at any arbitrary historical timestamp or sequence number by replaying events from baseline or the nearest verified snapshot.
- **Strict Event Immutability**: Historical events can never be edited, overwritten, or deleted.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Multi-agent coordination requiring complete historical audit trails of every action, tool call, and decision.
- Complex workflows demanding time-travel debugging, rewind/replay capabilities, or hypothetical branching.
- Financial, compliance, or mission-critical state tracking where historical record deletion is strictly forbidden.
- Keywords: "event sourcing", "append only event stream", "reconstruct state from events", "deterministic event replay", "immutable audit trail", "domain event log".

### 2.2. Negative Triggers
- Ephemeral, throwaway scratchpad edits with zero audit requirements.
- High-frequency sensory streaming (e.g., 1000 Hz raw telemetry) where storing every raw byte without pre-aggregation exhausts storage.
- Simple synchronous CRUD operations with no historical query needs.

---

## 3. Invariants & Non-Negotiable Rules

1. **APPEND_ONLY_IMMUTABILITY = MANDATORY**: An event record, once written to the store, cannot be updated, overwritten, or deleted. Direct SQL updates, file edits, or line deletions on historical events trigger fatal defect `EVENT_MUTATION_FORBIDDEN`.
2. **MONOTONIC_SEQUENCE_ORDERING = MANDATORY**: Every event within an aggregate or global stream must receive a strictly increasing sequence number:
   `seq_num(E[k+1]) == seq_num(E[k]) + 1`
   Sequence gaps or backward sequences trigger `SEQUENCE_GAP_DETECTED`.
3. **DETERMINISTIC_REPLAY_FIDELITY = MANDATORY**: Replaying the identical event stream against an empty baseline must produce an identical state projection with 100% mathematical determinism.
4. **SCHEMA_VERSIONING = MANDATORY**: Every domain event type must specify an explicit schema version (e.g., `TaskDispatchedV1`, `FileMutatedV2`). Event payloads must validate against their respective versioned schema. Validation failures trigger `SCHEMA_VALIDATION_ERROR`.
5. **OPTIMISTIC_CONCURRENCY_PROTECTION = MANDATORY**: Appending an event requires verifying `expected_version == current_stream_version`. Concurrency collisions trigger `OPTIMISTIC_CONCURRENCY_CONFLICT`.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Domain Event Envelope Schema (`EventEnvelope`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "EventEnvelope",
  "type": "object",
  "required": [
    "event_id",
    "stream_id",
    "sequence_number",
    "event_type",
    "schema_version",
    "payload",
    "metadata",
    "timestamp_utc",
    "integrity_hash"
  ],
  "properties": {
    "event_id": { "type": "string", "format": "uuid" },
    "stream_id": { "type": "string", "pattern": "^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$" },
    "sequence_number": { "type": "integer", "minimum": 1 },
    "event_type": { "type": "string", "pattern": "^[A-Z][a-zA-Z0-9]+$" },
    "schema_version": { "type": "integer", "minimum": 1 },
    "payload": { "type": "object", "additionalProperties": true },
    "metadata": {
      "type": "object",
      "required": ["actor_id", "correlation_id"],
      "properties": {
        "actor_id": { "type": "string" },
        "correlation_id": { "type": "string" },
        "causation_id": { "type": ["string", "null"] }
      },
      "additionalProperties": true
    },
    "timestamp_utc": { "type": "string", "format": "date-time" },
    "integrity_hash": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
  },
  "additionalProperties": false
}
```

### 4.2. State Snapshot Descriptor Schema (`SnapshotDescriptor`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "SnapshotDescriptor",
  "type": "object",
  "required": [
    "snapshot_id",
    "stream_id",
    "last_sequence_number",
    "state_data",
    "created_at_utc",
    "checksum"
  ],
  "properties": {
    "snapshot_id": { "type": "string", "format": "uuid" },
    "stream_id": { "type": "string" },
    "last_sequence_number": { "type": "integer", "minimum": 1 },
    "state_data": { "type": "object", "additionalProperties": true },
    "created_at_utc": { "type": "string", "format": "date-time" },
    "checksum": { "type": "string", "pattern": "^[a-f0-9]{64}$" }
  },
  "additionalProperties": false
}
```

### 4.3. Event Sourcing Defect Report Schema (`EventSourcingDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "EventSourcingDefectReport",
  "type": "object",
  "required": ["defect_id", "stream_id", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "stream_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "EVENT_MUTATION_FORBIDDEN",
        "SEQUENCE_GAP_DETECTED",
        "OPTIMISTIC_CONCURRENCY_CONFLICT",
        "PROJECTION_FOLD_FAILURE",
        "REPLAY_DIVERGENCE_DETECTED",
        "SCHEMA_VALIDATION_ERROR",
        "INTEGRITY_HASH_MISMATCH"
      ]
    },
    "expected_sequence": { "type": ["integer", "null"] },
    "actual_sequence": { "type": ["integer", "null"] },
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
                 | Event: INIT_STREAM (Create log, initialize sequence 0)
                 v
       +--------------------+
+----->|       IDLE         |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: PROPOSE_EVENT                    |
|                v                                         |
|      +--------------------+                              |
|      |  VALIDATE_APPEND   |                              |
|      +--------------------+                              |
|         /                \                               |
|        / Concurrency OK   \ Concurrency / Schema Fail    |
|       v                    v                             |
| +------------+     +-------------------+                 |
| | PERSISTING |     | EMIT_DEFECT_HALT  |                 |
| +------------+     +-------------------+                 |
|       |                                                  |
|       | Append Confirmed (fsync)                         |
|       v                                                  |
| +------------+                                           |
| | PROJECTING |-------------------------------------------+
| +------------+
|
| Event: TRIGGER_REPLAY(target_seq)
v
+--------------------+
|    REPLAYING       |
+--------------------+
  |
  | Fold complete
  v
+--------------------+
| HISTORICAL_VIEW    |
+--------------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
| :--- | :--- | :--- | :--- | :--- |
| `UNINITIALIZED` | `INIT_STREAM` | Storage directory accessible and writable | `IDLE` | Initialize stream log file/table; set `current_seq = 0`. |
| `IDLE` | `PROPOSE_EVENT` | Event payload non-empty | `VALIDATE_APPEND` | Ingest proposed event; validate schema and sequence number. |
| `VALIDATE_APPEND` | `CHECK_CONCURRENCY` | `expected_version == current_seq` | `PERSISTING` | Compute SHA-256 hash; append event envelope to log. |
| `VALIDATE_APPEND` | `CHECK_CONCURRENCY` | `expected_version != current_seq` | `IDLE` | Emit `OPTIMISTIC_CONCURRENCY_CONFLICT` Defect Report; reject append. |
| `PERSISTING` | `APPEND_SUCCESS` | Disk write flushed to storage (`fsync`) | `PROJECTING` | Update in-memory projection via `apply_event(state, event)`. |
| `PROJECTING` | `FOLD_SUCCESS` | Projection updated cleanly | `IDLE` | Increment `current_seq += 1`; emit telemetry log marker. |
| `PROJECTING` | `FOLD_FAILURE` | Handler raises exception | `FAULTED` | Emit `PROJECTION_FOLD_FAILURE` Defect Report; halt execution. |
| `IDLE` | `TRIGGER_REPLAY` | `target_sequence <= current_seq` | `REPLAYING` | Load initial state (or snapshot); sequentially fold events up to target. |
| `REPLAYING` | `REPLAY_COMPLETE` | All events folded deterministically | `IDLE` | Return historical projected view to caller. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Event Construction & Validation
1. Operational logic generates domain event draft:
   - `stream_id`: Identifier of aggregate or workspace (pattern: `^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$`).
   - `event_type`: PascalCase identifier (e.g., `WorkspaceCreated`, `FileMutated`, `TestCasePassed`).
   - `schema_version`: Positive integer version.
   - `payload`: Event-specific structured data dictionary.
   - `metadata`: Dictionary containing `actor_id`, `correlation_id`, and optional `causation_id`.
2. Validate `payload` against declared schema for `event_type` and `schema_version`.
3. IF validation fails:
   - Emit Defect Report: `SCHEMA_VALIDATION_ERROR`.
   - Halt append operation.
4. Transition state to `VALIDATE_APPEND`.

### Step 2: Optimistic Concurrency & Sequence Resolution
1. Query active sequence number for `stream_id`: `current_seq`.
2. Inspect `expected_version`:
   - IF `expected_version != current_seq`:
     - Emit Defect Report: `OPTIMISTIC_CONCURRENCY_CONFLICT`.
     - Reject append; instruct caller to reload active projection and recompute.
3. Assign `new_seq = current_seq + 1`.
4. Transition state to `PERSISTING`.

### Step 3: Cryptographic Integrity & Durable Append
1. Mint unique UUID: `event_id`.
2. Record current ISO 8601 UTC timestamp: `timestamp_utc`.
3. Compute `integrity_hash`:
   `hash = sha256(event_id + stream_id + str(new_seq) + event_type + json_canonical(payload) + timestamp_utc)`
4. Construct complete `EventEnvelope` instance.
5. Atomically write serialized envelope to append-only event store.
6. Flush write to non-volatile storage (`fsync`).
7. Emit log marker:
   `[EVENT_APPENDED] Stream: [stream_id] Seq: [new_seq] Type: [event_type] Actor: [actor]`

### Step 4: Projection Update (Read Model Fold)
1. Transition state to `PROJECTING`.
2. Locate registered projection handler: `apply_<event_type>(current_state, event.payload)`.
3. Execute handler to compute updated materialized state.
4. IF handler throws exception:
   - Emit Defect Report: `PROJECTION_FOLD_FAILURE`.
   - Transition to `FAULTED` state to prevent dirty read models.
5. Update active read model reference.
6. Check snapshot threshold (e.g., IF `new_seq % 100 == 0`):
   - Atomically persist `SnapshotDescriptor` with state checksum.
   - Emit log marker: `[SNAPSHOT_SAVED] Stream: [stream_id] Seq: [new_seq] Checksum: [sha256]`
7. Transition state to `IDLE`.

### Step 5: Time-Travel Replay Execution (On-Demand)
1. Caller requests state reconstruction: `replay(stream_id, target_timestamp_or_seq)`.
2. Transition state to `REPLAYING`.
3. Locate most recent verified snapshot where `snapshot.last_sequence_number <= target_seq`:
   - IF found: `state = deepcopy(snapshot.state_data)`, `start_seq = snapshot.last_sequence_number + 1`.
   - ELSE: `state = initial_empty_state()`, `start_seq = 1`.
4. Fetch ordered event slice from store: `events = query_events(stream_id, start_seq, target_seq)`.
5. For each event `ev` in `events`:
   - Verify `sha256(ev) == ev.integrity_hash`. IF mismatch: emit `INTEGRITY_HASH_MISMATCH` and halt.
   - Apply handler: `state = apply_<ev.event_type>(state, ev.payload)`.
6. Emit log marker:
   `[REPLAY_COMPLETE] Stream: [stream_id] TargetSeq: [target_seq] ElapsedMs: [ms]`
7. Return reconstructed `state`.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== EVENT STREAM INITIALIZED: [stream_id] ===`
- `[EVENT_APPENDED] Stream: [stream_id] Seq: [seq] Type: [type] Actor: [actor]`
- `[PROJECTION_UPDATED] Stream: [stream_id] Seq: [seq] DurationMs: [ms]`
- `[SNAPSHOT_SAVED] Stream: [stream_id] Seq: [seq] Checksum: [sha256]`
- `[REPLAY_INIT] Stream: [stream_id] FromSeq: [start] ToSeq: [target]`
- `[REPLAY_COMPLETE] Stream: [stream_id] TargetSeq: [seq] ElapsedMs: [ms]`

### 7.2. Defect Codes
- `EVENT_MUTATION_FORBIDDEN`: Attempted update or deletion of an existing event record in append-only storage.
- `SEQUENCE_GAP_DETECTED`: Sequence numbering is non-contiguous, skipped, or backward.
- `OPTIMISTIC_CONCURRENCY_CONFLICT`: Concurrency version mismatch during append (`expected_version != current_seq`).
- `PROJECTION_FOLD_FAILURE`: Error while executing registered projection handler for an event.
- `REPLAY_DIVERGENCE_DETECTED`: Deterministic replay produced state differing from verified baseline or snapshot.
- `SCHEMA_VALIDATION_ERROR`: Event payload failed schema conformance check for declared type and version.
- `INTEGRITY_HASH_MISMATCH`: Stored event cryptographic hash failed verification.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Workspace Mutation via Event Stream
**Stream**: `workspace:ws-01`
1. Agent creates file `main.py`.
2. Event proposed:
   - `event_type`: `FileCreated`
   - `payload`: `{"path": "src/main.py", "initial_bytes": 120, "sha256": "abc12345..."}`
3. Concurrency check: `expected_version: 0 == current_seq: 0`. Validated.
4. Sequence number assigned: `seq = 1`. Cryptographic integrity hash computed.
5. Appended to store: `[EVENT_APPENDED] Stream: workspace:ws-01 Seq: 1 Type: FileCreated Actor: agent-code-writer`.
6. Projection updated: `workspace_state.files["src/main.py"] = {"size": 120, "hash": "abc12345..."}`.
7. Agent modifies file -> `FileModified` event proposed with `expected_version: 1`, appended at `seq = 2`.
8. Complete audit history preserved with exact timestamps, diffs, and cryptographic provenance.

### 8.2. Scenario 2: Time-Travel State Reconstruction
**Goal**: Inspect workspace state as it existed at `seq = 1` after 5 modifications took place.
1. Caller executes `replay("workspace:ws-01", target_seq=1)`.
2. Replay engine initializes `empty_workspace()` baseline.
3. Fetches `Event 1 (FileCreated)`. Verifies SHA-256 integrity hash.
4. Applies `apply_FileCreated(state, payload)`.
5. Replay terminates cleanly at `target_seq = 1`.
6. Reconstructed state contains `src/main.py` in its exact original state prior to modifications at `seq = 2..5`.
7. Telemetry emitted: `[REPLAY_COMPLETE] Stream: workspace:ws-01 TargetSeq: 1 ElapsedMs: 4`.

### 8.3. Scenario 3: Optimistic Concurrency Conflict
**Goal**: Concurrent worker attempts to append event with stale sequence base.
1. Worker A and Worker B both read `current_seq = 4`.
2. Worker A appends `Event 5` successfully; stream advances to `current_seq = 5`.
3. Worker B proposes `Event` with `expected_version = 4`.
4. Concurrency gate evaluates: `expected_version (4) != current_seq (5)`.
5. Append rejected immediately. Structured defect report emitted:
   - `violation_code`: `OPTIMISTIC_CONCURRENCY_CONFLICT`
   - `expected_sequence`: 4
   - `actual_sequence`: 5
   - `error_message`: `Stream version divergence: expected 4, actual 5.`
6. Worker B reloads projection and recomputes change.

### 8.4. Scenario 4: Historical Event Mutation Violation
**Goal**: Malicious or buggy process attempts in-place modification of historical event record 1.
1. Integrity verification scans stream or replays events.
2. Replay engine computes `sha256(ev)` on historical record sequence 1.
3. Computed SHA-256 hash diverges from stored `ev.integrity_hash`.
4. Execution halts immediately with Defect Report:
   - `violation_code`: `EVENT_MUTATION_FORBIDDEN`
   - `error_message`: `Historical event record altered or corrupted at sequence 1.`
5. Telemetry emitted: `[DEFECT_REPORT] Code: EVENT_MUTATION_FORBIDDEN`.

---

## 9. Definition of Done (DoD) & Operational Safeguards

- [ ] All event stream mutations are strictly append-only; updates and deletions are rejected with `EVENT_MUTATION_FORBIDDEN`.
- [ ] Every event envelope conforms to `EventEnvelope` JSON Schema Draft 2020-12 with valid SHA-256 `integrity_hash`.
- [ ] Sequence numbers are strictly monotonic integers starting at 1 with zero gaps (`SEQUENCE_GAP_DETECTED` on gaps).
- [ ] Concurrency check enforces `expected_version == current_stream_version` (`OPTIMISTIC_CONCURRENCY_CONFLICT` on mismatch).
- [ ] Deterministic replay of `Events[1..N]` against empty baseline or verified snapshot produces identical state projection.
- [ ] Snapshots conform to `SnapshotDescriptor` JSON Schema Draft 2020-12 with SHA-256 state checksum.
- [ ] All defect reports conform to `EventSourcingDefectReport` JSON Schema Draft 2020-12.
- [ ] All files and schemas are strictly 7-bit ASCII-only English with zero unescaped non-ASCII characters.