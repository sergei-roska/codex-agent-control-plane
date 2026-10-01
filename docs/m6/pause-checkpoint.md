# M6 pause checkpoint

## Latest checkpoint: 2026-10-01 shared integration

This checkpoint supersedes the isolated/shared-file deferral in the historical
sections below. The owner confirmed Claude finished M4/M5 and explicitly forbade
starting M7. M6 runtime, product database, APIs, and dashboard are integrated.
All scoped workers finished. The full test suite passes 729/729 with zero skips;
the direct actual HTTP M6 suite passes 5/5. Protected-reference and whitespace
checks pass. No live OAuth grant or Jira/Confluence request was made.

See [local acceptance](acceptance.md) for delivered behavior and verification,
[integration backlog](integration-backlog.md) for open gates, and
[operator setup](operator-setup.md) for future live activation. The owner supplied
[Gemini's browser report](gemini-browser-report.md): 12/12 functional fixture cases
reported PASS and zero console errors. The lead reconciled the report and evidence;
functional browser acceptance is recorded. After Chrome DevTools MCP setup and
restart, the lead closed the 390px evidence gap with direct device emulation:
viewport/client/scroll widths all 390, source controls and modal fit, import,
history and unchanged refresh pass. See [follow-up](codex-browser-390-report.md).
Dedicated operator configuration and approved live feature/bugfix pilots are still
pending. After this verification, the owner authorized Claude to start M7 to use
the remainder of its current usage window. Claude owns M7 until the owner hands
it back to Codex. Codex must inspect the actual changes and acceptance evidence
at handoff; no M7 implementation is included in this checkpoint.

The lead's disposable QA server on port 38606 is stopped after verification;
its `/tmp/orchestrator-m6-qa-20261001` state is retained. Gemini reports its own
servers on 38607/38608 stopped; report and screenshots are retained. The owner
requested a local progress commit covering M4/M5 and the verified local M6 work.
No push was requested. The follow-up server on 38609 and its owned page are
stopped/closed; `/tmp/orchestrator-m6-codex-390-qa` state and screenshots remain.

Date: 2026-09-30. Requested pause: before 16:00 Europe/Chisinau.
Historical pause: 2026-09-30 at the owner's request. Current work resumed on
2026-10-01; the sections below preserve pause-time evidence.

Resumed on 2026-10-01 at the owner's request. The owner confirmed Claude still
validates/fixes integrated M4/M5 code. Shared-file ownership remains with Claude;
continue isolated M6 modules. A daemon restart interrupted the resumed workers
before their new code landed. The lead checked actual files before restarting the
aggregate-budget and encrypted-token-store workers.

Final OAuth independent review completed before that restart: all 17 tests and an
independent held-body response reproduction passed. The final response revision
guard is accepted within the standalone adapter scope; no live account/runtime
integration was tested.

## Owner instructions and scope

The owner delegated M4/M5 to Claude in parallel, requested M6 work in this session,
selected local fixtures before live retrieval, and then selected OAuth for the
orchestrator like the existing Codex Atlassian connection. Do not reuse or export
the Codex connector's credentials. No real account authorization/retrieval occurred.

The owner requested a safe pause on 2026-09-30 and explicitly resumed the session
on 2026-10-01. That pause instruction applied to the historical checkpoint,
not to the authorized resumed work.

M6 is not complete. M7 has not started. Only isolated new files are owned here:
`src/integrations/**`, `test/m6-*.test.js`, and `docs/m6/**`. Shared runtime,
product-store/migration/API/auth/dashboard files remain with Claude's M4/M5 work.
Protected reference `artifacts/dashboard/**` and Battle Pass remain unchanged.
No Git state changes or commit/push were made in this session.

## Implementation state

- `source-bundle.js`: configured-origin collection, typed immutable identities,
  alias/cycle dedupe, bounded traversal/text/warnings, missing/truncated context,
  in-memory evidence adapter for the existing PM Intake prompt.
- `fixture-source-provider.js`: local detached fixture reads, no network.
- `atlassian-source-provider.js`: Jira/Confluence ADF normalization and typed
  read-client bridge with bounded comments and linked context.
- `source-import-store.js`: separate caller-owned SQLite registry containing only
  `m6_source_*` tables, immutable ordered snapshots, repeat-read dedupe, A/B/A
  revision chains, outage preservation, and exclusive identity-to-ticket binding.
  This does not atomically create or deduplicate product tickets/runs.
- `atlassian-oauth.js` and `atlassian-read-client.js`: dedicated OAuth 3LO client
  with injected secret/token storage and typed GET operations. Hardened lifecycle
  review and its verification must be checked in the final section below.

## Review history relevant to continuation

Original OAuth implementation passed its initial tests but failed independent
review on transient refresh failures: it erased credentials on any outage.
Lead review also identified stale credentials being reread after failed disconnect,
and request deadlines starting after authorization dependencies. A bounded
`worker-luna-xhigh` hardening task owns these same OAuth files. Do not accept the
old 11-test result as verification of those fixes.

Collector warnings initially embedded full source documents, amplifying JSON
size. The source worker changed warnings to typed references; the independent
reproducer now persists successfully. Collector/store warning caps and unavailable
URLs were aligned. Store text preserves bounded CRLF/raw evidence; metadata stays
strict. Historical A/B/A content gets a new snapshot rather than replaying an old
snapshot and leaving the current pointer stale.

## Verified results

- Source suite: 7/7 passed again in lead execution immediately before the pause.
- History suite: 9/9 passed again in lead execution immediately before the pause.
- Protected-reference check: `sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt`, exit 0.
- OAuth hardened suite: final lead execution passed 17/17, including the
  post-response connection-change regression added immediately before interruption.

Verification commands (fixtures only):

```sh
node test/m6-source-bundle.test.js
node test/m6-source-import-store.test.js
node test/m6-atlassian-oauth.test.js
sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt
```

## Next session

1. Read this checkpoint, [implementation](implementation.md), and
   [integration backlog](integration-backlog.md); inspect actual Git status.
   Other agents may have changed M4/M5 files while this session was paused.
2. Resolve the aggregate serialized-size audit issue recorded below. Do not start broad testing or
   rewrite modules whose focused checks already passed without new evidence.
3. Confirm M4/M5 integration ownership has settled before touching shared files.
   Integrate atomic Jira identity/ticket creation and explicit source revisions
   into the product transaction, then persist source evidence for pinned Intake.
4. Wire paired-session OAuth begin/callback completion/disconnect and explicit
   site selection, secure token-store implementation, import/refresh API and UI.
   The dashboard uses `SameSite=Strict`; the callback needs a bounded handoff
   followed by authenticated same-origin completion, not a global cookie/CSRF
   relaxation. No live deployment configuration or approved pilot IDs exist yet.
5. Validate real approved feature/bugfix Intake and M6 exit cases. M7 is a
   separate follow-up after the pipeline/run control contracts are stable.

## Final checkpoint

The lead verified 33 focused tests successfully (7 source, 9 history, 17 OAuth).
Protected-reference hash verification passed again. Existing runtime/UI files
were not edited by this session; parallel M4/M5 changes belong to Claude.
Source/history workers finished. The lead interrupted the remaining OAuth hardening
and audit agents at the pause deadline; no session worker remains running.
The final read-race fix landed before interruption and its regression passed in
lead execution. The independent auditor did not rerun that last patch; finish the
final OAuth read-only review on resume before shared integration. No background
process was started by this work.

### Final OAuth review boundary

Hardening fixes temporary refresh recovery, rotated-token persistence retry,
failed-disconnect and failed-reauthorization stale-token guards, auth-dependency
deadlines, scope/token validation, and header-control rejection.

At 15:59 the auditor identified a final in-flight content-read race: connection
revision was checked before GET but not after the body completed. Disconnect or
new authorization during GET could return the old response. The hardening worker
added `ensureCurrent()` after body parsing and a regression before being stopped.
Lead verification passed 17/17 OAuth tests, including rejection of the stale
in-flight response. Final independent review of that last patch remains pending.

### Open audit finding: aggregate serialized-size budget

Severity: medium. Collector permits up to 20 documents of 1 MiB UTF-8 text each;
history accepts at most 24 MiB serialized JSON. Escaped text can exceed that JSON
budget while satisfying every collector limit. The independent auditor executed
a reproducer with 13 linked Confluence documents of exactly 1 MiB newline text:
13,631,488 raw text bytes, 27,266,078 serialized bundle bytes. Collection succeeds
but `recordSnapshot` rejects `invalid_bundle: bundle exceeds size limit`.

Next action: enforce a shared aggregate serialized-byte budget in the collector
with explicit per-document truncation/provenance retention, then add a meaningful
collector-to-history regression. Do not simply remove the history bound. Source
foundation remains `review` until this is resolved. This issue was intentionally
preserved at the owner's pause boundary rather than accepting a rushed fix.

## Resumed tranche completed: 2026-10-01

This section supersedes the historical pending findings above. The owner reported
Claude's M4 record is ready and M5 still awaits rechecking items 6, 7, 9, 11, and 12.
Shared runtime/API/dashboard ownership remains with Claude during those fixes.

- Aggregate source-size finding resolved: a 20 MiB serialized collector budget
  fits the 24 MiB history bound, including escaped text. Every document identity
  remains present, truncation is explicit, and unchanged refreshes replay.
- Final response-race review accepted; added session-bound synchronous OAuth
  state cancellation without changing credentials or connection revision.
- Added `encrypted-token-store.js`: injected external path/key, AES-256-GCM,
  private modes, atomic replacement, bounded reads, tamper/error handling.
  Absent reads/clears create no directory. Durability errors after replacement
  or unlink are explicitly distinguished; cross-process coordination is deferred.
- Added `oauth-handoff.js`: bounded one-use session-bound callback handles,
  authenticated completion, lifecycle/revision guards, adapter-state cleanup.
  The code exchange occurs only at completion, never on callback receipt.
- Lead execution passed 63 tests: source 9, history 9, OAuth 18, encrypted storage
  10, handoff 17. Protected-reference hashes matched. No test failures/skips.
- Final independent audit found no remaining actionable isolated-module defect.
  The former 32-denial lockout now allows the next begin; the regression also
  covers 40 malformed callbacks, expired handles, clear, and wrong-session use.

No live credentials, HTTP routes, product ticket integration, or dashboard wiring
were created. No shared M4/M5 files, protected reference, or Battle Pass files were
edited by this session. M6-F1 through M6-F5 are complete as isolated foundations;
M6 itself and M7 are not complete. Workers finished; no background service was
started. No Git mutation, commit, or push was performed.

Continuation: confirm shared-file ownership has settled, then implement M6-I1
through M6-I6 in [integration backlog](integration-backlog.md). Start with atomic
Jira identity/ticket mapping and persisted pinned source evidence, then mount
paired-session OAuth/site selection/import/refresh flows. Do not infer live M6
acceptance from these fixture tests. Operator OAuth/key configuration and approved
feature/bugfix pilots are still absent.
