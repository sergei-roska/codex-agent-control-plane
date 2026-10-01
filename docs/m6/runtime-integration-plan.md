# M6 runtime integration

Date: 2026-10-01. Status: complete_local; live exit gate remains pending.

The owner confirmed Claude finished M4/M5 and explicitly instructed that M7 must
not start. M4/M5 acceptance records exist. M6 may now integrate their final shared
runtime, product persistence, and dashboard code. Preserve their changes and the
protected dashboard reference. This work does not implement operator lifecycle
commands, protected Git actions, or Battle Pass.

Subsequent owner instruction: after local M6 acceptance, Claude is authorized to
start M7. Codex leaves M7 files to Claude until the owner explicitly hands the
work back. The scope and prohibition above record the completed M6 tranche.

## Write ownership

| Workstream | Allowed application files |
| --- | --- |
| Product persistence | `src/product-migrations.js`, `src/product-store.js`, `src/integrations/source-import-store.js`, `test/product-migrations.test.js`, new `test/m6-product-integration.test.js` |
| Runtime and HTTP | new `src/integrations/atlassian-integration.js`, new `src/integrations/atlassian-config.js`, new `src/dashboard-atlassian-api.js`, `src/server.js`, `src/dashboard-api.js`, `scripts/dashboard-dev-server.js`, new `test/m6-atlassian-integration.test.js`, new `test/m6-atlassian-api.test.js` |
| Dashboard | `web/dashboard/js/tabs/connections.js`, ticket record/run modules, `web/dashboard/js/app.js`, narrow pairing/callback coordination in `web/dashboard/js/api.js`, Connections HTML/CSS, working-copy index/build files |
| Lead | M6 planning, documentation, integration review, and executed verification |

Implementation workers may not mutate Git state or another workstream's files.
Any necessary scope expansion is reported to the lead first.

## Persistence decisions

Reuse the validated source registry in the product database. Migration 5 installs
the shared source schema and explicit requirement-revision/source-snapshot links.
An immediate outer transaction must atomically create the Jira ticket, immutable
source identity, initial snapshot, ticket binding, attached evidence artifact,
requirement revision, and command journal entry. The separate foundation registry
alone did not offer this guarantee.

Repeated import returns the bound ticket without creating a ticket, run, or new
requirement revision. Jira issue keys remain display aliases; the numeric issue ID
and selected origin identify the source. A command's retry fingerprint uses only
its bounded original request, not fetch timestamps or random artifact paths.
The stored result is returned before any new retrieval on replay.

Refresh is an explicit source command. An available changed source creates a new
requirement revision only while the ticket is in backlog. For active or settled
work, save the source snapshot as pending and leave the current requirement/run
inputs unchanged. A later explicit backlog refresh can apply the pending content.
Unavailable refreshes retain the last successful snapshot and all internal work.
This does not add any M7 transition to move a ticket back to backlog.

The complete bounded source bundle is persisted in snapshot history. A separate
bounded text artifact contains the PM evidence adapter output and is attached to
the new requirement revision before Intake. Write its file before the database
transaction; clean up only that new file when unused or the transaction fails.
Old attached files and replayed command evidence must never be removed.

## OAuth and routes

The dedicated Atlassian app uses server-owned secrets. Configuration is opt-in
through an explicit external config file; secret/key references point outside the
workspace to private operator-owned files. Missing configuration yields a truthful
unconfigured state. Invalid explicit configuration fails closed with redacted
errors. No current Codex connector token is exported or reused.

Resource discovery and explicit site selection are separate. Persist only sites
verified against the current accessible-resources response and required scopes.
Fixed typed gateway GET methods perform retrieval; no imported URL becomes a
request target. Disconnect/account/site changes invalidate an in-flight collection
before it can persist product changes.

Public callback receipt mounts after Host/no-store guards and before dashboard
session authentication. It consumes state and returns a redirect containing only
an opaque handle in a fixed dashboard fragment. The same-origin completion POST
requires the initiating paired session and normal Origin/CSRF checks. The existing
`SameSite=Strict` cookie policy is preserved.

Protected routes provide connection health, begin/complete/disconnect, resource
discovery, site selection, Jira import, ticket source refresh, source summaries,
history, and ticket-bound snapshot reads. Strict bounded JSON validation rejects
arbitrary identity, source bundle, token, session, path, or URL inputs. External
issue/comment/page/status/publication mutations remain unavailable.

## Verification and remaining live boundary

Verify actual database reopen/rollback/dedupe, immutable aliases, command replay,
artifact ownership, active-run pinning, failed refresh preservation, callback
authentication/CSRF/replay, and resource-selection guards. Check working-copy UI
flows against an explicitly injected local fixture service; retain M4/M5 behavior.
Run focused suites followed by the complete stable regression suite. Independent
review checks the product transaction and HTTP/security boundaries. Verify the
protected reference hashes after dashboard build and final checks.

Live activation still needs an operator-registered client/callback and private
secret/key references. M6 acceptance also needs approved Jira feature/bugfix and
Confluence pilot identities. Fixture/fake protocol evidence does not claim live
retrieval, live model quality, or full M6 acceptance.
