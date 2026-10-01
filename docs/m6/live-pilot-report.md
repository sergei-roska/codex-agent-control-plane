# M6 live pilot report - phase 1

Date: 2026-10-01. Server: `node src/server.js` on http://127.0.0.1:3000 (started with
`CODEX_ATLASSIAN_CONFIG`), state DB `.runtime/state.sqlite`, Atlassian site
`insomniacdesign` (cloud id `0a0664d0-92e4-45ce-a079-98138872173f`), read-only OAuth.
Evidence comes from dashboard API responses (`/integrations/atlassian/import`,
`/tickets/:id`, `/tickets/:id/source`, `/source/snapshots/:id`, `/source/history`) and
read-only queries on the state DB. Jira text is not reproduced here beyond titles and counts.

## Imported issues

| Field | INSDEV-406 | INSDEV-408 |
| --- | --- | --- |
| Internal ticket | `tkt_3qzkOn0RC-fso7N095TXhQ` | `tkt_xhJaGt9Uu8xOeucKaTy-iQ` |
| Title | ADR5 - Migrate Google reCAPTCHA to Google Cloud Platform | Custom Font Icons loading issue |
| External key / numeric id | INSDEV-406 / 58652 | INSDEV-408 / 59974 |
| Source identity | `src_4AXcpAF7PTraFnjZ2RQzGA` | `src_wCNsHwGsLQLjH4CY7wWgSQ` |
| Snapshot (ordinal 1) | `ss_LGWrm6vBmNamJznZBeqsYQ` | `ss_mvtBdqVzHkw85CGxpE7RYQ` |
| Source revision (Jira updated) | 2026-04-07T08:03:14.563-0400 | 2026-01-15T10:02:33.724-0500 |
| Root availability | available | available |
| Epic / parent in bundle | INSDEV-403 (58646), "Architectural Decisions Implementation", available | INSDEV-1 (27286), available |
| Comments in root text | 2 | 7 |
| Linked Confluence pages | 3 available: 1506181122 (rev 17), 1527021591 (rev 11), 1494646787 (rev 7, reached through page links) | none |
| Linked Jira issues in bundle | none (see finding 1) | none (see finding 1) |
| Bundle documents | 5 | 2 |
| `unavailable` entries | 0 | 0 |
| Truncation | no document/comment truncation; 1 `warning_limit` entry (provider warnings omitted after 40) | none |
| Warnings | 41: 32 unsupported ADF node types, 8 ignored non-Confluence ADF links, 1 `warning_limit` | 14: 12 unsupported ADF node types, 2 ignored ADF links |
| Source artifact | `source-context.txt`, 21317 bytes, extraction complete, not truncated | not inspected |

Both tickets were created in Backlog (version 1), `trackingMode: internal`, project
`prj_2d817dbac7bbf663`. State DB after the pilot: 2 tickets, 2 source identities,
2 source snapshots, 2 runs.

## PM Intake (normal path: submit, controller runs Intake)

| Ticket | Run | Classification | Readiness | Decision requests |
| --- | --- | --- | --- | --- |
| INSDEV-406 | `run_a2USSm45a8Q1zHlUHuzpRA` | feature | needs_input | 4 questions: delivery scope (inventory/tickets vs full migration), authoritative project/repo list, who may change reCAPTCHA/GCP records, which check ids to approve |
| INSDEV-408 | `run_xQ6Kdq_oRTUPpC01sQxgdw` | bugfix | needs_input | 2 questions: which repository/path holds the Partner Success Portal frontend, which check ids to approve |

INSDEV-408 has Jira type Story and was classified bugfix from content.

How Intake was bounded: code review shows a `ready` Intake result moves the run to
phase `branch`, then engineering. The coordinator profile is enforced read-only
(`src/role-pack.js`), and the branch preflight refuses a dirty checkout
(`dirty_worktree`); the checkout was dirty (8 paths) throughout. Both Intake results
were `needs_input`, so both runs paused at `awaiting_answer` before any branch step.
No decision was answered. Each run was then stopped through the product's Stop
command (run settled `stopped`, ticket `blocked`, decisions marked `stale`) because a
paused run holds the repository lease and INSDEV-408 stayed queued
(`repository_busy`) until the INSDEV-406 run was stopped. `git status --short` and
HEAD were identical before and after; no run has a branch name.

## Repeated requests

| Request | Result |
| --- | --- |
| Import INSDEV-406 by key (commandId `pilot-import-406-b`) | `duplicate: true`, `applied: false`, `changed: false`; same ticket and revision, ticket version 1 |
| Import by numeric id 58652 (`pilot-import-406-c`) | same result, same ticket, same snapshot `ss_LGWrm6...` |
| Source history of INSDEV-406 | 1 snapshot (no new snapshot); ticket count stayed 2; runs 0 at that point |

## Missing context

The real traversal produced no `unavailable` document and no truncated document. Only
warnings: unsupported ADF nodes and ignored non-same-site links, listed above.

## Egress audit

69 `atlassian_egress` rows (sequence 2-70): 1 `POST auth.atlassian.com /oauth/token`
(200, 14:54:30Z, before this phase), 68 GET, all `outcome: sent`, all status 200:
accessible-resources (34) plus `ex/jira` issue/comment/remotelink reads and
`ex/confluence` page reads for 58652, 58646, 59974, 27286 and pages 1506181122,
1527021591, 1494646787. The second and third imports each repeat the INSDEV-406
traversal (13 requests each). Violation check from `docs/m6/operator-setup.md`
(better-sqlite3 form) printed `[]`.

## Findings

1. Issue links (INSDEV-406 "relates to" x8, INSDEV-408 link to PSPME-751) are not part
   of the traversal: `atlassian-source-provider.js` follows parent/epic, remote links
   and Confluence page links only, and the egress rows show no issue-link or linked
   issue reads. The gate item "linked issues" is therefore not exercised by the
   current provider; the live plan's remark that linked client issues enter Intake
   context does not hold. Decide whether this is a gap or a scope clarification.
2. Repeat imports re-read the full tree from Atlassian each time (13 GETs per import);
   dedupe happens after the fetch.
3. A paused Intake clarification keeps the repository lease, blocking other tickets'
   runs until answered or stopped.

## Not covered in phase 1

- Expired or revoked credentials and reconnect state.
- Atlassian outage and recovery during refresh.
- External edits: no change between imports, so no new Backlog revision or pending
  context was observed; source refresh was not run.
- A missing or inaccessible epic/page (`unavailable` entry) was not produced.
- Intake `ready` path, planning, branch and engineering (intentionally not started).
- Answering Intake decisions.

## Phase 2: revoked credentials

Setup: the owner removed the app's access at id.atlassian.com; the stored token was
not edited or expired by hand. Session via `dashboard-pair.js`; cookie jar kept in the
scratchpad, never printed.

| Read | Before refresh | After refresh |
| --- | --- | --- |
| Health (`/integrations/atlassian`) | `state: connected`, `connected: true` | identical (`state: connected`) |
| Ticket INSDEV-406 version / status | 5 / blocked | 5 / blocked (same revision, same description) |
| Source `latestSnapshotId` | `ss_LGWrm6...` | `ss_Do7-KD...` (new, pending) |
| `appliedSnapshotId` | `ss_LGWrm6...` | `ss_LGWrm6...` (unchanged) |
| `pendingSnapshotId` / `pending` | null / false | `ss_Do7-KD...` / true |
| `latestAvailableSnapshotId` | `ss_LGWrm6...` | `ss_LGWrm6...` (unchanged) |
| Source history | 1 snapshot (5 documents, root available) | 2 snapshots; #2 has `rootAvailable: false`, 1 document, parent #1 |

Refresh (`pilot-p2-revoked-1`, expectedVersion 5): HTTP 200, `duplicate: false`,
`applied: false`, `changed: true`, `artifactAttached: false`. It did NOT return an
error. The provider's first call, `GET /oauth/token/accessible-resources`, got 401;
this was recorded as an unavailable root (snapshot bundle root `availability:
unavailable`) instead of being surfaced as `reconnect_required`.

Resources (`GET /integrations/atlassian/resources`): HTTP 409,
`{"error":{"code":"reconnect_required","message":"Request failed","requestId":"7b8a84f9e6d0"}}`.
No token or secret in any response body I received (health, ticket, source, refresh,
resources).

Egress rows after sequence 70 (atlassian_egress; 71-80 are run/lease events):

| Seq | Time | Request | Status | Outcome |
| --- | --- | --- | --- | --- |
| 81 | 15:51:55Z | GET api.atlassian.com /oauth/token/accessible-resources (refresh) | 401 | sent |
| 82 | 15:51:57Z | GET api.atlassian.com /oauth/token/accessible-resources (resources endpoint) | 401 | sent |

No token POST (`/oauth/token`) was attempted: the access token was rejected with 401
on the first call and the code path that maps `invalid_grant` to `reconnect_required`
was not reached for the refresh. Violation check (better-sqlite3 form, readonly):
`[]`.

Verdict: PARTIAL / FAIL on the gate item. Passed: the revoked credential failed
safely (401 only, no writes, no non-GET, no denied egress), the resources endpoint
reports `reconnect_required` redacted, ticket version/status/revision and the applied
snapshot are untouched. Failed: (a) the dashboard health state still reads
`connected` after revocation, so the UI cannot show "reconnect required" from health;
(b) the source refresh returns 200 and records a new pending snapshot with an
unavailable root (history now has 2 snapshots) instead of a reconnect error. The
pending snapshot is not applied, but it pollutes history and shows as pending context.
The refresh-token `invalid_grant` path was not exercised live (no token POST made).

## Phase 2 re-check after fix

Verdict: INCONCLUSIVE. The premise (grant still revoked) did not hold at re-check time:
the fixed 401 -> `reconnect_required` path was NOT exercised. Re-run is needed with a
revoked grant.

Evidence the grant was no longer rejected: egress seq 84 is `POST auth.atlassian.com
/oauth/token` 200 at 16:00:11Z (token refresh succeeded; token store file mtime matches),
seq 85-87 are `GET /oauth/token/accessible-resources` 200. Server restarted at 15:59:41Z
(seq 83 `server_started`). The 16:00:11Z refresh predates all calls of this re-check, so it
was made by something other than this run (owner reconnect or another client of the
server); the cause is not established.

| Read | Before | After refresh + import attempt |
| --- | --- | --- |
| Health | `state: connected`, `connected: true` | identical (no 401 seen, so no flip) |
| Ticket INSDEV-406 version / status / revision | 5 / blocked / rev_z-HM9V... | unchanged |
| Source latest / applied / pending | ss_Do7-KD... (unavailable) / ss_LGWrm6... / ss_Do7-KD... | unchanged |
| Source history | 2 snapshots (ss_Do7-KD... #2 unavailable, ss_LGWrm6... #1) | unchanged |
| DB counts | tickets 2, snapshots 3, identities 2, revision links 2, revisions 2 | unchanged |

Refresh (`pilot-p2-revoked-2`, expectedVersion 5): HTTP 200, `duplicate: false`,
`applied: false`, `changed: false`, `replayed: false`; source unchanged (the stale pending
unavailable snapshot ss_Do7-KD... from the first attempt remains in history and is still
pending; not deleted). Not a 409.

Import attempt (`pilot-p2-revoked-import-1`, INSDEV-408, jira originId from health):
HTTP 503 `{"error":{"code":"source_unavailable","message":"Request failed","requestId":"007f94733435"}}`.
No new ticket or snapshot. Open question: why a valid token yields `source_unavailable`
for INSDEV-408 after only `accessible-resources` 200 (no Jira GET recorded).

Egress rows with sequence > 82:

| Seq | Time | Request | Status | Outcome |
| --- | --- | --- | --- | --- |
| 84 | 16:00:11Z | POST auth.atlassian.com /oauth/token | 200 | sent |
| 85 | 16:00:12Z | GET api.atlassian.com /oauth/token/accessible-resources | 200 | sent |
| 86 | 16:00:35Z | GET api.atlassian.com /oauth/token/accessible-resources (refresh) | 200 | sent |
| 87 | 16:00:36Z | GET api.atlassian.com /oauth/token/accessible-resources (import) | 200 | sent |

Violation check (better-sqlite3 form): `[]`. No writes to Atlassian; no begin/complete/
disconnect/site routes called.

## Phase 2 lead re-check: revoked grant after both fixes

Lead analysis of the re-check above: removing the app grant at id.atlassian.com has
two observable forms. (1) The current access token is refused with 401 (seq 81-82).
(2) After the access token expires, the refresh_token grant still succeeds (seq 84,
POST 200), but accessible-resources returns no sites (owner's dashboard: "No
accessible Atlassian sites were returned"). The first fix handled form 1 only; a
second fix treats a selected site that is absent from accessible-resources, or lacks
`read:jira-work`, as `reconnect_required` (`assertSelectedSiteAccess` in
`src/integrations/atlassian-integration.js`). Full suite 957/957, M6 suites 97/97.

Executed by the lead at 16:04Z on the restarted server, grant still removed:

| Check | Result |
| --- | --- |
| Health before refresh | `connected` (in-memory state after restart) |
| `POST /tickets/tkt_3qzkOn0RC-fso7N095TXhQ/source/refresh` (`pilot-p2-revoked-3`, v5) | HTTP 409 `{"code":"reconnect_required","message":"Request failed"}`, no secrets |
| Health after | `state: reconnect_required`, `connected: false` |
| Ticket version | 5 before and after |
| Source history snapshots | 2 before and after (no new snapshot) |
| Egress | seq 89 GET accessible-resources 200 only; 76 rows total, 0 violations |

Verdict: PASS for the revoked/expired credential gate item. The stale unavailable
pending snapshot `ss_Do7-KD...` recorded before the fixes remains in history as
evidence of the defect; it was not applied and the applied snapshot is unchanged.

## Phase 2: reconnect and recovery

The owner reconnected through browser OAuth and reselected the site. The first
refresh (`pilot-p2-reconnected-1`) read the full tree (seq 93-111, all GET 200) but
reported `changed: true` with pending `ss_WbkFHA...`. The lead diffed it against the
applied `ss_LGWrm6...`: identical content and Jira source revision; only parent and
recordedAt differ. Change detection compared against the latest snapshot, including
the unavailable one, so any A -> unavailable -> A recovery produced a false change.

Fix in `src/product-store.js`: `refreshSourceBundle` compares the new available
content hash with the applied snapshot; `getTicketSource` reports pending only for an
available snapshot whose content differs from applied. Unavailable observations stay
in history only. Full suite 960/960.

Lead re-check after restart (`pilot-p2-recovered-2`): `changed: false`, pending
false, applied `ss_LGWrm6...` unchanged, ticket version 5 unchanged. Egress 117 rows,
0 violations. Verdict: PASS for recovery after an authorization outage.
