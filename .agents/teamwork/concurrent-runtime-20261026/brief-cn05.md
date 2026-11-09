# CN-05: durable per-attempt execution adapter

Project /home/sr/Projects/Workspace/codex-agent-control-plane. Read worker TOML
developer_instructions and development-access.md under /home/sr/codex-work,
project AGENTS.md and .codex/pitfalls.md if present. Root owns Git/docs. Preserve
dirty baseline. Node24, installed better-sqlite3/A2A SDK. No Git state, actual
target, live database/service/model/network/account actions. Disposable fake A2A
transport and test DBs only. ASCII English artifacts.

Allowed product files: new src/task-executor.js and test/task-executor.test.js.
Own .agents/teamwork/task-executor/ notes. Report required other source edits;
do not edit backlog, contracts, candidates or existing role service in parallel.
Read CN-05/local gate in implementation-plan.md and target-design.md dispatch/
recovery contracts, plus backlog-store/handoff.md and actual exported methods.
Read legacy lead-graph.js submitItem/findTask/receiveResult paths and
contracts.js checkSpecialistRequest plus DispatchJournal in durable-store.js.

Implement a reusable TaskExecutor over injected BacklogStore, DB, transport/
client resolver, selected-settings resolver and trusted settlement/effect adapter.
Do not rewrite legacy graph. Actual runtime/server routing is a later CN-14 gate.
The local gate may inject candidate/role-service interfaces, but reports must
distinguish tested fake protocol from installed legacy hooks.

Input is a durable claimed task/attempt/fence, never a raw unclaimed model task.
Re-read and validate pinned task revision/digest and current controls/generation,
claim/lease state, settings digest and role before external send. Pin real resolved
model/effort/Fast/settings via store.pinSelectedSettings before dispatch. Settings
and task snapshots cannot change after send; unknown settings cannot be reported
as selected. Keep source writes distinct from scratch execution in captured data.

Use a durable send state/CAS per attempt so two executor calls/processes cannot
both send an intent. Commit the deterministic context, request digest, journal
identity and send intent before network await. Stable IDs use serialized tuples.
Reuse DispatchJournal without assuming it alone provides exclusive send ownership.
Build compatible structured specialist requests and A2A messages using existing
request guards, or an explicit injected request adapter; do not silently truncate
contract text or bypass review/request validation. A real service that does not
support required concurrent publication semantics must not be presented as wired.

Known submitted identity is linked once. Validate response task/context/thread
identity against the pinned attempt; wrong/ambiguous identity is evidence and
unknown, not success. Result settlement occurs exactly once through BacklogStore;
the trusted result adapter must attest candidate/output and remote/process/effect
quiescence. A terminal A2A status alone is not child-process quiescence proof.
Duplicate identical events are idempotent; conflicting/late/stale-fence outcomes
cannot publish or free capacity. Retain bounded evidence of rejected responses.

After interrupted send-before-ack, lookup deterministic context without resend.
Missing/failed/ambiguous lookup is not no-effects proof. Expiry never releases the
claim. Reattach/poll known task; explicit trusted reconciliation is needed before
any safe replay. No overlapping provider-thread turns. Cancellation/abort is a
request until remote task AND owned processes are confirmed quiet; preserve unknown
effects and fenced capacity on timeouts. Shared transport death must mark every
associated active attempt uncertain, not only the current callback's attempt.

Minimum decisive tests: committed intent observed inside fake send; concurrent
execute calls yield one send; crash after send-before-ID persistence finds one
task; lookup absence/error never blindly resends or releases; duplicate/late/
wrong-context/task/thread response rejected; one terminal event/settlement;
generation/controls/settings drift prevents send; timeout/transport death retains
all affected claims until trusted reconciliation; candidate/output facts are
injected honestly. Use causal barriers, not timing sleeps. Run focused tests,
syntax/format checks and record exact API/results/limitations in brief/handoff.
Independent critic follows; targeted challenge is justified for replay/identity.
