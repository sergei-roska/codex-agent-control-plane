# AUT-02 runbook: fresh-target review recovery

Status: implementation plan, not implementation acceptance. Prepared 2026-10-15
against harness commit `cc0958edd54a5c7ddaab02e4844fa69b823af365`.

## 1. Mission and ordering

Qualify and, where evidence requires it, repair automatic recovery from a stale
review continuation. Reject the stale attempt before model execution, preserve
the checkpoint obligation, and obtain fresh current-target verifier and required
auditor receipts without owner intervention or repeated stale submission.

This is the next P1 item in [the autonomy backlog](orchestrator-improvement-backlog.md),
after the accepted [AUT-05 baseline](aut-05-review.md) and
[AUT-01 offline pilot](aut-01-review.md). It is independent of optional Phase 2A
feature enrollment in [the parent roadmap](spec-kit-luna-integration-plan.md).
Do not implement enrollment, Spec Kit worker procedures, AUT-03 skills, or AUT-04
tools as prerequisites. AUT-05 continues as the comparison process.

The authorized work here is preparation of this runbook. Executing its future
implementation brief is a separate task. Qualification uses fake transports,
fake App Server responses, temporary workspaces, and disposable state databases.
It requires no paid model calls or changes to running services, owner pauses,
existing sessions, or shared databases.

## 2. Current guarantees and evidence limits

Read these symbols again at implementation entry; line numbers drift.

| Boundary | Existing mechanism and source | Qualification still needed |
| --- | --- | --- |
| Review context | `checkReviewContext` in `src/contracts.js`; `sameReviewScope` in `src/review-policy.js` | All six normalized fields through recovery and direct continuation |
| Lead decision | `reviewObligationsSection`, decision validation, `gateFailure` in `src/lead-graph.js` | Full/delta/resumed prompts retain the exact obligation after rejection |
| Lead dispatch | `dispatch` recomputes target and emits `stale_review_continuation`, `stale_review_target`, or `review_target_unknown` | Both verifier and auditor, usage-limit and explicit scope continuation |
| Usage resume | `continueLimited` retains original assignment and captured target; continuation count is capped | Restart durability, no replay of a stale origin, bounded exhaustion |
| Direct endpoint | `originatingReviewTarget`, `targetForDirectReview` in `src/a2a-role-service.js` | Late endpoint rejection returns to lead recovery, context/run isolation |
| Receipt admission | `integrateFinishedGroup`, `matchingReceipt`, `currentGateState` in `src/lead-graph.js` | Old receipts cannot complete the changed candidate; verifier precedes required auditor |

Direct origin enforcement currently covers auditor and read-only pinned-check
fallback continuations. The direct verifier path has its own target/coverage
checks; do not assume it shares the auditor's origin guard. Direct requests do
not pass through the lead's checkpoint sequencing gate. Endpoint rejection alone
does not establish automatic lead recovery or overall task acceptance.

`computeReviewTarget` binds scoped content, the six-field context, policy, run,
goal, and applicable checks/requirements. Graph and direct-service computations
use different contextual inputs. Compare identities within their own boundary;
prove correlation through run/assignment/attempt/checkpoint, not by assuming the
two identity strings are interchangeable.

The historical r215 incident is preserved in
`test/fixtures/autonomy/corpus-v3/historical-source-evidence.md`: a preflight
`request_invalid / review_origin_stale` rejection preceded fresh r216/r217
reviews. These are historical summaries from work on the target orchestrator,
not a replayable harness fixture or proof of automatic recovery. Keep that
provenance and the unavailable incident source revision explicit.

Four existing leaf tests passed during runbook preparation with Node v24.21.0:

```sh
node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='a usage-limited auditor cannot continue|auditor continuations require|full and resumed delta prompts carry|pinned-check fallback continuations fail closed' \
  test/lead-graph.test.js test/a2a-role-service.test.js
```

Result: 4 pass, 0 fail, 0 skip. The graph recovery test scripts the next lead
decision. It proves the transport/gate path accepts that decision, not that an
unscripted lead chooses it. No product defect or complete AUT-02 qualification
is established. File-level runner summaries without named leaf tests are not
substitutes for this evidence.

## 3. Entry checkpoint R0: freeze an AUT-02 baseline

1. Read `.agents/teamwork/PROJECT.md`, current handoff, Git status/diff, this
   runbook, the backlog AUT-02 requirement, and parent plan section 13.1.
   Preserve unrelated changes and existing pauses.
2. Resolve accepted AUT-05 and AUT-01 decisions from
   `docs/evidence/aut-05/acceptance.json` and
   `docs/evidence/aut-01/acceptance.json`. Rehash referenced artifacts; stop on
   unexplained drift. Do not rerun unchanged accepted suites merely for entry.
3. Capture current implementation commit and relevant working-tree file hashes,
   Node/dependency versions, effective role profiles, check pins, review policy,
   test command, and fake transport configuration before changing runtime code.
4. Create an isolated AUT-02 fixture/evidence cohort. Reuse the historical case
   as motivation and its rejection oracle, but label all new executions as
   deterministic harness simulations. Freeze candidate A, candidate B, the exact
   six-field review object, fake responses, and expected forbidden effects.
5. Run baseline cases through actual graph and role-service boundaries. Record
   outcomes even when already passing. A missing probe may be added before the
   runtime intervention; record its hash and baseline outcome before fixes.
   Save the pre-change source snapshot so later probes can compare identical
   inputs. Do not manufacture a failing baseline or require a product edit.

Use `docs/evidence/aut-02/` for reviewed durable evidence and
`artifacts/autonomy/aut-02/` for generated scratch exports. Keep local agent
coordination in `.agents/teamwork/`. Proposed isolated fixture location:
`test/fixtures/autonomy/aut-02/`. None of these future artifacts exists merely
because its path is specified here.

Do not modify any accepted AUT-05/AUT-01 artifact, manifest, or observation.
Historical observations remain historical. If evaluator-format observations are
added, create a separate cohort with its own digests and declared applicability.
Do not retag target-orchestrator evidence as a new harness measurement.

## 4. Recovery contract

The checkpoint review object has exactly these normalized fields:

```text
kind, checkpointId, reason, paths, evidenceIds, prerequisiteFor
```

Preserve their stored values. Legacy omission of `prerequisiteFor` normalizes
to `[]` under the existing contract. Do not reconstruct a smaller scope from a
summary, change risk kind, remove evidence or prerequisite links, or use a new
checkpoint to evade an unresolved old obligation. Intentionally new scope needs
a distinct checkpoint while preserving outstanding obligations.

For a candidate change A -> B:

1. Settle writers first. Unknown target or unresolved effects block review.
2. Reject A's stale continuation before its model call. Graph skips and endpoint
   `request_invalid` failures are distinct outcomes; neither is an auditor
   verdict or a passing receipt. Preserve the failed attempt and origin evidence.
3. Keep old receipts as history but make them ineligible for B. A preflight
   rejection must not release checkpoint gates or authorize dependent writes.
4. Expose the bounded failure reason and complete stored review context to the
   recovery path. A fresh review uses new assignment/attempt/context identifiers,
   `continueFrom: null`, and no stale thread/origin continuation fields.
5. Dispatch a fresh verifier for B through normal admission. Dispatch its required
   auditor only after the verifier receipt is valid on the current target and
   under the identical stored review object. Routine review requires no new
   auditor; pinned-check preserve/repair decisions retain their existing policy.
6. Recheck freshness at dispatch and receipt integration. If B changes again,
   require current-target evidence again. A verifier's authorized test-only write
   may change identity: retain the existing post-verification binding rules and
   validate the actual settled target instead of demanding the original hash.
7. Permit finish or dependent work only through the existing complete gate.

Do not blind-retry an unchanged stale request. The implementation must select a
bounded recovery mechanism at R2: deterministic graph construction or the
existing lead planning turn with explicit recovery context. Preserve budgets,
owner pause, cancellation, round/continuation caps, and unresolved-writer gates.
No stale rejection grants budget, resumes an owner pause, or permits a writer.
Missing/corrupt origin or unknown target remains blocked until trustworthy
state is available; inventing an origin or downgrading review is not recovery.

An endpoint rejects direct stale requests and returns a bounded failure to its
caller. It does not start a lead run or manufacture verifier receipts. Prove
automatic recovery through the lead-managed path, including endpoint rejections
that occur after graph preflight. Test direct verifier behavior explicitly;
any additional guard must follow from a demonstrated origin/receipt failure.

## 5. Work packages and ownership

The lead owns scope, accepted evidence, Git, and final acceptance. Use the
delegate skill and lead policy. Sequence edits to the shared graph.

| Package | Owner and bounded files | Exit evidence |
| --- | --- | --- |
| R0 | Lead; explorer only for unresolved traces | Immutable baseline/cohort, source hashes, supported comparison scope |
| R1 | Worker: `test/lead-graph.test.js`, `test/a2a-role-service.test.js`, `test/review-policy.test.js`, `test/contracts.test.js`, isolated AUT-02 fixtures as needed | Actual baseline results for the matrix below; missing guarantees distinguished from missing assertions |
| R2 | Lead decision, independent critic | Recovery mechanism, state transition, applicable entrypoints and retry behavior specified; scripted tests versus automatic behavior distinguished |
| R3 | Worker: `src/lead-graph.js`, `src/a2a-role-service.js` and owned R1 tests | Only evidenced missing behavior repaired; no edit required if fully qualified existing behavior meets the contract |
| R4 | Independent verifier, then auditor; challenger for concrete race/replay probes | Integrated source and evidence pass all mandatory cases and existing project checks |
| R5 | Lead: AUT-02 review/evidence, backlog and roadmap | Bounded acceptance decision, comparison, limitations and next handoff |

Conditional files: `src/lead-orchestrator.js` for proven resume plumbing;
`src/contracts.js`/`src/review-policy.js` and their tests for a demonstrated
contract gap; `src/durable-store.js`/`src/staging-log.js` and tests only if durable
state is actually needed. Assign exact ownership before editing these. A new
persisted shape requires version/default/restart/rollback design at R2 and every
consumer updated together. Prefer existing journal and obligation state where
sufficient. No UI, model/profile changes, skill installation, or migrations by
default. Do not weaken strict validation to carry informal recovery metadata.

## 6. Mandatory qualification matrix

For every case retain named test, fixture hashes, boundary, request/call sequence,
attempt/checkpoint correlation, relevant state/events, and actual result.

| ID | Case | Required result |
| --- | --- | --- |
| Q01 | Stable usage-limited verifier and auditor | Valid same-target continuation remains allowed under existing policy; context preserved; bounded retries |
| Q02 | Usage-limited auditor, A -> B before resume | Zero stale submissions from graph; fresh verifier then required auditor on B; old receipts cannot finish |
| Q03 | Usage-limited verifier, A -> B | Stale verifier does not execute or satisfy gate; fresh verifier precedes auditor |
| Q04 | Explicit `continueFrom` review, same and changed targets | Stable policy preserved; stale origin cannot be disguised by constructing a new assignment; fresh recovery clears continuation |
| Q05 | Endpoint race after graph preflight | Actual service returns `review_origin_stale`; zero stale model calls; lead consumes rejection and reaches fresh review without another stale-origin request |
| Q06 | Missing, corrupt, ambiguous, other-run origin; unavailable staging evidence | Fail closed before affected model call; no borrowed origin/receipt or fabricated acceptance; retry only after trusted state is available |
| Q07 | Mutate each review field individually | Context mismatch/target rejection; no same-checkpoint narrowing or changed prerequisite links; legitimate array normalization remains compatible |
| Q08 | Full, delta and restarted lead context | All six fields and current obligation survive; complete pending prerequisite set preserved; no owner edit of next decision needed |
| Q09 | Crash/restart at rejection and before fresh submission | Durable failure history; recovery resumes or safely replans without duplicate effective submission, lost obligation or stale receipt reuse |
| Q10 | Wrong-target verifier, auditor-first, changed target during/after review | Required gates remain closed; terminal model status alone never creates an accepted receipt |
| Q11 | Owner pause, budget denial, cancellation, unresolved writer, retry exhaustion | No unauthorized submission or automatic budget/pause bypass; bounded stop with actionable reason |
| Q12 | Direct auditor, verifier and pinned-check fallback | Test each claimed origin boundary and unchanged-target control; direct results do not bypass lead acceptance sequencing |
| Q13 | Routine review, valid critical review, unrelated ordinary work | Existing behavior preserved; no new auditor requirement for routine work and no global feature-map requirement |
| Q14 | Verifier test-only write and candidate changes again during recovery | Preserve existing authorized post-verifier binding; require fresh evidence when actual current target changes |

Q02's existing scripted graph test is reusable evidence for its current
assertions, not complete Q02/Q05/Q08 coverage. Add exact six-field and receipt
assertions rather than only counting sends. Count model calls at the injected
App Server boundary, separately from lead-to-service sends and rejected decisions.

For automatic-recovery evidence, inject the stale failure through the real
boundary and exercise the selected R2 policy. A fake lead may return a fixed
correct decision to test plumbing, but that alone cannot prove recovery
selection. If recovery remains lead-driven, independently verify the delivered
recovery instruction/context and record that live model decision quality remains
unmeasured. Accept only the demonstrated deterministic guarantee; do not label
that narrower result full automatic AUT-02 completion.

## 7. Verification and comparison

Use the named leaf-test runner mode verified during preparation:

```sh
node --test --test-isolation=none --test-reporter=tap \
  test/contracts.test.js test/review-policy.test.js \
  test/a2a-role-service.test.js test/lead-graph.test.js
```

Add affected persistence/orchestrator tests when those inputs change. At milestone
integration run the existing full project suite and syntax/diff checks:

```sh
env -u NODE_TEST_CONTEXT node --test --test-isolation=none --test-reporter=tap test/*.test.js
git diff --check
```

Do not rerun unchanged accepted AUT-01/AUT-05 suites outside the integration
check without changed inputs or a concrete unresolved risk. Require actual leaf
counts, zero failures, and an explicit reason for any skip; no skipped mandatory
AUT-02 case. Independent review binds to final file hashes and evidence.

Before retention, compare the frozen R0 baseline and final candidate using the
same fixtures, fake responses, configuration, and gate rules. Require zero stale
model calls, zero unauthorized effects, zero false accepted receipts, preserved
context and review order, and no repeated stale-origin submission on a stable
recovery target. Record preflight rejections, fresh review attempts and bounded
stops separately. Already-passing guarantees count as retained controls, not new
improvement. New probes need a pre-change result before any improvement claim.

Fake runs qualify correctness and bounded routing only. Keep live tokens,
monetary cost, owner escalation rates, live lead decision quality, and production
recovery time unavailable. Test duration is not end-to-end workflow savings.

## 8. Acceptance, rollback and next handoff

At R5 retain `entry.json`, baseline/final qualification results, test commands,
source/config hashes, sanitized event/receipt traces, comparison, verifier and
auditor reports, and `acceptance.json` under `docs/evidence/aut-02/`. Write
`docs/aut-02-review.md` and link the exact supported scope in the backlog.
Do not issue an acceptance record during runbook preparation.

Complete AUT-02 only when the mandatory matrix and automatic-recovery contract
are demonstrated, required independent reviews approve, and integration checks
pass. Otherwise record a bounded qualified subset or a repair/defer decision.
Historical r215 rejection and later fresh reviews cannot replace these checks.

Rollback of the deterministic test increment affects only the scoped code/tests;
retain evidence. For any new persisted recovery state, first stop its admission
through an assessed policy transition, preserve obligations/history, and specify
how older readers treat pending state. Never roll back a guard or discard stale
history to allow an old request. Applying code to a running service or resuming
a paused session remains a separately authorized lifecycle action.

Implementation handoff: begin with R0-R1, inspect baseline evidence, select R2,
then implement only proven gaps. Record changed files, decisions, exact checks,
remaining limitations, evidence paths, and next concrete action in the active
local handoff. Reassess optional runtime enrollment or AUT-03 after this bounded
milestone; neither starts automatically.
