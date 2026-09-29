# Multi-Agent Orchestrator Design Reference

Status: independent architecture reference and implementation checklist. It does not prescribe a framework, model provider, programming language, deployment topology, or application domain. Code and product names below are examples, not prerequisites.

## 1. Purpose and boundaries

An orchestrator accepts a goal, divides or routes work, supplies permitted context and tools, coordinates executions, validates results, and records enough state to recover from interruption. An agent may be an LLM-powered process, a deterministic service, a human, or a combination. The same control model can support software development, research, content production, operations, or other workflows.

This document separates **portable contracts** from **replaceable mechanisms**. A minimal orchestrator may have one process, one worker, and an in-memory queue. A distributed system may add durable queues, leases, isolated workspaces, and external artifact storage. Add those mechanisms when the workload requires them.

This is a design reference, not a ready-to-run implementation. The illustrative algorithms omit storage and API details that must be specified for a particular system.

## 2. Choose the coordination model

Different levels of control solve different problems:

| Model | Use it for | Limitation |
| --- | --- | --- |
| Sequential plan | A small, predictable series of steps | Independent work waits unnecessarily |
| Dependency graph (DAG) | Tasks that can start when named prerequisites finish | A static DAG alone does not express retries, approval waits, or arbitrary loops |
| State machine or durable workflow | Explicit lifecycle transitions, retries, pauses, and recovery | It needs a task selection policy for parallel work |
| Event or queue-based dispatch | Decoupling producers from workers and absorbing load | Delivery does not define task correctness or authorization |
| Manager-led delegation | Adaptive decomposition and routing | Model decisions need limits and validation |

These models can be combined. A common design uses a lifecycle controller for the overall run and a DAG for one revision of its task plan. The controller may replan and install another validated DAG. Neither a DAG nor a state machine is mandatory for every orchestrator.

MapReduce is a useful special case when many independent tasks share a final aggregation step. A DAG permits a dependent task to start as soon as its own prerequisites complete. The choice affects latency only when independent work exists and enough worker capacity is available.

## 3. Portable concepts and contracts

Keep these identities distinct:

- **Run**: one accepted goal with an owner, policy, budget, and terminal outcome.
- **Plan revision**: a versioned set of tasks and dependencies for a run.
- **Task**: a bounded unit with defined inputs, outputs, acceptance criteria, and dependencies.
- **Attempt**: one dispatch of a task to an executor. Several attempts may belong to one task.
- **Execution**: the actual worker activity for an attempt, identified independently from the task.
- **Artifact**: a versioned result or evidence item, stored directly or by reference.
- **Decision**: a recorded human or policy approval tied to an exact action and artifact revision.

An example task record, expressed in JSON for clarity:

```json
{
  "id": "analyze_data",
  "planRevision": 3,
  "description": "Analyze the validated dataset",
  "dependsOn": ["validate_data"],
  "inputRefs": ["artifact:dataset:v2"],
  "expectedOutputs": ["analysis_report"],
  "acceptanceCriteria": ["Report includes the requested measures"],
  "requiredCapabilities": ["read_dataset", "write_report"],
  "status": "pending",
  "attemptCount": 0,
  "maxAttempts": 3,
  "assignedExecutionId": null
}
```

The exact schema can differ, but define these contracts before choosing a queue or framework:

| Contract | Minimum information |
| --- | --- |
| Task input | Goal, task and plan IDs, pinned source revisions, input artifact refs, allowed capabilities, limits |
| Execution result | Task/attempt/execution IDs, status, output refs, usage, error class, verification evidence |
| Artifact | Immutable ID or version, content type, origin task/attempt, storage reference, integrity metadata |
| Lifecycle event | Event ID, run/task IDs, plan revision, event type, timestamp, causation ID |
| Approval request | Exact action, target, artifact/plan revision, scope, expiry or invalidation rule |

The worker should return structured results. Free-form prose may accompany a result but must not be the sole source of authoritative status or artifact identity.

## 4. Reference components

```text
Input/API -> Policy + Planner -> Plan Store -> Scheduler -> Dispatcher -> Executor(s)
              |                   |              |                 |
              |                   |              +-- Result/Event Handler
              |                   |                         |
              +-- Human Decisions  +-- Artifact Store <- Verifier/Integrator
                                      |
                              Traces and Metrics
```

- **Input/API** accepts goals, cancellation, feedback, and status requests.
- **Policy** enforces permissions, budgets, approvals, and allowed transitions outside model prompts.
- **Planner** may be a human, a model, or deterministic code. Its output is a proposal until validated.
- **Plan Store** holds authoritative run, task, attempt, and plan-revision state.
- **Scheduler** selects tasks whose prerequisites and policy guards are satisfied.
- **Dispatcher** reserves capacity and creates an execution identity before sending work.
- **Executor** runs a bounded task with an isolated context and returns a structured result.
- **Verifier/Integrator** checks acceptance and merges or publishes outputs under explicit policy.
- **Artifact Store** holds inputs, outputs, and evidence by immutable reference.
- **Human Decisions** persist waits and responses so a restart does not lose them.
- **Traces and Metrics** connect work across all components.

One process may implement all components. A service boundary is an operational choice, not a requirement of the contracts.

## 5. Plan validation and readiness

For a DAG-based plan, validate in this order:

1. Validate task shape, IDs, status values, resource limits, and plan revision.
2. Reject duplicate IDs, self-dependencies, and references to unknown task IDs.
3. Reject unauthorized capabilities or missing required input/output definitions.
4. Detect cycles in the dependency graph.
5. Check that every task has an acceptance or completion rule.

Do not report a missing dependency as a cycle. Kahn's algorithm can detect cycles after reference validation: count each node's dependencies, enqueue zero-degree nodes, remove them one by one, and decrement their dependents. If fewer than all nodes are removed, the graph has a cycle. Its time cost is O(tasks + dependencies).

The basic readiness rule is:

```text
ready(task) = task.status in {pending, retry_pending}
           AND every required predecessor has succeeded
           AND required input artifacts are resolvable
           AND policy guards allow dispatch
           AND any retry delay has elapsed
           AND capacity and budget are available
```

A task with a failed prerequisite must not wait forever. Define whether the dependent task becomes `blocked`, is skipped, uses a fallback result, or waits for replanning. For conditional workflows, record which branch was selected and apply the corresponding dependency rule rather than treating a skipped branch as success.

The scheduler must reserve a task before dispatch. Two scheduler instances must not both claim the same pending task. Use a transaction, compare-and-swap, or another atomic claim mechanism in the selected store.

## 6. Lifecycle and concurrency invariants

A useful task lifecycle is:

```text
pending -> reserved -> running -> verifying -> integrating -> succeeded
                         |             |              |
                         |             |              +-> retry_pending / failed
                         |             +-> retry_pending / failed
                         +-> retry_pending / failed / cancelled
pending -> blocked / skipped / cancelled
retry_pending -> reserved
```

A run can independently be `planning`, `executing`, `waiting_for_human`, `completed`, `failed`, or `cancelled`. A failure in one task does not require the whole run to leave `executing` while unrelated executions are active.

Enforce these invariants in the state store:

- A task starts only after its required predecessors have succeeded under the current plan revision.
- At most one lease or execution generation is authoritative for a task at a time. A stale worker may still finish physically, but its result cannot be accepted.
- Every accepted result names the task, attempt, execution, and plan revision it belongs to.
- Worker capacity is released when an attempt reaches a terminal state, including failure, timeout, and cancellation.
- A failed task does not erase or reject valid results from other active tasks.
- Completion requires verified outputs, committed and resolvable output artifacts, and satisfied acceptance rules, not merely a worker's `success` claim.
- Each attempt has one accepted terminal result. Repeated or conflicting events cannot release its capacity twice or change that result.
- Budgets and retry counts survive process restarts.
- A protected external action requires a valid decision for that exact action and revision.

A completion handler should atomically record the result or failure, release the reservation, and make newly eligible tasks visible to the scheduler. Dispatch itself can happen afterward. If these steps span stores, define recovery for a crash between them.

## 7. Dispatch and worker capacity

The scheduler finds eligible tasks; the dispatcher matches them with capacity. Capacity may mean a fixed worker slot, a provider quota, a project quota, or a human queue. Track both global and per-run limits so one run cannot consume all resources unintentionally.

A local implementation may use an in-process pool. A distributed implementation may use a durable queue, such as a Redis-backed queue or another broker. Queue concurrency is usually per worker instance, so `concurrency: 1` alone does not establish a system-wide single writer or global rate limit.

For each dispatch:

1. Persist a unique execution ID, attempt number, plan revision, lease or deadline, and permitted capabilities.
2. Reserve capacity and mark the task `reserved` atomically with respect to other dispatchers.
3. Deliver the job with a stable operation ID. Treat delivery as potentially duplicated.
4. Move to `running` when the worker acknowledges or begins work.
5. Accept only a result that matches the current execution generation.
6. Record the terminal attempt outcome, release capacity, and schedule eligible successors.

A lost response is ambiguous: the worker may still be running. Reconcile execution status or let its lease expire before retrying. A lease expiration must fence late writes from the old execution.

## 8. Failure, retry, and recovery

Classify failures because they require different actions:

| Failure | Typical response |
| --- | --- |
| Temporary transport or provider error | Bounded retry with backoff and rate-limit awareness |
| Invalid output schema | Reject result; bounded repair attempt or escalation |
| Failed acceptance check | Return findings to an executor or replanner |
| Missing permission or approval | Persist a wait or fail with a policy reason |
| Task cannot be completed with current plan | Replan within limits or request human input |
| Worker crash or lost lease | Reconcile, fence old execution, then retry if allowed |
| Invalid plan | Reject before any new task is dispatched |

Give transport retries, task repair cycles, and plan revisions separate counters and budgets. A retry must preserve the original goal, acceptance criteria, input revisions, and prior failure evidence unless a deliberate plan revision changes them. Avoid blindly asking a worker to return only code: different tasks require different output contracts and explanations.

Use a durable event log or persistent state transitions for recovery. A queue and a checkpoint do not make external side effects happen exactly once. For writes to external systems, use stable operation IDs, idempotent APIs where available, reconciliation after ambiguous responses, and compensation where appropriate. Never assume a successful queue acknowledgment means the external action was committed.

If dispatch and state persistence use separate systems, a transactional outbox or equivalent reconciliation loop prevents a task from being marked reserved but never delivered. A recovery scan should identify expired leases, orphaned reservations, pending approvals, and incomplete integration steps.

## 9. Replanning and task replacement

Dynamic replanning changes a **plan revision**. Do it under a run-level lock or compare-and-swap so a concurrent completion cannot update an obsolete graph. Preserve the old revision and its results for audit.

To replace a failed task with subtasks:

1. Pause scheduling for the affected portion of the plan. Account for already running descendants.
2. Give the new tasks unique IDs, bounded depth, explicit inputs/outputs, and dependencies on the original task's required predecessors where needed.
3. Identify terminal subtasks in the replacement group. Rewire consumers of the old task to the outputs they actually need, not automatically to every new leaf.
4. Validate references, cycles, capabilities, artifact contracts, and budgets in the entire candidate plan.
5. Atomically install the new revision and resume scheduling. Carry forward completed tasks and artifacts only through an explicit revision mapping that confirms unchanged inputs, outputs, and acceptance criteria. Revalidate or rerun tasks whose inputs or contract changed. Reject late results carrying the old revision unless an explicit migration rule accepts them.

A failed task may be retained as historical state instead of physically deleted. Its replacement relationship should be recorded. Replanning cannot silently change the meaning of already approved actions or acceptance criteria.

## 10. Artifacts and context

Pass workers the context required by their input contract and policy. Direct predecessor artifacts are a useful starting point, but a task may also need an original user requirement, a transitive artifact, or an external source. Resolve those references explicitly and pin versions. Do not supply the entire run history by default.

For large artifacts, a **claim-check** approach sends immutable references through the queue and stores content in object storage, a database, or a shared filesystem. Verify access scope, integrity, and retention. The selected storage system is replaceable.

Ways to control model context size include targeted retrieval, dependency-based selection, summaries with source links, and structural code outlines. Summaries and outlines are lossy; workers must be able to request the full source when correctness requires it. Measure context reduction against task quality, not just token count.

Treat retrieved documents, source files, tickets, and tool outputs as data. Instructions embedded in them must not gain the authority of the orchestrator's policy or the user's request.

## 11. Isolation and integration of outputs

Parallel executors need isolated working state and a controlled integration path. Choose a pattern appropriate to the artifact:

| Pattern | Useful when | Required control |
| --- | --- | --- |
| Separate workspaces or branches | Workers create independent file changes | Base revision, merge policy, conflict handling, tests |
| Single writer | Many workers propose updates to one target | System-wide writer ownership, version checks, recovery |
| Immutable artifacts plus integrator | Workers produce reports, data, media, or code bundles | Schema validation, provenance, selected winner/merge rule |
| Transactional external API | Work updates a database or service | Authorization, idempotency, conflict detection |

A branch or worktree prevents direct file collisions but is not a security boundary. An in-process queue with one consumer does not guarantee atomic file changes or exclusive ownership across service replicas. For file integration, validate the base revision, apply changes in an isolated staging area, run checks, and publish the new revision with compare-and-swap or an equivalent lock. Avoid constructing shell commands by interpolating untrusted paths or patch content.

Define what happens when two valid outputs conflict. A model reviewer may propose a resolution, but the integrator must enforce revision checks and acceptance policy.

## 12. Verification and human decisions

Verification should be specific to the artifact: tests and static checks for code, schema and consistency checks for data, citation and factual review for research, or a configured review protocol for another domain. Record the exact artifact revision and evidence behind a verdict. New output invalidates evidence for the previous revision.

A reviewer can be another agent or a human. For an independent review, give it the requirements, candidate artifact, and check evidence without treating the producing worker's self-assessment as proof. A required mechanical gate cannot be waived by an agent's positive verdict.

Pause for a human when policy requires approval or a bounded recovery path is exhausted. Persist the requested action, target, artifact/plan revision, reason, and decision. On resume, re-check that the approval still applies to the current revision. Cancellation and rejection are explicit outcomes, not missing events.

## 13. Security and operational controls

Enforce least-privilege capabilities outside prompts. Scope credentials and artifact access to the run, project, executor, and action. Separate read, draft, publish, delete, and deployment permissions. Keep secrets out of worker context and redact them from traces.

Apply time, step, token, monetary, and recursion limits while work is running. A limit checked only after an agent returns cannot stop an unbounded tool loop. Rate limits may be global, provider-specific, or per tenant; centralize accounting when workers are distributed. Backoff must not be mistaken for a completed task.

Propagate cancellation to active executions and external operations where supported. If a side effect cannot be cancelled, record that state and reconcile its outcome before proceeding.

## 14. Observability and evaluation

Propagate a run/trace ID through planner, scheduler, queue, executor, verifier, and external tools. Record plan revision, task and attempt IDs, model/profile versions where applicable, capability grants, artifact refs, transitions, costs, latency, errors, and decisions. Control trace retention and access because inputs and tool results may contain sensitive data.

Evaluate the complete workflow with representative tasks and acceptance criteria. Compare quality, human correction effort, cost, latency, failure recovery, and policy violations. More parallelism can reduce elapsed time but increase integration work or provider throttling. Optimize from measured bottlenecks rather than assuming the largest worker pool is best.

## 15. Incremental implementation path

1. **Single bounded task:** define contracts, policy, one executor, output validation, and terminal states.
2. **Durable lifecycle:** persist attempts, budgets, approvals, cancellation, and restart behavior.
3. **Dependency plan:** add reference and cycle validation, readiness, and blocked-dependency handling.
4. **Controlled parallelism:** add reservations, leases, quotas, isolated execution, and integration checks.
5. **Adaptive planning:** allow bounded plan revisions and safe task replacement.
6. **Distributed scaling:** add a durable broker, outbox/reconciliation, external artifact storage, rate limiting, and cross-service tracing if needed.

Each stage should demonstrate a successful run, a failed run, a restart, and a protected action. The implementation can stop at any stage that meets the workload.

## 16. Decisions for a concrete orchestrator

Before implementing a specific system, answer:

- What kinds of goals, tasks, artifacts, and acceptance criteria are supported?
- Who or what plans work, and when may the plan change?
- Are dependencies sequential, DAG-based, conditional, or discovered at runtime?
- Which state store is authoritative, and how are claims and revisions atomic?
- What is the execution boundary: local process, service, container, or external agent?
- Which actions require human approval, and how is that approval bound to a revision?
- What are the retry, timeout, cancellation, and recovery contracts?
- How are concurrent outputs isolated, verified, and integrated?
- What are the global and per-run limits for capacity, cost, and tool access?
- Which traces and evaluations prove the system meets its actual workload?

A framework, queue, protocol, model, and storage product should be selected from these requirements. They are implementation choices, not the foundation itself.

## 17. Reference algorithms (language-neutral pseudocode)

These algorithms show the minimum coordination rules. Replace each `atomic` block with transactions or equivalent compare-and-swap operations in the chosen state store.

### Validate a dependency plan

```text
validate(plan):
    ids = empty set
    for task in plan.tasks:
        require valid task schema and task.planRevision == plan.revision
        require task.id not in ids
        add task.id to ids

    dependents = map each task ID to an empty list
    degree = map each task ID to zero
    for task in plan.tasks:
        for predecessor in task.dependsOn:
            require predecessor in ids
            require predecessor != task.id
            degree[task.id] += 1
            append task.id to dependents[predecessor]

    queue = all IDs with degree == 0
    processed = 0
    while queue is not empty:
        id = remove one ID from queue
        processed += 1
        for child in dependents[id]:
            degree[child] -= 1
            if degree[child] == 0:
                append child to queue

    require processed == count(plan.tasks), otherwise report a cycle
```

Schema, capability, budget, and artifact-contract validation still apply before the plan is installed. Reject a malformed plan as a whole; do not dispatch the valid-looking subset.

### Claim and dispatch ready work

```text
for task in tasks eligible under the current plan revision:
    atomic in authoritative state store:
        recheck status, dependencies, policy, budget, and capacity
        if any guard fails: continue
        increment attempt count
        create execution ID and lease generation
        reserve capacity
        mark task reserved
        record a dispatch intent with stable operation ID

    deliver the recorded intent to an executor
```

The dispatch intent may be an outbox record. A recovery process retries undelivered intents using the same operation ID. Duplicated delivery must not create a second authoritative execution.

### Accept a result and unlock successors

```text
on result or failure event:
    atomic in authoritative state store:
        find task by run ID, task ID, and plan revision
        if execution ID or lease generation is stale: record and ignore
        if event ID was already handled: return previous outcome
        if this attempt already has a terminal result: record conflict and ignore
        require task is reserved or running and this attempt owns its reservation
        record output refs or classified error
        release this attempt's reservation
        move task to verifying, retry_pending, failed, or cancelled
        record the event as handled

    if task is verifying:
        verify the exact output revision
        if valid: wait for any required approval, then integrate under the output contract
        atomically record succeeded only after the committed output is resolvable
        otherwise record the classified verification or integration failure
    trigger a scheduler pass for newly eligible work
```

The result handler remains active while other tasks fail, retry, or wait for a human. A failure event must not make the orchestrator discard a completion event from an unrelated execution.
