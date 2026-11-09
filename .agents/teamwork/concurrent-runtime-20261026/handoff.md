# Successor handoff: concurrent runtime foundations

Status: quota freeze. Owner latest report: 10% five-hour remaining supersedes the
intermediate99% report. No new agent turns/features after freeze. All workers
finished/froze. Fresh limits required before continuation; no Astra without both
verified native limits. Root owned Git/docs; no commit, restart, live model,
account action, target mutation or publication authorized/performed.

## Read first

1. ../PROJECT.md, Git status/diff and current source.
2. Tracked concurrent-harness README, implementation-status, foundation-api and
   verification-summary. Original architecture graph is a research baseline.
3. Frozen handoffs listed below, then their actual files and focused tests.

## Accepted local gates

CN-01/02/03/04/05/06/07/08 are source-qualified, CN-00 design accepted. No real
server routing, continuous lead completion, lifecycle/final acceptance, engine
migration or live provider throughput is qualified. Legacy server was not reloaded.

- CN-01: 16 tests: ../delivery-contracts-repair/ and challenge reports.
- Performance accepted: ../performance-final-review/ and performance-final-repair/.
- CN-03: ../backlog-store/, backlog-store-review/, backlog-store-challenge/.
  Atomic intent/capacity/events, stable IDs/CAS, explicit-result recovery.
- CN-04: 17 tests: ../candidate-store/, candidate-store-review/,
  candidate-store-challenge/, candidate-store-durability-challenge/. Full pinned
  identity, exact conservative recovery, v1 projection, reference/intent retention.
  SQLite manifest JSON authoritative; missing cache repairs, present corrupt cache
  rejects. Blobs retained DB lifetime. File/directory sync ordering tested with
  injected faults/retry; hardware power loss not tested, SQLite FULL required.
- CN-05: 65 related tests: ../task-executor/, task-executor-review/,
  task-executor-challenge/. Exclusive send CAS, exact task/context/thread pins,
  project-shared transport failures, pause drains admitted work, unknowns keep slots.
- CN-08: 81 related tests: ../task-scheduler/, task-scheduler-review/,
  task-scheduler-challenge/. Atomic optional strict frozen canClaim hook and runtime
  ceilings; per-attempt polling and fast-dependent progress, conservative reviews.

## Frozen unfinished source: do not accept from test count alone

- ../objective-extensions/handoff.md: src/backlog-store.js/test now add
  ownerCorrectionAuthorized/checkpointInventory plus applyOwnerCorrection.27/27
  owned tests pass; independent review absent. Verify source-message replay and
  crash between correction commit and inbox acknowledgement, CAS/auth/task state,
  no owner-check/authority rewriting, and inventory is not acceptance. Source-ID
  replay currently compares the entire normalized correction, including expected
  revisions; controller must replay a pinned payload rather than rebuild it from
  advanced revisions. This is a review concern, not an independently proven defect.
- ../project-delivery-controller/handoff.md: new delivery-inbox.js,
  lead-planner.js, project-delivery-controller.js; inbox/planner tests: 6/6.
  test/project-delivery-controller.test.js absent. Finish slow-worker+steering,
  actual owner correction/claim fence, lost wakeup/restart, bounded recovery and
  no-model-poll loop scenarios. Authenticate owner messages independently of
  payload flags; plain steering must retain correct goal/check provenance.
- ../candidate-review/handoff.md: new candidate-review.js and
  delivery-review-policy.js with two tests,5 passed / 1 failed. First concrete action:
  fix canReviewTogether for distinct checkpoint auditors at test line129 without
  weakening scope/identity checks. Bind actual BacklogStore-assigned attempt IDs;
  registry currently proposes attempt/thread IDs. Promotion/ancestry/unknown scope
  and stale owner/check/pin cases remain incomplete. No critic/challenge acceptance.

Shared extension worker had sole backlog ownership after CN-08 freeze. Other
workers owned only their new modules/tests; all are now idle. Future source edits
need one named owner. Prepared briefs: brief-objective-extensions.md, brief-cn09.md,
brief-cn10.md here. CN-11/CN-12/CN-13/CN-14/CN-15 remain from tracked plan.

## Exact verification and preservation

Final root affected command is in verification-commands.txt here and described in
tracked implementation-status.md. Result: 236 passed / 1 failed, 237 tests, 22 suites.
Only failure: CN-10 independent-checkpoint test. Temporary output:
/tmp/concurrent-harness-quota-checkpoint-20261026.tap. Full suite was NOT run;
App Server focused 4/4 evidence reused only for unchanged inputs.

All new JS syntax/ASCII checks and git diff --check passed. source-start.json
records 49 pre-existing dirty inputs, HEAD 65a970e. final-preservation-check.json
shows 40 unchanged and only 9 authorized contract/performance/docs changes. Preserve
all predecessor work. Tracked verification-summary captures current hashes,
including explicitly unreviewed source. Local reports/probes are ignored and
may disappear; permanent tests carry the regression behavior. Never force-add
teamwork notes. Do not infer lifecycle permission from this handoff.
