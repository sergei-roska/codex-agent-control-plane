# M0 implementation backlog

All implementation items below are planned, not executed. M0 documentation is
recorded in [README.md](README.md). M1 is the next authorized planning boundary;
this file does not start implementation or grant external publication authority.

## M1 scoped sequence

Each worker receives exact owned paths after a lead inspects the target files.
Suggested surfaces below are modules, not permission to edit every named folder.
Workers never change Git state or protected artifacts. Parallelize only confirmed
independent ownership; integration and dependent decisions stay with the lead.

| ID / state | Deliverable and proposed surface | Dependencies | Acceptance and verification |
| --- | --- | --- | --- |
| M1-01 / complete | Local browser pairing/session module; server integration; focused auth tests | M0 decisions D-09 | One-use expiring code, hashed storage, strict cookie, Host/Origin and rate limits; unauthenticated data inaccessible; A2A auth unchanged |
| M1-02 / complete | Read-only durable projection adapter plus tests; src/durable-store.js only if necessary | M0 contracts | Composite identity, root/standalone vs worker relation, pagination/filter validation; completed never implies human acceptance; no mutation from reads |
| M1-03 / complete | GET /api/dashboard/v1 endpoints with projection integration | M1-01, M1-02 | Context/cards/detail/roles/attempts/usage follow contracts; bounded queries, errors sanitized, API reads cannot dispatch or alter execution |
| M1-04 / complete | Runtime diagnostic event correlation and recovery evidence in runtime/store modules | M0 D-12; coordinate ownership with M1-02 | Durable IDs/sequence, startup/submission/dispatch/completion/error/recovery; exporter/observer failure does not fail execution; no duplicate usage |
| M1-05 / complete | Build/serve independent web/dashboard and integrate polling client | M1-03 | Assets and builds never use writable artifacts path; session expiry/reload/backoff/last-success visible; no secrets embedded |
| M1-06 / complete | Board/sidebar/detail wiring in web/dashboard | M1-05, M1-04 | Real cards/search/roles/counts/attempts/available usage; remove role toggles; no invented nine-role activation, cache/cost or hidden reasoning; unavailable mutations explained |
| M1-07 / complete | Browser/CLI/restart acceptance and lead review | M1-01 through M1-06 | Existing CLI run appears/progresses after reload/restart; failed/input-required/unknown/empty cases truthful; reference manifest unchanged; focused regressions pass |

M1 auth tests are necessary because read access exposes private local task data.
Projection/lifecycle tests should assert meaningful boundaries, not duplicate UI
implementation. Use fake protocol fixtures for reproducible integration checks;
report a real model run separately if deliberately performed.

## Subsequent milestone backlog

| ID / state | Increment | Critical contract/gate |
| --- | --- | --- |
| M2 / complete | Durable direct drafts/revisions/files with migrations, create/edit UI | Save does not execute; duplicate/stale commands; extraction truth and limits |
| M3 / complete | PM Intake, minimum persisted plan, serialized branch ownership, direct execution | One direct feature and bugfix reach evidence-based review; no protected commit/push |
| M4 / complete | Separate nine-role delivery pack, preset registry and real Pipelines | Role capability cases, dependency/scope validation and bounded repair routing |
| M5 / complete | Catalog-backed OpenAI defaults, account health and effective snapshots | New defaults cannot reconfigure active/resumed work; unsupported Fast unavailable |
| M6 / in_progress | Read-only Jira/Confluence Intake into internal tracking | 729 tests pass, zero skips; Gemini fixture QA reports 12/12 PASS; lead directly verifies 390px browser layout; approved live pilots pending; see [M6 acceptance](../m6/acceptance.md) |
| M7 / complete | Guarded operator commands, version-bound review and Git adapter | 782 tests pass, zero skips; two independent audits fixed; fixture browser acceptance incl. commit/push to a bare remote; live OpenAI/real remote not exercised; see [M7 acceptance](../m7/acceptance.md) |
| M8 / complete | Remaining views, cache/quality evidence and bounded MLflow experiment | 846 tests pass; browser flow and local MLflow Tracking readback verified; live prompt comparison 2/2 vs 2/2; production MLflow deferred; see [M8 acceptance](../m8/acceptance.md) |
| M9 / planned | Live pilots, recovery/security checks, packaging and beta review | Exact candidate evidence and owner release authority; no implicit merge/publication |

Resolve owned open choices by their milestone in [decisions.md](decisions.md).
For each implementation ticket retain objective, exact paths, input revisions,
acceptance cases, checks, risks and review evidence. Mark complete only after the
lead reviews actual changes and the appropriate gate passes.
