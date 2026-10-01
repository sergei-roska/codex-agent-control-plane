# M6 local integration acceptance

Date: 2026-10-01. Status: local integration verified; M6 live exit gate incomplete.
M7 is not implemented in this checkpoint. After local M6 acceptance, the owner
authorized Claude to start M7 and will hand that work back to Codex later.

## Delivered behavior

- Optional dedicated Atlassian Cloud 3LO configuration activates encrypted
  server-side credentials. Absent configuration reports Not configured. Invalid
  explicit configuration fails closed with redacted errors. Config, secret, key,
  and token paths are distinct; secret/key reads are bounded and owner-only.
- Existing dashboard session and origin guards protect connection, site choice,
  import, refresh, and disconnect. The public callback only produces a bounded
  one-use handle; authenticated completion is bound to the initiating session.
  Callback host and dashboard origin must match. No Codex connector token reuse.
- Explicit cloud-site selection restricts typed Jira/Confluence reads. Provider
  traversal and source history retain immutable identities, revision metadata,
  unavailable/truncated context, and bounded saved source bundles.
- Migration 5 shares the source registry with the product database. Ticket,
  identity, snapshot, saved Intake evidence, requirement revision link, and command
  result are committed atomically. Repeated Jira import opens the same ticket.
- Available changed source creates a new Backlog input revision. Active/settled
  work retains pinned input and stores pending context. An outage does not erase
  successful evidence or internal progress. History metadata is paginated; full
  snapshots are loaded only through an ownership-checked explicit request.
- Connections and ticket records expose OAuth state, site choice, import,
  provenance, history, and explicit refresh. Source text renders as text; external
  links require credential-free HTTPS. Existing M5 controls remain present.
- External issue/comment/page/status writes are unavailable. Internal completion
  does not claim a Jira status update. The reference and Battle Pass are unchanged.

## Executed verification

| Check | Result |
| --- | --- |
| `env -u NODE_TEST_CONTEXT npm test`, with local loopback binding permitted | 729 passed, 0 failed, 0 skipped |
| Direct `node test/m6-atlassian-api.test.js`, real local HTTP | 5 passed, 0 skipped: session/CSRF, denial/malformed/replayed callback, session-bound handle, site selection/import/replay/duplicate/outage/history |
| Direct product integration suite | 6 passed: stored evidence to Intake, persistent dedupe, Backlog and pinned-run revisions, project boundaries, unavailable refresh/history, atomic rollback |
| Config/service integration suite | 6 passed in full run: configuration constraints, path collisions, callback composition/origin, site replacement and clearing |
| Dashboard syntax/build and static call-chain review | Passed; generated output confined to `web/dashboard/index.html` |
| Independent integrated code audit | No remaining actionable M6 finding after callback route and config path-collision fixes |
| `git diff --check` | Passed |
| `sha256sum --check --quiet docs/m0/reference-integrity.sha256.txt` | Passed |
| Anonymous browser observation at 1280x720 | Pairing entry rendered; observation session closed, screenshot under `/tmp` |
| Owner-provided Gemini interactive fixture QA | Reported 12/12 PASS, zero console errors; desktop import/dedupe/history/refresh/Intake/outage/recovery/disconnect/unconfigured/local callback cases accepted |
| Requested 390px layout check | Lead directly verified 390x844 through Chrome DevTools MCP: viewport/client/scroll widths all 390, controls and source modal fit, import/history/unchanged refresh pass, zero console errors; see [follow-up](codex-browser-390-report.md) |

The initial sandbox HTTP execution skipped because loopback binding was denied.
The lead reran it with approved local-port execution; the reported HTTP and full
suite results above have zero skips. Fixtures used only disposable `/tmp` runtime
state and fake providers/App Server, with no live OAuth or Jira/Confluence calls.

Repeated import was tested through reopen and two database handles, not an actual
simultaneous multi-process race. Atomic transactions and uniqueness constraints
enforce the database boundary. Browser interaction is not inferred from unit
tests or the anonymous pairing screenshot.

## Remaining acceptance

Initially the lead's computer-use browser inventory was empty. The owner subsequently
provided [Gemini's interactive report](gemini-browser-report.md) and local
screenshots. The lead reviewed the report, checked evidence files, viewed selected
screenshots, and reran reference integrity and whitespace checks successfully.
Functional fixture browser acceptance is recorded above. This is owner-provided
execution evidence. After Chrome DevTools MCP setup and restart, the lead directly
executed the separate [390px follow-up](codex-browser-390-report.md).

The Gemini report's 390x844 label conflicted with its 492px document-width
measurement and 500x844 narrow PNG. The lead resolved that evidence gap using
device emulation and recorded actual viewport/client/scroll widths of 390px with
device pixel ratio 1. Narrow M6 layout acceptance is now complete. The fixed
fixture did not exercise changed content during an active run. Browser
autocomplete/id warnings were reported; no runtime console errors were reported.

Live activation requires a dedicated registered app, actual callback/configuration
and private secret/key references, and approved source identities. The master-plan
exit gate still requires one real Jira feature and one bugfix through Intake with
inspectable provenance, missing epic/page and expired credentials, external edits,
repeated requests, outage recovery, and proof of zero external publication calls.
Simple `DEMO-1` fixtures do not satisfy those live gates. See
[operator setup](operator-setup.md) and [integration backlog](integration-backlog.md).
