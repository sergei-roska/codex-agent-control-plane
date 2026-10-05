# Screen pass: `<screen-file>`

> One screen per pass. Do not start a second screen until this one's gate is green.
> Every cell in "Mockup behaviour" carries `file:line`. A claim without a citation
> is not a finding, it is a guess — delete it.

## Inventory

Paste the rows for this screen from `inventory.py --json`. The count here is the
number the gate will check against.

| # | Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- | --- |
| 1 | | | |

Controls in this screen: **N**
Of those, never touched by a script: **M** — each needs a verdict below.

## Extraction

One row per control. Columns 1–4 are derived from the source and are yours to
verify, not to invent. Column 5 is the only one the user fills.

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| | | | | |

Rules for "Mockup behaviour":
- Quote what the handler actually does, including the parts that are fake:
  a `setTimeout`, a canned string, an in-memory array push, an `alert`.
- If nothing happens, write `no handler` — that is a finding, not a blank.
- Never write what you assume the control is for. Write what the code does.

Rules for "Required real behaviour":
- Derive it from the mockup plus already-frozen decisions. Nothing else.
- Where the mockup is a simulation, say what replaces it AND mark it new.
- Where you cannot derive it, leave it empty and raise it in "Undecided".

## Data this screen needs

| Field | Type | Source in mockup | Already in contracts? |
| --- | --- | --- | --- |
| | | | |

Anything answered "no" here is a contract gap. Name it; do not add the field
silently to someone else's frozen type.

## Simulation boundary

List every behaviour on this screen that is fake in the mockup. Each one becomes
a new requirement with no precedent to trace to, so each one needs a source
before it can be called a contract.

- [ ] …

## Undecided

| ID | Question | What it blocks |
| --- | --- | --- |
| | | |

Only genuine forks belong here: two readings that lead to materially different
work. A question with an obvious default is not undecided — pick the default,
state it, move on.

## Gate

```
python3 scripts/coverage.py <mockup-dir> <spec-dir> --screen <screen-file> --list
```

- [ ] Gate green for this screen
- [ ] Every control in the inventory appears exactly once in the extraction table
- [ ] Every "Mockup behaviour" cell carries a `file:line`
- [ ] Every simulation is listed in the boundary section
- [ ] No acceptance checkbox anywhere is pre-ticked
