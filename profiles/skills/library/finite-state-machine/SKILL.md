---
name: finite-state-machine
description: Enforces deterministic Finite State Machine (FSM) execution for multi-phase agent trajectories, dialogues, and refactoring lifecycles with explicit transition tables, state guards, and atomic entry/exit actions.
---

# Finite State Machine Pattern (finite-state-machine)

## 1. Domain Problem & Scope

### 1.1. Context & Architectural Failure Modes
Autonomous agent trajectories, complex dialogues, and multi-step refactoring workflows that lack a formal state machine suffer from severe navigational instability:
1. **Uncontrolled Phase Skipping & Backtracking**: An agent skipping code verification and jumping directly to deployment, or randomly reverting back to requirements elicitation mid-compilation.
2. **Infinite Conversational & Operational Loops**: Cycling between two intermediate states (e.g., "Analyzing" and "Refining") without monotonic convergence toward a terminal state.
3. **Dangling Partial Side Effects**: Moving from state A to state B without cleaning up temporary locks, scratch buffers, or staging directories because no exit action was executed.
4. **Undefined Transition Ambiguity**: Encountering an unforeseen event or error condition with no registered handler, causing the agent to halt abruptly or hallucinate an improvised pathway.

### 1.2. Scope & Behavioral Boundaries
The `finite-state-machine` (FSM) pattern enforces rigorous, deterministic state control:
- **Formally Declared State Set (S)**: The system exists in exactly one state s in S at any discrete point in time.
- **Strict Transition Matrix (delta)**: A transition from current state s to target state s' occurs if and only if an explicit rule (s, e, g) -> s' exists, where e is a valid event and g is a satisfied guard predicate.
- **Atomic Entry and Exit Actions**: Leaving a state unconditionally executes registered cleanup/exit hooks; entering a state unconditionally executes initialization/entry hooks.
- **Deterministic Halting**: Execution terminates if and only if a designated terminal state (s in T) is reached or a loop limit is exceeded.

---

## 2. Triggering Conditions & Classification

### 2.1. Positive Triggers
- Multi-phase engineering lifecycles (e.g., Planning -> Prototyping -> Auditing -> Persisting).
- Complex conversational dialogue agents where valid transitions depend strictly on user consent or prerequisite inputs.
- Workflows requiring mathematically bounded trajectories and guaranteed loop prevention.
- Explicit keywords: "finite state machine", "fsm execution", "enforce state machine transitions", "state-driven workflow", "deterministic state transitions", "state transition matrix".

### 2.2. Negative Triggers
- Loosely coupled asynchronous pub-sub message routing without a single global state (`actor-model`).
- Purely functional data transform pipelines with static topologies (`pipes-and-filters`).
- Simple atomic tool invocations with no lifecycle stages.

---

## 3. Invariants & Non-Negotiable Rules

1. **DETERMINISTIC_EXCLUSIVITY = MANDATORY**: An FSM instance must reside in exactly one active state at any given moment. Concurrent dual states are strictly forbidden.
2. **ZERO_UNREGISTERED_TRANSITIONS = MANDATORY**: Attempting a state transition not explicitly registered in the transition matrix must trigger immediate halt with `UNAUTHORIZED_TRANSITION_ATTEMPT`.
3. **GUARD_ENFORCEMENT = MANDATORY**: If a transition rule specifies a guard predicate, the transition is blocked unless the guard evaluates to boolean `TRUE`. Defect code: `GUARD_EVALUATION_FAILED`.
4. **ATOMIC_EXIT_ENTRY_ACTIONS = MANDATORY**: Transition execution must follow the atomic sequence:
   `(1) Assert Guard -> (2) Execute Current Exit Action -> (3) Update State Pointer -> (4) Execute Transition Action -> (5) Execute Next Entry Action`.
   If an exit action fails, emit `EXIT_ACTION_FAILED` and transition to `FAILED`. If an entry action fails, emit `ENTRY_ACTION_FAILED` and transition to `FAILED`.
5. **BOUNDED_TRANSITION_DEPTH = MANDATORY**: The FSM must enforce a maximum transition counter (`max_transitions`). Exceeding this bound halts execution with `INFINITE_LOOP_DETECTED`.

---

## 4. Rigid Data Contracts & Schemas

### 4.1. FSM Definition Schema (`FsmDefinition`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FsmDefinition",
  "type": "object",
  "required": [
    "fsm_id",
    "initial_state",
    "states",
    "terminal_states",
    "transitions",
    "max_transitions"
  ],
  "properties": {
    "fsm_id": { "type": "string", "pattern": "^fsm-[a-zA-Z0-9_-]+$" },
    "initial_state": { "type": "string" },
    "states": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 2
    },
    "terminal_states": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "transitions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["from_state", "event", "to_state"],
        "properties": {
          "from_state": { "type": "string" },
          "event": { "type": "string" },
          "to_state": { "type": "string" },
          "guard_expression": { "type": ["string", "null"] },
          "action_name": { "type": ["string", "null"] }
        },
        "additionalProperties": false
      }
    },
    "max_transitions": { "type": "integer", "minimum": 1, "default": 50 }
  },
  "additionalProperties": false
}
```

### 4.2. FSM Transition Event Schema (`FsmTransitionEvent`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FsmTransitionEvent",
  "type": "object",
  "required": ["event_id", "fsm_id", "event_name", "payload", "timestamp_utc"],
  "properties": {
    "event_id": { "type": "string", "format": "uuid" },
    "fsm_id": { "type": "string" },
    "event_name": { "type": "string", "pattern": "^[A-Z0-9_]+$" },
    "payload": { "type": "object", "additionalProperties": true },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

### 4.3. FSM Defect Report Schema (`FsmDefectReport`)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FsmDefectReport",
  "type": "object",
  "required": [
    "defect_id",
    "fsm_id",
    "current_state",
    "violation_code",
    "error_message",
    "timestamp_utc"
  ],
  "properties": {
    "defect_id": { "type": "string", "format": "uuid" },
    "fsm_id": { "type": "string" },
    "current_state": { "type": "string" },
    "attempted_event": { "type": ["string", "null"] },
    "attempted_target_state": { "type": ["string", "null"] },
    "violation_code": {
      "type": "string",
      "enum": [
        "UNAUTHORIZED_TRANSITION_ATTEMPT",
        "GUARD_EVALUATION_FAILED",
        "INFINITE_LOOP_DETECTED",
        "ENTRY_ACTION_FAILED",
        "EXIT_ACTION_FAILED",
        "UNDECLARED_TERMINAL_STATE",
        "STATE_CONTEXT_CORRUPTION"
      ]
    },
    "error_message": { "type": "string" },
    "timestamp_utc": { "type": "string", "format": "date-time" }
  },
  "additionalProperties": false
}
```

---

## 5. Formal State Machine Architecture

```text
       +--------------------+
       |   UNINITIALIZED    |
       +--------------------+
                 |
                 | Event: INSTANTIATE_FSM (Validate states & transition matrix)
                 v
       +--------------------+
+----->|   CURRENT_STATE    |<-----------------------------+
|      +--------------------+                              |
|                |                                         |
|                | Event: INGEST_EVENT(e)                  |
|                v                                         |
|      +--------------------+                              |
|      |  LOOKUP_TRANSITION |                              |
|      +--------------------+                              |
|         /                \                               |
|        / Rule Found       \ No Rule / Unauthorized Event |
|       v                    v                             |
| +------------+     +-------------------+                 |
| | EVAL_GUARD |     | HALT_UNAUTHORIZED |                 |
| +------------+     +-------------------+                 |
|         /           \                                    |
|        / Guard TRUE  \ Guard FALSE                       |
|       v               v                                  |
| +------------+  +------------------+                     |
| | EXEC_EXIT  |  | BLOCKED_BY_GUARD |                     |
| +------------+  +------------------+                     |
|       |                                                  |
|       | State Pointer Updated                            |
|       v                                                  |
| +------------+                                           |
| | EXEC_ENTRY |                                           |
| +------------+                                           |
|       |                                                  |
|       | Check Terminal Condition                         |
|       v                                                  |
|  is_terminal?                                            |
|   /        \                                             |
|  / No       \ Yes                                        |
+--+           v                                           |
       +--------------------+                              |
       |      TERMINAL      |                              |
       +--------------------+                              |
```

### 5.1. State Transition Matrix Example (Generic Lifecycle)

| Current State | Event Trigger | Guard Condition | Next State | Action / Side Effect |
|:---|:---|:---|:---|:---|
| `IDLE` | `START_WORKFLOW` | inputs_valid == TRUE | `PLANNING` | Execute `on_enter_planning()`. |
| `PLANNING` | `PLAN_APPROVED` | plan_has_tasks == TRUE | `EXECUTING` | Execute `on_exit_planning()`, `on_enter_executing()`. |
| `PLANNING` | `PLAN_REJECTED` | None | `IDLE` | Reset planning buffer; log rejection. |
| `EXECUTING` | `TASKS_DONE` | pending_tasks == 0 | `VERIFYING` | Flush execution outputs; start verification. |
| `EXECUTING` | `FATAL_ERROR` | error_unrecoverable == TRUE | `FAILED` | Record error diagnostic dump; halt. |
| `VERIFYING` | `VERIFY_PASS` | all_checks_passed == TRUE | `COMPLETED` | Sign-off artifact; execute final commit. |
| `VERIFYING` | `VERIFY_FAIL` | retry_budget > 0 | `EXECUTING` | Decrement retry budget; re-open failing tasks. |
| `VERIFYING` | `VERIFY_FAIL` | retry_budget == 0 | `FAILED` | Emit Defect Report; halt. |

---

## 6. Deterministic Step-by-Step Execution Algorithm

### Step 1: FSM Initialization & Validation
1. Ingest `FsmDefinition`.
2. Validate topological integrity:
   - `initial_state` must exist in `states`.
   - All `terminal_states` must exist in `states`.
   - All `from_state` and `to_state` in `transitions` must exist in `states`.
   - `terminal_states` must have zero outgoing transitions.
   - `max_transitions` must be an integer >= 1.
3. Initialize execution context:
   - `current_state = initial_state`
   - `transition_count = 0`
   - `history_log = []`
4. Execute `on_enter_<initial_state>()`.
5. Emit log marker: `=== FSM INITIALIZED: [fsm_id] InitialState: [initial_state] ===`.

### Step 2: Event Ingestion & Transition Lookup
1. Ingest `FsmTransitionEvent(e)`.
2. Check loop boundary:
   - Increment `transition_count += 1`.
   - IF `transition_count > max_transitions`:
     - Emit Defect Report: `violation_code: INFINITE_LOOP_DETECTED`.
     - Transition to `FAILED`. Halt immediately.
3. Search registered `transitions` where `from_state == current_state` AND `event == e.event_name`.
4. IF matching rule not found:
   - Emit Defect Report:
     - `violation_code: UNAUTHORIZED_TRANSITION_ATTEMPT`
     - `current_state: current_state`
     - `attempted_event: e.event_name`
   - Halt execution.
5. Identify candidate rule: `rule = (current_state, e.event_name, guard, target_state)`.

### Step 3: Guard Predicate Evaluation
1. IF `rule.guard_expression` is declared:
   - Evaluate expression: `guard_result = eval(rule.guard_expression, context, e.payload)`.
   - IF `guard_result != TRUE`:
     - Emit log marker: `[TRANSITION_BLOCKED] FSM: [fsm_id] Guard failed for [rule.event]`.
     - Emit Defect Report: `violation_code: GUARD_EVALUATION_FAILED`.
     - Remain in `current_state`; discard event.
     - Return blocked status to caller.
2. Guard verified `TRUE` (or guard not required).

### Step 4: Atomic State Transition Sequence
1. **Execute Exit Action**:
   - IF `current_state` has registered `on_exit()` action:
     - Invoke action. IF action throws error:
       - Emit Defect Report: `violation_code: EXIT_ACTION_FAILED`.
       - Transition to `FAILED`. Halt.
2. **Update State Pointer**:
   - Set `previous_state = current_state`.
   - Set `current_state = rule.target_state`.
   - Append to `history_log`: `(previous_state, e.event_name, current_state, timestamp)`.
   - Emit log marker: `[STATE_TRANSITION] FSM: [fsm_id] From: [previous_state] Event: [e.event_name] To: [current_state]`.
3. **Execute Transition Action (if specified)**:
   - IF `rule.action_name` is declared:
     - Invoke `action(context, e.payload)`.
4. **Execute Entry Action**:
   - IF `current_state` has registered `on_enter()` action:
     - Invoke action. IF action throws error:
       - Emit Defect Report: `violation_code: ENTRY_ACTION_FAILED`.
       - Transition to `FAILED`. Halt.

### Step 5: Terminal State Evaluation
1. Check if `current_state` is in `terminal_states`:
   - IF `current_state in terminal_states`:
     - Emit log marker: `=== FSM TERMINATED: [fsm_id] FinalState: [current_state] Transitions: [transition_count] ===`.
     - Return final context and execution summary to caller.
2. ELSE:
   - Await subsequent `FsmTransitionEvent`.

---

## 7. Concrete Telemetry & Defect Codes

### 7.1. Telemetry Log Markers
- `=== FSM INITIALIZED: [fsm_id] InitialState: [initial_state] ===`
- `[EVENT_RECEIVED] FSM: [fsm_id] Event: [event] State: [current_state]`
- `[TRANSITION_BLOCKED] FSM: [fsm_id] Event: [event] Reason: [reason]`
- `[STATE_TRANSITION] FSM: [fsm_id] From: [from] Event: [event] To: [to]`
- `=== FSM TERMINATED: [fsm_id] FinalState: [state] Count: [count] ===`

### 7.2. Defect Codes
- `UNAUTHORIZED_TRANSITION_ATTEMPT`: Event emitted that has no legal transition from the active state.
- `GUARD_EVALUATION_FAILED`: State guard evaluated to false; transition rejected.
- `INFINITE_LOOP_DETECTED`: Exceeded `max_transitions` threshold without reaching a terminal state.
- `ENTRY_ACTION_FAILED`: The hook executed upon entering a new state threw an unhandled exception.
- `EXIT_ACTION_FAILED`: The hook executed upon leaving a state threw an unhandled exception.
- `UNDECLARED_TERMINAL_STATE`: Reached a dead-end state with no outgoing transitions that is not marked terminal.
- `STATE_CONTEXT_CORRUPTION`: Context payload corrupted, inconsistent, or unparseable.

---

## 8. Few-Shot Operational Walkthroughs

### 8.1. Scenario 1: Unauthorized Transition Blocked
**FSM State**: `PLANNING`
- Registered legal transitions: `(PLANNING, PLAN_APPROVED, EXECUTING)`, `(PLANNING, CANCEL, TERMINATED)`.
- Event arrives: `DEPLOY_CODE`.
- Execution:
  1. FSM looks up `(PLANNING, DEPLOY_CODE)`.
  2. Match: `None`.
  3. FSM halts transition immediately.
  4. Defect Report emitted:
     ```json
     {
       "defect_id": "8f3b2075-8120-4e55-a226-f8409055812e",
       "fsm_id": "fsm-deploy-pipeline",
       "current_state": "PLANNING",
       "attempted_event": "DEPLOY_CODE",
       "attempted_target_state": null,
       "violation_code": "UNAUTHORIZED_TRANSITION_ATTEMPT",
       "error_message": "No registered transition from state PLANNING on event DEPLOY_CODE",
       "timestamp_utc": "2026-09-12T14:30:00Z"
     }
     ```
  5. State remains `PLANNING`. Deployment is blocked.

### 8.2. Scenario 2: Successful Lifecycle to Terminal State
1. Initial state: `IDLE`.
2. Event `START_WORKFLOW` -> Guard passes -> State becomes `PLANNING`.
3. Event `PLAN_APPROVED` -> Guard checks `plan_has_tasks == TRUE` -> State becomes `EXECUTING`.
4. Tasks execute. Event `TASKS_DONE` -> State becomes `VERIFYING`.
5. Verifications pass. Event `VERIFY_PASS` -> State becomes `COMPLETED`.
6. `COMPLETED` is in `terminal_states`.
7. FSM finalizes: `=== FSM TERMINATED: fsm-refactor FinalState: COMPLETED Count: 4 ===`.

### 8.3. Scenario 3: Guard Evaluation Failure and Event Discard
**FSM State**: `VERIFYING`
- Registered transition: `(VERIFYING, VERIFY_PASS, all_checks_passed == TRUE, COMPLETED)`.
- Event arrives: `VERIFY_PASS` with payload `{ "all_checks_passed": false, "failed_tests": 2 }`.
- Execution:
  1. FSM looks up `(VERIFYING, VERIFY_PASS)`. Match found.
  2. Guard evaluated: `eval("all_checks_passed == TRUE") -> FALSE`.
  3. Log emitted: `[TRANSITION_BLOCKED] FSM: fsm-refactor Event: VERIFY_PASS Reason: Guard evaluation failed`.
  4. Defect Report emitted with `violation_code: GUARD_EVALUATION_FAILED`.
  5. Event is discarded. State remains `VERIFYING`.

### 8.4. Scenario 4: Atomic Action Failure Trapping
**FSM State**: `PLANNING`
- Event `PLAN_APPROVED` arrives. Guard passes.
- Transition sequence starts:
  1. Execute `on_exit_planning()`. Action throws exception: `Disk quota exceeded in scratch buffer`.
  2. Defect Report emitted: `violation_code: EXIT_ACTION_FAILED`.
  3. State pointer set to `FAILED`.
  4. Machine halts immediately to prevent dirty partial state propagation.

### 8.5. Scenario 5: Bounded Loop Limit Exceeded
**FSM State**: Cycling between `EXECUTING` and `VERIFYING` on recurring `VERIFY_FAIL`.
- Configured: `max_transitions: 10`.
- Execution:
  1. Transitions 1..10 proceed through retries.
  2. At transition 11, `transition_count (11) > max_transitions (10)`.
  3. FSM detects runaway loop.
  4. Defect Report emitted: `violation_code: INFINITE_LOOP_DETECTED`.
  5. Machine transitions to `FAILED` and halts.
