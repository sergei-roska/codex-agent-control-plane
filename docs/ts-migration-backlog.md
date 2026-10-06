# TypeScript migration backlog

Status: planned, not started, no owner start date. Recorded 2026-10-06 at the
owner's request. Nothing here is implemented. Each package needs its own brief and
acceptance evidence, and the owner decisions below come before TS-1.

## Why

The owner compared this orchestrator against a hypothetical Python build
(Pydantic, FastAPI, DSPy, LangGraph reference). The largest avoidable loss was not
the runtime but the missing type layer:

- The codebase is plain JavaScript (CommonJS) on Node 24.21.0: 0 `.ts` files, no
  `tsconfig`, no JSDoc types, `typescript` is not a dependency.
- Size on 2026-10-06: `src` about 22.4k lines, `test` about 28.1k lines in 75
  files (more test than code, which is what currently compensates for no
  compiler). 226 `require(` calls, 0 `import` statements.
- Hand-written runtime guards in `src`: 540 `typeof` comparisons, 190
  `Array.isArray`, about 300 `throw new Error/TypeError`. Part of this guards
  internal shapes a compiler would check; the part at external boundaries stays.
- Libraries already ship TypeScript types that are currently invisible:
  `@langchain/langgraph`, `@a2a-js/sdk`, `kysely`, `express`. `codex app-server
  generate-ts` emits protocol types.
- The lead verifies worker output by reading; `tsc --noEmit` is a cheap mechanical
  gate for worker briefs.
- Contracts (`src/contracts.js`, `WORKER_REPORT_SCHEMA`) and validators are written
  by hand; Zod can emit type, validation, and JSON Schema from one description.

## What this does not give

Runtime data (LLM output, Codex JSON-RPC, SQLite rows, HTTP bodies) still needs
runtime validation; a type is only a promise there. No speed gain. It does not
unlock DSPy or MLflow optimizers; Python-based integrations stay rejected (see the
[observability backlog](observability-optimization-backlog.md)).

## Feasibility evidence (2026-10-06)

Collected by a worker in a scratch directory outside the repository. These are
worker-reported results, not verified by the lead; TS-1 re-runs them in the repo
before relying on them.

| Check | Result |
| --- | --- |
| `.ts` file doing `require('./b.ts')` in a `commonjs` package, Node 24 type stripping | works |
| `require('./b')` without extension resolving to `b.ts` | fails: `Cannot find module './b'` |
| ES `import` inside a `.ts` file in a `commonjs` package | fails: `Cannot use import statement outside a module` |
| `import x = require()` in `.ts` under type stripping | fails: `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` (and TS1294 under `erasableSyntaxOnly`) |
| `.js` and `.ts` requiring each other in one CJS package | works |
| `enum`, `namespace`, parameter properties under type stripping | fail: unsupported in strip-only mode |
| `node --test x.test.ts` and `--test "*.test.ts"` | works |
| ESM package: `.ts` importing `.ts` with explicit extension | works; named imports from a CJS file fail, default import works |
| `tsc` 7.0.2 over `src/**/*.js`, `allowJs`, `checkJs` on, `strict` off | 78 errors (61 x TS2339); worst files `dashboard-api.js` 24, `codex-app-server.js` 17, `acceptance.js` 8, `a2a-role-service.js` 6, `dashboard-projection.js` 5 |
| Same with `checkJs` off | 0 errors |
| Zod 4.6.5 `z.toJSONSchema(z.strictObject(...))` | emits `additionalProperties: false` and a complete `required` array |

Reading: the existing JS already type-checks far better than expected (78 errors
across 22k lines at `strict: false`), so typed JavaScript is cheap. A real `.ts`
rename in a CommonJS package is the expensive part, because `.ts` files there
cannot use ES imports and `tsc` does not type `require()` in `.ts` files
(hypothesis; the experiment did not settle it, TS-1 checks).

## Decisions (lead, 2026-10-06)

- D1: Two stages. Stage 1 is compiler-checked JavaScript: `tsc` with `allowJs`,
  `checkJs` off globally, and an opt-in `// @ts-check` pragma per file. It changes
  no runtime behavior and renames nothing. Stage 2 (real `.ts` files) is optional
  and gated by an owner decision, see TS-9.
- D2: Opt-in per file is the ratchet. The gate is: every file carrying the pragma
  type-checks clean. New and migrated files carry the pragma; the count only goes up.
- D3: Migrate bottom-up (leaf modules first), so types flow upward and each
  package leaves the tree green.
- D4: No behavior change inside migration briefs. Real bugs found along the way
  go to a findings list in this file and are fixed in separate briefs.
- D5: Zod is adopted only at external boundaries and for contracts. Generated
  JSON Schema must be deep-equal to the current schema, or the lead reviews the
  diff, because structured-output strictness rules are easy to break silently.
- D6: Out of scope: `artifacts/dashboard/**` (immutable reference, excluded in
  `tsconfig`), `web/dashboard/**` and `web/launcher/**` (browser code, separate
  later decision), `data/`, `runtime/`.
- D7: No senior-tier agent is planned. Packages go to `worker-sonnet` with a
  per-module brief; graph and metrics work goes to `worker-haiku`. Take-it-back
  only if a worker fails twice.
- D8: Verification per package: `npm run typecheck` clean plus only the test files
  of the touched modules (never the whole suite), plus a check that
  `artifacts/dashboard/**` is unchanged.

## Status

| ID | Package | Owner tier | Depends on | Status |
| --- | --- | --- | --- | --- |
| TS-0 | This backlog, feasibility experiments, decisions D1-D8 | lead, worker-haiku | - | done (experiments unverified) |
| TS-1 | Tooling: `typescript` and `@types/node` as devDependencies; `tsconfig.json` (`allowJs`, `checkJs` off, `noEmit`, `nodenext`, include `src`, `scripts`, `launcher.js`; exclude `artifacts`, `web`, `data`, `runtime`, `node_modules`); `npm run typecheck`; re-run the table above in the repo; record the full `checkJs` baseline; produce the require graph and bottom-up layers. Done when `npm run typecheck` exits 0 and related tests still pass | worker-sonnet for config, worker-haiku for the graph | owner decisions 1-3 | planned |
| TS-2 | Contracts: express `src/contracts.js` shapes with Zod, emit JSON Schema, prove deep-equality with current `WORKER_REPORT_SCHEMA` and the other emitted schemas, derive types from the Zod schemas for use via `import('zod')` in JSDoc | worker-sonnet, lead reviews schema diff | TS-1 | planned |
| TS-3 | Foundation layer, pragma plus fixes: `durable-store`, `event-journal`, `product-migrations`, `role-pack`, `usage-ledger`, `process-quiescence`, `writer-admission`, `plan-validator`, `permission-profile`, `project-config`, `settings-store`. Exact set from the TS-1 graph | worker-sonnet | TS-2 | planned |
| TS-4 | Stores and projections: `product-store` (2265 lines), `artifact-store`, `role-rules-store`, `ticket-telemetry`, `dashboard-projection` (5 errors) | worker-sonnet | TS-3 | planned |
| TS-5 | Orchestration: `lead-graph`, `lead-orchestrator`, `delivery-controller`, `acceptance` (8 errors), `a2a-role-service` (6), `codex-app-server` (17, add `codex app-server generate-ts` protocol types), `git-adapter`, `git-delivery`, `workspace-snapshot` | worker-sonnet, one brief per file group | TS-4 | planned |
| TS-6 | API and entry points: `dashboard-api` (24 errors), the other `dashboard-*-api`, `integrations/**`, `server`, `launcher-*`, `cli`, `scripts/**`, `launcher.js` | worker-sonnet | TS-5 | planned |
| TS-7 | Tests: opt test files into the pragma where it pays (shared fixtures first); no mass edit of 28k lines | worker-sonnet | TS-6 | planned |
| TS-8 | Strictness ratchet: `noImplicitAny` then `strictNullChecks`, per area, new files strict from day one | worker-sonnet | TS-6 | planned |
| TS-9 | Optional, owner decision: real `.ts` files. Either convert to ESM (touches 226 `require` sites, `__dirname`, test mocking), or keep CJS with the erasable `typeof import()` typing pattern in `.ts` files. Decide after TS-1 evidence and the TS-6 outcome | lead decision, then worker-sonnet | TS-8 | planned |

Order is by dependency, not calendar. No estimates are recorded; the first brief
sizes the rest.

## Open owner decisions

1. When to start. The beta release candidate awaits publication, and a pilot
   ticket costs roughly 0.2-1.1M tokens, so migration workers compete for the
   same quota. Suggested: after the beta is published and the CDB pilot closes, on
   its own branch (branch creation needs the owner because hooks block it).
2. Is compiler-checked JavaScript (TS-1 to TS-8) enough, or are real `.ts` files
   required (TS-9)? The lead's default is to stop after TS-8 unless a concrete
   gain appears.
3. Zod as a new runtime dependency (7 direct dependencies become 8).

## Findings list

Empty. Real defects found during migration are recorded here with file and line,
not fixed inside migration briefs (D4).
