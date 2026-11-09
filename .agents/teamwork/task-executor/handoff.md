# CN-05 task executor handoff

Status: thread-identity and shared-transport repair applied; frozen for bounded lead review.

## API

`TaskExecutor` is exported from `src/task-executor.js`. Constructor options:
`backlogStore`, the same SQLite `db`, `transportFor`, `settingsFor`, `roleFor`,
`requestAdapter`, `resultAdapter`, optional `dispatchJournal`, `now`, and
`maxEvidence`. It uses `DispatchJournal` by default and has its own unique
per-attempt intent table/CAS; the journal is not treated as send ownership.

Methods: `execute(identity, {signal})`, `reconcile(identity)`, `poll(identity)`,
`acceptTerminal(identity, remote)`, `abort(identity, {signal})`,
`transportFailed(transportKey, error)`, `getAttempt(attemptId)`, and
`listEvidence(attemptId)`. Identity requires project/objective/task/attempt IDs
and fencing token. The task ID must exactly match the durable attempt and claim on first send and every replay, polling, abort, reconciliation, and terminal path. Explicit takeover settlement may include the current
`recoveryGeneration`; BacklogStore verifies that generation.

The adapter revalidates current task contract, controls, generation, claim/lease,
role and settings. It pins the settings resolver output before constructing the
checked specialist request. The request objective must exactly match the pinned
task, and its declared write set must equal the pinned product paths. The injected
request adapter remains responsible for lossless conversion of the other structured
contract fields; it must not omit or truncate them. Scratch roots remain separately
captured. It commits deterministic
context, request digest, journal identity and SQLite send intent before transport
await. Any prior intent is lookup/poll only; it is never sent again. Known
submitted task IDs replay without repinning or resending.

The request adapter may return `threadId` to identify a known continuation, or
the request may provide `threadId` / `metadata.threadId`. The executor reserves
that transport/thread pair with the send intent, includes the known ID in the
outgoing transport metadata, and rejects overlap before send.
Missing adapter `transportKey` uses `project:<projectId>` as a conservative
shared service group; explicit keys distinguish independent transports. The
first observed remote thread ID is durably pinned in the local intent record and
must match every later lookup, poll, and terminal event. A provider-assigned
thread that was unknown before send cannot be reserved in advance; it is pinned
upon first observation and any reservation conflict leaves the attempt uncertain.

A terminal event must match task/context and any pinned thread identity. Lookup,
poll, cancellation, and trusted settlement of already-submitted work remain
available after pause/control revision changes, while task, fence, authority, and
current owner generation checks remain enforced. The result adapter receives the
current objective/control state alongside captured attempt pins. A settled task
outcome is historical execution evidence, not current goal acceptance or a new
publication permit; publication stays with the separately gated candidate adapter.
Result and quiescence facts come only from injected `resultAdapter`; BacklogStore makes
terminal settlement idempotent and releases capacity only with its evidence
requirements. Abort/cancel calls only request cancellation. Shared transport
failure marks every matching live local intent uncertain and permanently blocks
new sends under that transport key; a replacement transport must use a new key.
Transport adapters signal shared death with `error.sharedTransportFailure === true`
or the owner calls `transportFailed`. This fanout runs for transport resolution in
`execute`, `reconcile`, `poll`, and `abort`, as well as send failures. Rejected response records are bounded and store identity/status/digests rather than raw remote
conversation bodies.

## Verification

- `env -u NODE_TEST_CONTEXT node --check src/task-executor.js`: passed.
- `env -u NODE_TEST_CONTEXT node --check test/task-executor.test.js`: passed.
- `env -u NODE_TEST_CONTEXT node --test test/task-executor.test.js test/backlog-store.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 65 passed, 0 failed.
- Python ASCII and trailing-whitespace check for source/test: passed.
- Tests use a disposable in-memory SQLite database, fake A2A transport, injected settings/request/result adapters, and causal promise barriers. No timing sleeps.
- Before repair, a minimal fake transport repro returned thread-A on execute and accepted a thread-B terminal event for the same task/context (`terminalError:null`, final task state `succeeded`). Regression now executes through the adapter and confirms thread-B is rejected and capacity stays held.
- Coverage includes exact task/attempt/fence identity on first send and replay, intent visible in send callback, concurrent execute CAS, send-before-ack lookup, absence/error/ambiguity with no resend, terminal dedupe/quiescence, wrong task/context/thread/fence evidence, exact objective and write-scope enforcement, settings/control/generation drift, delayed transport resolver, shared resolver-failure fanout from poll/reconcile/abort across roles with the default project group, automatic send-failure fanout/blocking, known continuation-thread overlap rejection, pause-compatible abort/poll/settlement, and takeover reconciliation.

## Limits

This is a local protocol gate using fake transport and injected adapters. No real role service supports or was tested for concurrent publication semantics. No startup wiring, legacy `lead-graph.js` routing, provider subprocess monitoring, or real candidate/output attestation is installed. `resultAdapter` is a trust boundary and must attest remote plus owned-process quiescence; terminal A2A status alone is insufficient. An unknown or absent lookup retains the claim and capacity indefinitely pending explicit trusted reconciliation. Root owns Git and tracked docs; no Git mutation, network, live service, model, or target was used.
