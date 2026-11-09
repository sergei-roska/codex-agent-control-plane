# CN14 router immutable intake repair

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Node CommonJS/node:test,
real disposable better-sqlite3. Read /home/sr/codex-home/agents/worker.toml
developer_instructions and development-access.md before work. English/ASCII.
Root owns Git/docs; preserve inherited dirty source (source-start.json here).

Own ONLY src/delivery-engine-router.js and test/delivery-engine-router.test.js.
Core engine worker independently owns new engine source/test. No shared ownership.
Read ../engine-integration-20261027/router-reassessment-next.md and
../cn14-core-seams-review-20261027/handoff.md. Two rejected router revisions demand
the documented reassessment, not one more individual-field patch.

Implement uniform immutable intake normalization for goal/contract/contextId/
newRequest. Persist only explicit defined fields on first intake, preserve omitted
fields on replay, reject conflicting explicitly supplied immutable values BEFORE
any mutation/provider call. Route stored authoritative intake, not omitted input.
Keep exact authorized replay nonmutating, including timestamps. Handle null versus
omission consistently; a legacy resume placeholder may backfill first real intake
exactly once and must retain its legacy engine even if default changes. Preserve
async legacy isResumable and all existing facade controls. No engine activation.

Required real SQLite regressions: omitted newRequest, explicit conflict/null,
omitted contract/context, changed context, async resumability, reopen, placeholder
backfill and fixed engine, stable timestamps/events and zero calls on conflicts.
Inspect all facade call sites for compatibility; no broad source changes without
root grant. No live provider/model/account/target/service/Git/dependency actions.
Owned temporary DB fixtures allowed. No extra agents. Maintain your own concise
.agents/teamwork/cn14-router-repair-20261027/brief.md and handoff.md with exact
APIs/commands/results, then freeze for independent critic.
