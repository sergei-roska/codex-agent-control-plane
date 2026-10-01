# M6 integration backlog

The owner confirmed Claude finished M4/M5 on 2026-10-01. Shared integration is
now authorized. See [runtime integration plan](runtime-integration-plan.md) and
[foundation implementation](implementation.md). After this local M6 acceptance,
the owner delegated M7 to Claude; Codex resumes M7 only after the owner's handoff.

| ID | Status | Task | Acceptance evidence |
| --- | --- | --- | --- |
| M6-F1 | complete | Source collector, fixture provider, Cloud normalization, PM input adapter | 9 tests pass; escaped-text 20 MiB budget persists within history bound, provenance/revision preserved; independent audit |
| M6-F2 | complete | Immutable source snapshot and identity registry | 9 tests pass; reopen, revisions, repeat reads, outage, binding; independent history audit |
| M6-F3 | complete | OAuth and typed read-only client | 18 tests pass; independent response-race and session-bound cancellation reviews; no live account wiring |
| M6-F4 | complete | Encrypted server-side token store | 10 foundation tests pass; now wired into optional runtime configuration |
| M6-F5 | complete | Session-bound OAuth callback handoff coordinator | 17 foundation tests pass; now mounted and verified through actual local HTTP |
| M6-I1 | complete | Operator OAuth configuration and token-store activation | Dedicated read-only app connected 2026-10-01 through browser OAuth; encrypted token store active; site insomniacdesign selected with `read:jira-work` and `read:page:confluence` only |
| M6-I2 | complete_local | Authenticated OAuth routes and resource/site selection | Actual local HTTP suite passes 5/5, zero skips; paired-session callback, CSRF, one-use handoff, explicit site choice and account clearing |
| M6-I3 | complete_local | Atomic imported-ticket identity mapping in product database | Product suite passes 6/6; unique identity and immediate transaction, command replay, reopen/two handles, project boundaries; simultaneous-process race not executed |
| M6-I4 | complete_local | Persist retrieved evidence and attach to explicit requirement revisions | Stored artifact feeds Intake prompt; source history and revision links persist; active input remains pinned; rollback and outage tests pass |
| M6-I5 | complete_local | Import/refresh API and dashboard source states | Actual HTTP passes; Gemini reports 12/12 functional fixture cases PASS; lead directly verifies 390x844 layout, import, saved history and unchanged refresh through Chrome DevTools MCP |
| M6-I6 | complete | Real approved feature and bugfix pilots | Feature INSDEV-406 and bugfix INSDEV-408 through Intake with provenance; repeat import deduped; revoked grant yields 409 `reconnect_required` with no writes; reconnect and recovery without false change; 117 egress rows, 0 violations. Three live defects found and fixed. Owner waived live outage, missing context and external edits in favor of fixture evidence. See [live pilot report](live-pilot-report.md) |

`complete_local` means implemented and fixture-verified, not the live M6 exit
gate. See [local acceptance](acceptance.md) and
[Gemini browser QA brief](gemini-browser-qa.md).

## Original shared integration requirements

The points below record the pre-integration gaps. The runtime/product/UI changes
in [local acceptance](acceptance.md) now implement them; live gates remain open in
the table above.

- `src/product-migrations.js` and `src/product-store.js`: current creation hardcodes
  `source: direct`; only command IDs are deduplicated. External immutable identity
  needs a uniqueness constraint and ticket creation in the same transaction.
  The foundation's separate registry is not a substitute for that transaction.
- `src/delivery-controller.js` and `src/intake.js`: current referenced strings are
  explicitly not retrieved. Persist evidence before submission, then load the
  saved evidence associated with the pinned requirement/source snapshot. The
  in-memory adapter is for fixture/contract verification only.
- `src/dashboard-api.js`, `src/server.js`, and `src/dashboard-auth.js`: authenticated
  begin/import/refresh/disconnect commands and redacted reads. The current dashboard
  cookie is `SameSite=Strict`; a cross-site OAuth callback cannot assume that cookie
  is sent. Use a bounded callback handoff followed by same-origin authenticated
  completion bound to the initiating session. Do not globally weaken dashboard
  CSRF/session rules to make OAuth work.
- `web/dashboard/**`: OAuth status/site selection, import and refresh, source
  provenance and missing-context display. Reference and Battle Pass stay unchanged.

## Required failure semantics

Import failure does not create a runnable draft claiming retrieved requirements.
Refresh failure never erases a previous successful snapshot, ticket revision,
plan, run, candidate, or review evidence. Imported issue types are deployment
metadata; no universal feature/bugfix mapping is assumed. Changes by Jira users
become explicit new input revisions and cannot replace an active run's input.

No scope or credential grants Jira/Confluence publication in beta. Local
completion displays internal completion and never claims a Jira status update.
OAuth authentication POSTs are allowed only at the fixed token endpoint; external
issue/comment/page/status writes have no callable operation.
