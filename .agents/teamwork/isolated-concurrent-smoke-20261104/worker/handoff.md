# Handoff

Status: native smoke incomplete; narrow repair in progress. Root owns broad
regression and acceptance review. Existing user runtime state and services are
excluded.

Current facts: the default Codex home has an auth file and config; the account
profile registry has one inactive profile, so the native wrapper will use the
isolated CODEX_HOME copy. No credential contents were printed. Test fixtures
show the HTTP A2A client and the `metadata.acceptance.requiredChecks` contract.

## Native smoke milestone

The single native task used an isolated loopback server, state database, token,
workspace, lane/storage directories, temporary CODEX_HOME auth copy, temporary
workspace trust, and temporary project settings. The local permissions setting
was `full-access`; native lane isolation reported `cooperative` with
`owner_full_access_cooperative` and `confinement=none`. The role overrides were
gpt-6-luna/low for coordinator, engineer, and verifier. No global settings,
auth, launcher, project, or runtime database were changed.

The task created `fixture/output.txt` with exactly `concurrent-smoke-ok\n`.
The independent command `node verify-output.js` in `worker/fixture` returned
`PASS exact synthetic output` with exit 0; SHA-256 is
`5af9330850129a61b69ce46bab68efc6c46a267f8865fb4a907191911ba6bf25`.
The Legacy `candidates` schema and seeded row remained unchanged beside the
Concurrent candidate table (two rows). Server start and restart each returned
agent-card HTTP 200. Both safe closes persisted `shutdownPhase=released`.

No acceptance was recorded. The engineer task succeeded, but the verifier
settled failed with `role_report_or_turn_failed`; the native report was blocked
because no candidate artifacts or review scope were provided. Its required
`verify-output` check was not run by the verifier. Root's read-only inspection
found the verifier usage at 16,474 tokens in
`delivery_role_executions.record_json.usage`; `usage_ledger` was empty. The A2A
task remained WORKING at the 420000 ms objective bound. Closing the private
server canceled the objective, persisted a released shutdown phase, and the
server reopened with the durable objective disposition `canceled`. No replay
was attempted. The disposable temp root, copied auth, token, and runtime state
were removed after the safe second close. Sanitized result and retained fixture
are archived under `pre-repair/`.

The earliest startup probes failed before any model turn: inherit mode selected
`native_permissions_use_shared_workspace`; a later full-access probe lacked a
Git workspace; after adding Git, full access lacked a trusted project. The
consolidated runner fixed these fixture issues by initializing Git and adding
trusted status for only the disposable workspace in the temporary config.

## Authorized narrow repair

Root authorized the scoped verifier capability binding fix in
`src/codex-app-server.js` and `src/delivery-role-capabilities.js`, with the
regression in `test/delivery-verifier-integration.test.js`. The change must add
host-generated candidate path/identity/manifest/scratch/read-scope context to
scoped verifier thread instructions, preserve the checked turn input byte for
byte, keep candidate-relative `filesInspected`, and keep host-pinned checks out
of the verifier's checks array. No scope, permission, drift, or acceptance gate
may be widened. Unscoped and forged capabilities must not expose candidate
paths. A focused regression initially failed as expected because
`scopedExecutionDetails.readScope` was undefined. The scoped context and
regression are now implemented in the three authorized files. It copies and
freezes the trusted read scope, adds candidate/task/manifest/scratch context
only to scoped verifier thread instructions, preserves the turn input array
exactly, and specifies candidate-relative inspection plus host-check ownership.
The forged and unscoped paths remain free of candidate path context.

Commands/results:

- `node --check worker/native-smoke.js` passed before the native task.
- `timeout --signal=TERM --kill-after=20s 510s node worker/native-smoke.js`
  returned status `incomplete`; the task was still WORKING at the 420000 ms
  objective polling bound.
- `node verify-output.js` in `worker/fixture` passed, exit 0.
- `node --test --test-name-pattern='scoped verifier run uses only its scratch root|candidate paths stay out of unscoped' test/delivery-verifier-integration.test.js`
  initially reported 1 pass and 1 expected failure before the capability fix;
  the focused rerun passed 2/2.
- `node --test test/delivery-verifier-integration.test.js test/codex-app-server.test.js`
  passed 147/147, 0 failures, 0 skipped.
- `node --check src/codex-app-server.js`,
  `node --check src/delivery-role-capabilities.js`,
  `node --check test/delivery-verifier-integration.test.js`, and scoped
  `git diff --check` passed.

Source/test edits are frozen after the 147/147 focused pass and exact diff
inspection. Root owns broader suite review and the next-task acceptance
contract. Do not rerun the native model until root supplies its separate
task/check contract and approves the repaired integration path.

## Candidate-root clarification delta

Root inspected generated verifier tool calls from the second failed native run.
They used relative `cat output.txt` and `sed ... verify-output.js`, followed by
`pwd; ls -la`; those commands ran in the intentionally empty scratch directory.
The frozen candidate existed separately and contained both files. The verifier
report had no inspected files or checks, so it failed the existing nonempty,
all-passed report protocol. No native retry is warranted until this source delta
is reviewed.

The authorized delta in `src/codex-app-server.js` now explicitly distinguishes
scratch cwd from candidate root, directs candidate inspection workdir/paths,
requires checking candidate root before claiming missing files, keeps writes in
scratch, and requires actual completed checks with at least one observed pass.
It explicitly omits only deferred host-owned checks and does not permit invented
passes. The scoped verifier integration regression asserts this wording while
retaining original input identity, scope, and unscoped/forged no-path-leak checks.

Verification after this delta:
- `node --test test/delivery-verifier-integration.test.js test/codex-app-server.test.js`
  passed 147/147, 0 failed, 0 skipped.
- `node --check src/codex-app-server.js` passed.
- `node --check test/delivery-verifier-integration.test.js` passed.
- `git diff --check -- src/codex-app-server.js test/delivery-verifier-integration.test.js`
  passed.
- Current hashes: codex-app-server.js
  `8afe15a782c615a94cd155810fbd6a86113b3a58a8f81e370a3c06741138cdbe`;
  delivery-role-capabilities.js
  `809e3da3273bcd5380a7cfb0cfdb8ffd150cf0084d209883e2ae6067a08dea90`;
  delivery-verifier-integration.test.js
  `a5d4781c40b6990df8421b0f7fbd84dfc97bfe260ac27a7072d3fa2660845e39`.

Source/test files are frozen pending root/critic delta review. Runner adapter work
and another native call are deferred until root confirms review and re-freeze.

## Third synthetic attempt after root GO

Root approved the source delta and reported full suite 2095 passed, 0 failed,
1 skipped (2096 total). Before the GO run, only the owned synthetic runner was
changed: role overrides use gpt-6-luna/high; it checks settled verifier failure
records between A2A polls and cancels immediately on that terminal condition;
result captures source hashes and prior archive locations. Syntax and diff
checks passed. Prior evidence remains under `pre-repair/` and
`after-context-fix/`.

The fresh run failed before any specialist role execution. Loopback startup and
A2A card succeeded (HTTP 200). Effective planner settings from
`delivery_planner_turns.pins_json` were Luna/high, Fast off, but the planner
turn ended in status unknown and result error `unexpected_expected_revision` at
`$.tasks[0].expectedRevision`. A2A returned INPUT_REQUIRED; the run is paused
and fenced, objective disposition remains executing, no verifier row or output
file exists, and acceptance is not recorded. Provider usage is unavailable.
The fail-fast verifier path was therefore not exercised.

`runtime.close()` failed with `concurrent_shutdown_unsafe`, leaving shutdown
phase `provider_closing`. I retained private state at
`/tmp/isolated-concurrent-native-xsowd6`, including DB, locks, workspace and
storage. Read-only inspection showed its provider PID 879930 absent; the
runner-owned Node PID 879880 still held loopback port 43009. I sent SIGTERM only
to that verified runner process; its listener is now closed. This OS stop does
not prove safe runtime close. Do not restart the retained runtime or delete its
DB/locks/workspace/storage without root direction.

Evidence is under `after-root-clarification/`: full runner result, sanitized
stdout/stderr and diagnosis. No further model task was submitted.

Commands/results:
- `node --check .agents/teamwork/isolated-concurrent-smoke-20261104/worker/native-smoke.js`
  passed.
- `git diff --check -- .agents/teamwork/isolated-concurrent-smoke-20261104/worker/native-smoke.js`
  passed.
- `timeout --signal=TERM --kill-after=20s 510s node .agents/teamwork/isolated-concurrent-smoke-20261104/worker/native-smoke.js`
  emitted `{"status":"failed","port":43009,"disposition":"executing","verifierExitCode":null}`;
  runner exit path recorded `unexpected_expected_revision` and
  `concurrent_shutdown_unsafe`.

## Planner expectedRevision guidance repair

Root reviewed the generated plan and confirmed `write-output-txt` was a new task
with `expectedRevision: 0`. Existing `validatePlanDelta` correctly rejects any
expectedRevision on a new task; it was not changed. Root authorized a narrow
prompt/schema-only correction in `src/concurrent-delivery-engine.js` and a
regression in `test/server-delivery-engine.test.js`.

The planner input and taskChange schema descriptions now say: absent task IDs
must use revision 1 and omit expectedRevision; existing-task update/supersede
must use the exact existing revision >= 1; never use 0 or null. The schema test
asserts both branch descriptions and the prompt guidance, exercises a valid new
task with expectedRevision omitted, then confirms the existing validator rejects
the same new task with expectedRevision 0 as `unexpected_expected_revision`.
No validator, recovery, quarantine or ledger code changed.

The owned runner is prepared for the next approved run with coordinator and
engineer at gpt-6-luna/low and verifier at gpt-6-luna/high. No native retry has
started. Retained failed runtime state remains at
`/tmp/isolated-concurrent-native-xsowd6`; do not restart or delete it.

Verification:
- `node --test --test-name-pattern='planner sends a strict usable schema and exposes a failed terminal provider turn' test/server-delivery-engine.test.js`
  passed 1/1.
- `node --test test/server-delivery-engine.test.js test/delivery-contracts.test.js`
  passed 97/97, 0 failed, 0 skipped.
- `node --check src/concurrent-delivery-engine.js`,
  `node --check test/server-delivery-engine.test.js`,
  `node --check .agents/teamwork/isolated-concurrent-smoke-20261104/worker/native-smoke.js`,
  and scoped `git diff --check` passed.

The source/test delta is frozen pending root/critic review and broad suite result.
The next native retry is not authorized until root sends GO.

## Candidate manifest ordering repair

Root identified a review-input materialization mismatch before provider
invocation: CandidateStore orders manifest entries by full path, while
candidate-review measured entries in sorted-directory DFS order. The retained
3207-entry manifest first differed at index 2289 (`patches.lock.json` versus
`patches/3415650-custom-gtranslate.patch`), although the path sets matched.

`treeManifest` now sorts measured entries by full path with JavaScript code-unit
ordering before digesting them, matching CandidateStore's default full-path
sort. A regression uses `patches.lock.json` and `patches/a.patch`, proves exact
materialization passes `prepareReviewInput` and `verifyReviewInput`, and proves
content, executable-mode, extra-file, and missing-file drift is rejected. The
existing candidate read-scope compaction change remains in the same files.
No retained runtime database, target workspace, or native provider was touched.

Verification:
- `node --test test/candidate-review.test.js` passed 29/29, 0 failed, 0 skipped.
- `node --check src/candidate-review.js` and
  `node --check test/candidate-review.test.js` passed.
- `git diff --check -- src/candidate-review.js test/candidate-review.test.js`
  passed.
- SHA-256: `src/candidate-review.js`
  `d8a1c822fbc68813dbea7993814d5c49a8264cb99c76db842786650e60a85caf`;
  `test/candidate-review.test.js`
  `915b25a810ce78f03574d4410ba4e59f46fbbb31288d11cb312088053fedb5a3`.

These two source/test files are frozen for root and critic review. No native
retry was performed.

## Scoped verifier owner-context briefing

Root's latest real verifier reached the provider but had no original owner goal
or acceptance criterion in its request. The baseline Composer validation exits
0 with warnings; candidate validation correctly exits 2 because registering
`extra.patches` changes the official Locker content hash from
`4ff...` to `b11...` while `composer.lock` is unchanged. The failed check is
relevant and must remain a failure. This change addresses only the missing
review context; it does not alter check selection or verdict handling.

For frozen verifier tasks, `#requestFor` resolves exactly one stored run for the
same project/objective and fails with
`concurrent_review_owner_context_missing` if that owner context is absent or
ambiguous. It includes the exact stored owner goal in labeled background-context
inputs, chunked on Unicode code-point boundaries at 2800 UTF-16 units. The
50,000-character intake bound fits within the specialist request's 20-item and
3000-character limits without truncation. The existing candidate hint, task
objective, write scope, task-specific criteria, and pinned checks remain. If
task-specific criteria are absent, a contextual criterion binds the review to
the current task objective, checkpoint scope, owner/control revisions and
pinned checks, and says the original intake does not override current controls
or grant actions.

The scoped full-access integration regression dispatched a verifier request for
a 50,000-character goal containing a supplementary Unicode character at a chunk
boundary. It reconstructed the original text byte-for-byte at the JavaScript
string level, checked all request item/character bounds, checked the unchanged
task objective and empty write scope, and recomputed the delivered request
digest against the persisted execution/settings/task digest and scoped
capability identity. The verifier report and independent host check passed and
the run reached its existing accepted disposition.

Verification:
- `node --test --test-name-pattern='owner full-access carries lossless owner context' test/server-delivery-engine.test.js`
  passed 1/1.
- `node --check src/concurrent-delivery-engine.js` and
  `node --check test/server-delivery-engine.test.js` passed.
- `git diff --check -- src/concurrent-delivery-engine.js test/server-delivery-engine.test.js`
  passed.
- SHA-256: `src/concurrent-delivery-engine.js`
  `8a72fadfaff4fbd70dda96d3c22d325ecafa1eb587c3b2e6d01c9a2ade2e31a1`;
  `test/server-delivery-engine.test.js`
  `88d1b1462f2d68d857741b2f358febe5f80f8ff17ecd98a9c9f14499b744e424`.

No native provider call, DCCOURTS target edit, or retained runtime database
interaction was performed. These source/test files are frozen for root review.

## Scoped verifier verdict versus host acceptance

Root's fresh real verifier evidence (`34504525`) showed the scoped static review
fields and normalized baseline digest passed. The report was inconclusive solely
because the three required host-owned checks were deferred until after the
report; all three host checks then passed. Those checks remain mandatory for
overall acceptance, and their correct deferral must not be represented as model
execution.

The trusted scoped verifier instructions now distinguish its semantic/static
candidate verdict from final host acceptance. Deferred host checks alone are not
a reason for an inconclusive scoped verdict. Identified candidate defects still
require a failing verdict; missing scoped evidence or an unassessable candidate
still requires an inconclusive verdict. The guidance does not force a pass or
change contracts, permissions, report parsing, host checks, receipts or
finalization.

Verification:
- `node --test --test-name-pattern='scoped verifier run uses only its scratch root|candidate paths stay out of unscoped' test/delivery-verifier-integration.test.js`
  passed 2/2, 0 failed, 0 skipped.
- `node --check src/codex-app-server.js` and
  `node --check test/delivery-verifier-integration.test.js` passed.
- `git diff --check -- src/codex-app-server.js test/delivery-verifier-integration.test.js`
  passed.
- SHA-256: `src/codex-app-server.js`
  `7c580c9934037342c7bde5e0a9963702d0b42b2996031cbd0fcf0945f4b5fd2a`;
  `test/delivery-verifier-integration.test.js`
  `7720d0ef88c28678e2bc0cc25aa714b8facf96a01f23353ee4f92d9c9f348582`.

No provider, native task, target workspace, runtime service, or retained database
was touched. Source/test edits are frozen for root and critic review.

## Finalization check-pin ordering repair

The final native task `55090d5b-c1a7-4e2e-9e41-d4635272eec7` produced a static
`VERDICT: pass` and all three host check proofs passed, but finalization returned
`finalization_unauthorized` before inserting a finalization row. Root and the
critic independently traced the refusal to `#finalizationAuthorized`: checkpoint
`checkPins` are normalized in sorted order, while `run.contract.requiredChecks`
preserves owner intake order. For the real three-check order, the arrays contained
the same three IDs but in different order.

The predicate now compares checkpoint pins against a sorted copy of the contract
ID list. Sorting preserves all entries and cardinality; no IDs are deduplicated,
and the ordered contract, request `requiredCheckIds`, check execution order,
digests, proof/receipt checks, and finalization gates are unchanged.

The composed full-access verifier regression uses three nonlexical required
checks, verifies they remain exactly represented in the sorted checkpoint pins
while finalization retains the original contract order, and reaches the existing
accepted path only after the verifier and all host checks pass. It then exercises
missing, extra, and duplicate checkpoint pin lists against the same authorization
predicate and confirms each is refused.

Verification:
- `node --test --test-name-pattern='owner full-access carries lossless owner context' test/server-delivery-engine.test.js`
  passed 1/1.
- `node --check src/concurrent-delivery-engine.js` and
  `node --check test/server-delivery-engine.test.js` passed.
- `git diff --check -- src/concurrent-delivery-engine.js test/server-delivery-engine.test.js`
  passed.
- SHA-256: `src/concurrent-delivery-engine.js`
  `9a613d802bf4e19e41fcec38475760fb4b91aee5828419eb64674e1d63191528`;
  `test/server-delivery-engine.test.js`
  `5be9ddbeb45cc27846c512e1164c15ff27f226cc17acc045a2541349da74303d`.

After critic approval, the test now also asserts that the same valid captured
commit-authorization facts return true immediately before the missing/extra/
duplicate negative probes. The focused composed test passed 1/1 again; the
test syntax and scoped diff checks passed. No product source changed after review.

No native retry or access to retained run database
`/tmp/dccourts182-native-FffhpM` or its backup was performed. The changes are
frozen for root/critic review; root owns broader tests and any later trial.

Critic requested a prose correction for a newly added task that supersedes an
existing task. Prompt and schema descriptions now say to omit expectedRevision
only for a newly added task without supersession; an update or supersession uses
the exact existing/superseded task revision >= 1. The current planner task schema
does not expose supersedesTaskId, so no new schema shape or supersession fixture
was added. Existing delivery contract tests continue to cover validator
supersession rules. The new malformed new-task expectedRevision=0 assertion
remains and verifies `unexpected_expected_revision` from the unchanged validator.

After this prose-only delta:
- `node --test --test-name-pattern='planner sends a strict usable schema and exposes a failed terminal provider turn' test/server-delivery-engine.test.js`
  passed 1/1.
- `node --check src/concurrent-delivery-engine.js`,
  `node --check test/server-delivery-engine.test.js`, and scoped
  `git diff --check` passed.

The source/test delta is frozen again. Do not retry native execution until root
confirms review and full-suite approval.

## Accepted synthetic native smoke

Root approved the final source manifest and authorized one fresh native run. The
runner used configured gpt-6-luna/low coordinator and engineer overrides and
gpt-6-luna/high verifier override. It used a new disposable root; retained
`/tmp/isolated-concurrent-native-xsowd6` was not opened or changed.

The run completed as A2A `TASK_STATE_COMPLETED`; concurrent mapping, run,
objective and host finalization all persisted `accepted`. Candidate ID was
`candidate-attempt-6f292193152114d2d6715d7d1a29ec5c`. Safe close recorded
`shutdownPhase=released`, server restart returned agent-card HTTP 200, reopen
retained concurrent-v1 mapping and accepted disposition, and second safe close
also recorded `released`. The Legacy `candidates` schema/columns and seeded row
remained intact beside `concurrent_candidates`.

The synthetic `output.txt` is 20 bytes, SHA-256
`5af9330850129a61b69ce46bab68efc6c46a267f8865fb4a907191911ba6bf25`. The
independent `node verify-output.js` command returned exit 0 and
`PASS exact synthetic output`; the script SHA-256 is
`0b4bf0a53efff460f4d9ce9a252a1bc44b45e5b2ac2854677887f65b0552d113`. The A2A
result artifact states `Acceptance: accepted`.

Limits: the retained runner snapshot reports no finalization check rows and
`usage_ledger` contains zero rows. Per-role execution provenance/provider token
usage was not preserved after successful private temp cleanup. The result
records configured role overrides; the broader runtime roleProfiles list is
catalog data and is not treated as proof of the selected per-task settings. No
performance, cost or broader autonomy claim is made.

Complete runner output, acceptance summary and copied synthetic fixture are
archived under `worker/accepted/`. `acceptance-evidence.json` binds the result to
the final source manifest; all product/test hashes match. Independent fixture
recheck command:
`node verify-output.js` from `worker/fixture`, exit 0.

## Accepted-run verification

- Final source manifest comparison: five relevant product/test hashes matched.
- `timeout --signal=TERM --kill-after=20s 510s node .agents/teamwork/isolated-concurrent-smoke-20261104/worker/native-smoke.js`
  emitted `{"status":"accepted","port":37595,"disposition":"accepted","verifierExitCode":0}`;
  process exited 0.
- `node verify-output.js` in the retained fixture passed independently.
- Worker accepted evidence is final; no further synthetic/native task was run.

## DCCOURTS artifact binding scope-order repair

Root diagnosed the real trial's `binding_authorization_denied` using
`../dccourts-182-trial-20261104/runner/native-run-result.json` and its retained
read-only runtime DB. The writer contract retained path order
`patches/shs-3620147-preselect-stored-values.patch`, `composer.json`,
`patches.lock.json`; `DeliveryOutputArtifacts.bind` validated the same unique
scope and sorted `declaredWritePaths`, while service authorization compared the
record's unsorted array directly. No provider invocation occurred in the trial.

The authorized fix changes only `src/delivery-role-service.js` and
`test/delivery-role-service.test.js`. Authorization now compares canonical
sorted copies of both arrays, preserving exact multiset equality, duplicates,
and input immutability; all surrounding identity, fencing, current-state,
binding, and path-validation checks remain intact.

The composed regression supplies the real three-path order through TaskExecutor,
DeliveryRoleService, and DeliveryOutputArtifacts.bind; binding/capture/publication
succeeds. Subset, added-path, and duplicate-path authorization variants are
refused, and the stored bound row remains unchanged. Test results:
- `node --test --test-name-pattern='unsorted multi-path task binds sorted scope and refuses subset or added declarations' test/delivery-role-service.test.js`
  passed 1/1.
- `node --check src/delivery-role-service.js`,
  `node --check test/delivery-role-service.test.js`, and scoped
  `git diff --check` passed.

No native retry or DCCOURTS runtime/DB interaction was performed. The change is
frozen pending root review and the coordinated final gate.

## Large frozen-candidate review read scopes

Root diagnosed the second DCCOURTS attempt: engineer implementation succeeded,
but automatic review-task creation rejected a known read scope with 3203 paths.
The full closure is attested from the same frozen candidate manifest. Only the
review task's permission path list needed a compact representation.

The authorized change is limited to `src/candidate-review.js` and
`test/candidate-review.test.js`. Known closure paths are checked against the
candidate manifest by exact path and digest. For larger sets, a deterministic
segment trie emits a directory prefix only when every manifest file beneath
that exact prefix is selected. Full closure entries, closure digest and context
remain unchanged. Scope results are sorted antichains and verified against each
manifest entry. Root wildcard/dot prefixes are never emitted; exact covers over
the existing 500-path task limit fail with `review_read_scope_unrepresentable`
before review context/task insertion.

Regression coverage uses actual `proposeReviews` at 1000 and 1001 selected
files, validates the resulting task and compares the full closure/digest;
tests a 501-file compacted subtree beside sparse/unselected and similar-prefix
sibling files; verifies absent-path and mismatched-digest closures fail; and
verifies 501 independent root files fail before DB insertion. No manifest/closure
data is truncated or marked unknown.

Verification:
- `node --test --test-name-pattern='large known closures compact|large sparse read scopes|known closures must match' test/candidate-review.test.js`
  passed 8/8, 0 failed, 0 skipped.
- `node --check src/candidate-review.js`,
  `node --check test/candidate-review.test.js`, and scoped
  `git diff --check` passed.
- No native calls, target edits, or retained runtime DB access occurred.

Changes are frozen pending root's batched review/full gate. The original
DCCOURTS candidate must be reused by the root-owned verification continuation.
