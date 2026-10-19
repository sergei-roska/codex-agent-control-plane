# Lead loop fixes after the M3 runs (LL)

Status: decided by the lead on 2026-10-10; the owner approved all items, with item 4
reworked so acceptance checks are proposed by the agent, not written by the owner.
Implemented the same day: LL-2 `9d72147`, LL-3 `2a2600b`, LL-1 and LL-4 `0594e5e`,
pinned-check integrity `bf68990`, checks shown in the dashboard `c553788`, LL-5
`281db09`. Known limits: pins cover only files named directly in a check's argv; a
sandboxed check cannot be canceled before its timeout; trivially passing commands such
as `node --version` are not refused.

## Evidence (forensics of 7 runs on codex_team_work, 2026-10-10)

- The M3 gate was unreachable by code changes: pytest failures were fixed in the first
  working run and later suites passed (343..425 green), but the project's acceptance
  matrix kept 50 of 52 mandatory requirements "unverified". Causes: hard-coded counts
  (425/140/2/50) in the matrix scripts and rows that need live runtime qualification or
  an independent sign-off. Those are owner decisions.
- The lead never asked the owner: 0 `request_human_input`, 0 recorded resolutions in
  every run. Runs ended "M3 remains OPEN" after 6 rounds; each owner re-prompt started a
  new run that re-explored the same documents (TEAM.md read 69 times, the PRD 46, the
  matrix 37; about 35M tokens on explorers and auditors).
- 5 of 9 worker decision requests were rejected by report validation
  ("recommendation must be one of the option ids"), so the lead never saw them as open
  decisions. Explorer reports were rejected for "summary exceeds the size limit".
  5 extra lead turns came from rejected dispatches with 0 assignments.
- 9 scope blocks (needed files outside `allowedFiles`), each costing a full round.
- Every run had `requiredChecks: []`; the server could not tell "tests fail" from
  "requirements unverified".
- Outcomes in the lead prompt hit the 60,000-char cap from round 3; older outcomes were
  elided entirely.

## Decisions

### LL-1 escalation instead of looping

- Decision schema (strict) gains `goalAchieved: boolean | null`, required on `finish`
  (true or false), null otherwise.
- `finish` with `goalAchieved: false` does not end the run. The graph turns it into a
  human-decision pause: the question is the lead's final text; the options are
  `continue` (another bounded attempt with the owner's note), `accept_as_is` (finish
  now with the current result), `change_goal` (the owner states a new or narrowed goal).
  The lead's text must name the blockers.
- Reaching the round limit does the same instead of ending with `max_rounds`: options
  `continue` (grants another `maxRounds` budget), `accept_as_is`, `change_goal`.
- Prompt rules: escalate with `request_human_input` (blockers, options, recommendation)
  as soon as a blocker needs owner authority, external or live resources, a change of
  scope or acceptance criteria, or the same blocker survived two rounds. Worker
  decision requests are open decisions: resolve them or escalate them; never ignore
  them.

### LL-2 worker reports are normalized, not rejected

- A `decisionRequest` whose recommendation is not one of the option ids keeps the
  request: the recommendation becomes null with a normalization note; the report stays
  valid and the decision is opened for the lead.
- An over-long `summary` (or other bounded string) is truncated with a marker and a
  note instead of invalidating the report.
- The reminder for a dispatch with 0 assignments tells the lead to use `finish` or
  `request_human_input` when there is nothing to dispatch.

### LL-3 memory between runs of one session

- A follow-up run (a message that references the previous task, see
  `composeFollowUpGoal` in `src/server.js`) gets a bounded digest of the previous run
  (at most 12,000 chars): its goal, final text, per-assignment role, objective,
  outcome, and a short summary; open decisions and blockers; files changed (attested
  deltas); documents already inspected (most frequent `filesInspected`); and the
  lead's stated next work.
- The decision prompt presents it as "Previous run in this session" with the rule: do
  not re-explore what it established; dispatch explorers only for gaps it names.

### LL-4 acceptance checks proposed by the agent

- When the run has no owner-provided checks, the lead's first decision may propose
  `acceptanceChecks` (0-10 entries in the existing `acceptance-contract/v1` check
  format: `{ id, argv, timeoutMs }`), derived from the project's PRD, release or gate
  documents, and test commands. The server pins them as the run's acceptance contract;
  later decisions cannot change or remove them. Only the owner can (a message or the
  UI).
- At `finish` the server runs them as today; failures go back to the lead with the
  exact output under the existing acceptance retry rule. A check that cannot pass
  without owner action leads to LL-1 escalation.
- The dashboard shows the pinned checks under the session status and lets the owner
  remove or edit one (UI part can follow later; the API comes with LL-4).
- Guard against vacuous checks: every argv[0] must be an executable inside the
  workspace or a known tool (`python`, `pytest`, `node`, `npm`, `bash` with a script
  path inside the workspace); `echo`, `true`, and inline shell strings are refused.

### LL-5 scope without full-round ping-pong

- Prompt guidance: repair and debugging assignments use directory prefixes that cover
  the module and its tests rather than single files.
- Assignment field `continueFrom: assignmentId | null`: the lead can answer a worker's
  scope or decision request by re-dispatching the same work with expanded
  `allowedFiles` as a continuation of that worker's thread (and lane), reusing the
  BUD-2 continuation path, so the worker does not re-discover its context.

## LL-6 investigate before asking (owner correction, 2026-10-10)

Implemented in `9de69a1`. Deviation accepted: a dispatch that contains only read-only
roles may leave worker decisions open, so they can be investigated before being
resolved or escalated; writer dispatches and finish still resolve them.

The owner rejected LL-1's eager escalation: "if the answer is reachable with a couple
of logical questions and a wider search, the lead must not ask me." The owner is the
senior engineer and has no one to ask; the lead must behave the same way. In M3 the
blocking cause (hard-coded counts in the matrix scripts) was one search away.

Decisions (they replace the conflicting parts of LL-1 and LL-4):

1. Owner-only decisions are a closed list: spending money or paid resources beyond
   the run, credentials and access grants, publishing or writing to external systems,
   irreversible operations, and removing or weakening requirements the PRD states.
   Interpreting the PRD, fixing evidence tooling, choosing an implementation, and
   expanding file scope are the lead's decisions after investigation.
2. `request_human_input` is allowed only for an owner-only decision and only when the
   run already holds an investigation outcome about that blocker. Otherwise the
   decision is rejected with a reminder to dispatch an investigation first (a new
   predicate `decision.investigate_first`, code `investigation_missing`). The human
   input must cite that investigation's evidence.
3. A blocker that persists is a reason to investigate its root cause (explorer or
   auditor with the concrete question), not to escalate.
4. `finish` with `goalAchieved: false`: the first time in a run, the graph does not
   pause. It returns to `decide` with a note that each named blocker needs a
   root-cause investigation (or a fix) before escalation, and grants 3 extra rounds.
   Only a later `finish` with `goalAchieved: false`, after that investigation round,
   pauses for the owner, and its question must state why each remaining blocker is
   owner-only, with evidence.
5. Round limit: if the last two rounds made progress (an integrated change, a newly
   passing acceptance check, or a resolved worker decision), the budget is extended
   automatically by `maxRounds`, up to a total cap of 18 rounds per run. The pause
   asks the owner only beyond the cap, because that spends the owner's budget.
6. `check_changed` (a pinned agent check's script changed): the graph dispatches an
   independent auditor (read-only) with the diff of the pinned script, the check's
   purpose, and the PRD reference. A change that preserves the requirement (for
   example, measuring from real output instead of hard-coded numbers) is approved, and
   the check is re-pinned with new hashes. A change that weakens the requirement is
   rejected; the check keeps failing, and the lead must fix the cause. The owner sees
   it only if the auditor concludes the PRD requirement itself must change (owner-only
   item 1).

## Order

Wave A in parallel: LL-2 (contracts), LL-3 (digest in orchestrator and server).
Wave B after A: LL-1 and LL-4 (decision schema, graph, acceptance pinning), then LL-5.

## LL-8 healthy long runs and repeated-work recovery (2026-10-12)

Status: locally qualified on 2026-10-13; live activation remains separate. This
supersedes the implicit round budgets and automatic extension ceiling in LL-1
and LL-6.

- Dispatch rounds remain identifiers and metrics. The default has no round
  ceiling. An explicit positive `maxRounds` supplied by a caller remains an
  optional cap; it is never inferred from elapsed time or the number of short
  research assignments. Progress and blocker investigation do not increase an
  explicit cap automatically; owner `continue` or `change_goal` grants another
  configured allowance. Existing checkpoint extensions are preserved, and
  legacy round-limit pauses remain resumable with the unlimited default.
- A deterministic, checkpointed detector compares bounded recent work and
  evidence. Repeating an unchanged result three times warns the lead in its
  next normal turn to change its hypothesis or method. Repeating the warned
  work again without relevant new evidence produces a resumable
  `loop_detected` owner decision with the repeated attempts and reasons.
- Research can advance through new inspected scope, checks and findings.
  Integrated content, accepted review targets and resolved blockers also
  provide evidence. IDs, timestamps and rephrased failure claims are not new
  evidence. Unknown deltas never prove a content change. Unrelated research
  cannot clear a warning about an unchanged failing target.
- Equivalent review work shares role, checkpoint and declared scope; changing
  request prose or incidental evidence IDs does not reset its repetition count.
  Actual scoped content and performed-check changes remain evidence.
- Evidence identities use complete relevant path and check sets before report
  display truncation. Case-sensitive paths retain their identity. Persist only
  bounded hashes, descriptions and attempt references in detector state.
- The detector covers direct repetition and short cycles. It is a bounded
  heuristic, not proof of semantic equivalence or a general progress oracle.
  Detector state is bounded; the existing full outcome history still grows
  with run length and remains a separate storage consideration.
- The lead gets an opportunity to replan before an owner pause. Repeated
  invalid decisions retain their two correction opportunities and then pause
  with diagnostics. No additional model calls are used for detection.
- Owner `continue` or `change_goal` deliberately starts a fresh detector
  episode. Process restart, technical graph rollover and budget pause retain
  detector history. `accept_as_is` still runs acceptance and cannot bypass
  pending reviews or unresolved writer effects.
- The LangGraph per-invocation step ceiling is a technical segmentation point.
  Only a confirmed framework recursion-limit exception with an advanced
  checkpoint can continue from the same run's pending steps. Initial inputs
  and resume commands are not replayed. Actual interrupts, cancellation and
  no-advance failures remain bounded.
- Qualification requires long productive and research runs, unchanged failure
  and A/B cycles, relevant novelty, durable resume, old checkpoints, and a real
  small-step LangGraph rollover test without duplicate dispatch effects.

The running staging server remains under the owner's control. Implementation
and isolated tests do not activate code in that process or resume its paused run.

## LL-9 stopping and concluding with a partial result (2026-10-20)

Evidence: run 9e2c8b53 dispatched 265 times in 251 rounds and never finished;
151 dispatches were verifier or auditor, in streaks of 8-13 rounds with no
implementation. The LL-8 evidence-identity guard fired once, because reviewer
reports differ in wording every round. There was no round cap, environment
blockers became owner pauses that re-entered dispatch, and the only terminal
states were an accepted goal or a `goal_not_achieved` pause.

Mechanical stops:

- Recurrence guard (`src/loop-guard.js`). Second key: (checkpoint id or
  objective, role class verify|audit|investigate, target identity). Target
  identity is the tracked review target, else the scoped content identity,
  else the objective; report text and file lists are excluded. Three rounds of
  one key with no integrated writable change in between pause `loop_detected`
  (same owner choices as before; `continue` resets). Plain research without a
  checkpoint id is left to the evidence guard, which existing behavior relies
  on (the same research objective with new evidence is progress).
- `DEFAULT_MAX_ROUNDS` is 80. The existing `round_limit` pause carries a
  summary by role and integrated changes; `continue` grants another 80.
  `maxRounds: null` remains an explicit opt-out.

Concluding:

- `partial` disposition: finish with `goalAchieved` false and a ledger
  `checkpoints: [{ id, status: accepted|blocked|not_started, reason, evidence }]`.
  The task is `COMPLETED`; artifact metadata has `disposition: "partial"` and
  the ledger; the CLI exits 5 (4 wins when acceptance failed). Review gates are
  waived only for blocked and not-started ledger entries. Failed acceptance
  downgrades accepted entries to blocked, so the ledger is never more
  optimistic than the checks.
- Blocked checkpoints: an owner answer `defer` or `outside_run` to an
  `infeasible_requirement` or `credentials_or_access` request blocks the
  checkpoints it cites; no more verifier or auditor dispatch, no automatic
  review recovery, and no hold on unrelated writers. Free-text answers are not
  interpreted; the option id is the signal.
- Lead contract: finish with the partial ledger when every remaining
  checkpoint is accepted or blocked by something the team cannot do here;
  re-verifying unchanged content is not progress.

Not changed: acceptance semantics for owner and agent checks, writer admission,
and review-policy receipts.
