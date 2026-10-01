# Gemini browser QA brief: M6

Perform an independent interactive browser check of the current M6 implementation
in `/home/sr/Projects/Workspace/codex-agent-control-plane`.

## Authority and boundaries

- Read `AGENTS.md`, `docs/beta-master-plan.md`, and `docs/m6/operator-setup.md`.
- Test only local disposable fixtures. Do not connect a real Atlassian account,
  grant OAuth permissions, call live Jira/Confluence, or use Codex connector tokens.
- Do not implement M7, change product code, dependencies, build configuration, Git
  state in this repository, or `artifacts/dashboard/**`. The reference and Battle
  Pass are protected. Report defects before proposing fixes.
- Temporary runtime state and screenshots belong under `/tmp`. A QA report may
  be written to `docs/m6/gemini-browser-report.md` in English.
- Keep pairing codes, cookies, OAuth states/handles, and token contents out of
  screenshots, logs, reports, and chat. Use them only in their local test flow.
- Stop only processes you started. Do not stop another agent's server or take
  over a occupied port. Do not delete existing runtime state to reset a test.

## Start a separate fixture instance

Use a new disposable directory and a free loopback port, for example:

```sh
env -u NODE_TEST_CONTEXT DASHBOARD_DEV_DIR=/tmp/orchestrator-m6-gemini-qa DASHBOARD_DEV_SCENARIO=delivery DASHBOARD_DEV_ATLASSIAN_FIXTURES=1 CODEX_ATLASSIAN_CONFIG= PORT=38607 npm run dashboard:dev
```

If that directory already contains unrelated state, choose another new `/tmp`
directory. The existing dev harness creates a tiny Git repository inside that
disposable workspace; it must not modify this project's Git state. Do not use
the default `.runtime/dev` directory.

Open the newly printed pairing URL in your own interactive browser. It is a
single-use local test code. Wait until pairing finishes and the fragment is
removed before collecting evidence. If it expires, issue another code:

```sh
CODEX_A2A_TOKEN_FILE=/tmp/orchestrator-m6-gemini-qa/a2a-token PORT=38607 npm run dashboard:pair
```

Keep the directory and port consistent if you choose alternatives.

## Interactive cases

1. **Connections and layout:** open Connections at desktop width and a narrow
   viewport. Atlassian fixture state must be connected and read-only, with the
   fixture site visible. Existing M5 OpenAI/model controls must remain visible.
   Check clipping, overlap, scrolling, focus, buttons, and browser console errors.
2. **Explicit site selection:** load available sites and select the fixture site.
   Confirm the UI shows the selected Jira capability. This fixture may already
   have a site selected at startup.
3. **Import:** import `DEMO-1`. Open the resulting internal ticket. Confirm source
   Jira, immutable ID `10001`, key `DEMO-1`, inspectable source provenance, applied
   snapshot, and saved evidence. The fixture title is
   `Fixture import: bounded source context`.
4. **Duplicate:** import `DEMO-1` again, then `10001`. Both must open the same
   ticket ID and must not create another ticket, run, or requirement revision.
5. **History:** open saved snapshot details. Source text must render as text;
   provenance, availability, and revision metadata must be understandable. Reload
   the page and reopen the ticket to verify persistence.
6. **Unchanged refresh:** Refresh Source. Confirm an unchanged result does not
   claim a new revision or pending change. Existing evidence remains available.
7. **Invalid/missing import:** try malformed input and a valid nonexistent key,
   such as `DEMO-999`. Show a useful error without a new runnable imported ticket.
8. **Intake:** submit the imported ticket once through the existing local fake
   delivery flow. Inspect PM Intake and saved evidence. Refresh during the run
   if observable; pinned run input must not change. Do not commit, push, merge,
   publish, or introduce any M7 controls. The simple fixture has fixed source
   content, so it does not prove a changed-source active-run scenario.
9. **Outage:** stop your own instance gracefully and restart it using the same
   directory and port with `DASHBOARD_DEV_ATLASSIAN_OUTAGE=1` added. Re-pair if
   needed, reopen the previously imported ticket, and Refresh Source. The UI must
   explain that retrieval failed/unavailable and preserve the prior successful
   evidence, requirement revision, run, and internal progress. Then restart
   without the outage flag and verify recovery. Do not reset the database.
10. **Disconnect:** disconnect the fixture account. It must show disconnected,
    clear site selection, and refuse further imports/refreshes while saved ticket
    evidence and history remain readable.
11. **Unconfigured state:** start a second disposable instance on another free
    port without `DASHBOARD_DEV_ATLASSIAN_FIXTURES=1` and without the `atlassian`
    scenario, keeping `CODEX_ATLASSIAN_CONFIG=`. Pair it and verify Connections
    shows Not configured, with direct-ticket and M5 controls still usable.

## Optional local OAuth callback UI case

The fixture authorization URL points to a real vendor hostname with fake data.
Do not navigate there. To exercise callback handling without a live account:

1. In the paired fixture browser, issue same-origin
   `POST /api/dashboard/v1/integrations/atlassian/begin` with JSON `{}` using that
   browser's normal session. Inspect only the returned URL locally.
2. Extract its `state` and navigate the same browser tab to the local callback
   `/api/dashboard/v1/integrations/atlassian/callback?state=<state>&code=fixture-code`.
   Do not include the state or URL in your report.
3. Confirm the redirect is local, the OAuth fragment is promptly removed, the
   authenticated completion succeeds, and explicit site selection is needed
   again. Browser storage must not contain OAuth codes, tokens, or handles.
4. If your browser tooling cannot safely perform this case, mark it NOT RUN.
   Backend session-bound callback behavior already passed real local HTTP tests.

## Report and cleanup

Give each case PASS, FAIL, or NOT RUN with concrete observations. For defects,
include reproduction steps, expected/actual result, severity, and a screenshot
path under `/tmp`; redact all authentication material. Report console errors and
viewport sizes. Distinguish fixture behavior from live OAuth acceptance.

Do not claim live feature/bugfix pilots, expired real credentials, changed Jira
content, linked Confluence traversal, or missing epic/page are validated by the
simple fixture. Those still require dedicated operator configuration and approved
real source identities. Stop your own servers after checking. Verify:

```sh
sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt
git diff --check
```

Return the report for integration by the development lead. No M7 work is authorized.
