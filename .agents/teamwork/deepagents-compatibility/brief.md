# Brief: DeepAgents Explorer compatibility proof

## Objective

Determine whether DeepAgents can run on the current read-only Explorer route
without changing Codex account routing, tool boundaries, or task identity.

## Constraints

- Do not use an API key or a second model provider.
- Do not add a LangChain adapter or unsupported App Server interface unless the
  current route exposes a safe tool-call exchange.
- Preserve Explorer's tools, MCP pins, skills-off policy, read-only sandbox,
  cancellation, identity, usage accounting, and worker-report/v1 contract.
- If the route is incompatible, add a small offline proof and document the
  precise boundary without claiming global DeepAgents incompatibility.
