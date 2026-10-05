# Views display inheritance — the model behind the procedure

Why edits leak between displays, and how the storage actually works.

## Default display and inheritance

Every view has a **default display** (`display.default`, "Master" in older UIs). All other displays — `block_1`, `block_2`, `page_1`, feeds, attachments — inherit their settings from it. A view with "2 blocks" therefore has at least **three** display entries in config: `default`, `block_1`, `block_2`.

Nearly every display-level setting exists in one of two states:

- **Inherited** — stored only in `display.default.display_options`. The UI shows the selector as "For: **All displays**".
- **Overridden** — a copy stored in `display.<id>.display_options`. The UI selector reads "For: **This block (override)**".

Rendering resolves a setting by checking the display's own `display_options` first, falling back to `default`.

## Why the classic mistake happens

The task says "change block 1", but if the setting is inherited, its only storage location is `display.default`. An agent (or human) who edits "where the setting is" edits `default` — and every non-overriding sibling display changes too. The named target of the task and the storage location of the setting are different things; mapping one to the other is the step people skip.

## Overrides are per-section

The override switch applies to a whole handler section, not to individual items: `filters`, `fields`, `sorts`, `arguments`, `pager`, etc. each override as a unit. You cannot override "one filter" — overriding filters copies the entire filter set into the display, and from then on that display's filters evolve independently of default. Practical consequences:

- To change one filter on one display: copy the whole `filters` section from `default` into the display, then modify the one filter.
- After an override exists, later edits to `default`'s same section no longer reach that display — a common source of "I changed the view but block 2 didn't update" confusion (the inverse of the leak).

## What it looks like in YAML

Inherited (title lives only in default; both blocks show "Recent articles"):

```yaml
display:
  default:
    display_options:
      title: 'Recent articles'
      filters: { status: { ... }, type: { ... } }
  block_1:
    display_options: { display_description: '' }
  block_2:
    display_options: { display_description: '' }
```

Overridden (block_2 has its own title; block_1 still inherits):

```yaml
display:
  default:
    display_options:
      title: 'Recent articles'
  block_1:
    display_options: { }
  block_2:
    display_options:
      title: 'Archive'
      defaults:
        title: false        # marks the setting as no longer inherited
```

Note the `defaults:` map — `title: false` records that this display does NOT take `title` from default. When creating an override in config directly, set both the value and the corresponding `defaults.<key>: false` entry, mirroring what the UI does.

## The general Drupal pattern

Views inheritance is one instance of shared-config-with-multiple-consumers. Others with the same failure mode:

- `field.storage.node.field_x` (one per field name, shared by every bundle using the field: cardinality, type settings) vs `field.field.node.article.field_x` (per-bundle: label, required, default value).
- `core.entity_view_display.*` / form displays referenced by multiple contexts.
- Any config entity listed as a dependency by others — enumerable via config dependency tracing before an edit.

The invariant: **the blast radius of an edit is defined by who reads the object, not by who was named in the task.**
