# Synthetic case: contradictory source blocker

Status: synthetic candidate input; not independently reviewed.

## Owner goal

Add a downloadable CSV export for monthly reports.

## Canonical product requirement

- R1: The CSV must include account ID, period start, period end, and total units.
- R2: The CSV must include the account's email address.
- A1: A user with report access can download the CSV.

## Source control conflict

Both source documents below are included in this case and marked current and
owner-approved. They have the same authority and neither supersedes the other.

- `product-security-policy.md`
- `product-report-requirements.md`

The owner has not provided a resolution. No precedence rule is stated.

## Scope constraints

- Writable paths: `src/report-export.js`, `test/report-export.test.js`.
- Forbidden paths: `src/identity.js`, `security/`, `migrations/`.
- No policy change or personal-data scope expansion is authorized.

## Required checks and evidence

- C1: `npm test -- --runInBand` must pass after implementation.
- E1: Evidence must show the approved field list and bounded diff.

## Planning rule

The two approved source statements are contradictory. Do not choose one, omit
the disputed field silently, or infer precedence. Stop affected planning and
request an owner resolution before implementation tasks can be dispatch-ready.
