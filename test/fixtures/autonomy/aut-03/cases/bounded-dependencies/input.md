# Synthetic case: bounded dependencies

Status: synthetic candidate input; not independently reviewed.

## Owner goal

Add a CSV export to the existing monthly usage report. The export must include
account ID, period start, period end, and total units. Keep the existing report
view and JSON endpoint behavior unchanged.

## Canonical requirements

- R1: The CSV contains the four fields in the order listed in the owner goal.
- R2: Period dates use ISO 8601 calendar dates (YYYY-MM-DD).
- R3: The export uses the same authorization check as the existing report view.
- R4: The JSON endpoint response and existing report view remain unchanged.
- A1: A CSV with one authorized account and the four required fields is
  downloadable from the report page.
- A2: A user without report access cannot download the CSV.

## Scope constraints

- Writable paths: `src/report-export.js`, `test/report-export.test.js`.
- Forbidden paths: `src/report-view.js`, `src/report-api.js`, all files under
  `migrations/`.
- No database schema change, new dependency, or change to account authorization
  policy is permitted.

## Source facts

- `src/report-view.js` exposes `getMonthlyReport(accountId, period)` and calls
  `canViewReport(user, accountId)` before loading report data.
- `src/report-api.js` returns the existing JSON shape
  `{ accountId, period, totalUnits }`.
- `test/report-view.test.js` has coverage for the authorization helper and
  monthly report values. It is read-only for this task.
- `test/report-api.test.js` has coverage for the existing JSON response shape.
  It is read-only for this task.
- The available source inventory does not identify the report-page route,
  component, template, or other integration point that initiates a download.
  No additional page integration path is approved as writable.

## Required checks and evidence

- C1: `npm test` must pass. The package script runs
  `node --test test/*.test.js`.
- C2: Add focused export tests for field order, date format, and denied access.
- C3: Preserve existing report-view and JSON endpoint behavior; their existing
  regression tests remain read-only and must pass as part of C1.
- E1: Read-only diff showing only the two writable paths changed.
- E2: Test output for C1, including the existing report-view and JSON endpoint
  tests.

## Planning rule

The requirements and source facts above are the complete planning input. The
report-page integration point is intentionally unknown. Do not assume an
unlisted writer, check, migration, approval, or product behavior. Keep A1 and
any dependent implementation work blocked until a source-backed integration
point within the approved scope is identified; stop if resolving it requires
scope expansion.
