# Core milestone frozen for review

Status: partial. Source frozen 2026-10-27 pending independent review. Root owns
Git/docs and remaining facade qualification. No Git mutations, live models,
accounts, services or targets, dependency installs, or subagents.

## Changed files and decisions

- src/concurrent-delivery-engine.js:143 creates durable planner execution facts.
  Lines 497-511 connect existing lifecycle recovery proof/retry/reconciliation APIs.
  Lines 563-610 persist exact ledger identity, observed start and validated terminal
  provider facts. Invalid JSON or rejected sanitized output returns null to existing
  planner validation, preserving outputReturned and bounded validation retry behavior.
  Lines 613-637 join exact project/session/ledger turn/thread/scope/owner generation,
  compare start/terminal process identity, require trusted completed terminal and
  cleanup flags, then independently prove process group gone. Unknown provider
  exceptions never become validation recovery. Reconciliation additionally requires
  lifecycle-issued recovery_eligible proof matching every identity field.
- test/concurrent-delivery-engine.test.js:140 qualifies real RoleService acceptance
  with required checks, empty checks, and invalid JSON followed by corrected planner
  output. Recovery uses a real detached disposable fake process, stopped before
  terminal result. Asserts persisted facts and lifecycle reconciled proof.
  Line 690 adds live-process, missing-terminal, wrong-thread, and provider-error
  negatives. Each stays held with one provider call, no lifecycle proof, unknown
  ledger turn and unsafe shutdown rejection. Abort returns canceled facade status
  without falsely clearing the unknown ledger.
- src/delivery-acceptance.js:334 normalizes legacy not_required to accepted only
  after pinned frozen manifest checks and only with zero required checks and empty
  results/issues/reasons. Other not_required results reject. No fabricated checks.
- test/delivery-acceptance.test.js:256 adds real empty-check proof and negatives for
  required checks, unexpected check result, issues, reasons and candidate mutation.

No delivery-role-service files changed. The previously suspected role-service
proof defect did not reproduce: empty verifier proof passes. Actual initial failure
was finalization_check_result_invalid because legacy disposition was not_required;
checkSettings was already present (initial hypothesis corrected before edits).
Root explicitly granted delivery-acceptance source/test scope for this finding.

## Authorized verification

`node --check src/concurrent-delivery-engine.js`: pass.

`env -u NODE_TEST_CONTEXT node --test --test-name-pattern='pinned base candidate' test/concurrent-delivery-engine.test.js`:
initial reproduction 1 pass, 1 fail (empty contract finalization).

`env -u NODE_TEST_CONTEXT node --test --test-name-pattern='planner-recovery' test/concurrent-delivery-engine.test.js`:
1 pass, 0 fail.

Final exact-skip command:
`env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/concurrent-delivery-engine.test.js test/delivery-acceptance.test.js test/delivery-output-artifacts.test.js test/delivery-role-capabilities.test.js`
46 pass, 0 fail. Prohibited test absent from output. Node reports 0 skipped because
skip-pattern excludes it from discovered reported tests. Accepted artifact,
capability, overlap, pins, steering and required acceptance behavior remains green.

## Boundary deviations (not authorized security evidence)

Two commands mistakenly executed the prohibited disposable hostile Git-filter
regression; root notified promptly. Do not reuse those executions as authorized
security evidence, and do not repeat them.

1. `env -u NODE_TEST_CONTEXT node --test test/concurrent-delivery-engine.test.js test/delivery-acceptance.test.js`
   23 pass, 1 fail: new candidate mutation fixture tried writing a readonly file.
   Corrected fixture to chmod before mutation, matching existing mutation test.
2. `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='^(?!candidate attributes and inherited Git configuration)' test/concurrent-delivery-engine.test.js test/delivery-acceptance.test.js`
   28 pass, 0 fail, but negative regex did not exclude the forbidden test. Command
   was already running when root supplied exact --test-skip-pattern requirement.

Every subsequent command including delivery-acceptance.test.js must include the
exact final skip option above. No guard denial was bypassed, no shared state used.

## Remaining work and concrete next action

Independent critic review of the frozen four-file milestone and inherited core
changes. Root takes remaining run/resume, pause/cancel, owner correction, DB reopen
and shutdown facade qualification after review. No claim that all CN14 gates close.

Inspection concern for next qualification: #waitForTerminal handles blocked_technical
and stale recovery, but does not return paused_owner. This is unverified as a facade
bug; add a bounded pause/resume test before deciding a fix. Persisted recovery facts
are now durable, but reopen recovery itself is not yet tested. Current recovery
requires process group gone, so shared long-lived provider processes intentionally
remain held even with completed turn text or cleanup flags.

## Second milestone: production recovery shape and durable shutdown safety

2026-10-27 source frozen again for immediate review of this safety delta.

Critic correctly rejected the cleanupSucceeded requirement: production executionOf
never exports it. Inspected real AppServer _run:1209 awaits _cleanupTerminal,
cleanup failure throws, terminalError throws, only then :1212 returns completed.
run:1021 attaches the real executionOf shape. Removed fake-only cleanup predicate;
retained completed result, exact terminal/start identities and process group gone.
Positive recovery fixture omits cleanupSucceeded and asserts persisted absence.
No AppServer source changes or fabricated fields.

Ignored scratch `facade-probes.cjs` extracts only the existing core fixture prefix
with Module._compile; no copied test suite. Command:
`env -u NODE_TEST_CONTEXT node --test .agents/teamwork/cn14-core-followup-20261027b/facade-probes.cjs`
3/3 observation probes passed against the earlier frozen source. Log is
`facade-probes.log` (local ignored evidence, may disappear). Findings:
- paused_owner run facade remains pending; resume(existing controller) leaves
  paused_owner and pending. Bounded 150ms observations, no real providers.
- authenticated correction invalidates old planner output (stale), increments
  objective goal/digest; concurrent_delivery_runs requirement_digest stays old.
- unknown planner -> owner cancel -> actual DB close/reopen: recoverStoredRuns
  returns [], then shutdown incorrectly returned safeToRelease true/projections[].
  Durable planner ledger was still unknown. This is a proven safety defect.

Fixed shutdown in core source only: after fencing/draining current controllers,
scan every persisted run including canceled/terminal ones without an in-memory
controller. Build existing DeliveryLifecycle shutdown projection from durable
store/inbox and actual publication settlement resolver. No recovery, provider call,
controller startup, claim mutation or fence clearing. Unknown ledger/claims/inbox/
publication still reject. No duplicated lifecycle projection policy.

Added actual SQLite reopen regression in core test: canceled run retains unknown
planner turn, no second provider call, shutdown rejects with exact durable reason.

Verification:
`env -u NODE_TEST_CONTEXT node --test --test-name-pattern='planner-recovery|planner recovery holds uncertain host facts' test/concurrent-delivery-engine.test.js`
5/5 pass with production-shaped execution fixture.
`env -u NODE_TEST_CONTEXT node --test --test-name-pattern='database reopen|planner-recovery|planner recovery holds uncertain host facts' test/concurrent-delivery-engine.test.js`
6/6 pass. No delivery-acceptance suite or prohibited regression run in this round.

Pending priorities: independent review of safety delta, pause/resume facade,
settlement bridge after host close, correction run-digest sync. Host close diagnostic
`.agents/teamwork/cn14-host-followup-20261027b/close-diagnostic.log` proves terminal
RoleService effectsSettled true but claimed backlog/active claim, no external task
id after send AbortError and shutdown HTTP503. Proposal under investigation: exact
terminal host identity proof through executor.recover/no-publication semantics;
never clear uncertain claims without durable settled evidence.

## Third milestone: RoleService no-publication recovery API and NULL fence

Source frozen for review. New narrow grant touched only delivery-role-service.js
and its test; engine wiring remains unchanged. Additional explicit core grant fixes
missing effectsSettled SQL NULL handling only.

API:
- `await roleService.prepareNoPublicationRecovery(identity)` where identity is
  `{ projectId, objectiveId, taskId, attemptId, fencingToken, recoveryGeneration }`.
  Returns `{ state: 'prepared', attemptId }`; same preparation replay is idempotent.
  Refuses active provider work, unknown/failed/nonterminal provider effects, stale
  account/home/model/settings/request/context/contract/fence/generation identities,
  unowned or cooperative writer lanes, any candidate/publication intent (even
  refused/applied), any candidate produced by this attempt, or changed lane facts.
  Proves captured provider start matches exact terminal thread/process. New starts
  persist providerStartReceipt; older writer records can use durable lane.turnStart.
  Uses existing lanes.complete(integrate:false) to mark owned lane not_integrated
  with recovery_no_publication; retained bytes are evidence, never integrated.
  Persistent intermediate recovering_no_publication state closes artifact producer
  authorization before await. Rechecks all durable facts after async cleanup, then
  marks role record settled with explicit not_published result and digest marker.
- `roleService.recoveryProofFor({ identity })` is synchronous, rereads all facts and
  requires preparation, attempt unknown and claim expired/fenced, current provider
  and settings unchanged. Returns exactly immutable RECOVERY_PROOF_FIELDS with
  frozen evidenceRefs for existing executor.recover. Does not write claims or
  publish output. Snapshot payload supplied by caller is not trusted; source facts
  come directly from durable stores. Does not return proof for already-settled
  backlog attempts (executor.recover itself rejects recovery_not_pending there).

Expected wiring order for root: after host calls drained, prepare exact terminal
records, call store.requestLifecycleRecovery to expire live claims/mark unknown,
then executor.recover with recoveryProofAdapter delegating to recoveryProofFor.
This API intentionally refuses any publication intent rather than broadening its
settled-state whitelist. Existing resultAdapter late delivery fails closed after
preparation; captured artifact and private lane evidence remain retained.

Role tests add actual executor no_effect_requeued settlement, canceled generation
handoff returning canceled, exact proof keys/frozen object/array, duplicate prepare,
retained private lane bytes, unchanged shared tree, no publication rows, late
terminal delivery refusal and getter revalidation after account mutation, plus12
negative identity/effect/publication cases. Two fixture corrections during development:
actual stableDigest is insertion-order JSON, so restored settings digest verification
uses settingsFor plus canonical equality with persisted selectedSettings; binding
artifact id is a row column, not identity_json field. Actual existing executor result
states are no_effect_requeued and canceled; assertions now use those real outcomes.

Exact verification:
`env -u NODE_TEST_CONTEXT node --test test/delivery-role-service.test.js --test-name-pattern='.'`
30/30 pass, 0 fail. No acceptance/prohibited regression execution.

NULL fence repair: core #effectsSettled SQL now uses
`json_extract(record_json,'$.effectsSettled') IS NOT 1` rather than `<>1`.
A missing field must not disappear through SQL three-valued logic. Added missing
and explicitfalse durable terminal-record regression cases without controllers.
`env -u NODE_TEST_CONTEXT node --test --test-name-pattern='settlement attestation|database reopen|planner-recovery|planner recovery holds uncertain host facts' test/concurrent-delivery-engine.test.js`
8/8 pass, 0 fail. Previous recovery and real reopen safety checks remain green.

Pending review: role API and NULL repair. No engine recovery wiring, pause/resume
or correction implementation was added in this milestone. Publication not_applied
whitelist question remains for root; this API refuses any publication intent.
