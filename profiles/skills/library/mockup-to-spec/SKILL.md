---
name: mockup-to-spec
description: Turn a working HTML/CSS/JS mockup into implementation specs by walking it screen by screen, with a mechanical coverage gate. Use when a designer-built or hand-coded prototype is the real requirement and the specs must be derived from it rather than from a document about it. Extracts an inventory of every control, drives one screen at a time through a fixed extraction table, and fails the build when any control is unaccounted for. Also use to audit an existing spec set against the mockup it claims to describe.
---

# Mockup to spec

The mockup is the requirement. Everything else — architecture notes, prior specs,
a summary someone wrote — is hearsay about the requirement.

This skill exists because of a specific, repeatable failure: four different agents
wrote or audited specs for one project, and **not one of them read the mockup
screen by screen**. They read documents about it. The result was 8100 lines of
detailed, confident, internally consistent specification containing a storage
model, an execution model and a read-only mode that the user had never asked for
and that no line of the mockup implied.

## The one rule

```text
A claim about behaviour is admissible only with a file:line citation
into the mockup source. A citation to a document about the mockup is
not admissible.
```

Everything below is machinery for enforcing that rule at scale.

## When this applies

Use it when all of these hold:

- A working mockup exists — real markup, real handlers, not a picture.
- The mockup is the authority on what the product does.
- Specs must be produced or checked against it.

Do not use it to design something the mockup does not show. That is a different
job with a different source of truth, and mixing the two is how invented
requirements get in.

## Procedure

### 0. Inventory — before anything else

```bash
python3 scripts/inventory.py <mockup-dir>
python3 scripts/inventory.py <mockup-dir> --json > inventory.json
```

Read the two lists at the bottom of the output before you read anything else:

- **ids never touched by any script.** Each is either decorative, or a control
  the mockup collects and then ignores, or a dead stub. All three are findings.
  A field the mockup gathers and never reads is a requirement gap wearing a
  disguise — it means the author wanted it and the prototype never delivered it.
- **ids referenced by scripts but declared in no fragment.** These live in the
  assembled shell or the build script. They are almost always the application
  frame — sidebar, navigation, theme, global buttons — and they are the single
  most commonly missed part of a spec set, because no screen file contains them.
  The coverage gate injects them as a synthetic `<app shell>` screen so they
  cannot be quietly dropped.

### 1. Baseline the existing specs, if any

```bash
python3 scripts/coverage.py <mockup-dir> <spec-dir> --list
```

Run this before writing anything. The percentage is the honest starting point,
and the per-screen table tells you the order to work in.

**State the gate's limits whenever you report its number.** It tests whether a
control's identifier appears verbatim in a spec file. If the target application
renames things — DOM ids becoming component test ids, say — a legitimate spec
will score low. That is why step 2 requires recording both names in one row: it
makes the gate meaningful instead of pedantic. Report the number with this
caveat attached, every time. A number presented without its limits is the same
error this skill exists to prevent.

### 2. One screen at a time

Copy `templates/screen-pass.md`, fill it for exactly one screen, finish it,
gate it, then move to the next. Do not batch screens. Do not start the second
before the first is green.

Order the screens by dependency, not by size: the app shell first, because every
other screen mounts into it, then the screens that own the primary data, then
the overlays that mutate it.

The extraction table has five columns. Four are derived from the source and are
the specifier's work. The fifth — **Undecided** — is the only one the user
fills, and it should be short. If a screen produces twenty open questions, the
extraction was lazy: most of those answers are in the handler.

### 3. Ask narrowly, and never with a leading recommendation

When a genuine fork appears, ask about the fork itself. Do not bundle it with a
recommendation, because a recommendation from an agent that has misread the
situation will be confirmed by a user who trusts it, and the misreading becomes
a frozen decision. This has already happened once on this project and cost a day.

Ask what the thing *is* before proposing what to *do* about it.

### 4. Gate, then commit the screen

```bash
python3 scripts/coverage.py <mockup-dir> <spec-dir> --screen <screen> --list
```

Green means every control is accounted for. It does not mean the content is
right — that is what review is for. It means nothing was silently skipped.

## What the extraction must capture

For every control, all four of these or the row is incomplete:

| Column | Standard |
| --- | --- |
| Mockup behaviour | What the handler literally does, with `file:line`. Including the fake parts: the `setTimeout`, the canned reply, the in-memory push, the `alert`. `no handler` is a valid and important answer. |
| Required real behaviour | Derived from the mockup plus frozen decisions, nothing else. Where the mockup simulates, name the replacement and mark it new. |
| Data needed | Field, type, where it appears in the mockup, whether the contracts already have it. Every "no" is a contract gap to name, never a field to add silently to a frozen type. |
| Undecided | Only forks where two readings lead to materially different work. |

## Simulation boundary

A mockup fakes things. Every fake is a requirement with **no precedent to trace
to**, which makes it the most dangerous category in the set: it looks like it is
already designed because it is already on screen.

List each one explicitly per screen. Typical shapes: a timer standing in for a
model call, a fake auth handshake, a hardcoded permission matrix, a file input
that keeps only the filename, mutations that live in memory and vanish on
reload, health indicators with no probe behind them.

None of these may be written as a contract until a source settles it.

## Failure modes this skill is built to stop

Each one is real and happened on this project.

| Failure | How it got in | What stops it |
| --- | --- | --- |
| Storage and execution model invented wholesale | An agent was given a path to an unrelated project and absorbed its architecture | The one rule: cite the mockup, or it is not a finding |
| Specs faithfully implemented a contaminated upstream document | Downstream agent read the document, never the source | The one rule again, applied downstream |
| Whole screens missing from the spec set | Coverage checked by reading, not counting | `coverage.py`, red build |
| The application shell specified nowhere | It lives in the build script, so no screen file contains it | Synthetic `<app shell>` screen in the gate |
| A field collected by the UI and read by nothing | Nobody diffed declared ids against referenced ids | `inventory.py`, both orphan lists |
| Conclusion drawn from three fixture lines without opening the 200-line modal | Speed over source | One screen at a time, gate before moving on |
| 62 acceptance boxes pre-ticked with zero code written | Template artifact nobody questioned | Gate checklist forbids a pre-ticked box |
| A misreading frozen by a leading question | Agent proposed an interpretation and the user confirmed the agent's framing | Step 3: ask what it is, not what to do |

## Reporting

Report coverage as a number with its caveat, per screen, and name what is still
uncovered. Never report a spec set as complete while the gate is red. If a screen
is deliberately out of scope, say so in the spec and leave the gate red for it —
a knowingly red gate with a written reason is honest; a green gate obtained by
weakening the check is not.

## Bundled resources

- `scripts/inventory.py` — mechanical extraction of controls, handlers, orphans.
- `scripts/coverage.py` — the gate. Exit 1 on any uncovered control.
- `templates/screen-pass.md` — the per-screen worksheet.
