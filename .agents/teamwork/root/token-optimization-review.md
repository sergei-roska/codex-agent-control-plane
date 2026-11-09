# Token optimization review

Updated: 2026-10-13
Run: a125b4c6-f640-45ae-a106-22f97837f8e9

## Evidence

- Read-only usage report at 2026-10-13 20:35 UTC: 363 rows, 355 turns, 349
  rows with known token data, and 14 unknown rows. Known totals: 204,700,914
  input tokens, 188,258,816 cached input tokens, and 1,994,405 output tokens.
  Cost is null because this is subscription usage.
- Workers account for 165,492,779 input tokens, about 81% of total; 94% of
  their input is cached.
- Largest assignments include completed r17:a0 recovery-engineer
  (11,362,479 input, zero retries) and r66:a0 engineer (10,476,201 input,
  zero retries). These are cumulative per-assignment totals, not single-prompt
  sizes. No prompt contents were read.
- `src/codex-app-server.js:894-925` calculates ledger tokens from the delta in
  thread totals. It cannot attribute model requests one-to-one; `modelRequests`
  remains null. Worker `contextTokens` and `contextWindow` are transient and
  are not persisted in `usage_ledger`.
- Existing controls already bound old worker outcomes, project oversized text
  to evidence references, use delta prompts for continuing lead threads, and
  use bounded digests after a rollover.
- Official OpenAI docs say cached tokens remain part of input and count toward
  API tokens-per-minute limits; a high cache percentage does not by itself
  measure savings on the total task. See the [observability guide](https://developers.openai.com/api/docs/guides/agents-api/observability)
  and [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).
- Read-only usage snapshot at 2026-10-13 20:51 UTC: 370 rows, 356 rows with
  known token data, and 14 unknown rows. Known totals: 210,320,223 input tokens
  (193,344,128 cached) and 2,054,399 output tokens. The usage report measures
  subscription use, so measured monetary cost remains null.
- Applying the official Standard API short-context rates as a counterfactual
  gives $34.48 USD: gpt-6.1-sol at $2/$0.10/$10 and gpt-6-luna at
  $0.10/$0.01/$0.50 per million input/cached-input/output tokens. The estimate
  covers 356 rows and omits 14 rows without token data. It is not the Codex
  subscription charge. Source: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).
- Coordinator accounts for about $20.97 and auditor about $10.37 of that
  short-context estimate (about 91% combined); engineer about $1.33. A
  same-volume scenario with no cached input would be about $169.52, showing
  about $135.03 of hypothetical cache-rate discount. This compares rates, not
  token reduction or measured subscription savings.
- The API page applies higher rates to an individual prompt above 272K input
  tokens. This ledger stores cumulative thread-total deltas and
  `modelRequests` is null, so it cannot identify the number or size of model
  requests. Applying long-context rates to every known token gives $65.46 as
  an illustrative stress scenario, not a reliable upper bound or expected bill.
- Source inspection: `src/role-catalog.js:134-169` inlines the full team rules
  into role profiles that reference them, and `createLeadRole` includes the
  complete rule file. `src/codex-app-server.js:754` appends shared skill and
  reading boundaries to every role. This is a candidate for careful static
  instruction deduplication, not proof of waste; these rules are policy and
  must remain intact. Since cached prefixes are cheap, reducing dynamic
  coordinator/auditor state is more likely to reduce API cost than trimming
  cached policy text. This is a hypothesis, not measured savings.
- Lead session context sample at 2026-10-13 20:54 UTC: `session_threads`
  records the latest request at 76,409 input tokens of a 475,000-token window
  and 11 rollovers. This is 16.1% of the current window and does not indicate
  immediate context pressure. It is only the most recent request, not a history;
  worker context size is not persisted.

## Decision

Do not lower worker reasoning effort, remove verifier/auditor assignments, or
change rollover policy based on these totals. They do not prove wasted context,
and these changes could reduce correctness or conflict with session continuity.
Preserve all review and writer gates. The 94% worker ratio shows substantial
cache reuse, not 94% fewer tokens. API rates can price a counterfactual, but the
report's subscription basis still has no measured monetary cost.

Optimization hypothesis: first inspect coordinator and auditor instruction
composition because they account for about 91% of the Standard API estimate.
Then run a reversible, one-role pilot that shortens only duplicated general
instructions. Compare input-token deltas per completed, similar assignment,
elapsed time, outcomes, rework, permission denials, and review acceptance.
Establish a baseline before changing instructions. If worker context
saturation is the specific concern, first persist the last or peak worker
context size and context window, since current worker ledger rows do not contain
them. Do not modify or reload the active runtime while the current orchestrator
run is using it; stage a prompt pilot for a safe runtime transition.

Status: investigation complete; no runtime or role-profile changes made.
