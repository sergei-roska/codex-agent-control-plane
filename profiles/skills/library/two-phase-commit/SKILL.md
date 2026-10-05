---
name: two-phase-commit
description: A software engineering skill implementing the Two-Phase Commit (2PC) consensus protocol for atomic workspace mutations, code generation, and multi-file refactoring, enforcing unanimous validator consensus, staging isolation, and zero dirty writes.
---

# SKILL: two-phase-commit

## 1. Overview

A deterministic software engineering skill implementing the Two-Phase Commit (2PC) consensus protocol for autonomous agent workflows, atomic workspace mutations, code generation, and multi-file refactoring. In Phase 1 (Prepare / Vote), proposed modifications are isolated within a virtual staging buffer and evaluated concurrently across all declared validation delegates (syntax linters, AST verifiers, unit test suites, security scanners). In Phase 2 (Commit / Abort), changes are permanently flushed to disk if and only if 100% of validators return an explicit VOTE_COMMIT decision; otherwise, the entire transaction is immediately aborted, staging buffers are purged, and the workspace remains in its exact pristine pre-transaction baseline state.

## 2. Trigger & Activation

### Positive Triggers
- "two phase commit"
- "2pc transaction"
- "atomic multi-file commit"
- "consensus validation before write"
- "fail-safe file commit"
- Multi-file code generation and architectural refactoring where partial writes corrupt workspace integrity.
- Automated file modifications requiring multi-delegate consensus (linter, compiler, test suite) prior to persistence.
- High-integrity operations requiring guaranteed rollback to pristine baseline on any validation defect.

### Negative Triggers
- Single-file exploratory writes or scratchpad edits where atomic guarantees are unneeded.
- Read-only workspace inspections, queries, or static code analysis where zero state mutation occurs.
- Freeform conversational edits where partial or incremental file modifications are explicitly permitted.
- Operations where validators cannot evaluate staged diffs in isolation prior to disk persistence.

## 3. Invariants & Rules

- **UNANIMOUS_CONSENSUS = MANDATORY**: All declared validation delegates must explicitly return a VOTE_COMMIT decision. A single VOTE_ABORT or validation timeout triggers an immediate transaction abort with defect code `COMMIT_CONSENSUS_FAILED`.
- **STAGING_ISOLATION = TRUE**: Proposed mutations must be staged in an isolated virtual buffer or temporary shadow directory. Production target files must remain completely untouched until Phase 2 commit.
- **ATOMIC_WRITE = TRUE**: Phase 2 commit must flush staged modifications in an atomic, non-interruptible sequence with post-write checksum verification.
- **ZERO_DIRTY_WRITES = TRUE**: If Phase 2 aborts, all temporary staging buffers are purged; zero uncommitted diffs or partial files remain on disk.
- **PRECONDITION_VALIDATION = MANDATORY**: Before transaction initialization, the coordinator must verify: (1) valid mutation patch payload, (2) non-empty list of registered validation delegates, and (3) clean target workspace baseline. Failure immediately halts with `PRECONDITION_FAILED`.
- **FAIL_FAST = TRUE**: Any validator timeout, communication failure, or staging error immediately halts the active phase and transitions directly to transaction abort.

## 4. Protocol Architecture & Core Data Contracts

Every 2PC transaction is governed by strictly typed schemas.

### 4.1. Transaction Configuration (`TransactionConfig`)
- `timeout_ms` (integer, default: 30000): Global transaction timeout in milliseconds.
- `staging_dir` (string, default: ".agents/staging/2pc/"): Filesystem path for shadow staging buffers.
- `require_unanimous` (boolean, constant: true): Enforces 100% commit consensus requirement.
- `atomic_flush_strategy` (string enum: `shadow_atomic_rename`, `direct_fsync_write`): Strategy used during Phase 2 flush.

### 4.2. Proposed Mutation (`ProposedMutation`)
- `file_path` (string, required): Relative or absolute target workspace path.
- `staged_content` (string, required): Proposed file content after mutation.
- `baseline_checksum` (string, required): SHA-256 checksum of target file before mutation.
- `diff_summary` (string, optional): Unified diff overview of proposed modifications.

### 4.3. Validation Delegate (`ValidatorDelegate`)
- `validator_id` (string, required): Unique identifier for the validation agent or tool.
- `name` (string, required): Human-readable name (e.g., "eslint-linter", "cargo-check", "pytest-suite").
- `command` (string, required): Command or tool invocation executed against staged shadow buffer.
- `timeout_ms` (integer, default: 10000): Per-validator execution timeout limit.

### 4.4. Vote Envelope (`VoteEnvelope`)
- `validator_id` (string, required): Identifier of voting delegate.
- `vote` (string enum: `VOTE_COMMIT`, `VOTE_ABORT`): Binary voting decision.
- `execution_time_ms` (integer, required): Time spent executing validation.
- `evidence_log` (string, required): Diagnostic logs, test outputs, or compiler messages.
- `error_details` (string or null): Specific error trace if vote is VOTE_ABORT.

### 4.5. Commit Receipt (`CommitReceipt`)
- `txn_id` (string, required): Unique transaction identifier (e.g., "TXN-2026-001").
- `status` (string, constant: "COMMITTED"): Final status confirming successful write.
- `mutated_files` (array of objects): List of modified paths with verified post-write SHA-256 checksums.
- `committed_at` (integer, required): Unix timestamp of commit completion.

### 4.6. Defect Report (`DefectReport`)
- `violation_code` (string enum: `COMMIT_CONSENSUS_FAILED`, `VALIDATOR_TIMEOUT`, `STAGING_ISOLATION_BREACH`, `ATOMIC_WRITE_FAILED`, `PRECONDITION_FAILED`, `VALIDATOR_UNAVAILABLE`).
- `txn_id` (string, required): Unique transaction identifier.
- `failed_validators` (array of strings): List of validator IDs that rejected or timed out.
- `message` (string, required): Diagnostic explanation of failure.
- `timestamp` (integer, required): Unix timestamp of abort completion.

## 5. State Machine Diagram

```text
+-----------------------------------------------------------------+
|                       TRANSACTION REQUEST                       |
+-----------------------------------------------------------------+
                                |
                                v
                            [ IDLE ]
                                |
             Event: REGISTER_TRANSACTION (Preconditions OK)
                                |
                                v
                           [ STAGED ]
                                |
             Event: DISPATCH_PREPARE (Spawn Validators)
                                |
                                v
                          [ PREPARING ]
                                |
             Event: AWAIT_VOTES (Concurrent Poll)
                                |
                                v
                           [ VOTING ] ----------------------------+
                                |                                 |
           Event: ALL_VOTES_RECEIVED             Event: TIMEOUT_EXPIRED
                                |                                 |
                                v                                 v
                         [ EVALUATING ]                   [ ABORTING ]
                          /          \                            ^
   100% VOTE_COMMIT      /            \ Any VOTE_ABORT            |
                        v              \                          |
                 [ COMMITTING ]         +-------------------------+
                    /           Flush Success   /          \ Flush Failure (Write Error)
                  v                        [ COMMITTED ]       +--------------------------------->
           (Terminal State)                                       |
                                                                  v
                                                             [ ABORTED ]
                                                           (Terminal State)
```

## 6. State Transition Table & Evaluation Logic

### 6.1. State Transition Table

| Current State | Event Trigger | Guard Condition | Next State | Operational Action |
| --- | --- | --- | --- | --- |
| `IDLE` | `REGISTER_TRANSACTION` | Valid patch AND non-empty validators AND clean workspace | `STAGED` | Mint `txn_id`, create shadow directory, write staged files |
| `IDLE` | `REGISTER_TRANSACTION` | Empty validators OR invalid patch OR dirty workspace | `ABORTED` | Emit `PRECONDITION_FAILED` Defect Report, halt |
| `STAGED` | `DISPATCH_PREPARE` | Staging buffer verified isolated | `PREPARING` | Spawn concurrent validation jobs targeting staged files |
| `PREPARING` | `AWAIT_VOTES` | All validation jobs dispatched | `VOTING` | Await vote envelopes until complete or timeout |
| `VOTING` | `COLLECT_VOTES` | All votes collected before timeout | `EVALUATING` | Tally voting decisions |
| `VOTING` | `TIMEOUT_EXPIRED` | One or more validators exceeded timeout | `ABORTING` | Record `VALIDATOR_TIMEOUT` for missing delegates |
| `EVALUATING` | `EVALUATE_CONSENSUS` | count(VOTE_COMMIT) == total_validators AND count(VOTE_ABORT) == 0 | `COMMITTING` | Begin atomic flush of staged files to disk |
| `EVALUATING` | `EVALUATE_CONSENSUS` | count(VOTE_ABORT) > 0 OR count(TIMEOUT) > 0 | `ABORTING` | Record `COMMIT_CONSENSUS_FAILED`, trigger buffer purge |
| `COMMITTING` | `FLUSH_SUCCESS` | All target files written AND checksums verified | `COMMITTED` | Purge staging buffers, emit CommitReceipt |
| `COMMITTING` | `FLUSH_FAILURE` | Filesystem write error OR checksum mismatch | `ABORTING` | Restore baseline backups, record `ATOMIC_WRITE_FAILED` |
| `ABORTING` | `PURGE_COMPLETE` | Shadow buffers purged AND baseline pristine | `ABORTED` | Emit DefectReport detailing rejections, halt |

### 6.2. Consensus Evaluation Logic

The evaluation predicate is strictly binary and zero-tolerance:

```text
ConsensusVerdict = 
    IF (count(VOTE_COMMIT) == total_declared_validators AND
        count(VOTE_ABORT) == 0 AND
        count(TIMEOUT) == 0)
    THEN ADVANCE_TO_COMMIT
    ELSE ADVANCE_TO_ABORT
```

## 7. Execution Algorithm

### Step 1: Precondition Check & Transaction Registration
1. Verify mutation patch is non-empty and well-formed.
2. Verify registered validator list contains at least 1 active delegate.
3. Compute SHA-256 baseline checksum for each target file.
4. IF any precondition fails:
   - Emit log: `[PRECONDITION_FAILED] Transaction registration rejected`
   - Emit Defect Report with `violation_code: "PRECONDITION_FAILED"`
   - Transition to `ABORTED` and halt.
5. Mint transaction identifier `txn_id` (format: `TXN-YYYY-SEQ`).
6. Emit log marker: `=== 2PC TRANSACTION INITIALIZED: [txn_id] ===`.

### Step 2: Shadow Staging Isolation
1. Create isolated shadow staging directory `.agents/staging/2pc/<txn_id>/`.
2. Write proposed file mutations into shadow directory, preserving relative path topology.
3. Assert target production workspace files remain unmodified:
   `ASSERT(current_checksum(target_file) == baseline_checksum)`
4. IF staging isolation check fails:
   - Emit log: `[STAGING_ISOLATION_BREACH] Premature disk write detected`
   - Purge staging directory and transition to `ABORTED`.
5. Transition state to `STAGED`.

### Step 3: Phase 1 (Prepare / Vote Dispatch)
1. Transition state to `PREPARING`.
2. For each registered validator in `ValidatorDelegate`:
   - Emit log: `[PHASE_1_PREPARE_DISPATCH] Validator: [validator_id] Command: [command]`
   - Dispatch validation job concurrently, pointing delegate working directory to shadow buffer.
3. Transition state to `VOTING`.
4. Initialize global countdown timer (`timeout_ms`).
5. Await responses from all delegates.
6. IF timer expires before all votes are received:
   - For each pending validator, record `vote: "VOTE_ABORT"`, `error_details: "VALIDATOR_TIMEOUT"`.
   - Emit log: `[VALIDATOR_TIMEOUT] Validator did not respond within [timeout_ms] ms`.
   - Transition state to `ABORTING`. Proceed to Step 5B.

### Step 4: Vote Aggregation & Consensus Evaluation
1. Collect and parse `VoteEnvelope` from each delegate.
2. For each received vote:
   - Emit log: `[VOTE_RECEIVED] Validator: [validator_id] Vote: [VOTE_COMMIT|VOTE_ABORT] Duration: [execution_time_ms]ms`
3. Transition state to `EVALUATING`.
4. Compute vote totals:
   `total_commit = count(vote == "VOTE_COMMIT")`
   `total_abort = count(vote == "VOTE_ABORT")`
5. IF `total_commit == len(validators)` AND `total_abort == 0`:
   - Emit log: `[CONSENSUS_ACHIEVED] 100% Unanimous Commit Approval`
   - Transition state to `COMMITTING`. Proceed to Step 5A.
6. ELSE:
   - Emit log: `[CONSENSUS_FAILED] Transaction rejected by [total_abort] validator(s)`
   - Transition state to `ABORTING`. Proceed to Step 5B.

### Step 5A: Phase 2A (Atomic Commit & Verification)
1. For each file in `ProposedMutation`:
   - Atomically copy/rename staged file from shadow directory to target production path.
   - Verify post-write file integrity by recalculating SHA-256 checksum.
2. IF any file write fails or checksum mismatch occurs:
   - Emit log: `[ATOMIC_WRITE_FAILED] Disk mutation failed on [file_path]`
   - Revert modified files to recorded baseline backups.
   - Transition state to `ABORTING`. Proceed to Step 5B.
3. Purge shadow staging directory `.agents/staging/2pc/<txn_id>/`.
4. Transition state to `COMMITTED`.
5. Emit `CommitReceipt` with mutated file list and checksums.
6. Emit log marker: `=== 2PC TRANSACTION COMMITTED: [txn_id] ===`.
7. Return success result to caller.

### Step 5B: Phase 2B (Transaction Abort & Buffer Purge)
1. Recursively delete shadow staging directory `.agents/staging/2pc/<txn_id>/`.
2. Verify all target workspace production files match original baseline checksums.
   `ASSERT(current_checksum(target_file) == baseline_checksum)`
3. Transition state to `ABORTED`.
4. Construct and emit `DefectReport` detailing:
   - `violation_code`: `COMMIT_CONSENSUS_FAILED` or `VALIDATOR_TIMEOUT`
   - `failed_validators`: List of rejecting or timed-out delegate IDs
   - `evidence_logs`: Aggregated rejection output from delegates
5. Emit log marker: `=== 2PC TRANSACTION ABORTED: [txn_id] ===`.
6. Return failure report to caller.

## 8. Telemetry & Defect Report Specification

### 8.1. Standard Log Markers
Every 2PC transaction emits deterministic log markers:
- `=== 2PC TRANSACTION INITIALIZED: [txn_id] ===`
- `[STAGING_VERIFIED] ShadowBuffer: [path] BaselineVerified: TRUE`
- `[PHASE_1_PREPARE_DISPATCH] Validator: [validator_id] Command: [command]`
- `[VOTE_RECEIVED] Validator: [validator_id] Vote: [VOTE_COMMIT|VOTE_ABORT] Duration: [ms]`
- `[CONSENSUS_ACHIEVED] 100% Unanimous Commit Approval`
- `[CONSENSUS_FAILED] Transaction rejected by [count] validator(s)`
- `[ATOMIC_WRITE_FLUSH] Path: [file_path] Checksum: [sha256]`
- `=== 2PC TRANSACTION COMMITTED: [txn_id] ===`
- `=== 2PC TRANSACTION ABORTED: [txn_id] ===`

### 8.2. Violation Codes
- `COMMIT_CONSENSUS_FAILED`: One or more validation delegates rejected the proposed changes.
- `VALIDATOR_TIMEOUT`: A delegate failed to emit a vote within configured timeout bounds.
- `STAGING_ISOLATION_BREACH`: Target production files were modified prior to Phase 2 commit.
- `ATOMIC_WRITE_FAILED`: Filesystem I/O error or checksum mismatch occurred during Phase 2 flush.
- `PRECONDITION_FAILED`: Invalid patch, missing validators, or dirty baseline detected at start.
- `VALIDATOR_UNAVAILABLE`: Configured validation tool or executable could not be found or executed.

## 9. Few-Shot Operational Walkthroughs

### Example 1: Successful Unanimous 2PC Transaction
- Proposed changes: Refactor `auth_service.py` and `token_helper.py`.
- Registered validators: `ast-syntax-check`, `flake8-linter`, `unit-tests`.
- Execution:
  1. Transaction `TXN-2026-101` registered; baseline checksums recorded.
  2. Staged in `.agents/staging/2pc/TXN-2026-101/`. Target files pristine.
  3. Phase 1 dispatch: All 3 validators invoked concurrently against shadow files.
  4. Votes collected:
     - `ast-syntax-check`: VOTE_COMMIT (32ms)
     - `flake8-linter`: VOTE_COMMIT (140ms)
     - `unit-tests`: VOTE_COMMIT (890ms)
  5. Consensus: 3 of 3 VOTE_COMMIT (100%).
  6. Phase 2 commit: Files flushed to disk; post-write checksums verified; shadow directory purged.
  7. Marker emitted: `=== 2PC TRANSACTION COMMITTED: TXN-2026-101 ===`.

### Example 2: Validator Rejection Abort
- Proposed changes: Add payment endpoint to `billing_controller.py`.
- Registered validators: `syntax-check`, `security-scanner`, `integration-tests`.
- Execution:
  1. Transaction `TXN-2026-102` registered; staged in shadow buffer.
  2. Phase 1 dispatch: All 3 validators invoked concurrently.
  3. Votes collected:
     - `syntax-check`: VOTE_COMMIT (40ms)
     - `security-scanner`: VOTE_ABORT (210ms, "Insecure direct object reference detected")
     - `integration-tests`: VOTE_COMMIT (1200ms)
  4. Consensus: 2 VOTE_COMMIT, 1 VOTE_ABORT. Unanimity failed.
  5. Phase 2 abort: Shadow buffer `.agents/staging/2pc/TXN-2026-102/` recursively purged.
  6. Workspace baseline verified 100% pristine. Zero dirty writes on disk.
  7. Marker emitted: `=== 2PC TRANSACTION ABORTED: TXN-2026-102 ===`.
  8. DefectReport emitted with `violation_code: "COMMIT_CONSENSUS_FAILED"`.

### Example 3: Validator Timeout Abort
- Proposed changes: Update database schema in `schema.prisma`.
- Registered validators: `prisma-validate`, `db-migration-dryrun`.
- Execution:
  1. Transaction `TXN-2026-103` registered; staged in shadow buffer.
  2. Phase 1 dispatch: Both validators dispatched with 5000ms timeout limit.
  3. `prisma-validate` returns VOTE_COMMIT in 200ms.
  4. `db-migration-dryrun` hangs due to network deadlock; timer expires at 5000ms.
  5. Coordinator marks `db-migration-dryrun` as `VALIDATOR_TIMEOUT`.
  6. Phase 2 abort: Staging buffer purged immediately. Target files untouched.
  7. Marker emitted: `=== 2PC TRANSACTION ABORTED: TXN-2026-103 ===`.
  8. DefectReport emitted with `violation_code: "VALIDATOR_TIMEOUT"`.
