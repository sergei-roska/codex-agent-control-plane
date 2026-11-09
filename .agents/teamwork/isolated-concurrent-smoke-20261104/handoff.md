# Handoff

Status: source qualification complete; isolated native smoke in progress.
Baseline c67bf68; only tracked change is test/lead-planner.test.js, updating a
stale exact expectation to include existing bounded providerFailure diagnostics.
Product source is unchanged. Untracked :memory:.lockdb is preserved.

Verification:
- focused.tap: 212 passed, 0 failed, 53.6s.
- full.tap baseline: 2093 passed, 1 inherited stale assertion failed, 1 skipped.
- planner-baseline.log: same failure reproduced alone (10 passed, 1 failed).
- planner-repair/handoff.md: fixed strict expectation; 11 passed.
- full-after.tap: 2094 passed, 0 failed, 1 skipped, 60.7s.
- review/source-review.md: independent source APPROVE; 11/11 and disposable
  dual-Concurrent-schema conflict probe independently verified. Runtime criteria
  remain unverified pending final evidence.

Worker native-smoke-progress.json proves isolated loopback Concurrent startup,
200 A2A card, Legacy candidates row/schema coexistence, and a running task row.
It does not yet prove a completed model turn or accepted output. Private home
required isolated project trust and explicit project full-access settings;
earlier setup failures were fixture configuration errors, not product fixes.
No global settings or original runtime DB/service was changed.

Real project followup is authorized; see ../dccourts-182-trial-20261104/brief.md.
Its environment worker is preparing candidate-bound Lando validation. Original
bugfix/DCCOURTS-182 checkout and untracked requirements file remain unchanged.

Next: complete bounded native smoke, retain durable state/cleanup proof, then
submit real code-only task once validator baseline-fail/upstream-pass controls
are ready. Independently review final trial and undo owned test changes.

## Scoped verifier blocker and repair

The first native smoke wrote the correct file but never reached acceptance.
Verifier cwd was scratchRoot; neither original request nor thread instructions
provided scoped.candidatePath/readScope. Its report honestly blocked. The 420s
bound ended with safe cancellation, released phase, reopen and second safe close.
Failure evidence is retained under worker/pre-repair/; copied auth/temp runtime
was deleted after safe close. Actual per-role usage is in execution records,
not the empty legacy usage_ledger. No savings or complete usage claim is made.

Narrow source repair adds trusted capability-derived candidate path/identity/
manifest/scratch/readScope to scoped thread developer instructions, preserving
original turn input bytes and permission/receipt/check gates. Report conventions
require candidate-relative inspected paths and actual static checks only; host
pinned acceptance checks remain separately enforced. Read scopes are copied and
frozen. Unscoped/forged capabilities do not expose paths.

Verification: worker focused147/147; root full-context-repair.tap2095 passed,
0 failed,1 skipped (2096 total). Critic context-repair-review.md APPROVE with4
independent decisive tests. Native rerun is authorized with source frozen.

Target DCCOURTS validator has independent positive/negative controls (5/59 pass
with public MR59 vs4 failed tests on test-only pristine SHS), fixed oracle hash,
and critic APPROVE. Trial infrastructure commit5ddfe8317 on the test branch
contains only AGENTS.md, PHP-only .lando.yml and validation script. The original
bugfix checkout is unchanged. task-input.json pins exact source/goal/checks;
after accepted synthetic smoke, the worker may run that bounded code-only task.
Root owns capture/evaluation and resetting owned trial changes afterwards.

## Second native observation

The first context fix passed all source gates but its native verifier still
failed: developer messages contained candidatePath/readScope, yet the two
recorded tool calls read relative output.txt/verify-output.js and listed cwd,
which was intentionally empty scratch. Root verified actual candidate files
exist at the bound .candidate path. Thus this is an operational cwd/context
clarity issue, not missing materialization or permission denial.

Root authorized a narrow same-scope clarification: explicitly distinguish cwd
scratch from frozen candidate root, use candidate-root workdir/absolute paths,
scratch-only writes, candidate-relative reports and actual completed static
checks (nonempty checks remain required; host-owned checks deferred). Original
input/gates/policies remain unchanged. Same Luna will use high effort next.
Worker must safely stop/archive the second failed trial, implement assertions,
freeze focused checks and get delta review/full regression before one fresh
native run. Do not retry the same failed instruction unchanged.

Real-project task is not admitted yet. Its infrastructure baseline is pinned
in ../dccourts-182-trial-20261104/trial-baseline.json and task-input.json. Original
checkout remains untouched. Environment worker is preparing an independent
Composer lock/resolver evaluation helper without changing the frozen validator.
