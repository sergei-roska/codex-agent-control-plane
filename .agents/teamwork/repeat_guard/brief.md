# Repeated review guard repair

## Scope

- Stable failed-review identity in `src/loop-guard.js`.
- Matching detector and graph regressions.
- Acceptance-auditor report guidance in the graph dispatch contract.

## Identity decision

For review work, the work key uses role, review kind, checkpoint ID, declared
paths, and allowed files. It excludes check-request prose, review reason, and
evidence IDs. Executed report checks, inspected paths, review result, and the
scoped candidate content identity remain evidence. Non-review work retains its
objective and requested-check identity.

## Constraints

Preserve predecessor changes. No staging, commit, push, service restart, live
task resume, or model call. The lead owns Git and integration.
