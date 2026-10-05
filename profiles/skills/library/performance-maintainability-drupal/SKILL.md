---
name: performance-maintainability-drupal
description: Improve Drupal performance and maintainability with production-safe recommendations. Use when tasks involve cache strategy, slow query/load paths, render/theme asset pipeline issues, code complexity cleanup, or pre-release performance risk analysis.
---

# Performance Maintainability Drupal

## Overview

Find and prioritize bottlenecks in Drupal code/theme layers while preserving release safety.
Use this skill when the goal is measurable performance improvement with maintainable architecture.

## Workflow

1. Scope performance surfaces.
Identify whether the issue is cache behavior, query/load pressure, render pipeline, asset delivery, or code maintainability debt.

2. Collect evidence.
Use profiling signals, query hotspots, build/runtime observations, and template/library loading paths.

3. Classify root cause.
Separate symptoms from causes, then map each to cache, query, rendering, asset, or complexity category.

4. Propose safe optimizations.
Prefer low-risk, high-impact changes first, then staged follow-ups for deeper refactors.

5. Define verification.
Specify measurement points, success thresholds, and rollback conditions.

## Optimization Categories

### Cache Strategy

- Validate `#cache` tags/contexts/max-age alignment with actual data variability.
- Detect over-broad cache invalidation (e.g., clearing all caches instead of specific tags).
- Ensure cacheability metadata bubbles correctly through render arrays.
- Use `#lazy_builder` for personalized/uncacheable fragments inside cached pages.
- Use BigPipe placeholders for user-specific content (cart, login state) on otherwise cacheable pages.

### Query & Entity Load

- Detect N+1 patterns: repeated `Node::load()` in loops → use `loadMultiple()` or preloading.
- Detect expensive queries in frequently hit paths (Views with complex filters, uncached entity queries).
- Prefer targeted entity queries with `->range()` over loading all results.
- Use Views caching (tag-based or time-based) for listing pages.

### Render & Twig Pipeline

- Minimize Twig template complexity on critical paths.
- Avoid heavy PHP processing inside `hook_preprocess_*` — move to services.
- Review `#attached` library usage for duplicate or unnecessary JS/CSS loading.

### Frontend Assets

- Ensure CSS/JS aggregation is enabled in production (`system.performance` config).
- Verify compiled theme assets are up to date and not re-compiled at runtime.
- Use `defer` or `async` for non-critical JS where possible.
- Check for duplicate library attachments across components.

### Maintainability

- Flag high-complexity classes/functions that block safe iteration.
- Flag duplicated logic across modules/themes.
- Recommend low-risk extraction or simplification steps.

## Anti-Patterns

- Premature micro-optimizations without measured bottleneck evidence.
- Cache disabling (`max-age: 0`) as a workaround for correctness issues.
- Using `\Drupal::entityTypeManager()->getStorage()->loadMultiple()` without access checks in public-facing paths.
- Large refactors without staging or rollback strategy.
- Asset pipeline changes without verifying compiled outputs and delivery behavior.
- Clearing all caches (`drush cr`) as a "fix" for performance issues.

## References

- Read `references/performance-maintainability-playbook.md` for detailed checks.
- Read `references/dry-run.md` for a worked analysis example.
