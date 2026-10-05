---
name: idempotency-key-filter
description: A software engineering skill enforcing Idempotency Key semantics for autonomous agent tool invocations, external API mutations, and filesystem operations, guaranteeing strict exactly-once execution semantics via journal caching and concurrent locking.
---

# Idempotency Key Filter Pattern (idempotency-key-filter)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
In autonomous agent workflows and distributed tool invocations, network hiccups, tool timeouts, and LLM retry policies frequently cause duplicate executions of mutating operations. Without strict idempotency filtering, devastating side effects occur:
1. **Duplicate Financial or Resource Mutations**: A payment, cloud instance spawn, or token allocation call times out at the network layer after server-side execution; the agent retries the call, resulting in double billing or duplicated infrastructure.
2. **Duplicate File System Writes & Appends**: Retrying a write or append command duplicates text blocks, corrupts configuration files, or creates orphan duplicate assets.
3. **Concurrent Race Conditions**: Two concurrent subagents issue identical mutating requests simultaneously with the same intent, corrupting shared database state or tripping duplicate key constraints.
4. **Phantom Regressions**: Retried operations overwriting downstream modifications that occurred in the interim.

### 1.2. Scope & Behavioral Boundaries
The `idempotency-key-filter` pattern enforces strict **Exactly-Once Execution Semantics** for all mutating tools, APIs, and file operations:
- **Unique Idempotency Key**: Every mutating request carries an explicit or deterministically derived key K = SHA256(actor_id, target_resource, operation, payload_digest).
- **Atomic Journal Locking**: Before executing the target mutation, the filter acquires an atomic distributed lock in an **Idempotency Journal** marking state `IN_PROGRESS`.
- **Payload Fingerprint Verification**: If a duplicate key arrives with a differing payload, the filter rejects the request immediately with `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- **Cached Replay Guarantee**: If a request arrives with a key whose previous execution has status `COMMITTED`, the filter bypasses mutation execution entirely and returns the stored verified output receipt.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Non-idempotent operations: file creation, database inserts, external API POST/PUT mutations, financial transactions, or git commits.
- Subagent delegation chains where retry policies could trigger duplicate work.
- Tool wrappers protecting against intermittent network timeouts.
- Explicit keywords: "idempotency key filter", "enforce idempotent execution", "prevent duplicate tool executions", "exactly-once mutation semantics", "deduplicate retried operations".

### 2.2. Negative Triggers
- Naturally idempotent pure read queries (GET requests, file reads, grep searches).
- Operations where duplicate execution is intentionally desired (e.g., logging a raw append-only heartbeat).
- In-memory local transformations without external side effects.

---

## 3. Invariants & Non-Negotiable Rules

1. **EXACTLY_ONCE_MUTATION = MANDATORY**: The underlying mutating side effect must be executed at most once per unique idempotency key within the retention window.
2. **PAYLOAD_CONSISTENCY_ASSERTION = MANDATORY**: If a key exists in the journal and a subsequent request presents a different payload hash, the operation must halt immediately with `IDEMPOTENCY_PAYLOAD_MISMATCH`.
3. **CONCURRENCY_LOCKING_ISOLATION = MANDATORY**: If a request arrives while key K is in state `IN_PROGRESS`, concurrent execution must be blocked or rejected with `OPERATION_IN_FLIGHT`.
4. **DURABLE_RECEIPT_STORAGE = MANDATORY**: Output payloads and execution metadata must be stored in the journal upon successful completion with status `COMMITTED`.
5. **BOUNDED_RETENTION_TTL = MANDATORY**: Journal records must enforce an expiration TTL (e.g., 24 hours), after which keys may be safely recycled.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. Idempotency Journal Record Schema (`IdempotencyRecord`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "IdempotencyRecord",
  "type": "object",
  "required": [
    "idempotency_key",
    "operation_name",
    "target_resource",
    "payload_hash",
    "status",
    "created_at_utc",
    "expires_at_utc"
  ],
  "properties": {
    "idempotency_key": { "type": "string", "pattern": "^idem-[a-zA-Z0-9_-]+$" },
    "operation_name": { "type": "string" },
    "target_resource": { "type": "string" },
    "payload_hash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
    "status": { "type": "string", "enum": ["IN_PROGRESS", "COMMITTED", "FAILED"] },
    "cached_response": { "type": ["object", "string", "null"] },
    "error_details": { "type": ["string", "null"] },
    "lock_owner_id": { "type": "string" },
    "created_at_utc": { "type": "string", "format": "date-time" },
    "completed_at_utc": { "type": ["string", "null"], "format": "date-time" },
    "expires_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.2. Idempotency Evaluation Receipt (`IdempotencyReceipt`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "IdempotencyReceipt",
  "type": "object",
  "required": [
    "receipt_id",
    "idempotency_key",
    "execution_type",
    "response_payload",
    "served_at_utc"
  ],
  "properties": {
    "receipt_id": { "type": "string", "format": "uuid" },
    "idempotency_key": { "type": "string" },
    "execution_type": { "type": "string", "enum": ["FRESH_EXECUTION", "CACHED_REPLAY"] },
    "response_payload": { "type": ["object", "string"] },
    "served_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. Idempotency Defect Report Schema (`IdempotencyDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "IdempotencyDefectReport",
  "type": "object",
  "required": ["defect_id", "idempotency_key", "violation_code", "error_message", "timestamp_utc"],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "idempotency_key": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "IDEMPOTENCY_PAYLOAD_MISMATCH",
        "OPERATION_IN_FLIGHT",
        "LOCK_ACQUISITION_FAILED",
        "JOURNAL_STORAGE_ERROR",
        "STALE_LOCK_FORCE_RELEASED",
        "RECORD_CORRUPTED"
      ]
    },
    "error_message": { "type": "string" },
    "diagnostic_context": { "type": ["object", "null"] },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal State Machine

```text
       +--------------------+
       |   REQUEST_INGEST   |
       +--------------------+
                 |
                 | Event: DERIVE_KEY_AND_HASH
                 v
       +--------------------+
+----->|   LOOKUP_JOURNAL   |
|      +--------------------+
|         /       |        \
|        / Found  | Found   \ Not Found
|       / COMMITTED IN_PROG  |
|      v          v           v
| +--------+ +----------+ +---------------+
| | CACHE  | | REJECT   | | ACQUIRE_LOCK  |
| | REPLAY | | IN_FLIGHT| +---------------+
| +--------+ +----------+         |
|                                 | Lock Acquired
|                                 v
|                         +---------------+
|                         |   EXECUTING   |
|                         +---------------+
|                            /         \
|               Success     /           \ Execution Error
|                          v             v
|                   +------------+ +------------+
|                   | COMMIT_REC | | MARK_FAIL  |
|                   +------------+ +------------+
|                          |             |
|                          | Receipt saved| Lock cleared
|                          v             v
|                   +------------+ +------------+
|                   | COMPLETED  | |   FAILED   |
|                   +------------+ +------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `REQUEST_INGEST` | `INGEST` | Key present or derived, payload hashed | `LOOKUP_JOURNAL` | Query journal table for `idempotency_key`. |
| `LOOKUP_JOURNAL` | `MATCH_COMMITTED` | record.status == COMMITTED AND hash == record.hash | `CACHE_REPLAY` | Retrieve cached response; emit `CACHED_REPLAY` receipt. |
| `LOOKUP_JOURNAL` | `HASH_MISMATCH` | record exists BUT hash != record.hash | `FAILED` | Emit `IDEMPOTENCY_PAYLOAD_MISMATCH` Defect Report; halt. |
| `LOOKUP_JOURNAL` | `MATCH_IN_PROGRESS`| record.status == IN_PROGRESS AND lock valid | `REJECT_IN_FLIGHT` | Emit `OPERATION_IN_FLIGHT` Defect Report; reject/block. |
| `LOOKUP_JOURNAL` | `LOCK_STALE` | record.status == IN_PROGRESS AND lock expired | `ACQUIRE_LOCK` | Force-release stale lock; emit `STALE_LOCK_FORCE_RELEASED`. |
| `LOOKUP_JOURNAL` | `KEY_NOT_FOUND` | record does not exist | `ACQUIRE_LOCK` | Atomically insert record with status `IN_PROGRESS`. |
| `ACQUIRE_LOCK` | `LOCK_GRANTED` | Atomic insert succeeds | `EXECUTING` | Forward request to mutating tool / operation. |
| `ACQUIRE_LOCK` | `LOCK_DENIED` | Concurrent insert collision | `LOOKUP_JOURNAL` | Retry lookup after brief randomized jitter. |
| `EXECUTING` | `OP_SUCCESS` | Operation completes without error | `COMMIT_REC` | Update journal: status `COMMITTED`, store `cached_response`. |
| `EXECUTING` | `OP_FAILURE` | Operation throws error | `MARK_FAIL` | Update journal: status `FAILED`, record `error_details`. |
| `COMMIT_REC` | `RECEIPT_STORED` | Journal write confirmed | `COMPLETED` | Return `FRESH_EXECUTION` receipt to caller. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Idempotency Key & Payload Derivation
1. Intercept mutating request: `request = (target, operation, payload, explicit_key)`.
2. Compute `payload_hash = sha256(canonical_json(payload))`.
3. Resolve `idempotency_key`:
   - IF `explicit_key` is provided: `key = explicit_key`.
   - ELSE: `key = "idem-" + sha256(target + ":" + operation + ":" + payload_hash)[:16]`.
4. Transition state to `LOOKUP_JOURNAL`.

### Step 2: Journal Inspection & Guard Validation
1. Query `IdempotencyRecord` for `key` in journal storage.
2. **Case A: Key Found with status COMMITTED**:
   - Verify `record.payload_hash == payload_hash`:
     - IF mismatch:
       - Emit Defect Report: `IDEMPOTENCY_PAYLOAD_MISMATCH`.
       - Halt request immediately with HTTP 422 / Conflict.
   - Emit log marker: `[IDEMPOTENCY_CACHE_HIT] Key: [key] SavedExecutions: 1`.
   - Return `IdempotencyReceipt(execution_type="CACHED_REPLAY", response_payload=record.cached_response)`.
3. **Case B: Key Found with status IN_PROGRESS**:
   - Check lock expiration: `is_stale = now() > record.created_at + lock_timeout_ms`.
   - IF NOT stale:
     - Emit Defect Report: `OPERATION_IN_FLIGHT`.
     - Return retry-after rejection envelope to caller.
   - ELSE (stale lock detected):
     - Emit log marker: `[STALE_LOCK_RELEASED] Key: [key] Force releasing orphaned lock`.
     - Proceed to Step 3.
4. **Case C: Key Not Found**:
   - Proceed to Step 3.

### Step 3: Atomic Lock Acquisition
1. Attempt atomic insert of new record:
   - `idempotency_key`: `key`
   - `operation_name`: `operation`
   - `target_resource`: `target`
   - `payload_hash`: `payload_hash`
   - `status`: `IN_PROGRESS`
   - `created_at_utc`: `now()`
   - `expires_at_utc`: `now() + ttl_seconds`
2. IF insert fails due to unique constraint collision:
   - Concurrency collision detected. Revert to Step 2 after 50ms backoff.
3. Lock acquired successfully.
4. Transition state to `EXECUTING`.
5. Emit log marker: `[IDEMPOTENCY_LOCK_ACQUIRED] Key: [key] Status: IN_PROGRESS`.

### Step 4: Mutation Execution Wrapper
1. Execute underlying tool, API call, or file mutation within monitored try/except block.
2. IF execution completes successfully:
   - Capture `response_payload`.
   - Atomically update journal record:
     - `status = COMMITTED`
     - `cached_response = response_payload`
     - `completed_at_utc = now()`
   - Emit log marker: `=== IDEMPOTENT MUTATION COMMITTED: Key: [key] ===`.
   - Return `IdempotencyReceipt(execution_type="FRESH_EXECUTION", response_payload=response_payload)`.
3. ELSE (execution throws exception):
   - Capture `error_message`.
   - Atomically update journal record:
     - `status = FAILED`
     - `error_details = error_message`
   - Emit log marker: `[IDEMPOTENT_MUTATION_FAILED] Key: [key] Error: [error_message]`.
   - Propagate error to caller.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== IDEMPOTENCY FILTER INGEST: Key: [key] Op: [op] ===`
- `[IDEMPOTENCY_CACHE_HIT] Key: [key] SavedExecutions: 1`
- `[IDEMPOTENCY_LOCK_ACQUIRED] Key: [key] LockOwner: [owner]`
- `[IDEMPOTENCY_CONFLICT] Key: [key] Reason: [IN_FLIGHT | MISMATCH]`
- `=== IDEMPOTENT MUTATION COMMITTED: Key: [key] DurationMs: [ms] ===`
- `[IDEMPOTENCY_RECORD_EXPIRED] Key: [key]`

### 7.2. Defect Codes
- `IDEMPOTENCY_PAYLOAD_MISMATCH`: Re-used key with a conflicting payload.
- `OPERATION_IN_FLIGHT`: A request with this key is currently executing.
- `LOCK_ACQUISITION_FAILED`: Unable to acquire exclusive atomic lock in journal.
- `JOURNAL_STORAGE_ERROR`: Database or storage failure when accessing idempotency journal.
- `STALE_LOCK_FORCE_RELEASED`: An in-progress lock timed out and was forcibly broken.
- `RECORD_CORRUPTED`: Journal record contains malformed JSON or invalid schema.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Retried Network Call Returns Cached Response
1. Agent issues `create_invoice({"amount": 500, "client": "ACME"})`.
2. Key derived: `idem-9b12f84a`.
3. First call acquires lock, creates invoice `INV-1001`, saves response to journal, marks `COMMITTED`.
4. Network drops before agent receives HTTP 200 response.
5. Agent timeout triggers retry: `create_invoice({"amount": 500, "client": "ACME"})` with same key.
6. Filter intercepts retry: finds `idem-9b12f84a` with status `COMMITTED`.
7. Checks payload hash: matches 100%.
8. Filter returns cached response: `{"invoice_id": "INV-1001", "status": "CREATED"}` without re-creating invoice.
9. Zero duplicate invoices created.

### 8.2. Scenario 2: Key Re-Use with Altered Payload Rejected
1. Key `idem-fixed-01` was previously committed with payload `{"role": "viewer"}`.
2. Caller attempts `idem-fixed-01` with payload `{"role": "administrator"}`.
3. Filter compares payload hash with stored hash: `MISMATCH`.
4. Request rejected immediately: `IDEMPOTENCY_PAYLOAD_MISMATCH`.
5. Privilege escalation attempt blocked.

---

## 9. Operational DoD & Verification Checklist

- [ ] Every mutating tool or API call passes through the idempotency key filter before side-effect execution.
- [ ] Idempotency keys follow pattern `^idem-[a-zA-Z0-9_-]+$`.
- [ ] Payload hash is calculated using SHA-256 over canonicalized parameters.
- [ ] Concurrent requests for an in-flight key are rejected with `OPERATION_IN_FLIGHT`.
- [ ] Mismatched payload hashes for an existing key are rejected with `IDEMPOTENCY_PAYLOAD_MISMATCH`.
- [ ] Completed operations persist durable receipts and return cached responses on duplicate calls.
- [ ] Stale in-progress locks exceeding timeout are force-released with `STALE_LOCK_FORCE_RELEASED`.
- [ ] Telemetry log markers and defect reports strictly follow Section 4 and Section 7 specifications.
- [ ] All documentation, contracts, and code contain strictly ASCII-only English punctuation and characters.
