# ADR: Harness-managed external connectors

Status: accepted 2026-10-19 (owner direction; lead decisions 1-8 below).
Implementation: backend and launcher sidebar (UI-02) done and independently reviewed
(APPROVE, 2026-10-19, after one blocking fix: concurrent sign-ins for one connector
could leak a process; sign-ins are now serialized per name).
Live sign-in and tool verification are pending; nothing here is verified live yet.
Planned code: `profiles/connectors/catalog.json` (new), `src/connector-catalog.js`
(new), `src/codex-app-server.js` (`_toolPolicy`), launcher UI (UI-02 sidebar).

## Context

The owner wants Confluence (with Jira), Figma, Google Tag Manager (GTM) and
Context7 available to Harness agents. It is one connection shared by all
projects, and the owner signs in once per service in a browser.

Harness agents cannot use the owner's Codex MCP servers. `_toolPolicy` disables
every configured server that a role does not allow, so entries in
`~/.codex/config.toml` never reach Harness threads. The connectors must therefore
be defined by the Harness.

Facts checked on 2026-10-19:

- Codex CLI 0.163.0 app-server methods (from strings in the local binary, not a
  schema): `mcpServer/oauth/login`, `mcpServerStatus/list`, `mcpServer/tool/call`,
  `config/mcpServer/reload`; notification `mcpServer/oauthLogin/completed`.
  The request and response shapes are not read yet.
- Account sign-in already runs through `account/login/start` (returns `authUrl`)
  and `account/login/completed`: `src/codex-app-server.js:572`,
  `src/launcher-app.js:775`.
- Atlassian official page: endpoint `https://mcp.atlassian.com/v2/mcp`, OAuth 2.1
  by default, API token for headless use.
- Figma official page: endpoint `https://mcp.figma.com/mcp`, HTTP transport,
  browser sign-in on first connect.
- Context7: endpoint `https://mcp.context7.com/mcp`; the API key is optional.
- GTM: the owner's Codex config uses `https://gtm-mcp.stape.ai/mcp` through
  `mcp-remote` (`~/.codex/config.toml:784-788`). Its tool list and vendor
  documentation are not verified.
- Codex MCP OAuth credentials: secondary sources place them in
  `$CODEX_HOME/.credentials.json` in file mode. Not verified against 0.163.0.
- Gap (static reading of `src/codex-app-server.js`, about lines 690-705): an
  allowed server that is not in the Drupal catalog stays enabled with all its
  tools. Recorded as P-39 in `docs/production-transfer.md`.

## Decision

1. **Harness owns the connector set.** Four connectors with config names
   `harness-atlassian`, `harness-figma`, `harness-context7`, `harness-gtm`. The
   `harness-` prefix matches the existing server-name rule. Definitions live in
   `profiles/connectors/catalog.json`, separate from the Drupal catalog, whose
   checks (six servers, 76 tools) stay unchanged.
2. **Transport.** Each connector is a remote URL, passed to each thread as
   transient config overrides (`url`, `enabled`, `required`, `enabled_tools`),
   following the Drupal pattern. Harness never writes them to global Codex config.
3. **Sign-in.** Browser OAuth is started from the Harness UI through
   `mcpServer/oauth/login` and completes through `mcpServer/oauthLogin/completed`
   or `mcpServerStatus/list`. The owner signs in once per service. Agents never
   start a sign-in.
4. **Credentials.** Codex-managed, in the active account's `CODEX_HOME`. One
   connection therefore covers every project of that account. A second account
   needs its own sign-in. A Harness-level credential store is deferred (see Open).
5. **Tool exposure is default-deny per connector.** Each connector has an
   explicit read-only allowlist of tool names, checked against the live inventory
   after sign-in. Tools not on the list stay disabled, including tools added
   later. Write, publish, delete and admin tools are excluded. Enabling any write
   tool needs a separate owner decision. Initial allowlists, all to be verified
   live:
   - `harness-atlassian`: `getJiraIssue`, `searchJiraIssuesUsingJql`,
     `getConfluenceContent`, `searchConfluence`, `getAccessibleAtlassianResources`,
     `atlassianUserInfo`. Verified live on 2026-10-19 (readOnlyHint true). Generic
     gateways `executeRead`, `discover`, and the write tools stay out; `executeRead`
     reaches hundreds of operations and is an owner decision.
   - `harness-figma`: `get_design_context`, `get_metadata`, `get_screenshot`,
     `get_variable_defs`, `search_design_system`, `whoami`.
   - `harness-context7`: `resolve-library-id`, `query-docs`.
   - `harness-gtm`: empty until the owner has classified its tools.
6. **Role ceiling (defaults; reversible).** A role may use a connector only if its
   profile lists it in `mcp_servers`. Defaults:
   - `harness-context7`: explorer, scout, architect, engineer, senior-engineer.
   - `harness-atlassian`: explorer, scout, architect.
   - `harness-figma`: architect, engineer, senior-engineer.
   - `harness-gtm`: no role.
   The lead selects tools per assignment, at most five, as for Drupal.
7. **Close the gap (P-39).** `_toolPolicy` enables an allowed harness connector
   only with `enabled_tools` from its allowlist or from the lead's pinned
   selection. It disables any allowed server that is neither a Drupal catalog
   server nor a connector.
8. **Selection reuses the pin model.** Connector tools are chosen by trusted IDs
   with sha256 pins, as Drupal tools are, and count toward the five-tool limit.

## Consequences

- A second catalog and loader. The Drupal catalog is not changed.
- Before any connector tool appears, the owner must sign in to each service.
- Credential and refresh risks, listed below, apply to every connector.

## Risks

- Refresh-token races when several processes share one credentials file. Codex
  issue #48507 reports this on 0.157.1; not checked on 0.163.0. Parallel runs
  under one account must be tested before they are relied on.
- The credential file's format and store are contested in secondary sources;
  unknown for 0.163.0.
- GTM is verified only through secondary sources; Context7's Bearer-key header
  is described differently in two sources (the official page wins).
- Resolved 2026-10-19: the Atlassian v2 endpoint works in the Codex client (oAuth
  status, 23 tools listed on the active account).

## Open

Owner-only:
- Sign in to Atlassian, Figma, GTM and Context7 (key optional) in the browser.
- Confirm the GTM server identity and its write policy.
- Confirm the role defaults in decision 6.
- Decide whether any write tool is ever enabled, and for which role.

Unknown, with the evidence that would settle each:
- Request and response shape of `mcpServer/oauth/login`: generate the app-server
  schema from the local 0.163.0 binary.
- Whether a thread-level `url` override reuses stored OAuth credentials for the
  same server name: live test after the owner's sign-in.
- GTM tool list: after sign-in, from `mcpServerStatus/list`.
- Owner decision: whether `executeRead` (generic Atlassian read gateway) is
  allowlisted. Excluded until the owner says so.
- Credential sharing across account homes: deferred to a follow-up ADR.
- Inventory cache after sign-in: the MCP inventory is cached per app-server
  generation. If sign-in writes the Codex config, the cache may be stale until the
  generation restarts (hypothesis from review 1; check in the UI phase).

Known limits accepted at review 1 (2026-10-19):
- (Resolved 2026-10-19 by the live check.) At review 1 the Atlassian names were
  `unverified_*` placeholders, so a selection gave the worker no tool.
- Status mapping (review 4): `oAuth` with `runtimeStatus` "failed" and no
  `toolsError` still maps to signed_in. Not seen live: the probe without a thread
  reports runtimeStatus null. Optional guard, not implemented. Filter unverified tools from candidates or
  replace them after the live check.
- The connector catalog loads once per process. Catalog edits take effect after a
  project-server restart.
- A malformed connector catalog also breaks Drupal-only selection (fails closed).

Sidebar and status API limits (review of 2026-10-19):
- `GET /api/connectors` probes through a short-lived app-server, cached for 5 s
  and single-flight. A probe that started before a sign-in can show the old state
  for one poll.
- `oAuth` is read as "credentials stored" (schema enum). An expired token may still
  show "Connected" until a live check.
- Sign-in app-servers stay alive until the completion notice, 10 minutes, a new
  sign-in for the same name, or launcher shutdown. At most one per connector name.
- The sign-in POST has no origin or token check, the same as the account POST routes.
  A cross-site page can start one sign-in process for a connector; it cannot read
  the result. This is a project-wide gap, not specific to connectors.
- The launcher must restart to load the new routes and catalog titles.

## Verification plan

- Unit tests with a fake app-server: allowlist enforcement, unknown tools denied,
  P-39 closed for unmanaged servers, pin mismatch rejected.
- Tests make no live calls to Atlassian, Figma, GTM or Context7 and write nothing
  to company systems.
- Live check after the owner's sign-in: the visible tool list equals the
  allowlist, one read-only call per connector succeeds, and no write tool is
  visible to an agent.
