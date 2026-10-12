# Team LED states

Status: approved by the owner on 2026-10-12. UI only; the team composition and
the lead graph are unchanged (an earlier `team` roster proposal was dropped).

## LED states (`launcher-ui/app.js` `updateTeamLeds`, `launcher-ui/styles.css` `.agent-led`)

| Situation | LED | Tooltip / aria-label |
| --- | --- | --- |
| No session shown, or the shown session has no turns yet (before intake) | unchanged: current idle style (`#2a2a36`) | `idle` |
| Session has turns and the role is working | green, lit, visibly brighter than the 2026-10-11 redesign style | `active` |
| Session has turns and the role is idle | green, off: dim green, clearly distinct from the pre-intake dark dot | `available` |
| Role is unavailable | red, lit (`--danger` with glow, no pulse); class `is-unavailable` | `unavailable` |

The red state is styled but has no trigger yet: the orchestrator does not
declare which roles take part in a run, so no role is currently unavailable.
Wire it when such a signal exists.

The `Now` rows in the situation panel keep using the lit green style.
