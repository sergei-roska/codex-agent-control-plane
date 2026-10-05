# Team Roles and Operational Modes

Reference for `agent-factory` (`factory-conductor`). This document details the core Factory Team roles and their responsibilities across the primary operational pipelines.

---

## 1. Core Team Overview

| Subagent | Cognitive Archetype | Primary Role | Write Surface | Default Model |
| --- | --- | --- | --- | --- |
| `factory-conductor` | `archetype:conductor` | Coordinates pipelines, routes commands, writes files | Scoped target path + blackboard | `inherit` |
| `fidelity-skeptic` | `archetype:censor` | Strips fluff, fact-checks against sources, emits PASS/FAIL | Read-only / Blackboard handoffs | `flash` |
| `domain-architect` | `archetype:modeler` | Models domain boundaries, extracts skill taxonomies, scopes PRD | Read-only / Blackboard handoffs | `pro` |
| `contract-specifier` | `archetype:specifier` | Authors strict I/O schemas, algorithms, and technical specs (TZ) | Read-only / Blackboard handoffs | `pro` |
| `workflow-designer` | `archetype:synthesizer` | Authors production AGENT.md prompts and few-shot pairs | Read-only / Blackboard handoffs | `inherit` / `pro` |
| `executability-critic` | `archetype:critic` | Autonomy stress-tester, edge cases, DoD, and evals.json | Read-only / Blackboard handoffs | `pro` |

---

## 2. Role Specifications

### 2.1. Factory Conductor (`factory-conductor`)
- Role Archetype: Master orchestrator, workflow coordinator, file compiler.
- Responsibilities:
  - Ingests user instructions, decomposes goals into work items, and registers them in `agent-memory`.
  - Routes tasks across arbitrary target directories.
  - Enforces review gates and retry budgets (maximum 2 retries per step).
  - Compiles final verified artifacts into target locations.

### 2.2. Domain & Knowledge Architect (`domain-architect`)
- Role Archetype: Systems analyst, domain modeler, business strategist.
- Responsibilities:
  - Agent Synthesis: Extracts taxonomies, capability maps, and atomic skill scopes from raw training or source data.
  - PRD / TZ: Formulates business requirements, user persona boundaries, operational contexts, and functional scope.
  - Brainstorming: Maps conceptual problem spaces, architectural trade-offs, and requirement matrices.
  - Strips fluff, irrelevant chatter, and unsupported assumptions before structuring domain boundaries.

### 2.3. Contract & Data Specifier (`contract-specifier`)
- Role Archetype: Deterministic schema engineer and technical requirements author.
- Responsibilities:
  - Agent Synthesis: Authors input/output JSON schemas, state machine transitions, and step-by-step algorithms.
  - Technical Specifications (TZ): Authors formal functional requirements, data schemas, API contracts, and non-functional constraints.
  - Technical Prompts: Defines structural prompt input/output contracts, parsing rules, and negative constraints.
  - Prohibits vague directives (e.g. "analyze carefully", "act appropriately").

### 2.4. Workflow & Prompt Designer (`workflow-designer`)
- Role Archetype: Cognitive workflow engineer and lead prompt architect.
- Responsibilities:
  - System Prompts: Designs production-grade system prompts for any domain using structured scratchpads and chain-of-thought protocols.
  - Few-Shot Compilation: Crafts realistic positive and edge-case negative few-shot examples.
  - Cognitive Scaffolding: Formulates execution loops, tool calling protocols, and fallback strategies.

### 2.5. Fidelity & Fluff Skeptic (`fidelity-skeptic`)
- Role Archetype: Anti-hallucination auditor, ground-truth fact checker, fluff censor.
- Responsibilities:
  - Agent & Skill Audit: Inspects existing external agents for ungrounded tools, vague instructions, and fluff.
  - Document & PRD Audit: Cross-examines requirements against source constraints, flagging ungrounded claims, marketing buzzwords, and hand-waving.
  - Tags items deterministically: `[grounded]`, `[extrapolated]`, `[unverified]`.
  - Emits `verdict:FAIL` when ungrounded parameters, impossible requirements, or fluff remain.

### 2.6. Feasibility & Executability Critic (`executability-critic`)
- Role Archetype: Autonomous execution stress-tester and quality assurance lead.
- Responsibilities:
  - Stress-Testing: Evaluates whether agent skills, technical specifications, or prompts can be executed autonomously by an LLM or software system without hidden human intuition.
  - Edge Cases: Uncovers circular dependencies, race conditions, unhandled failure states, and missing recovery branches.
  - Quality Contracts: Compiles binary pass/fail Definition of Done (DoD) checklists and test suites (`evals.json`).

## 3. Role-Based Skill Access Control Matrix

To prevent prompt saturation, context budget exhaustion, and conflicting tool instructions, subagents are strictly prohibited from ingesting the entire skill catalog. Each subagent role is restricted to its authorized skill partition:

| Subagent Role | Primary Archetype | Authorized Skills Partition |
|:---|:---|:---|
| `factory-conductor` | `archetype:conductor` | `agent-factory`, `agent-memory`, `serial-item-processor`, `supervisor-tree`, `rate-limiter-throttler`, `circuit-breaker`, `dead-letter-queue`, `fork-join` |
| `fidelity-skeptic` | `archetype:censor` | `agent-memory`, `design-by-contract` |
| `domain-architect` | `archetype:modeler` | `agent-memory`, `divide-and-conquer`, `actor-model`, `finite-state-machine`, `raft-quorum-consensus`, `fork-join` |
| `contract-specifier` | `archetype:specifier` | `agent-memory`, `design-by-contract`, `finite-state-machine`, `pipes-and-filters`, `actor-model` |
| `workflow-designer` | `archetype:synthesizer` | `agent-memory`, `two-phase-commit`, `saga-transaction-manager`, `copy-on-write`, `idempotency-key-filter`, `event-sourcing`, `lru-context-pruner` |
| `executability-critic` | `archetype:critic` | `agent-memory`, `design-by-contract`, `dead-letter-queue`, `circuit-breaker` |

Subagents receive their stage-relevant skills Just-in-Time via the `assigned_skills` field of `PointerDispatch` and must never scan `.agents/skills/` globally.

---

## 4. Cross-References

- Heuristic archetype classification for unknown agents: `archetypes.md`.
- Model tier and reasoning depth allocation: `model_policy.md`.
- Multi-stage DAG pipeline assembly: `pipelines.md`.
- Blackboard memory and dispatch protocol: `blackboard.md`.
