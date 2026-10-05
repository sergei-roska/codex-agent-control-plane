---
name: drupal-views-safe-edit
description: MUST load before editing any Drupal Views config (views.view.*) or a block/page rendered by a view. Enforces a blast-radius procedure — locate where the target setting actually lives (default display vs override), override before editing, verify by diff — so a single-display change never leaks into sibling displays. Also applies to other inherited Drupal config (field storage vs field instance, display modes).
when_to_use: Any task that will modify a views.view.* object or a view-rendered block. Triggers — "измени/поправь вьюшку", "блок который создаётся вьюшкой", "фильтр/поля/сортировку во вьюшке", "edit the view", "change the view block", "views filter/fields/sort". Load BEFORE opening the config.
---

# Drupal Views: safe editing

A change requested for ONE display must change ONLY that display. Views displays inherit settings from the default (master) display, so an unchecked edit lands in `default` and silently changes sibling displays. Follow the procedure below for every Views edit, however small. Background on the inheritance model: [inheritance.md](inheritance.md).

## Procedure

### 1. Pin the exact target display

- Task names a block on a page → map it to a display: `mcp__drupal-render__inspect_blocks_and_regions` (plugin id `views_block:VIEWNAME-DISPLAYID`), or grep `block.block.*` config.
- Task names a view → still confirm the display ID (`block_1` / `block_2` / `page_1`). Ambiguous which display → ask the user; do not guess.

### 2. Locate where the setting lives

- Read the object: `mcp__drupal-config__inspect_config_object` with `config_name: views.view.<name>` (fallback: `drush cget views.view.<name>` or the sync YAML).
- Enumerate ALL displays under `display:` — never assume a view has one block.
- Find the target setting: under `display.<target>.display_options` → already overridden, edit in place. Only under `display.default.display_options` → inherited, go to step 3.

### 3. Scope the edit

- **Ambiguity gate:** if the setting is inherited and the task wording allows both readings ("change the view's filter" — this display only, or the view as a whole?), do NOT pick a scope yourself. Tell the user what you found (setting lives in `default`, N displays inherit it) and ask which scope they mean. Proceed only after confirmation.
- Single-display task + setting inherited → **override first**: copy the relevant `display_options` section from `default` into the target display, then change it there. Never edit `default` for a single-display task.
  - Overrides are per-section: `filters` / `fields` / `sorts` override as a whole block, not per item. Copy the full section, then modify.
- Whole-view task → editing `default` is correct; state which displays this affects before proceeding (siblings with their own override are NOT affected).

### 4. Edit minimally

Config-level edits (sync YAML + import, or `drush cset`). Touch only the keys the task requires.

### 5. Verify blast radius — hard pass condition

- Diff the whole config object before/after (`mcp__drupal-config__diff_active_vs_sync` with `include_patch: true`, or a file diff).
- **Pass:** diff touches keys only under `display.<target>`. Any change under `display.default` or a sibling on a single-display task → revert, redo via override.
- Report which display changed and that siblings were verified unchanged.

## Same rule beyond Views

Before editing any config object with multiple consumers, run the same locate → scope → verify loop:

- `field.storage.*` (shared across bundles) vs `field.field.*` (per bundle) — "change the field on Article" almost never means storage.
- Display/form modes shared across bundles.
- Check consumers with `mcp__drupal-config__trace_config_dependencies` (`direction: required_by`) or `find_config_owner`.

## Anti-patterns

- Editing `display.default` "because that's where the setting was" without checking siblings.
- Verifying by re-reading only the target display — the pass condition is a diff of the whole object.
- Skipping the procedure for one-line edits; leaks are size-independent.
