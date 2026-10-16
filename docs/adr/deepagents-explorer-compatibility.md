# ADR: DeepAgents Explorer compatibility decision

- Status: accepted fallback; no integration implemented
- Date: 2026-10-16
- Decision ID: DA-COMPAT-01
- Evidence: compatibility investigation `ev_2836fcd00405ecdecabf5135ea63ddcc`
  and offline client test `test/deepagents-compatibility.test.js`

## Context

The Explorer prototype request required a minimal compatibility proof if the
current Harness interface could not run DeepAgents. The checked-in
`CodexAppServer.run()` contract creates/resumes a Codex thread and starts a
turn. It validates selected MCP and skill pins, preserves role model/sandbox
configuration, correlates execution identity, handles cancellation and server
approval requests, and reports aggregate usage. It does not expose the
LangChain model/tool-call/result exchange required to put a DeepAgents graph in
that existing route.

The official DeepAgents JavaScript model guide requires a LangChain chat model
with tool calling. Its customization guide also documents built-in filesystem
and subagent capabilities that this Explorer role cannot accept without
additional enforcement. See the [model guide](https://docs.langchain.com/oss/javascript/deepagents/models)
and [customization guide](https://docs.langchain.com/oss/javascript/deepagents/customization),
checked 2026-10-16. These references support the integration requirements;
they do not imply that DeepAgents is globally incompatible with Codex.

The offline test exercises the real client with a fake stdio peer. It proves
only those observable client behaviors. It does not execute DeepAgents, call a
provider, prove global incompatibility, or establish token/tool-call research
limits.

## Decision

Record the current route as **NOT RUNNABLE** for the requested DeepAgents
prototype and deliver the offline compatibility test and factual status
documentation. Do not add a LangChain adapter, substitute interface, research
runner, production integration, DeepAgents dependency, or inert runtime
setting.

## Unknowns and deferred requirements

The installed Codex App Server protocol revision was not established by the
investigation, and the cited upstream protocol sources track `main`. DeepAgents
release-specific compatibility was not verified; the cited release listing
does not establish behavior for the installed environment. No live
compatibility or limit enforcement was tested.

A future runnable design must specify an owner-only strict boolean default-off
setting and preserve routing, accounting, tool, identity, cancellation, and
worker-report contracts. It must have no filesystem writes, shell, subagents,
or persistent memory; use bounded ephemeral state; and enforce no more than 3
sequential passes, 12 underlying tool calls, 180 seconds, and 12,000 total
tokens per task. Unknown underlying counts must remain UNKNOWN. These are
unimplemented requirements, not current guarantees.

## Consequences

The Harness has a deterministic offline proof of the supported client route and
a clear integration blocker. The prototype cannot be run through that route;
resolving this requires a future separately authorized design and a supported
exchange boundary. Existing App Server tests do not establish DeepAgents
compatibility or future limit enforcement.
