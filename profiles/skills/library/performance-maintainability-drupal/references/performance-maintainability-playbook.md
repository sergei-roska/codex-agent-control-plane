# Performance and Maintainability Playbook for Drupal

## Scope Discovery

- Identify symptoms: slow pages, high query counts, large assets, cache misses.
- Map affected layers: backend services, entity/query paths, Twig/rendering, frontend pipeline.

## Cache Strategy Checks

- Validate cache contexts/tags/max-age alignment with data variability.
- Detect over-broad invalidation and unnecessary cache clears.
- Ensure cacheability metadata is propagated in render arrays.

## Query and Load Hotspot Checks

- Detect repeated entity loads and N+1 patterns.
- Detect expensive queries in frequently hit paths.
- Prefer targeted preloading/batching over repeated single-item lookups.

## Render and Theme Pipeline Checks

- Review Twig/template complexity in critical paths.
- Review library attachment and duplicate asset inclusion.
- Ensure compiled assets are updated and delivery-friendly.

## Maintainability Checks

- Flag high-complexity classes/functions that block safe iteration.
- Flag duplicated logic across modules/themes.
- Recommend low-risk extraction or simplification steps.

## Output Contract

- Bottlenecks with evidence and impacted area.
- Optimization list with impact/effort rating.
- Safe implementation order and rollback notes.
- Verification plan with measurable success criteria.
