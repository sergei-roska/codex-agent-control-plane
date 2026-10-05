---
name: raft-quorum-consensus
description: "A distributed systems skill implementing Raft-style Quorum Consensus for multi-agent deliberation, architectural decision-making, and contradictory specialist verdict arbitration across an odd-numbered agent cluster."
---

# SKILL: raft-quorum-consensus

## 1. Overview & Mission

The `raft-quorum-consensus` skill implements Raft-style distributed deliberation and quorum commit semantics for autonomous multi-agent systems. In complex multi-agent architectures, specialist subagents (e.g., security auditor, performance architect, product manager, domain modeler) frequently produce contradictory recommendations or conflicting review verdicts on the same codebase or architectural proposal.

Without a formal consensus protocol, multi-agent systems suffer fatal failure modes:
1. Split-Brain Stalemates: Balanced positive and negative votes resulting in deadlocked pipelines without deterministic resolution.
2. Stale Ballot Ingestion: Delayed ballots from preceding review cycles corrupting active vote tallies.
3. Informal Majority Drift: Arbitrary commitment decisions made on incomplete votes without verifying a strict majority quorum.
4. Lack of Dissent Auditability: Decisions committed without preserving dissenting arguments, preventing root-cause failure analysis.

This skill eliminates these failure modes by enforcing an odd-numbered voting cluster ($N \ge 3$, $N \% 2 == 1$), monotonic term progression, strict majority quorum thresholds ($\lfloor N / 2 \rfloor + 1$), and append-only decision logging with preserved dissenting rationales.

---

## 2. Trigger & Activation

### 2.1. Positive Triggers (MUST Run)
- Resolving conflicting review verdicts among specialist subagents (e.g., security vs speed, performance vs maintainability).
- Deciding on high-impact architectural tradeoffs where no single subagent holds unilateral veto power.
- Multi-agent committee decisions requiring a verified majority quorum before state persistence.
- Explicit keywords:
  - "raft quorum consensus"
  - "multi-agent consensus arbitration"
  - "majority vote decision"
  - "resolve conflicting agent verdicts"
  - "distributed architectural quorum"
  - "cluster ballot"

### 2.2. Negative Triggers (MUST NOT Run)
- Operations requiring 100% unanimous approval before writing to disk (use `two-phase-commit` instead).
- Hierarchical command-and-control architectures where a single supervisor agent makes unilateral executive decisions (use `supervisor-tree` instead).
- Purely linear sequential pipeline transformations without peer voting (use `pipes-and-filters` instead).

---

## 3. Invariants & Non-Negotiable Rules

1. MAJORITY_QUORUM_ENFORCEMENT = MANDATORY: A proposition is committed if and only if strictly greater than 50% of registered cluster members cast affirmative ballots: `count(VOTE_GRANT) >= floor(N / 2) + 1`. Failure code: `QUORUM_NOT_REACHED`.
2. ODD_CLUSTER_MEMBERSHIP = MANDATORY: The active voting cluster must maintain an odd number of voting members ($N \ge 3$ and $N \% 2 == 1$). Even-numbered clusters trigger immediate rejection with failure code `EVEN_CLUSTER_MEMBERSHIP_DETECTED`.
3. TERM_MONOTONICITY = MANDATORY: Each deliberation round increments `term_id` monotonically. Any ballot bearing `term_id < current_term` must be dropped as stale with failure code `STALE_TERM_BALLOT_DROPPED`.
4. ONE_VOTE_PER_DELEGATE = MANDATORY: Each registered cluster member may cast at most one valid ballot per `(term_id, proposal_id)`. Duplicate ballots within the same term are ignored.
5. DISSENT_PRESERVATION = MANDATORY: Dissenting rationales (`VOTE_DENY`) must be permanently recorded alongside approving rationales in the final committed consensus receipt.

---

## 4. Rigid Data Contracts & Schemas

All payloads must strictly validate against the following schemas.

### 4.1. Consensus Cluster Configuration (ClusterConfig)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ClusterConfig",
  "type": "object",
  "required": ["cluster_id", "voting_members", "voting_timeout_ms"],
  "properties": {
    "cluster_id": { "type": "string", "pattern": "^cluster-[a-zA-Z0-9_-]+$" },
    "voting_members": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 3
    },
    "current_term": { "type": "integer", "minimum": 1, "default": 1 },
    "voting_timeout_ms": { "type": "integer", "minimum": 1000, "default": 15000 },
    "decision_log_path": { "type": "string", "default": ".agents/storage/consensus/decisions.jsonl" }
  },
  "additionalProperties": false
}
```

### 4.2. Proposal Payload Schema (ProposalPayload)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ProposalPayload",
  "type": "object",
  "required": [
    "proposal_id",
    "cluster_id",
    "term_id",
    "title",
    "proposed_change",
    "evaluation_criteria",
    "created_at_utc"
  ],
  "properties": {
    "proposal_id": { "type": "string", "pattern": "^prop-[a-zA-Z0-9_-]+$" },
    "cluster_id": { "type": "string" },
    "term_id": { "type": "integer", "minimum": 1 },
    "title": { "type": "string" },
    "proposed_change": { "type": "object", "additionalProperties": true },
    "evaluation_criteria": { "type": "array", "items": { "type": "string" } },
    "created_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. Ballot Envelope Schema (BallotEnvelope)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BallotEnvelope",
  "type": "object",
  "required": [
    "ballot_id",
    "proposal_id",
    "term_id",
    "voter_id",
    "vote",
    "rationale",
    "timestamp_utc"
  ],
  "properties": {
    "ballot_id": { "type": "string", "format": "uuid" },
    "proposal_id": { "type": "string" },
    "term_id": { "type": "integer", "minimum": 1 },
    "voter_id": { "type": "string" },
    "vote": { "type": "string", "enum": ["VOTE_GRANT", "VOTE_DENY", "ABSTAIN"] },
    "rationale": { "type": "string" },
    "confidence_score": { "type": "number", "minimum": 0.0, "maximum": 1.0, "default": 1.0 },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.4. Consensus Commit Receipt (ConsensusCommitReceipt)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ConsensusCommitReceipt",
  "type": "object",
  "required": [
    "receipt_id",
    "proposal_id",
    "term_id",
    "verdict",
    "total_cluster_size",
    "votes_granted",
    "votes_denied",
    "committed_at_utc"
  ],
  "properties": {
    "receipt_id": { "type": "string", "format": "uuid" },
    "proposal_id": { "type": "string" },
    "term_id": { "type": "integer" },
    "verdict": { "type": "string", "enum": ["COMMITTED", "REJECTED"] },
    "total_cluster_size": { "type": "integer" },
    "quorum_threshold": { "type": "integer" },
    "votes_granted": { "type": "integer" },
    "votes_denied": { "type": "integer", "minimum": 0 },
    "ballots": { "type": "array", "items": { "$ref": "#/definitions/BallotEnvelope" } },
    "committed_at_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.5. Defect Report Schema (RaftDefectReport)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "RaftDefectReport",
  "type": "object",
  "required": ["cluster_id", "term_id", "violation_code", "message", "timestamp_utc"],
  "properties": {
    "cluster_id": { "type": "string" },
    "term_id": { "type": "integer" },
    "proposal_id": { "type": "string" },
    "violation_code": {
      "type": "string",
      "enum": [
        "QUORUM_NOT_REACHED",
        "EVEN_CLUSTER_MEMBERSHIP_DETECTED",
        "STALE_TERM_BALLOT_DROPPED",
        "VOTING_TIMEOUT_EXPIRED",
        "UNREGISTERED_VOTER_REJECTED"
      ]
    },
    "message": { "type": "string" },
    "state": {
      "type": "object",
      "properties": {
        "cluster_size": { "type": "integer" },
        "quorum_threshold": { "type": "integer" },
        "votes_granted": { "type": "integer" },
        "votes_denied": { "type": "integer" },
        "votes_abstained": { "type": "integer" }
      }
    },
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
                 | Event: VERIFY_CLUSTER (Check N is odd, N >= 3)
                 v
       +--------------------+
+----->|   CLUSTER_READY    |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: BROADCAST_PROPOSAL (Advance Term)|
|                v                                         |
|      +--------------------+                              |
|      |  COLLECTING_VOTES  |                              |
|      +--------------------+                              |
|         /                \                               |
|        / Ballots received \ Timeout expires              |
|       v                    v                             |
| +------------+     +-------------------+                 |
| | TALLY_VOTES|     | HARVEST_PARTIAL   |                 |
| +------------+     +-------------------+                 |
|        |                     |                           |
|        +----------+----------+                           |
|                   |                                      |
|                   v                                      |
|            EVALUATE_QUORUM                               |
|              /          \                                |
|             /            \                               |
|  Grant >= (N/2)+1         Grant < (N/2)+1                |
|           v                v                             |
|     +------------+   +------------+                      |
|     |  COMMITTING|   |  REJECTING |                      |
|     +------------+   +------------+                      |
|           |                |                             |
|           | Log appended   | Log rejection               |
|           v                v                             |
|     +------------+   +------------+                      |
|     | COMMITTED  |   |  REJECTED  |                      |
|     +------------+   +------------+                      |
|           |                |                             |
|           +--------+-------+                             |
|                    |                                     |
+--------------------+-------------------------------------+
```

### 5.1. State Transition Matrix

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `UNINITIALIZED` | `INIT_CLUSTER` | `len(voters) % 2 == 1 AND len(voters) >= 3` | `CLUSTER_READY` | Register delegates; initialize `current_term = 1`. |
| `UNINITIALIZED` | `INIT_CLUSTER` | `len(voters) % 2 == 0` | `FAILED` | Emit `EVEN_CLUSTER_MEMBERSHIP_DETECTED` Defect Report; halt. |
| `CLUSTER_READY` | `SUBMIT_PROPOSAL` | Proposal well-formed | `COLLECTING_VOTES` | Increment `term_id += 1`; broadcast proposal to all voters. |
| `COLLECTING_VOTES` | `BALLOT_RECEIVED` | `ballot.term_id == current_term AND voter registered` | `COLLECTING_VOTES` | Store ballot; record voter participation. |
| `COLLECTING_VOTES` | `BALLOT_RECEIVED` | `ballot.term_id < current_term` | `COLLECTING_VOTES` | Drop stale ballot; emit `STALE_TERM_BALLOT_DROPPED`. |
| `COLLECTING_VOTES` | `ALL_VOTED` | `count(ballots) == total_members` | `TALLY_VOTES` | Stop countdown timer; begin tally. |
| `COLLECTING_VOTES` | `TIMER_EXPIRED` | `elapsed_ms >= voting_timeout_ms` | `TALLY_VOTES` | Seal ballot box; mark missing voters as ABSTAIN. |
| `TALLY_VOTES` | `QUORUM_MET` | `affirmative_votes >= floor(N/2) + 1` | `COMMITTING` | Construct `ConsensusCommitReceipt` with verdict COMMITTED. |
| `TALLY_VOTES` | `QUORUM_FAILED` | `affirmative_votes < floor(N/2) + 1` | `REJECTING` | Construct receipt with verdict REJECTED. |
| `COMMITTING` | `PERSIST_COMPLETE` | Decision appended to persistent log | `CLUSTER_READY` | Broadcast binding decision to cluster and caller. |
| `REJECTING` | `PERSIST_COMPLETE` | Rejection logged | `CLUSTER_READY` | Emit `QUORUM_NOT_REACHED` Defect Report; return rejection. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: Cluster Precondition Verification
1. Inspect `voting_members` array: `N = len(voting_members)`.
2. Assert `N >= 3` and `N % 2 == 1`:
   - IF `N % 2 == 0`:
     - Emit Defect Report: `EVEN_CLUSTER_MEMBERSHIP_DETECTED`.
     - Halt immediately.
3. Compute quorum threshold: `quorum_threshold = (N // 2) + 1`.
4. Transition state to `CLUSTER_READY`.
5. Emit log marker: `=== CLUSTER INITIALIZED: [cluster_id] Members: [N] Quorum: [quorum_threshold] ===`.

### Step 2: Proposal Broadcast & Term Advancement
1. Receive `ProposalPayload(P)`.
2. Increment `current_term += 1`.
3. Set `P.term_id = current_term`.
4. Initialize ballot ledger for `current_term`: `ballots = {}`.
5. Broadcast proposal `P` to all `N` delegates concurrently.
6. Initialize countdown timer: `voting_timeout_ms`.
7. Transition state to `COLLECTING_VOTES`.
8. Emit log marker: `=== PROPOSAL BROADCAST: [P.proposal_id] Term: [current_term] ===`.

### Step 3: Concurrent Ballot Collection
1. While `now() < deadline` AND `len(ballots) < N`:
   - Upon receiving `BallotEnvelope(B)`:
     - IF `B.term_id < current_term`:
       - Emit log marker: `[STALE_BALLOT_DROPPED] Voter: [B.voter_id] BallotTerm: [B.term_id]`.
       - Continue loop.
     - IF `B.voter_id not in voting_members`:
       - Emit log marker: `[UNREGISTERED_VOTER_REJECTED] Voter: [B.voter_id]`.
       - Continue loop.
     - IF `B.voter_id in ballots`:
       - Ignore duplicate ballot from same voter in same term.
       - Continue loop.
     - Accept ballot: `ballots[B.voter_id] = B`.
     - Emit log marker: `[BALLOT_RECORDED] Voter: [B.voter_id] Vote: [B.vote] Term: [B.term_id]`.
2. IF `len(ballots) == N` OR timer expires:
   - For any voter in `voting_members` who did not submit a ballot before timer expiration:
     - Synthesize `BallotEnvelope(vote="ABSTAIN", rationale="TIMEOUT_EXPIRED")`.
     - `ballots[missing_voter] = synthetic_ballot`.
   - Transition state to `TALLY_VOTES`.

### Step 4: Quorum Tally & Verdict Evaluation
1. Tally votes:
   - `grants = count(b.vote == "VOTE_GRANT" for b in ballots.values())`
   - `denies = count(b.vote == "VOTE_DENY" for b in ballots.values())`
   - `abstains = count(b.vote == "ABSTAIN" for b in ballots.values())`
2. Emit log marker: `[TALLY_COMPLETED] Grants: [grants] Denies: [denies] Needed: [quorum_threshold]`.
3. IF `grants >= quorum_threshold`:
   - Transition state to `COMMITTING`.
   - Set `verdict = COMMITTED`.
4. ELSE:
   - Transition state to `REJECTING`.
   - Set `verdict = REJECTED`.

### Step 5: Persistent Decision Commit & Broadcast
1. Mint unique UUID: `receipt_id`.
2. Assemble `ConsensusCommitReceipt`:
   - `receipt_id`, `proposal_id`, `term_id`, `verdict`, `total_cluster_size: N`,
   - `quorum_threshold`, `votes_granted: grants`, `votes_denied: denies`,
   - `ballots: list(ballots.values())`, `committed_at_utc: now()`.
3. Atomically append receipt to `decision_log_path` in JSONL format.
4. IF `verdict == COMMITTED`:
   - Emit log marker: `=== CONSENSUS COMMITTED: [P.proposal_id] Term: [current_term] ===`.
5. ELSE:
   - Emit log marker: `=== CONSENSUS REJECTED: [P.proposal_id] Term: [current_term] ===`.
   - Emit Defect Report: `QUORUM_NOT_REACHED`.
6. Broadcast `ConsensusCommitReceipt` to all cluster members and caller.
7. Return receipt to orchestrator.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== CLUSTER INITIALIZED: [cluster_id] Members: [count] Quorum: [count] ===`
- `=== PROPOSAL BROADCAST: [proposal_id] Term: [term] ===`
- `[BALLOT_RECORDED] Voter: [voter_id] Vote: [vote] Term: [term]`
- `[STALE_BALLOT_DROPPED] Voter: [voter_id] BallotTerm: [term]`
- `[TALLY_COMPLETED] Grants: [grants] Denies: [denies] Needed: [quorum]`
- `=== CONSENSUS COMMITTED: [proposal_id] Term: [term] ===`
- `=== CONSENSUS REJECTED: [proposal_id] Term: [term] ===`

### 7.2. Defect Codes
- `QUORUM_NOT_REACHED`: Proposal failed to gather strictly greater than 50% affirmative votes.
- `EVEN_CLUSTER_MEMBERSHIP_DETECTED`: Cluster was configured with an even number of voters.
- `STALE_TERM_BALLOT_DROPPED`: Received ballot bearing an obsolete term ID.
- `VOTING_TIMEOUT_EXPIRED`: Voting timer expired before all delegates submitted ballots.
- `UNREGISTERED_VOTER_REJECTED`: Ballot received from an unauthorized agent address.

---

## 8. Operational Scenarios & Few-Shot Walkthroughs

### 8.1. Scenario 1: 3-Member Cluster Commits Architectural Migration
**Cluster**: `[security_critic, perf_architect, domain_analyst]` ($N = 3$, Quorum = 2).
- Proposal: Migrate user authentication to JWT tokens (`prop-jwt`).
- `Term = 1`. Proposal broadcast to all 3 delegates.
- Ballots received:
  1. `perf_architect`: `VOTE_GRANT` ("Reduces database session lookups by 80%")
  2. `domain_analyst`: `VOTE_GRANT` ("Satisfies stateless microservice architecture requirement")
  3. `security_critic`: `VOTE_DENY` ("Token revocation requires Redis denylist")
- Tally: Grants = 2, Denies = 1.
- Quorum calculation: `Grants (2) >= Quorum (2)`.
- Verdict: `COMMITTED`.
- Both concurring arguments and the security critic's dissent are appended to the decision receipt.
- Telemetry:
```text
=== CLUSTER INITIALIZED: [cluster-auth] Members: [3] Quorum: [2] ===
=== PROPOSAL BROADCAST: [prop-jwt] Term: [1] ===
[BALLOT_RECORDED] Voter: [perf_architect] Vote: [VOTE_GRANT] Term: [1]
[BALLOT_RECORDED] Voter: [domain_analyst] Vote: [VOTE_GRANT] Term: [1]
[BALLOT_RECORDED] Voter: [security_critic] Vote: [VOTE_DENY] Term: [1]
[TALLY_COMPLETED] Grants: [2] Denies: [1] Needed: [2]
=== CONSENSUS COMMITTED: [prop-jwt] Term: [1] ===
```

### 8.2. Scenario 2: Proposal Rejected Due to Lack of Quorum
**Cluster**: `[agent_A, agent_B, agent_C, agent_D, agent_E]` ($N = 5$, Quorum = 3).
- Proposal: Introduce dynamic eval in production pipeline (`prop-eval`).
- Ballots:
  - `agent_A`: `VOTE_GRANT`
  - `agent_B`: `VOTE_DENY` (Security vulnerability)
  - `agent_C`: `VOTE_DENY` (Unsafe execution)
  - `agent_D`: `ABSTAIN` (Timeout)
  - `agent_E`: `VOTE_GRANT`
- Tally: Grants = 2, Denies = 2, Abstains = 1.
- Quorum calculation: `Grants (2) < Quorum (3)`. Quorum failed!
- Verdict: `REJECTED`.
- Telemetry:
```text
=== CLUSTER INITIALIZED: [cluster-eval] Members: [5] Quorum: [3] ===
=== PROPOSAL BROADCAST: [prop-eval] Term: [1] ===
[BALLOT_RECORDED] Voter: [agent_A] Vote: [VOTE_GRANT] Term: [1]
[BALLOT_RECORDED] Voter: [agent_B] Vote: [VOTE_DENY] Term: [1]
[BALLOT_RECORDED] Voter: [agent_C] Vote: [VOTE_DENY] Term: [1]
[BALLOT_RECORDED] Voter: [agent_D] Vote: [ABSTAIN] Term: [1]
[BALLOT_RECORDED] Voter: [agent_E] Vote: [VOTE_GRANT] Term: [1]
[TALLY_COMPLETED] Grants: [2] Denies: [2] Needed: [3]
=== CONSENSUS REJECTED: [prop-eval] Term: [1] ===
```
- Defect Report emitted with `violation_code: QUORUM_NOT_REACHED`.

### 8.3. Scenario 3: Stale Ballot Dropped
Scenario: Delegate emits ballot with Term 1 while active Term is 2. The coordinator intercepts and discards the stale ballot.
- Telemetry:
```text
=== CLUSTER INITIALIZED: [cluster-data] Members: [3] Quorum: [2] ===
=== PROPOSAL BROADCAST: [prop-data-303] Term: [2] ===
[STALE_BALLOT_DROPPED] Voter: [worker-delayed] BallotTerm: [1]
[BALLOT_RECORDED] Voter: [worker-fast-1] Vote: [VOTE_GRANT] Term: [2]
[BALLOT_RECORDED] Voter: [worker-fast-2] Vote: [VOTE_GRANT] Term: [2]
[TALLY_COMPLETED] Grants: [2] Denies: [0] Needed: [2]
=== CONSENSUS COMMITTED: [prop-data-303] Term: [2] ===
```

### 8.4. Scenario 4: Even Cluster Membership Rejection
Scenario: Cluster is configured with 4 delegates (an even number), violating the odd-numbered cluster invariant.
- Telemetry:
```text
{
  "defect_report": {
    "cluster_id": "cluster-invalid-even",
    "term_id": 1,
    "violation_code": "EVEN_CLUSTER_MEMBERSHIP_DETECTED",
    "message": "Voting cluster must maintain an odd number of voting delegates (N >= 3). Observed: 4",
    "timestamp_utc": "2026-09-12T17:46:58Z"
  }
}
```

---

## 9. Definition of Done (DoD)

- [ ] Every active voting cluster maintains an odd number of voting members ($N \ge 3$ and $N \% 2 == 1$).
- [ ] Any even-numbered cluster configuration immediately fails fast with `EVEN_CLUSTER_MEMBERSHIP_DETECTED`.
- [ ] Every deliberation cycle strictly increments `current_term`.
- [ ] Ballots bearing `term_id < current_term` are dropped with `[STALE_BALLOT_DROPPED]`.
- [ ] Quorum threshold is strictly evaluated as `floor(N / 2) + 1`.
- [ ] Decision receipts record both approving and dissenting rationales in an append-only log.
- [ ] All output is strictly ASCII English with valid JSON schemas.
