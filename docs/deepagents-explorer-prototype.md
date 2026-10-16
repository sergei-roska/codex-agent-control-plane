# DeepAgents Explorer prototype compatibility status

Status: **NOT RUNNABLE through the Harness's currently checked-in Codex App
Server route.** This is a statement about this route and its exposed contract;
it does not establish global DeepAgents incompatibility.

## Checked-in contract

`src/codex-app-server.js` implements the route used by the Harness. Its
`CodexAppServer.run()` validates the role, selected skill hashes, and selected
MCP tool pins (lines 730-782); it creates or resumes a Codex thread with model,
sandbox, approval, and tool configuration (797-851); and starts a turn with
text/skill input and model/effort (853-930). Server approval requests are
answered by this client, with command and file-change approvals declined
(1151-1200 and following). `src/a2a-role-service.js` owns task/attempt identity
correlation, active-run reservation, selected pins, and usage recording
(351-360, 407-424, 464-491, 645-672).

This is a turn-oriented Codex client. The checked-in route does not expose a
LangChain model invocation, tool-call request/result exchange, or an adapter
interface through which a DeepAgents graph can own the model/tool loop while
retaining the Harness's existing identity, routing, and accounting boundary.
The existing `@langchain/*` dependencies do not supply such an interface in
this route. No DeepAgents integration or DeepAgents package pin is installed.
DeepAgents' [JavaScript model guide](https://docs.langchain.com/oss/javascript/deepagents/models)
requires a LangChain chat model with tool calling; its
[customization guide](https://docs.langchain.com/oss/javascript/deepagents/customization)
documents built-in filesystem and subagent capabilities that also require
explicit control for this read-only Explorer role. References checked
2026-10-16.

The offline proof in `test/deepagents-compatibility.test.js` drives the actual
`CodexAppServer` implementation using an in-process fake stdio transport. It
demonstrates the existing `thread/start` and `turn/start` contract, routed model
and effort, read-only sandbox selection, turn identity and text result, and
the client declining an approval request. `modelRequests` remains unavailable
(`null`) because the client does not infer model request counts from turn
usage. The test is not a DeepAgents execution test and does not prove future
research limits.

## Unimplemented requirements for any future runnable prototype

Any future proposal must first provide a supported model/tool exchange while
preserving the existing route's account/model/effort routing, aggregate usage,
Explorer tools, MCP pins, skills-off policy, read-only enforcement,
task/context/attempt identity, cancellation, and `worker-report/v1` output.
The following are requirements only; none is implemented or verified here:

- A strict boolean opt-in controlled only by the project owner, defaulting to
  false and inaccessible to model output, task metadata, and assignments.
- No filesystem writes, shell access, subagents, or persistent memory.
- Bounded ephemeral state; at most 3 sequential passes, 12 underlying tool
  calls, 180 seconds, and 12,000 total tokens per task.
- Honest `UNKNOWN` accounting where underlying token or call totals cannot be
  established; no silent substitution of turn counts for model calls.
- Offline failure, cancellation, duplicate/late result, and exhausted-limit
  behavior tests before any live trial.

Do not enable or infer this opt-in from the unrelated AUT-03 project setting.
No live compatibility, release-specific behavior, or research-limit
enforcement has been verified.
