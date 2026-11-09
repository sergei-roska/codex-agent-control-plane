# AD-01 review fix: busy profile switch while a call is active

Role: junior_worker (Luna), review-fix follow-up. Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root AGENTS.md, the original same-home `brief.md`, `review-handoff.md`, and `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Observed failure

Sol's bounded child-process probe reproduced a hang at `src/app-server-switch.js:116-117`: with a bound A call awaiting a timer, changing the selected profile to B makes `switchTo('b')` return `busy`. A second bound call repeatedly awaits immediately resolved promises because `ensureBoundGeneration()` returns the still-active A generation while `needsSwap()` remains true. The microtask loop starves the A timer/I/O; the child timed out after 1500 ms although the A call was set to finish in 30 ms. Full evidence is in `review-handoff.md`.

## Goal

Fix the pending cross-home switch path so a new bound call fails closed immediately while another provider call is active, or waits on a real settlement signal without starving I/O. Preserve the active A call. After A settles, a retry must perform the switch and bind/invoke only on B's generation. Keep same-home identity-change behavior intact.

## Allowed files

- `src/app-server-switch.js`
- `test/app-server-switch.test.js`
- this task's `handoff.md`

No other files or Git state changes. Do not alter provider-call journal semantics. Add regression coverage that runs the potentially hanging interaction in a bounded child process or another isolation whose timeout remains runnable while the child event loop spins.

## Acceptance

- Reproduce the sequence: bound call A is active; select B and observe switch busy; a second bound call cannot invoke on A or spin; active A settles; a fresh retry swaps to B and binds B's hash.
- The old A generation is not closed before its call settles. The second call gets a stable fail-closed error or genuinely awaits settlement without starving the first call; choose the narrowest safe behavior.
- The regression check cannot hang the main test runner if the defect returns.
- Existing profile switching, same-home rotation, expected-home checks, worker/lead call binding and fail-closed behavior remain intact.
- Run focused wrapper, durable-store and e2e checks; report exact counts.

No live provider/account read, real credentials or quota, or runtime activation. Update the task handoff. This is a Luna review fix; no tier escalation is warranted.
