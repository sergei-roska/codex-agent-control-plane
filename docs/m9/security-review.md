# M9 security review and disposition

Status: candidate review on 2026-10-02. This is not release approval. Two
independent read-only audits supplied the first findings below; a later
idempotency review, the live pilot, and an independent pre-merge audit supplied
the findings in the second table. The lead reviewed each code path and
integrated scoped fixes. Remaining live evidence is tracked in
[acceptance](acceptance.md).

## Findings

| Finding | Severity | Disposition |
| --- | --- | --- |
| Default workspace can overlap the application and let a writer alter the served dashboard | High | Fixed: startup and writer-profile guards reject a workspace equal to, within, or containing the application root, including symlink aliases. Setup now requires a separate task repository. Focused server/profile tests passed. |
| Commit can target a branch outside the ticket lifecycle | Low | Fixed: `beginCommit` requires the candidate branch to be reserved for that ticket. A read-only run on `main` cannot commit another party's changes. Store tests passed. |
| Candidate verification and Git staging can race another writer | Low | Fixed within the application writer boundary: operator commit holds WriterAdmission through staging, commit, and settlement. The staged Git blobs are checked against reviewed manifest bytes and modes. Controller and Git tests passed. External manual edits to a leased checkout remain outside the supported operating procedure. |
| Diagnostic redaction misses JSON and underscore token forms; a second redactor is weaker | Low | Shared redaction now covers quoted assignments, common headers, GitHub and ATATT token forms, JWT-shaped strings, and permission events. Focused journal and App Server tests passed. Nonstandard standalone JWT headers remain outside the pattern. |
| `waitDetail`, decision questions, and stderr may expose diagnostic secrets | Low | Delivery wait details and persisted decision questions now use shared redaction; the dashboard API redacts unexpected stacks before stderr. Focused regressions passed. |
| Stop/Cancel can remain pending forever for an unresolved writer after the lead becomes terminal | Medium | Fixed: controller retries WriterAdmission reconciliation on later ticks and settles only after quiescence is proven. A focused regression covers unresolved and later-reconciled outcomes. |
| Pause/Stop checks can be missed at lead decision and acceptance boundaries; hold lookup fails open | Low | Fixed: resumed hold and completed decision paths recheck operator control, and lookup failure parks the graph. Lead graph regressions passed. |
| A completed review run can emit a misleading `run_stopped` journal event on ticket cancellation | Low | Fixed: event emission requires a run actually ended stopped or cancelled. Store regression passed. |
| A terminal lead can settle while a child writer remains live, after which ticket Cancel can release the repository lease | Medium, conditional | Fixed fail-closed: terminal lead handling waits for any workspace writer; durable store settlement and cancellation also refuse lease release while a writer is active or unresolved. Tests use distinct parent lead and child writer task IDs. The exact exceptional lead terminalization trigger was not reproduced live. |
| Session cookies are shared by loopback services across ports | Low | Open limitation. The cookie name includes the port, but browser cookie isolation is by host, not port. Use a trusted local machine and avoid untrusted services on the same loopback hostname while operating this beta. A separate per-origin request secret is a future hardening item. |
| Atlassian import has no Jira project or Confluence space allowlist | Low | Open limitation. The connector is tenant-scoped, read-only, and bounded. Use a dedicated account with only the projects and spaces approved for this pilot. |
| Plan protected-path list does not cover every CI/package configuration file | Low, unproven bypass | Review candidate diffs and allowed files before acceptance. Broader policy needs a deliberate rule for legitimate DevOps tickets. No automated protected action follows solely from an Intake plan. |
| Inactive escalation modal uses raw `innerHTML` | Low, unreachable in current UI | Remove or escape before wiring it to live escalation data. |
| Atlassian OAuth has no PKCE | Unconfirmed | Current flow uses a one-time session-bound state and a client secret. Atlassian PKCE support and behavior need direct provider verification before changing the flow. |

## Findings after the live pilot and pre-merge audit

| Finding | Severity | Disposition |
| --- | --- | --- |
| Codex CLI 0.160 creates zero-byte placeholder files in the task repository for every missing carve-out target of the generated permission profile; the `artifacts/dashboard` target then fails sandbox setup ("Not a directory"), QA cannot run, and the untracked placeholders make the checkout dirty for the next ticket | Critical (primary flow) | Fixed: optional carve-outs are emitted only for targets that exist with the expected type, the application-specific `artifacts/dashboard` entry is removed, and the thread binding is built from the rule list so it stays stable when optional paths appear. Found by the live direct-ticket pilot. |
| With carve-outs conditional, a writer could create `.codex/config.toml` (MCP servers, hooks) that a later thread in the unsandboxed App Server loads | Major, conditional | Fixed: before every profile is built the server ensures `.codex`, `.agents`, and `.claude` exist as real directories (empty directories leave Git clean) and grants them read-only to writers; a placeholder file or symbolic link there fails closed. Whether Codex 0.160 trusts a project config for this cwd was not verified; the fix does not depend on it. |
| A path created during a run (for example `.env`) is not covered by deny or read-only carve-outs for already loaded threads until the next thread or App Server restart | Low | Accepted for beta: such a path can only hold content the agent itself wrote, because the operator must not modify a leased checkout during a run. Pre-existing operator files are covered when the thread starts. |
| A second push of an already pushed commit was accepted with a new command id | Medium | Fixed: one push per commit and remote; failed or unknown pushes may be retried; command replay still returns the original result. The dashboard stops offering Push after success. |
| A commit delivery recorded as `unknown` is terminal: it is never re-reconciled, cannot be pushed, and does not block Release Repository | Low (liveness) | Open limitation. No duplicate commit is possible (Git-side candidate verification refuses it, covered by a test) and no other ticket's work can mix in (dirty checkout refusal, branch from base). The operator inspects the branch and pushes it with Git directly if needed. |
| Model decision and report schemas did not state cross-field rules (recommendation must be an option id; `final` empty or required by action), so valid-looking model output was rejected | Low (robustness) | Fixed: schema descriptions and the prompt contract lines state the rules; validation is unchanged and still fails closed. |
| Connections & Models could stay on "Loading" forever, clip the role table, and offer stale actions while disconnected | Low | Fixed: independent bounded requests with a server-side App Server timeout, load on any tab activation and on reconnect, a scrollable table, disabled mutating ticket actions while disconnected or unloaded, stale Board labeling, and a reachable mobile header. |

## Reviewed boundaries

The independent audit found no demonstrated bypass in Host/Origin checks,
cookie lifetime, pairing, command replay/version checks, candidate-bound review,
push refspec and remote restrictions, Git argument handling, attachment storage
and response headers, Markdown rendering, Atlassian egress allowlist, or token
storage. Static review cannot prove Codex sandbox enforcement or browser cookie,
CSP, and download behavior in every browser. The live Codex pilot and browser
checks in [acceptance](acceptance.md) carry the observed evidence instead.
