---
name: investigate-before-asking
description: MUST load before calling AskUserQuestion, or before writing any blocking/clarifying question to the user in chat — including EN cue phrases ("should I", "which do you prefer", "do you want", "which one", "is that right") and RU cue phrases ("не уверен", "уточните", "какой вариант", "подскажите"), or any turn that would otherwise end waiting on a reply. Forces a cheap, tool-call-bounded investigation of the repo (grep, config/manifest files, git log/blame, existing tests, analogous files, project docs) so the agent answers its own question instead of blocking the user. Applies to every agent and subagent, including ones spun up with fresh/clean context that have no memory of this rule.
---

# Investigate before asking

You are about to block on the user — via `AskUserQuestion` or a chat message that ends the turn waiting on a reply. Before you do, run this gate: a cheap, bounded investigation that tries to answer your own question first.

## Decisions (frozen)

- Reversibility is checked on **the action gated by the missing fact**, not on the question's surface category.
- Every investigation-loop source resolves to **RESOLVED / PARTIAL / NO_MATCH** per source. This is separate from the final two-way provenance label, **SOURCED / ASSUMED**, attached to the answer as a whole.
- **RESOLVED threshold**: unanimous agreement among matches when fewer than 5 hits exist; ≥80% agreement when 5+ hits exist. Anything short of that is PARTIAL. Zero relevant hits is NO_MATCH. Log hit count and agreement ratio per source.
- The budget is a **tool-call count** (default 5, overridable by the caller), not wall-clock time. Any "~2-3 minutes" language elsewhere is soft color commentary only, never the actual limit.
- **Outer-turn budget interaction**: before starting the loop, check remaining outer-turn tool-call headroom. Cap the loop to `min(default budget, headroom)`. If headroom is 0, skip the loop entirely and go straight to `ASK_WITH_INVESTIGATION_FINDINGS` with reason "turn budget exhausted, no investigation possible" — never `ASK_IMMEDIATELY`, since that would falsely imply investigation was deliberately skipped rather than impossible.
- **Pre-classification probe (mandatory, not implicit)**: no question may be finalized into a `USER_CALL_*` category until one cheap existence check has been run against whichever ranked source is most plausibly relevant to the question's domain (e.g. a config/design-tokens file for an aesthetic question, `package.json`/lockfile for a tooling question). Only classify as `USER_CALL_*` if that probe returns NO_MATCH.
- **Reversible/low-impact test** (all four must hold; if any is false or unknown, treat as irreversible/high-impact and fail closed to ASK):
  1. Effect confined to files/state inside this repo/workspace — no external API calls, no data sent outside the repo, no irreversible infra/deploy action.
  2. Fully undoable by editing/re-running the same file(s) again (a follow-up edit or `git revert` suffices).
  3. No other party (another agent, a deployed service, an end user, CI) can have already observed or built on the result before the agent's next checkpoint.
  4. Blast radius limited to code the agent itself just wrote in this task, not shared/production config or other people's in-flight work.
  Log which sub-criteria held.
- On any `PROCEED_*` outcome, the one-line disclosure (source pointer, or "no existing convention found") is mandatory — never omit it.

## Trigger & Activation

- **T1 (grounded)**: any call to the `AskUserQuestion` tool. Load this skill first, every time, no exceptions.
- **T2 (operational extension, not independently verified — see Design notes)**: any free-text chat turn that functions as a blocking clarifying question, including the EN/RU cue phrases in the frontmatter description. Treat T2 as best-effort coverage, not a guarantee (see Known limitations).
- Applies to every agent and subagent in a pipeline, including ones started with fresh/clean context — they have no memory of this rule, so it must be loaded fresh each time they are about to ask.

## Execution Algorithm

1. **parent_supplied_answer short-circuit** — if the parent/orchestrator context already supplied this fact, use it: provenance SOURCED, outcome `PROCEED_WITH_SOURCED_ASSUMPTION`, stop.
2. **Pre-classification probe** — run exactly one tool call against the single ranked source most relevant to the question's domain (see the ranked list in step 6). Log RESOLVED / PARTIAL / NO_MATCH. This consumes the first slot of the step-6 budget.
3. **Classify**: `USER_CALL_IRREVERSIBLE_ACTION` / `AESTHETIC_PREFERENCE` / `CONFLICTING_INSTRUCTIONS` / `BUSINESS_DECISION` / `OTHER` / `INVESTIGABLE`. A `USER_CALL_*` category may only be finalized if the step-2 probe returned NO_MATCH. If the probe returned RESOLVED or PARTIAL, classify as `INVESTIGABLE` regardless of how "subjective" or "business" the question sounds on its face.
4. Any finalized `USER_CALL_*` → `ASK_IMMEDIATELY`, stop. No further investigation.
5. `INVESTIGABLE` → state the `missing_fact` in one sentence (skip if step 2 already stated it).
6. **Ranked loop** over sources not already consumed in step 2 — `reread_request`, `grep_repo_pattern`, `config_manifest_files`, `existing_tests`, `git_log_blame`, `nearest_analogous_file`, `project_docs`, in that order — 1 tool call per source, stop at the first RESOLVED or when the capped budget (per Decisions) or the list is exhausted.
7. **Provenance**: resolved-with-a-pointer → SOURCED; anything else (PARTIAL/NO_MATCH on every source tried) → ASSUMED.
8. **Reversibility test** (Decisions, above) applied to the action gated by the missing fact.
9. **Branch**:
   - SOURCED → `PROCEED_WITH_SOURCED_ASSUMPTION`.
   - ASSUMED + reversible/low-impact (per step 8) → `PROCEED_WITH_ASSUMED_ASSUMPTION`.
   - ASSUMED + irreversible/high-impact (per step 8), or zero signal found → `ASK_WITH_INVESTIGATION_FINDINGS`.
10. Emit output per the format below.

## Output & Disclosure Format

- `PROCEED_WITH_SOURCED_ASSUMPTION` / `PROCEED_WITH_ASSUMED_ASSUMPTION`: one-line disclosure, then proceed. `"Using <choice>, matching <file:line>/<config>/commit <sha>."` or, if genuinely unsourced, `"No existing convention found; picking <choice>."` Never phrase an ASSUMED choice with SOURCED-level confidence.
- `ASK_WITH_INVESTIGATION_FINDINGS`: a short "what was checked" preface before the question, e.g. `"Checked <sources>; found <A> in <file> vs <B> in <file>, no tiebreaker."`
- `ASK_IMMEDIATELY`: no investigation preamble — the question was never investigable in the first place.

## Worked examples

1. **Testing framework** — question: "which test framework should I use for this new file?" Probe/step 6 hits `package.json` with `vitest` already a dependency and existing `*.test.ts` files. → RESOLVED, SOURCED → `PROCEED_WITH_SOURCED_ASSUMPTION`: "Using vitest, matching `package.json` and the existing `*.test.ts` files."
2. **Helper naming** — "should this be `formatDate` or `toDateString`?" No config/test settles it; the nearest analogous file has only 2 similar helpers, both `formatX`-named — below the 5-hit threshold for a clean RESOLVED, so this stays PARTIAL → ASSUMED. The action (renaming a local, just-written helper) is reversible under all four criteria → `PROCEED_WITH_ASSUMED_ASSUMPTION`: "No config settles this; using `formatDate` to match the `formatX` pattern in `date-utils.ts` (thin signal — 2 examples)."
3. **dayjs vs moment** — repo has both dayjs and moment imported in different modules, no discernible rule. Loop finds CONFLICTING signal → NO tiebreaker → ASSUMED, and picking wrong could ripple through a shared date layer (fails reversibility criterion 3/4) → `ASK_WITH_INVESTIGATION_FINDINGS`: "Checked imports repo-wide: dayjs used in `src/orders/*`, moment in `src/billing/*`, no stated preference. Which should the new `src/shipping` module use?"
4. **Force-push** — "should I force-push to overwrite the remote branch?" Step 2 probe (e.g. checking a branch-protection/CI policy file) returns NO_MATCH or is irrelevant — this is `USER_CALL_IRREVERSIBLE_ACTION` regardless, since no repo artifact can authorize discarding another party's commits → `ASK_IMMEDIATELY`, no investigation preamble.
5. **Button color, with design tokens (fixed-ordering case)** — "what color should this button be?" looks like `AESTHETIC_PREFERENCE` on its face. Under the *old, buggy* ordering this short-circuited straight to `ASK_IMMEDIATELY` without ever checking the repo. Under the *fixed* ordering: step 2 probe checks for a design-tokens/theme file first, finds `tokens/colors.json` with a `primary` token used by every other button in the codebase → RESOLVED, so step 3 classifies this as `INVESTIGABLE`, not `USER_CALL_*` → SOURCED → `PROCEED_WITH_SOURCED_ASSUMPTION`: "Using `colors.primary` (`tokens/colors.json`), matching every other button in the app."
6. **Auth library, with package.json (fixed-ordering case)** — "which auth library should I use?" also reads as a `BUSINESS_DECISION`/tooling call on its face. Step 2 probe checks `package.json` first, finds `passport` already installed and wired into `src/auth/*` → RESOLVED → step 3 classifies `INVESTIGABLE` instead of `BUSINESS_DECISION` → SOURCED → `PROCEED_WITH_SOURCED_ASSUMPTION`: "Using passport, matching the existing `src/auth/*` setup and the `package.json` dependency."

## Design notes

This skill practices the SOURCED/ASSUMED discipline it preaches. What's genuinely grounded, and what's invented scaffolding needed to make an executable gate out of one sentence of source material ("Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults."):

- **Grounded / frozen**: the T1 `AskUserQuestion` trigger itself, and the four Decisions carried over unchanged from the Contract Specifier stage (reversibility checked on the action not the category; per-source RESOLVED/PARTIAL/NO_MATCH kept separate from SOURCED/ASSUMED provenance; tool-call-count budget, not wall-clock; mandatory one-line disclosure on every `PROCEED_*`).
- **Invented for operability (ASSUMED, not SOURCED)**: the specific 7-item ranked source list and its order; the T2 free-text chat-trigger scope and the EN/RU cue-phrase lists; the claim that this applies uniformly to subagents with fresh context; the `parent_supplied_answer` short-circuit mechanism; and the exact `USER_CALL_*` taxonomy used for the non-firing exclusion categories. None of these were derived from source material — they were built to turn one sentence of intent into something an agent can actually execute, and are disclosed as such rather than stated with unearned confidence.

## Known limitations

T2 (the free-text chat trigger) is a self-triggered skill-listing mechanism, not a hook-enforced check. It relies on the agent recognizing its own cue phrases before writing a blocking question. A paraphrase outside the cue list (e.g. "sound good?") carries a real, inherent false-negative risk — the gate simply won't fire. This is a known gap, not something the cue list claims to fully cover.

## Anti-patterns this skill exists to stop

- Asking "which testing framework should I use?" when `package.json` already has one installed.
- Asking "what should the error message say?" when 5 other error messages in the file follow a clear format.
- Asking "should this be async?" when every sibling function in the file is already async.
- Asking a *fresh subagent's* question that the parent/orchestrator context already answered — check task instructions and any provided context first.
- Treating a question as `USER_CALL_*` (aesthetic/business/tooling-sounding) without first running the pre-classification probe — a repo-resident answer (design tokens, an installed library) can hide behind subjective-sounding phrasing.

## Definition of Done (Executability self-check)

Binary checklist — every item must hold before emitting an outcome:

1. Pre-classification probe run before any `USER_CALL_*` classification is finalized.
2. `USER_CALL_*` finalized only when that probe returned NO_MATCH.
3. `missing_fact` stated in one sentence before the investigation loop starts.
4. Loop capped at `min(default budget, remaining outer-turn headroom)`, checked before the loop starts.
5. Headroom = 0 routes to `ASK_WITH_INVESTIGATION_FINDINGS` (reason: turn budget exhausted) — never `ASK_IMMEDIATELY`.
6. Each source tried is logged as RESOLVED / PARTIAL / NO_MATCH with hit count and agreement ratio.
7. RESOLVED threshold applied correctly (unanimous when <5 hits, ≥80% when 5+ hits).
8. Provenance (SOURCED / ASSUMED) is a separate label from the per-source RESOLVED/PARTIAL/NO_MATCH results.
9. Reversibility 4-part test applied and its held/failed sub-criteria logged; any false or unknown criterion fails closed to ASK.
10. Every `PROCEED_*` output carries the one-line disclosure naming a source/pointer, or explicitly states "no existing convention found."
11. Every `ASK_*` output states what was checked; no ASSUMED content is phrased with SOURCED-level confidence anywhere in the output.

## Open questions

- Whether the 7-item ranked source list's ordering is optimal across domains (e.g. should `existing_tests` outrank `config_manifest_files` for behavior questions?) has not been empirically validated — treat the order as a reasonable default, not a proven optimum.
- The EN/RU cue-phrase list for T2 is not exhaustive and has no mechanism for extension by users of other languages; expanding it is a candidate follow-up if false negatives prove common in practice.
