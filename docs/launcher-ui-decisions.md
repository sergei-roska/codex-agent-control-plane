# Launcher dashboard decision log

Decisions taken during the 2026-10-11 redesign session. "Owner" = decided by
the project owner; "Lead" = decided by the dev lead (Claude) within the
owner's direction. Backend designs live in their own docs and are only
referenced here.

## Visual system

| Decision | By | Why |
|---|---|---|
| Neutral palette tinted toward the accent, base #0a0a0f instead of pure #000; surfaces #101016 / #15151d / #1d1d28 | Lead | Pure black made layers indistinguishable; depth by fill instead of borders |
| Single signature accent iris #8b7cff, used only for primary actions, focus, selected/active states, links, brand mark; primary fill #6f5ff0, hover #5f4fe0 (white text >= 4.5:1) | Lead | Generic Tailwind look had no identity; accent must be deliberate |
| Desaturated status colors (success #3fb68b, danger #e5534b, warning #d9a03f) | Lead | Status should inform, not shout |
| Text tokens: muted #9d9dab, dim #8a8a99 (>= 4.5:1) | Lead | Readability after the owner asked for larger, clearer text |
| Type scale limited to 12 / 13 / 14 / 15 (body) / 17 / 18 / 22 px | Owner (+1..2 px, larger fonts), Lead (scale) | 15 ad-hoc sizes, mostly 10-12 px, read poorly |
| Monospace only for code, commands, IDs, paths, terminal; numbers use Inter tabular-nums | Lead | Mono everywhere looked like debug output |
| 4 px spacing grid; radii 4 / 6 / 8 / 12 / 16 | Lead | Consistent rhythm |
| Borders only on top-level containers; nested items separate by fill; faint inset top highlight instead of heavy black shadows | Lead | Card-in-card borders created line noise |
| Buttons: primary / secondary / ghost / danger / success levels; heights 38 / 32 / 26 | Lead | All buttons looked the same |
| Inline Lucide SVG sprite instead of emoji icons | Lead | Emoji were the strongest "cheap" signal |
| Custom tooltip component (`data-tooltip`), no native `title` tooltips; role description tooltip only when the text is clamped | Owner | Native tooltips look cheap |
| No native browser dialogs | Owner (earlier rule) | In-page UI only |
| Responsive layout is best effort, never a gate | Owner | Desktop-only use |

## Layout

| Decision | By | Why |
|---|---|---|
| Three columns: left sidebar 360 px, center, right sidebar 300 px; max-width 1880 px; right sidebar drops below at <= 1440 px | Owner (right sidebar), Lead (sizes) | Reserve space for connectors |
| Right sidebar holds an empty "Connectors" card (`#connectorsSlot`) until connectors exist | Owner | Reserved, no fake entries |
| Server status pill moved from the navbar center to the actions group before Start/Stop | Owner | Status belongs next to its controls |
| Navbar "Terminal" button removed; the logs drawer keeps its own Collapse/Expand toggle | Owner | Redundant |
| "About Orchestrator" card first in the left sidebar, collapsed by default | Owner | Rarely needed |
| Project remove button is an icon (trash) so the project select fits | Lead | Select text was truncated after the type increase |
| Session header shows the project name (folder name: "-" and "_" to spaces, each word capitalized, rest unchanged) instead of "Session" | Owner | "Session" duplicated the session chip; AGENTS.md headings are too generic to use (Lead) |
| Team & Roles moved out of the sidebar into a full-width band at the bottom, 4 cards per row | Owner (placement), Lead (card design) | Roles did not belong in the sidebar |
| Role card: name, id, badges on one line; 2-line description; model/effort chips (override in accent); live LED; session tokens (total, in / cached / out) pinned to the bottom | Owner (description, tokens), Lead (layout) | |
| Role modal: 760 px wide, full-width controls, 260 px rules textarea, all fonts >= +4 px | Owner | Modal and fonts were too small |
| Static quick-goal chips removed | Owner | Not useful; replaced by the situation panel and scout |

## Features (designs elsewhere)

| Decision | By | Doc |
|---|---|---|
| Per-role session token usage endpoint; legacy `orch-lead` rows fold into the lead role | Lead | commit bd986be |
| Session situation panel (phase, round, now / done this turn, changed files, where we stopped) | Owner (problem: UI does not keep the owner informed), Lead (design) | docs/session-situation-design.md SIT-1..3 |
| Ask the scout: existing `scout` role, gpt-6-luna, medium, roams the project read-only; composer switches to Scout mode while the lead works | Owner (role, model, effort), Lead (dispatch path) | docs/session-situation-design.md SIT-5 |
| Owner pause (soft stop) reusing the budget-pause path | Owner (feature), Lead (design) | docs/owner-pause-design.md PAUSE-01 |
| Deterministic emergency Stop that leaves the lead resumable | Owner (do not postpone), Lead (semantics) | docs/owner-pause-design.md STOP-01 |
