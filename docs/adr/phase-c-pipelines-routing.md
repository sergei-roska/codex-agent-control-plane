# ADR: Phase C pipelines and routing

Status: defer PIP-05 activation and OPT-04 activation. Evidence baseline:
`c6b7e69`.

## PIP-05 decision

The repository documents manual efficiency-trial procedures in
`docs/efficiency-comparison.md` and a frozen matched-trial plan in
`docs/orchestration-benchmark-plan.md`. The latter specifies per-trial pinning,
acceptance, latency, usage coverage, retries, and recovery. Both result tables
are templates, not measured output. In the reviewed CLI and harness evidence,
no repeated workflow requiring multistage composition is demonstrated, and no
shared consumer justifying a Pipe Broker is demonstrated. This does not
establish that such workflows or consumers do not exist outside the reviewed
scope.

Defer PIP-05 pending a named repeated workflow. If one is identified, prefer an
internal process pipeline with typed JSONL records. A shared consumer is not
required for internal pipes; consider a broker only if multiple real consumers
need a shared service. Existing CLI operations include `npm run ask`,
repeatable acceptance checks, usage reporting, and evidence retrieval, but
their presence alone does not establish a multistage pipeline.

No Phase C benchmark result or measured improvement is claimed. Existing
benchmark tolerances are gates for future comparisons, not observed outcomes.
Evidence artifacts currently default to 30-day retention with a configurable
1..365-day range; large evidence remains subject to its size, truncation, and
retrieval contract (`docs/evidence-artifact-contract.md`).

Reopen PIP-05 when a named repeated CLI workflow and its composition needs are
identified, then verify stage exit handling, separate stdout/stderr and
truncation, descendant cancellation, byte limits and slow-consumer behavior,
retrievable large evidence, and restart from durable artifacts/journal state.
Consider a broker only if multiple consumers demonstrably need a shared
service.

## OPT-04 decision

Defer route activation because OPT-01..03 remain unstarted prerequisites at the
M2 evidence baseline. This pass records an activation defer; it does not
permanently reject routing and does not infer that an owner declined it. The
absence of prerequisite work means there is no grounded allowlist or route
measurement to activate. Unknown measurements are not zero or a passing result.

Reopen OPT-04 after OPT-01..03 are completed. Then run shadow
evaluation and matched end-to-end trials that include planning, retries, and
failed attempts. Require declared success and quality constraints, resource
tolerances, adequate data coverage, safe fallback for sparse data, unchanged
enforcement/escalation order, and proof that disabling routing restores
baseline behavior. Activate only the measured allowlist that passes those
gates.

## Alternatives considered

- Add a Pipe Broker before a shared consumer is shown: rejected as unsupported
  by the current evidence.
- Build internal deterministic pipelines if a repeated workflow is shown:
  retained as the first option.
- Activate adaptive route choices before their prerequisites and trials:
  deferred because no valid decision evidence exists yet.
- Permanently reject routing: not selected; prerequisites remain unstarted and
  may be completed later.

## Sources

- The M2 resolution states OPT-01..03 were not started and OPT-04 remains
  dependent on later routing work: `docs/m2-audit-resolution.md:1-5`.
- The backlog sets PIP-05's preferred internal pipes and broker evidence gate,
  and OPT-04's shadow/matched-trial gate:
  Phase C table rows PIP-05 and OPT-04 in
  `docs/orchestrator-improvement-backlog.md` (baseline `c6b7e69`).
- `docs/efficiency-comparison.md:74-95` defines a manual trial procedure and
  blank result table; `docs/orchestration-benchmark-plan.md:152-199` defines
  the matched procedure and a result-record example. Neither is trial output.
- CLI operations are exposed as ask, usage, and evidence commands:
  `package.json:5-11`; acceptance checks are repeatable on a new run:
  `src/cli.js:1-2`, `:74-87`; evidence retention and retrieval limits are
  documented at `docs/evidence-artifact-contract.md:110-126`.
