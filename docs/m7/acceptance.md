# M7 acceptance

Date: 2026-10-01. Status: complete on the fake protocol; live OpenAI and a real remote not exercised.
Decisions: [implementation.md](implementation.md). Exit gate: [beta plan M7](../beta-master-plan.md#m7-give-the-operator-real-control).
Owner delegated M7 to Claude; Codex inspects the actual changes and this evidence at handoff.

## Delivered

- Migration 6 `operator_controls`: run control requests, run kinds/parents, staged revisions,
  candidate-bound reviews, commit/push delivery records. New run status `stopped`; ticket
  `paused` and `done` are now set by commands.
- Pause / Resume / Stop / Cancel / Return to Backlog as guarded, idempotent, version-checked
  commands. Pending requests are shown as requests; settlement requires a terminal lead task
  and no active or unresolved writer. File changes are never reverted.
- Lead graph `operatorControl` hook: a hold is checked before every `decide` and inside
  `dispatch` before submission; `operator_pause` interrupt; `operator_stop` after reconciliation.
- Staged revisions for open tickets; applied only by Return to Backlog or a new Submit.
- Review: Accept and Request corrections bound to run, candidate id and integrity hash, with a
  fresh checkout verification; corrections create a bounded rework run (max 3 per revision).
- `src/git-delivery.js`: the only add/commit/push code. Commit stages exactly the reviewed
  manifest (set equality), no hooks, trailers `Ticket`/`Candidate`/`Delivery-Id`; push without
  force to an allowlisted remote, non-interactive; intent persisted before Git and reconciled on
  startup. Release repository for operators who deliver by hand. No PR creation.
- API endpoints of D-M7-8, state-derived available/unavailable actions, delivery view; UI
  controls, review/delivery panels, native drag/drop limited to Submit and Return to Backlog.
- Dev harness `DASHBOARD_DEV_SCENARIO=delivery` now also creates a fixture bare `origin`.

## Verification

- Full suite after all fixes: `npm test` 782/782 pass, 0 failed, 0 skipped (M6 baseline 729).
  Focused: git-delivery 25, lead-graph 58, product-store 46, delivery-controller 49, HTTP
  `test/m7-operator-controls.test.js` 11.
- Protected reference: `sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt` exit 0.
- Two independent read-only audits (authorization/Git safety; control lifecycle races). Findings
  fixed: lease released by a failed later run despite repository effects; pending stop/cancel lost
  when a step settled naturally; pause + needs_input deadlock; branch switch / lead start after a
  persisted stop; pause/resume race; settle on an escalated control; partial-manifest commit
  (subset check); commit reconciliation relying on checkout HEAD; file mode outside the integrity
  hash; remote names starting with `-`; interactive credential prompts; adapter calls without
  timeout; partial password left by URL sanitizing; overriding a user's `core.sshCommand`.
- Browser acceptance on the fixture harness (Chrome DevTools MCP, port 38711, 4 s turn delay):
  pause requested -> paused -> resume on the same run; corrections -> rework run with a new
  candidate; accept -> done; commit with trailers and push to the bare remote (verified with
  `git log` / `show-ref`); stop retains files; return to backlog; cancel while running; staged
  revision notice; drag Backlog -> Pending submits; wrong integrity hash 409 with no commit;
  401 without session; 403 foreign Origin; 390 px viewport without horizontal overflow.
  "Stop/Cancel requested" banners were not observable because the fake settles in < 0.3 s.
- QA defects fixed afterwards: silent native drag rejection, stale wait reason on closed cards,
  parent run still "human_review" after corrections, 404 source requests for direct tickets.
  Covered by unit/projection tests; the drag and source-request fixes were not re-run in a browser.

## Limits and open items

- Fake protocol only. A live OpenAI run, a real network remote and credential helpers were not
  exercised. Push uses the operator's existing Git credentials non-interactively; a remote that
  needs a prompt fails instead of hanging.
- Candidates captured before migration 6 have no file mode in their hash and fail verification
  (`candidate_changed`) after upgrade; review them again.
- A writer whose interrupt is unconfirmed keeps Stop pending with `writer_unresolved` until
  reconciliation (server restart reconciles stale writers).
- A ticket holding the lease (stopped, returned to backlog, done without commit) blocks other
  tickets from the checkout until it is resubmitted, committed, released or cancelled.
- No Reopen, no applying a revision to a running run, no PR creation (by design).
