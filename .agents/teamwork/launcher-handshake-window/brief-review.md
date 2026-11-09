# Independent review: account usage handshake

Mode: Review. Repository /home/sr/Projects/Workspace/codex-agent-control-plane.
Read /home/sr/codex-home/agents/critic.toml developer_instructions first.
Read brief.md and handoff.md in this directory, then inspect the actual diff.
Review only the current handshake-window change, preserving unrelated port
startup edits in README.md, launcher.js and test/launcher-startup.test.js.

Core criteria: POST handshake performs exactly one bounded minimal completed
model turn using the clicked existing ChatGPT account, with no activation or
project task changes; fresh provider limits drive an immediate correct card
update. No fake five-hour reset and no false success with legacy backend.
Inspect ephemeral scratch read-only/no-network behavior, ordinary run defaults,
terminal completion races, failed/interrupted/process-exit/timeout cleanup,
concurrent duplicate click deduplication, provider update lag, stale limits and
UI refresh races. Plans with no five-hour reset may remain explicitly pending.
Review cache protection against older GET overwriting newer handshake limits.

Relevant source: src/codex-app-server.js, src/launcher-app.js,
launcher-ui/app.js; focused tests named in worker handoff. Native schema evidence
must establish newly used fields; no real model turn needed for source review.
Reuse current valid test evidence, run the smallest decisive extra checks only.
Disposable fake/local fixture services allowed; no live launcher/project/model
requests, restarts, Git mutations, credential inspection, or reviewed edits.

Write review.md here in English with ASCII punctuation. Return APPROVE, REJECT
or INCONCLUSIVE with file:line evidence and material limitations. Distinguish
source/fake-process qualification from a live provider usage-window observation.
Do not require a live request to accept source correctness. Report concise.
