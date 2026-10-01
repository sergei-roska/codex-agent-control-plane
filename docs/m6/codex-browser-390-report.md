# Codex browser follow-up: actual 390px viewport

Date: 2026-10-01. Verdict: PASS for the M6 narrow-layout follow-up.

After the owner restarted Codex, the configured Chrome DevTools MCP tools were
available in this session. The lead performed this check directly through MCP,
using the separate temporary browser profile and an isolated fixture context.
This resolves the measurement gap in [Gemini's report](gemini-browser-report.md).

## Environment and measurement

- Fixture server: `http://127.0.0.1:38609`.
- Disposable state: `/tmp/orchestrator-m6-codex-390-qa`.
- Existing delivery harness with `DASHBOARD_DEV_ATLASSIAN_FIXTURES=1`; no live
  account, credentials, provider calls, or M7 work.
- Chrome DevTools MCP `emulate` viewport: `390x844x1,mobile,touch`.
- Browser paired using its existing local pairing flow; fragment removed.

Measured in the actual dashboard page:

```json
{
  "innerWidth": 390,
  "innerHeight": 844,
  "clientWidth": 390,
  "scrollWidth": 390,
  "visualViewportWidth": 390,
  "devicePixelRatio": 1
}
```

Window resizing was not used as evidence for mobile viewport size.

## Executed cases

1. Open Connections. Atlassian reads Connected (read-only); M5 provider/model
   sections remain present. Load available sites and select the local fixture.
2. Measure the site selector, load/disconnect/select buttons, issue input, and
   import button. Every control is inside the 390px horizontal bounds. The issue
   input is 306px wide, and the controls wrap vertically without overlap.
3. Enter `DEMO-1` and click Import Jira issue. The source-backed ticket modal opens
   with Jira source, immutable ID `10001`, key `DEMO-1`, and requirement revision 1.
4. Open saved source context. Measure Refresh Source, snapshot selector, context
   view button, and retrieved-text block. All fit inside the viewport. The modal
   bounds are x=9.75 to x=380.25, width 370.5; its client and scroll widths are both
   369px. Source identity and snapshot IDs wrap. Vertical scrolling exposes the
   source history and saved context.
5. Click Refresh Source. The UI reports unchanged source content; revision 1
   remains current. Browser console error query returns no messages.

Screenshot evidence, both at 390x844:

- `/tmp/m6-codex-390-connections.png`
- `/tmp/m6-codex-390-source-history.png`

The lead viewed both screenshots. No product code or dashboard reference was
changed. Reference integrity and whitespace checks pass. The owned fixture page
was closed and server stopped after verification; disposable state is retained.

## Limits

This is the narrow-layout follow-up, not a repeat of every desktop case in the
Gemini report or a complete mobile accessibility audit. Live OAuth, approved Jira
feature/bugfix pilots, linked Confluence source cases, and the master-plan live
exit gate remain separate. M7 remains excluded.
