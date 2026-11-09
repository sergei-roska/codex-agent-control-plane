# Bounded live comparison design re-review

Verdict: REJECT live dispatch until the native planner supersession interface is repaired.
The earlier steering blocker is resolved: trial-design.md:35-42 now triggers from
actual non-coordinator onEvent turn/started and bounds receipt timing by actual
started/completed events. No change to earlier native or cleanup acceptance.

## Confirmed blocking interface gap

src/concurrent-delivery-engine.js:2070-2101 omits supersedesTaskId from all
planner task schemas, whose additionalProperties is false. Its new-task branch
also forbids expectedRevision. The only branch accepting expectedRevision pins
taskId to the existing identity and revision to current+1. Therefore no valid
native structured output can express a distinct repair task superseding the
failed diagnostic. Same-ID retry remains possible, but does not satisfy this
trial's distinct-task obligation.

Read the preventing mechanism: delivery-contracts.js:341-350 requires a new task
at revision1, supersedesTaskId identifying the old task, and change-level
expectedRevision equal to the old task revision. Active/terminal/cross-scope
supersession remains forbidden. backlog-store.js:740-742 applies this lineage by
marking the prior task superseded. Sanitization at concurrent-delivery-engine.js:
1341-1356 copies existing task/change fields but does not manufacture lineage, so
it cannot close the missing-schema gap. Prompt at :1252 additionally instructs
all new tasks to omit expectedRevision, directly contradicting supersession.

Ran a read-only Node probe calling the actual plannerOutputSchema on a failed
engineer task at revision3: both returned branches lack supersedesTaskId and have
additionalProperties:false; the new branch requires only task, while the update
branch pins existing taskId and expectedRevision3. No DB/runtime constructed.
Ran node --test --test-name-pattern='explicit queued-task supersession|revisioned replacements preserve supersession' test/delivery-contracts.test.js:
2 passed,0 failed. Existing domain support is real; the integration gap is native
structured-output reachability, not an observed model failure.

## Narrow repair acceptance criteria

1. Expose an explicit superseding-new-task branch for eligible projected tasks:
   new distinct taskId, revision1, supersedesTaskId pinned to target taskId, and
   change-level expectedRevision pinned to that target's current revision. Use
   the existing eligible roles/states and retain domain validation as authority.
   Do not broaden publication authority, task scope, check pins or owner gates.
2. Preserve the ordinary new-task branch without expectedRevision and existing
   exact-ID/current-revision/next-revision update branches. Updates of existing
   superseding tasks must preserve their exact supersedesTaskId lineage; neither
   schema nor prompt should silently erase lineage or permit introducing it on
   an existing task. delivery-contracts.js:359 already enforces this invariant.
3. Update the actual planner prompt and schema descriptions to distinguish all
   three operations. State that a distinct repair supersedes the failed task
   using its current revision, while retaining failed attempts as history. Do
   not require owner input or fabricate successful diagnostic completion.
4. Add native-schema regression coverage proving a legitimate distinct repair
   is expressible and passes the real plan validator/application path, with the
   old task superseded and its failed attempt retained. Prove stale target
   revision, active/terminal target, same-ID misuse and altered lineage fail in
   the appropriate schema/domain gate. Preserve ordinary create/update tests.
   A test merely checking property existence is insufficient.
5. Run the affected planner/domain/integration tests. No native/provider rerun is
   necessary to establish this source repair. Review the actual delta before
   dispatching either live comparison arm.

Other previously assessed bounded fixture, asymmetric steering, usage-unknown,
private cleanup and non-generalization constraints remain supportable. Token
admission thresholds can overshoot through already active work; keep actuals.

Status: complete
Scope expansion: none
