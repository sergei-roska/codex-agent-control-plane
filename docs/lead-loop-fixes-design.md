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

## Order

Wave A in parallel: LL-2 (contracts), LL-3 (digest in orchestrator and server).
Wave B after A: LL-1 and LL-4 (decision schema, graph, acceptance pinning), then LL-5.
