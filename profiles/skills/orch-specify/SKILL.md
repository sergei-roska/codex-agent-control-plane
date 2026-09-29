---
name: orch-specify
description: Turn a target project's orchestrator goal into a concrete, technology-neutral specification before framework or protocol selection.
---

# Specify an Orchestrator

Use when starting or materially changing an orchestrator and the product boundaries or coordination choices are unresolved. Read the relevant sections of `.codex/orch/REFERENCE.md`, especially sections 1-3, 15, and 16.

1. Extract the goal types, users, inputs, outputs, acceptance criteria, protected actions, and operating constraints from the target project's evidence. Label unresolved items instead of inventing requirements.
2. Define the smallest lifecycle and task selection model that meets the workload. State whether dependencies, dynamic replanning, parallelism, and durable recovery are needed and why.
3. Identify authoritative state, artifact storage, execution isolation, approval ownership, and integration boundary. Keep product policy separate from agent prompts.
4. Record candidate framework, A2A protocol, blackboard, and memory-store decisions as adopt, defer, or reject, each with the workload evidence and tradeoff. Do not mandate any of them by default.
5. Produce a reviewable specification: actors and trust boundaries, contracts, lifecycle, failure cases, measurable acceptance cases, phased implementation, and open decisions.

Do not begin implementation solely because the reference shows an example. If a consequential choice remains unresolved, give the lead the alternatives and the smallest experiment or evidence needed to decide.
