# Independent V43 offline acceptance review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

## Scope and inspected changes

Read: critic role policy, development-access policy, current PROJECT.md,
cn15-recovery handoff, validation.md V43/L2/L6 boundaries, implementation-plan.md
CN-10/CN-12/CN-15 integration obligations, full new V43 test, production role
settlement/check-proof/receipt consumers, engine check execution and finalization,
frozen acceptance runner, controller recovery, and authenticated host controls.
Ran: git status --short and git diff --stat; inspected git diff for server source.
The V43 fixture and concurrent engine are untracked in the inherited checkout, so
Git HEAD cannot provide their package delta. Compared the engine and role service
with cn14-terminal-20261028/originals using diff -u instead. The review addresses
the V43 fixture and engine evidence-reference normalization at lines 975-981;
it does not approve all inherited source/UI/docs changes or concurrent terminal
shutdown work. No reviewed source, tests, fixtures, config or Git state was edited.

## Acceptance criteria

PASS - Real composed recoverable failure and internal recovery. Read/ran: V43
starts the actual server, invokes its A2A lead request handler, and traverses
planner, backlog, scheduler, role service, executor, output publication, review
and acceptance. Offline provider scripts produce a real failed worker report,
then a read-only explorer investigation, then a new superseding engineer task
using expectedRevision. The entire original failed attempt and execution/report
remain equal to snapshots; exactly one failed original attempt exists, effects
are settled, publication is not_published, and its actual child process group
is gone. The repair has distinct attempt/context identities and publishes.

PASS - Current-candidate independent review and authoritative mandatory checks.
Read/ran: the verifier receives a scoped capability and independently executes
verify-product.js from the frozen candidate. The engine separately executes the
original mandatory argv through runFrozenCandidateChecks, which checks candidate
identity/materialization, required check IDs/argv, and unchanged candidate bytes.
The fixture verifies the accepted source bytes, unchanged check script and contract,
a single complete verifier receipt for the exact accepted candidate/check pin,
and passing final authoritative check results. The check performs a real assertion
against source.txt. No production acceptance result is stubbed or hardcoded.

PASS - Durable accepted outcome and evidence. Read/ran: V43 reads the actual
concurrent_delivery_runs result_json/contract_json and accepted backlog finalization,
checks exact candidate pin, and reads real stdout bytes from the SQLite evidence
store. Both normalized verifier stdout/stderr evidence IDs resolve under the
verifier attempt and correct check/kind. The disposable database is removed by
fixture cleanup; retained logs record the run/attempt/candidate diagnostics.
This is durable storage inspection within one server lifetime, not a restart test.

PASS - Status/steering stay available while work is held, without an owner decision
reply. Read/ran: a native promise barrier holds investigation; actual HTTP GET/POST
reject invalid tokens with 401, accept authenticated status, reject stale steering
with 409, acknowledge current steering, and durably apply its inbox record. Two
idle controller cycles add no planner calls. Goal/control revisions stay 1, final
plan revision is 4, all planner ownerDecision fields are null and no owner_correction
message exists. The harmless steering message does not supply a repair decision.
Host auth middleware, scope validation, and transactional revision checks were read.

PASS - Evidence normalization preserves strict proof validation. Read: the engine
converts evidence-ref/v1 objects with valid durable ID syntax to ID strings and
retains bounded nonempty string support, throwing for unsupported entries. Proof
body/digest and stored proof digest are computed after normalization. Role service
still validates exact proof keys, attempt/fence/context/thread/candidate/manifest/
settings/request pins, exact mandatory check pins/results, string references and
canonical body digest. Its receipt adapter requires settled execution and host check
proof. No strict consumer was weakened in this delta. Ran: the related verifier
negative test first rejects a forged unrequested check pin, preserves the running
attempt without checksPassed, then settles only after correct proof is supplied.

PASS - Integrity and bounded scope. Read: fixture assertions exercise real output,
storage and authentication behavior rather than trivial success flags. Scripted
provider reports are isolated offline dependencies, not replacements for engine
acceptance. No policy broadening or check removal was introduced by the V43 fixture
or normalization delta.

## Independent commands and results

- node --test --test-reporter=tap --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/concurrent-recovery-acceptance.test.js
  PASS 1, FAIL 0; v43.log, exit 0, duration 2223 ms.
- node --test --test-reporter=tap --test-name-pattern='verifier host check proof and frozen CandidateReview receipt require pinned passing checks|failed work prompts one bounded internal investigation turn without owner reply or model fallback' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/delivery-role-service.test.js test/project-delivery-controller.test.js
  PASS 2, FAIL 0; related.log, exit 0, duration 455 ms.

## Limits and non-blocking observations

- V43 is approved for the requested offline layer only. L6 live model diagnosis,
  latency/cost/quality and rollout remain UNVERIFIED and outside this brief.
- Recovery covers one known terminal, no-write/no-publication worker failure;
  it does not qualify arbitrary uncertain-effect retries or shared live providers.
- Initial A2A intake is through the real in-process request handler, while status
  and steering use actual authenticated loopback HTTP.
- No broad/full suite was run, as instructed. Terminal source has another owner;
  this report does not replace its separate review or final frozen integration gate.
- Hashes below were stable before/after both focused checks for all inspected
  runtime/check inputs listed; later source changes require affected revalidation.

## SHA-256 inputs and retained evidence

a467ec0a8d70c8f924ca2593fb6df89c8e4bc4079292c95dd17c3650ea5dd137  test/concurrent-recovery-acceptance.test.js
afbdf9bdf0bea1001647c98b99e7e978eb60bc2f58ea5b76163cd6bd15c71280  src/concurrent-delivery-engine.js
f2182cfef9df24484fe19020ac9ebbd27716ce090db8c75f8647ecc002d48346  src/delivery-role-service.js
931777ea1ee27fc1286cc2db1798f80328dca4c42096d0e97aba25cc59ad3062  src/server.js
97512f0dafc2f590718d07eef3a051396d11f33a816c91d03b392f2619719a4f  src/project-delivery-controller.js
d7602bb672aa2722ea89e7a086792d888b6b6294f0a1d4cd5b4ab9fde506a03d  src/delivery-host-controls.js
46e570bde7d34b3cce59411c149803469a2ced05e3e989ecf7823026b8dea180  src/delivery-acceptance.js
bd2e3a97b7f7cc025aa6b4bcfb5aa8735e97356691ab6b879bc8325f60b33fd3  test/delivery-role-service.test.js
f2bf88c8749f68f578ab4a6a2e5108bd126da8f76bdefb634420bcfc1ea1a834  test/project-delivery-controller.test.js
e7774b5f522bc65abab62ea8f72e68467f67858036b98f22e7ebadbeabd6bb6c  docs/architecture/concurrent-harness/validation.md
a1696e9790a54d492cec1e4b3346edb7dd17c8817b748441cc5c3b431301b88f  docs/architecture/concurrent-harness/implementation-plan.md
6ff7fcad89ec42756652439c63e3417d32cc23234d094d7168c368784a88d27d  .agents/teamwork/cn15-recovery-20261028/review/v43.log
3ef998c5696149377bdd8dd68adadb3a5aec28b4c07090642f5041aab1076a47  .agents/teamwork/cn15-recovery-20261028/review/related.log
