# AUT-05 metric definitions

Status: metric definitions for corrected AUT-05 cohort v2. Baseline acceptance
is recorded separately in [the AUT-05 review](aut-05-review.md). Parent:
[AUT-05 runbook](aut-05-baseline-runbook.md).
Updated: 2026-10-15.
Metric definitions version: `aut-05-metrics/v1`.

These definitions are frozen for corrected cohort v2. The submitted v1 draft
was rejected and is not a comparable accepted cohort. Changing a metric's
semantics, unit, denominator, or availability rule for an accepted cohort
creates a new metric-definition version and a new comparison cohort; it never
silently reinterprets an existing baseline.

## 1. Reporting contract

Every reported ratio carries, at minimum:

- `metricId`: stable slug from section 2.
- `value`: the measured quantity, or `null` when unavailable for the declared
  scope. A numeric zero is valid only when directly observed.
- `unit`: one of `ratio`, `count`, `milliseconds`, `tokens`,
  `currency_per_accepted_result`.
- `availability`: `measured`, `derived`, `partial`, or `unavailable`.
- `sourceRef`: reference to the exact observation/run/task/attempt/checkpoint
  and evidence artifact the value was computed from.
- `missingReason`: human-readable reason, required when `value` is `null` and
  recommended when `availability` is `partial`.
- For every ratio, `numerator`, `denominator`, and
  `excludedIncompleteCount` are recorded explicitly alongside the value.
- `observationMode`: the corpus case's declared evaluation mode
  (`offline_contract`, `artifact_assessment`, `historical_observation`,
  `live_workflow`) that produced this value.

An attempt-time sum is not wall-clock elapsed time for parallel work. A numeric
derived total is always labeled `derived` with its formula. Absence is `null`,
never `0`.

Counts and token quantities are non-negative safe integers. Ratio values are
finite and within `[0, 1]`; numerator, denominator, and excluded count are
explicit safe counts whenever a ratio is measured. An unavailable ratio has a
null value and null count fields with a missing-data reason.

## 2. Metric catalog

Stable metric IDs. Do not rename these.

| `metricId` | unit | Definition and boundary |
|---|---|---|
| `requirement_preservation` | `ratio` | Reviewed required requirement/constraint IDs satisfied by the observed artifact divided by all mandatory IDs. List every missing/violated ID. Numerator may be 0. Denominator is the independently reviewed mandatory inventory, never the artifact's own claims. |
| `first_pass_accepted_checkpoints` | `ratio` | Checkpoints whose first candidate obtained the complete required current-target review sequence without repair, divided by checkpoints with a fully observed first-review outcome. Checkpoints missing first-attempt evidence are excluded and listed in `excludedIncompleteCount`. |
| `accepted_results` | `count` | Results with all required deterministic checks and matching current-target acceptance evidence. A completed task status alone is insufficient. |
| `repair_cycles` | `count` | Distinct observed failed-review-to-candidate-repair sequences. Report underlying assignment/candidate IDs, not objective hashes or raw round numbers. |
| `review_cycles` | `count` | Distinct observed candidate/checkpoint review sequences. Verifier and auditor steps and retry attempts stay separately visible. |
| `owner_escalations` | `count` | Unique durable owner-input decisions. Deduplicate retries/polls; retain the reason and decision ID. A permission denial is not an escalation unless an actual owner decision was requested. |
| `elapsed_time` | `milliseconds` | Wall time from declared cohort/case start to terminal result. Report pause handling and incomplete intervals; an incomplete interval is not a measured total. |
| `tokens` | `tokens` | Observed input/cached/output/reasoning/total fields with per-field source coverage. Never add cached input to input again. |
| `measured_cost_per_accepted_result` | `currency_per_accepted_result` | Total measured cohort cost, including failed attempts, divided by accepted results. Requires complete compatible cost coverage and a nonzero denominator; otherwise `null`. |

## 3. Denominator and null rules

- A metric with no eligible denominator returns `null` with an explicit reason,
  not zero or infinity.
- For `first_pass_accepted_checkpoints`, the cohort is defined before scoring.
  Checkpoints with missing first-attempt evidence are excluded from the
  denominator and reported. Omitting hard cases to raise a ratio is forbidden.
- For `accepted_results`, the denominator context is the full eligible cohort,
  including failed and incomplete attempts. Failed attempts remain in cohort
  costs and repair history.
- Duplicate observation/attempt IDs must not inflate either numerator or
  denominator. Duplicates are rejected at ingestion, not deduplicated silently.

## 4. Cost semantics

- Subscription monetary cost stays `null` for this milestone unless another
  actual measured-spend source is supplied and validated.
- Hypothetical API prices may appear in a separate field with their own pricing
  version. They cannot fill `measured_cost_per_accepted_result` or justify a
  savings claim. Partial cost cannot become a complete cost-per-result metric.

## 5. Token semantics

The `tokens` metric is recorded as a structured `tokenBreakdown` rather than a
single scalar. Each token field carries its own value and coverage:

- `input`, `cachedInput`, `output`, `reasoningOutput`, `total`: each is
  `{ value, coverage }` where `coverage` is `measured`, `derived`, or
  `unavailable`. `cachedInput` is a separate field and is never added to
  `input`.
- `derived`: true when `total` was computed by addition, false when it was
  observed directly.
- `formula`: the exact formula when `total` is `derived`; otherwise null.

The derived total formula, when applicable, is `total = input + output`
(reasoning output is already included in `output` by the source). If the source
already records `total`, it is used as `measured` (`derived: false`, no formula).
Any derived total must equal input plus output. Cached input is a separate
subset and is never added a second time.
A field absent from the source is `coverage: "unavailable"` with a null value.
When no token data exists for an observation, the `tokens` metric `value` and
`tokenBreakdown` are both null with `availability: "unavailable"`.

## 6. Provenance

Every metric value references the observation(s) it was computed from by
`observationId`, and, where applicable, `runId`, `taskId`, `assignmentId`,
`attemptId`, and `checkpointId`. An expected golden outcome is never recorded as
an observed metric value; the oracle says what should happen, the observation
records what happened.

For `requirement_preservation`, `sourceRef` must point to the verified,
independently reviewed reviewer-assessment artifact, whose score must match the
metric fields. The artifact assessment and its mandatory semantic inventory are
both pinned local inputs. The evaluator rejects non-null measurements for
metrics it cannot compute in the declared offline scope. Case-oracle passes
and current-target accepted results are separate: `accepted_results` remains
null unless its strict definition has matching current-target acceptance
evidence.
