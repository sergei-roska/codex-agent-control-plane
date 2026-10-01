# M6 parallel foundation

This document records the isolated foundation phase. Current integrated status
and outstanding live/browser gates are in [local acceptance](acceptance.md).

Date: 2026-09-30. Status: in_progress. This is an isolated foundation, not M6 acceptance.
Resumed: 2026-10-01. The owner confirmed M4/M5 integration is implemented and
Claude is validating and fixing it; shared files remain with Claude. Continue
isolated M6 modules and fixture verification only.
Later on 2026-10-01 the owner confirmed Claude finished. Shared integration is
now authorized under [runtime integration plan](runtime-integration-plan.md).
The owner explicitly instructed that M7 must not start.
Claude owns M4/M5 and their shared runtime/dashboard integration. This work owns
only new `src/integrations/**`, `test/m6-*.test.js`, and `docs/m6/**` files.
Protected reference `artifacts/dashboard/**` and Battle Pass remain read-only.

## Decisions and authority

- The owner requested parallel M6 work while M4/M5 are implemented elsewhere.
  M7 is deferred because it changes the same runtime stage/control boundaries.
- The owner selected local fixtures first, then explicitly selected OAuth for
  the orchestrator, matching the authorization experience of the connected
  Atlassian app. No live account retrieval or authorization occurs in this work.
- Implement an Atlassian Cloud OAuth 2.0 authorization-code adapter using the
  official 3LO endpoints. This is an implementation choice; the owner selected
  OAuth, not a specific protocol version or app registration. A dedicated app
  registration and callback wiring remain necessary before live activation.
  Do not export or reuse credentials from the Codex Atlassian connector.
- Read-only scope set: `read:jira-work`, `read:page:confluence`, `offline_access`.
  Resource discovery is separate from explicit operator site selection. Product
  API calls use typed GET operations only. OAuth token exchange/refresh POSTs
  are authentication operations, not Jira/Confluence publication.
- Credentials/tokens must stay in server-side injected secret/token stores.
  No browser token, ticket secret, log secret, or committed credential.
- Defaults from M0: at most 20 retrieved documents, traversal depth 2, 1 MiB
  per source document. Limits cannot be raised by imported content. Unavailable
  and truncated context remain inspectable.

## Module ownership and contracts

### Source collection and PM input

`src/integrations/source-bundle.js`, `fixture-source-provider.js`,
`atlassian-source-provider.js`, and `test/m6-source-bundle.test.js` belong to the
source worker.

`collectSourceBundle({ provider, root, origins, limits?, now? })` returns a JSON
bundle `{ schemaVersion: 1, root, documents, warnings, fetchedAt, contentRevision }`.
`root` and each typed link are `{ sourceKind: 'jira'|'confluence', originId,
externalId }`. Jira roots must preserve the immutable issue ID returned by the
provider; issue keys are display aliases. Configured origins are
`[{ originId, sourceKind, baseUrl }]`, trusted operator input, not ticket text.
Provider interface: `read(reference)` returns a normalized document:
`{ sourceKind, originId, externalId, displayKey?, url, sourceRevision?, title,
text, links: [reference], availability: 'available'|'missing'|'unauthorized'|
'unavailable', truncation? }`. A thrown provider error becomes bounded missing
context with a generic message, never the raw error. Root failure is explicit
and must not produce a usable ticket draft.

Only configured HTTPS origins are valid. Document URLs must match the configured
origin and base path and contain no URL credentials. Traversal deduplicates
typed identities, stops cycles, enforces all budgets, and preserves unresolved
link entries. Stable content revision excludes fetch timestamps. Received text
is untrusted data.
The collector also enforces a 20 MiB serialized JSON ceiling, below the history
store's 24 MiB ceiling. Escaped text counts toward that budget. Text is divided
fairly across documents, with explicit truncation markers and all identities
preserved; content revision is computed after truncation.

`bundleToIntakeInput(bundle)` returns `{ revision, artifacts, extractedTexts,
contentRevision }`
accepted by existing `buildIntakePrompt`. This is an in-memory input adapter,
not staged/persisted product artifacts. Its ticket fields must satisfy current
title/description/reference limits. It preserves source provenance and explicit
missing-context markers in extracted text; no reference is presented as retrieved
by the existing reference-string path. Do not claim PM classification was run.

`createFixtureSourceProvider({ documents })` performs local reads only and
returns independent copies. `createAtlassianSourceProvider({ client, sites })`
bridges the typed OAuth read client below to normalized Jira/Confluence docs.
`sites` explicitly maps origin IDs to configured cloud IDs/site URLs. It must
bound comment pagination and remote-link discovery; handle Jira ADF and
Confluence `atlas_doc_format` as data, and preserve unsupported content warnings.

### Immutable source history

`src/integrations/source-import-store.js` and `test/m6-source-import-store.test.js`
belong to the history worker.

`SourceImportStore({ db, now? })` uses a dedicated database supplied by its caller
and installs only `m6_source_*` tables. It never modifies product schema/tickets.
`recordSnapshot({ projectId, bundle })` returns
`{ identityId, snapshotId, changed, replayed }`; identity is
`projectId + root.originId + root.externalId` for Jira immutable IDs. Identical
content and provenance produce no extra snapshot despite a new fetch timestamp.
Changed context adds an immutable, parent-linked snapshot. Root-unavailable
refreshes must not overwrite the latest successful snapshot.
`getIdentity({ projectId, originId, externalId })`, `getSnapshot(snapshotId)`,
`listSnapshots(identityId)`, and `bindTicket({ identityId, ticketId })` expose
durable history/linking. One identity can bind to exactly one ticket; rebinding
to the same ticket is idempotent; binding to another ticket is rejected.
This registry alone does not atomically create product tickets or prevent duplicate
product runs. That requires later integration in the shared product database.

### OAuth and read-only transport

`src/integrations/atlassian-oauth.js`, `atlassian-read-client.js`, and
`test/m6-atlassian-oauth.test.js` belong to the OAuth worker.

An injected token store is mandatory; the foundation provides no plaintext disk
fallback. OAuth state must be random, session-bound, expiring, and single-use.
Redirects on token/API HTTP requests are rejected. Requests have deadlines and
bounded streaming response reads. Errors and public health responses exclude
tokens, authorization codes, client secrets, and raw upstream bodies.
Refresh is serialized per client and saves rotated tokens before reuse.
Restart invalidates in-memory pending OAuth states; no callback can silently
rebind another browser session.

OAuth exports a factory `createAtlassianOAuthClient(options)` with
`beginAuthorization({ sessionId })`, `completeAuthorization({ sessionId, state,
code })`, `cancelAuthorization({ sessionId, state })`, `getAccessToken()`,
`getResources()`, `getHealth()`, and `disconnect()`.
Cancellation is synchronous, session-bound, and idempotent. It removes pending
state without exchanging a code, changing connection revision, or clearing tokens.
Token persistence is injected as async `tokenStore.read()`, `write(value)`,
`clear()`. `clientSecret` is obtained by injected `resolveClientSecret()`.
Never return a token from authorization completion or health. `getAccessToken`
is an internal server-only interface.

`createAtlassianReadClient({ oauth, sites, fetchImpl?, ...limits })` exposes only
`getIssue({ originId, issueIdOrKey })`,
`getComments({ originId, issueIdOrKey, startAt?, maxResults? })`,
`getRemoteLinks({ originId, issueIdOrKey })`,
`getPage({ originId, pageId })`. It validates origin/site access and required scopes
against fresh resource discovery, constructs gateway URLs itself, and never
accepts arbitrary paths, HTTP methods, or URLs from imported content. Site entries
are `{ originId, sourceKind, cloudId, baseUrl }`. Use `body-format=atlas_doc_format`
for Confluence. Returned values are raw bounded JSON for the normalization bridge.

## Deferred integration and exit gates

After M4/M5 settle shared file ownership, implement atomic Jira identity/ticket
creation and explicit source-to-requirement revisions in `ProductStore`/migrations;
persist source artifact text before Intake; wire authenticated OAuth callback,
site selection, import/refresh API, and dashboard state. Active/resumed run inputs
stay pinned. Defaults and refreshed source context cannot silently replace them.

M6 remains incomplete until one approved Jira feature and bugfix pass actual
Intake with source history, repeat-import dedupe, missing pages, expired OAuth,
external edits, and outage recovery. M7 integration remains separate.

## Resumed independent work

- Resolved aggregate serialized-size compatibility within the collector, preserving
  bounded history validation and provenance for every collected document.
- Completed the final read-only review of the OAuth response-race correction.
- Added encrypted server-side token persistence and a callback handoff coordinator
  in isolated modules. No shared server/config/API file is changed and no live
  credential is created.
- Fixed canceled adapter state accumulating after denied/malformed callbacks.
  Matching session-bound state is canceled on terminal handoff paths.

`createEncryptedTokenStore({ filePath, workspaceRoot, bindingId,
resolveEncryptionKey })` uses caller-selected absolute storage outside the
configured project workspace. No default path or generated key fallback.
`resolveEncryptionKey()` supplies a 32-byte Buffer from operator-owned secret
storage; the key is never written next to the ciphertext. AES-256-GCM with a fresh
12-byte nonce authenticates a versioned envelope and the nonsecret binding ID.
Token records remain bounded and validated against the OAuth adapter contract.
Readers reject tampering, malformed envelopes, unsafe file modes, and symbolic
links, without returning raw filesystem/crypto/dependency errors.

Writes use owner-only temporary files and atomic replacement in the same private
directory, with fsync before success; cleanup affects only this operation's own
temporary file. Failures before atomic replacement preserve the previous record;
failure syncing the directory after replacement reports uncertain durability.
Clear reports the same uncertainty if directory sync fails after unlink.
Operations serialize
within one store instance. The existing application single-instance policy must
cover this store at integration; cross-process coordination is not claimed.
Directory ownership/mode and symlink checks must not silently chmod unrelated
operator directories. Only writes may create the selected final private directory;
its ancestor must already exist. Reads and clears never create directories.
Clear is idempotent for absent storage. OAuth health/API
must never expose the decrypted record or encryption key.

### OAuth callback handoff coordinator

A new `oauth-handoff.js` can be implemented without mounting/changing shared
API/auth files. `createOAuthHandoff({ oauth, now?, ttlMs?, maxPending? })` exposes
`begin({ sessionId })`, `receiveCallback({ state, code, error? })`,
`complete({ sessionId, handle })`, `disconnect({ sessionId })`, and `clear()`.
The future route caller must validate the paired dashboard session for every
operation except callback receipt; a session ID here is the server-side session
hash, never an arbitrary user-supplied body field.

Begin stores bounded expiring server-side state bound to that session and returns
the authorization URL. The cross-site callback validates/consumes handoff state,
stores code server-side, and returns a random opaque handle only. It must not
exchange tokens or return code/state/token/session details to the browser. The
future callback route clears OAuth query parameters by redirecting to a fixed
same-origin dashboard URL with only the handle in the fragment. A subsequent
same-origin authenticated POST completes only the initiating session's handle.
Handles are expiring and single-use, including after failed completion. Forged,
expired, duplicate, wrong-session, denied, and malformed callbacks fail with fixed
redacted errors. Concurrent begin/complete/disconnect operations cannot restore
an obsolete flow. Disconnect clears local flows before invoking OAuth disconnect.
No timers/background work; expiry is checked on access. Restart discards flows.
Terminal flows must cancel their matching adapter state, including denial,
malformed callbacks, expired handles, failed/late begin, and local clear. A valid
callback retains adapter state until authenticated completion. No cancellation
may exchange an authorization code or cancel another session's state.
This module alone grants no HTTP access and does not prove callback/UI integration.

## API evidence

- [Atlassian OAuth 2.0 3LO](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/): authorization, token exchange, resource discovery, refresh rotation.
- [Jira Cloud REST v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/): ADF issue/comment content.
- [Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/): typed comment pagination.
- [Remote issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/): read-only linked context.
- [Confluence pages v2](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/): page ID, body format, read scope.

## Verification

Resumed on 2026-10-01. Final lead execution passed 63 focused tests: 9 source,
9 history, 18 OAuth, 10 encrypted storage, and 17 callback handoff. No failures,
skips, or cancellations. The five-file test invocation also passed. Protected
reference hashes matched. Independent settled-file review found no remaining
actionable finding in the isolated modules, including source budget, encrypted
storage, response-race correction, adapter cancellation, and handoff lifecycle.
The former 32-denial lockout reproduction now permits the next begin with only
its new adapter state pending. See
[pause checkpoint](pause-checkpoint.md) for history and
[integration backlog](integration-backlog.md) for current scope.
No live service claims. No M4/M5 shared-file mutations.

```sh
node test/m6-source-bundle.test.js
node test/m6-source-import-store.test.js
node test/m6-atlassian-oauth.test.js
node test/m6-encrypted-token-store.test.js
node test/m6-oauth-handoff.test.js
sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt
```
