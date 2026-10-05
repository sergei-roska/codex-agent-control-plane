# ADR: Phase C tool mutation boundary

Status: accepted decision to defer DBC-06 (Contract Proxy). Evidence baseline:
`c6b7e69`.

## Decision

DBC-05 does not prove a supported, mandatory interception point for a scoped set
of tool mutations. Defer DBC-06. This is a boundary finding, not a claim that
the current sandbox or approval behavior is ineffective for its documented
purpose.

The role tool schema declares MCP server names and whether skills are enabled;
it does not select individual tool operations. `_toolPolicy` disables
non-allowlisted MCP servers when `config/read` succeeds, but records
`enforced: false` and continues if enumeration fails. The runner does not
intercept ordinary in-workspace mutations. Shell and patch paths remain
alternatives to MCP calls. Approval requests are declined, but ordinary
mutations are not approval requests. Workspace snapshots and deltas are
post-execution observations, not prevention. (`src/role-catalog.js`,
`src/codex-app-server.js`, `src/workspace-snapshot.js`,
`docs/execution-boundary-contract.md`.)

Observed boundary gaps in the reviewed report include ignored files, transient
write-then-restore changes, external symlinks, and nested repositories beyond
the snapshot's coverage. User hook notifications for shell and patch tools
were not verified as an enforceable mediation path. No supported scoped tool
set with mandatory mediation was demonstrated. These are findings for the
reviewed configuration and evidence; other deployment hooks or controls remain
unknown.

## Alternatives considered

- Proceed with a Contract Proxy: rejected because direct shell, patch, or other
  paths could bypass a proxy claim.
- Treat MCP allowlists, approval declines, or post-run deltas as the boundary:
  rejected because they do not mediate every mutation path.
- Defer until a supported mediation point and bypass analysis are demonstrated:
  accepted.

## Reopen DBC-06 when

1. A supported mechanism intercepts every mutation in a named, scoped tool set
   before execution, including direct alternatives and failure paths.
2. Tests show no bypass through shell, patch, configured tools, or other
   available paths, and mediation fails closed when inventory/configuration is
   unavailable.
3. Trusted predicates bind to pinned contracts and handle path/version races,
   symlinks, ignored files, nested repositories, and failed postconditions with
   preserved evidence and a defined containment policy.
4. The ADR records the concrete boundary, residual exclusions, evidence, and
   acceptance checks before proxy implementation is authorized.

Until then, boundary claims must remain limited to the enforced sandbox,
approval, dispatch, and post-run checks actually evidenced by the runtime.

## Sources

- The role schema only accepts MCP server names and a skills boolean:
  `src/role-catalog.js:39-56`.
- Inventory failure leaves `enforced: false` and still returns the config;
  thread setup applies that config and the sandbox/approval settings:
  `src/codex-app-server.js:589-619`, `:701-719`.
- Approval declines handle approval requests; they do not intercept ordinary
  in-workspace mutations: `src/codex-app-server.js:1039-1064`.
- Snapshot scope uses Git status and hashes dirty/untracked paths; ignored files
  are explicitly invisible and directories such as nested repositories are
  not hashed: `src/workspace-snapshot.js:8-9`, `:23-31`, `:56-75`.
- The existing boundary contract disclaims per-tool prevention and documents
  snapshot limits: `docs/execution-boundary-contract.md:27-30`, `:211-215`;
  the hardening spec describes
  tool policy as a cost control and says sandbox/approval settings are
  unchanged: `docs/hardening-spec.md:157-164`.
