# Skill audit A

Source: `/home/sr/Projects/Workspace/ws-knowledge/skills`. Read-only review on 2026-10-16. The source worktree had pre-existing modifications, deletions, and a rename; none were changed. Facts below cite current worktree files unless stated otherwise. Harness currently selects up to five skills per assignment and MCP servers are allowlisted by role, not assignment (`.agents/teamwork/harness-tool-routing/handoff.md`). Recommendations are suitability judgments for assignment-level routing, not authorization to run tools. A skill cannot grant a Harness role additional authority; mutation, environment, and external tool actions still require the assignment's actual capabilities and user authorization (inference from Harness role/tool boundaries).

## Per-skill findings

### a11y-frontend-twig - ADAPT
- Purpose/fit: component markup and keyboard/screen-reader accessibility for Drupal Twig and SDC; Drupal-only, useful to frontend implementer/reviewer on Twig tasks (`a11y-frontend-twig/SKILL.md:12-29,42-66`).
- Dependency: no MCP/service/credential required; refers to public WAI-ARIA APG and Drupal docs (`:68-71`).
- Gaps/cost/conflict: current file is modified; old evaluation and checklist references are deleted in source status. Skill calls for keyboard/screen-reader testing but provides no runnable test setup. No Harness role-specific boundary; its "implement" wording must not authorize edits for a read-only reviewer. Short, low context cost.
- Route only for Twig/SDC accessibility changes or review; frontend implementer and independent reviewer. Keep scoped to those file surfaces.

### codebase-indexing - DEFER
- Purpose/fit: manage AST/vector index lifecycle for Drupal repositories (`codebase-indexing/SKILL.md:8-18,69-89`); Drupal-centric and MCP-dependent.
- Dependency: requires `local-memory-indexer` MCP, plus shared filesystem/index storage. Assumes `LOCAL_VECTOR_SEARCH_DATA_ROOT`, default `~/.agent-forge/local-memory-search` (`:59-67`). No credential stated; server and data root must exist.
- Gaps/cost/conflict: sibling `local-memory-indexer` and `local-memory-search` skill folders are deleted in source worktree; cannot validate tool contracts from those docs. Commands include start/pause/resume and destructive `delete_project_index`; recovery recommends delete/rebuild (`:69-89`). This mutates external index state and exceeds read-only roles absent explicit assignment authority. Medium context cost due schemas, six operations, failure table.
- Route only when a compatible indexer is installed and indexing lifecycle is explicitly requested; repository/index operator, not general implementer. Prefer defer until tool contract and state authorization are verified.

### codebase-search - ADAPT
- Purpose/fit: hybrid/vector/keyword code search, symbol graph and context-pack retrieval (`codebase-search/SKILL.md:8-18,66-110`); potentially general across code once indexer supports the language, but documented as Drupal/PHP.
- Dependency: `local-memory-search` MCP and a prebuilt index; requires validated `project_path` and shared data root assumptions. No credential stated (`:53-64,66-102`).
- Gaps/cost/conflict: matching server skill folder is deleted in source worktree. Thirteen operations are listed, although assignment needs usually require a small subset. Skill correctly forbids indexing here and warns callers are not control-flow analysis (`:104-110` and entity analyzer). Context cost medium-high. Context packs for subagents fit Harness delegation in concept, but must not bypass lead's assignment scope or cause broad source disclosure (inference).
- Route to codebase investigators only when this MCP/index is installed; adapt operation guidance to actual registered tools and project scope. Use filesystem search fallback otherwise.

### drupal-views-safe-edit - ADAPT
- Purpose/fit: prevent inherited Drupal Views/config edits from leaking to sibling displays; Drupal-only (`drupal-views-safe-edit/SKILL.md:1-53`, `inheritance.md:1-69`). Good targeted safeguard for config implementers and reviewers.
- Dependency: recommends Drupal config/render MCP tools, with Drush or sync YAML fallback; no credential itself. Active DB/config MCP availability is tool-dependent (`SKILL.md:16-53`).
- Gaps/cost/conflict: named `mcp__drupal-*` tools may not exist in Harness; fallback references presume a local Drupal checkout and Drush. Inherited-scope ambiguity instruction asks the user, which is appropriate when task scope is genuinely unresolved but cannot be used to avoid inspecting available evidence. Medium cost because inheritance reference is substantive. Editing/config import is mutating; read-only reviewer should only inspect diffs.
- Route before any Views display or shared config edit, to Drupal implementer; also reviewer for blast-radius verification. Adapt tool names/fallback to the target project.

### entity-query-analyzer - ADAPT
- Purpose/fit: report-only static EntityQuery/access/load-risk audit, explicitly separates runtime from static evidence (`entity-query-analyzer/SKILL.md:1-19,87-131`); Drupal-only specialized reviewer.
- Dependency: may use `drupal-codebase-introspect`, `local-memory-search`, and configured PHP analyzers, but explicitly falls back to filesystem search and does not require MCP (`:33-58`). No credential stated.
- Gaps/cost/conflict: current long 159-line skill refers to `dev-validatecode`, `New-MCP-Servers.md` and `qa/runs/<id>` structured routing (`:133-159`), which are external project-specific contracts, not established by this Harness audit. A report path must be supplied; no source mutation. Strongly aligned to read-only audit roles and explicit non-authority over security decisions. High context cost, including ledger, coverage-state taxonomy, lifecycle workflow, structured contract. `agents/openai.yaml` adds short description/default prompt.
- Route only for EntityQuery/access/repeated-load static audits, to Drupal security/performance reviewer. Adapt/remove external QA contract unless the target project supplies it; preserve report-only guardrails.

### performance-maintainability-drupal - ADAPT
- Purpose/fit: identify Drupal cache/query/render/asset/complexity bottlenecks and propose verification/rollback (`SKILL.md:1-78`, references `performance-maintainability-playbook.md:1-37`, `dry-run.md:1-20`); Drupal-only reviewer/consultant.
- Dependency: no mandatory MCP or credential; asks for profiling/runtime observations, which depend on project instrumentation and access (`SKILL.md:17-24`).
- Gaps/cost/conflict: playbook repeats much of the skill and dry run adds little; moderate context duplication. Some heuristics are risky without evidence (for example, loadMultiple is suggested as an N+1 remedy), while anti-pattern section cautions against unmeasured changes. It suggests optimizations but doesn't authorize implementation. Route to Drupal performance reviewer only with performance/cache/render scope; adapt to require evidence level and distinguish static candidates from measured bottlenecks.

### php84-systems-design - DEFER (until version gate; then ADAPT)
- Purpose/fit: Drupal service/plugin design and OO refactoring (`php84-systems-design/SKILL.md:14-24,28-76`); Drupal-only implementer/reviewer.
- Dependency: no MCP/service credential. Assumes PHP 8.4, Drupal-compatible PHP features, and project analyzer/docs; dry run claims PHPStan/PHPCS results without supplying project config (`references/dry-run.md:1-68`).
- Gaps/cost/conflict: several universal imperatives (`strict_types` even for refactored files, always `final`, attributes over annotations, `match`, PHP 8.4 array APIs) may conflict with target Drupal/PHP versions or established compatibility (`SKILL.md:32-54`). Persistence rules assume a semantic memory store. Long checklist plus examples and evaluation file add context. Design advice cannot override task compatibility or reviewer-only role.
- Route only when project PHP/Drupal constraints are confirmed and task creates/refactors Drupal PHP OOP; PHP implementer/reviewer. Adapt imperatives to project compatibility and conventions.

### provision-ddev - DEFER
- Purpose/fit: configure/start/initialize/verify DDEV across multiple stacks (`provision-ddev/SKILL.md:8-95`); tool-dependent, only useful for DDEV projects.
- Dependency: DDEV CLI, Docker, shell, project preset/handoff; no credential stated. `references/ddev-provision-guide.md:1-49` describes host/container lifecycle and delete/poweroff commands.
- Gaps/cost/conflict: documentation presumes writable target `.ddev`, stable current directory, and preset variables not defined by this Harness. `rm -f .gitkeep` is unconditional (`:25-32`); `eval` executes caller-provided scaffold/init/verification commands (`:54-70,86-90`); `ddev start -y` changes environment (`:48-52`). Those actions need explicit project/user scope and cannot be assigned to read-only/reviewer agents. Medium context cost.
- Route only for explicit DDEV environment provisioning to an authorized environment operator. Defer from default Harness skill catalog until dangerous commands are gated and target preset contract exists.

### provision-lando - DEFER
- Purpose/fit: configure/start/initialize/verify Lando across multiple stacks (`provision-lando/SKILL.md:8-94`); tool-dependent and Lando-only.
- Dependency: Lando CLI, Docker, shell, handoff preset; no credential stated. `references/lando-provision-guide.md:1-54` documents lifecycle, rebuild/destroy/poweroff.
- Gaps/cost/conflict: assumes writable `.lando.yml` target and preset inputs; `rm -f .gitkeep` is unconditional (`:23-30`); `eval` invokes supplied commands (`:52-68,85-89`); `lando init --yes` and `lando start` mutate project/environment (`:32-50`). The claim that scaffold uses a temporary subdirectory is not reflected in its command block (`:52-59`), a procedure inconsistency. Medium context cost; overlaps DDEV adapter.
- Route only for explicit Lando provisioning to authorized environment operator after correcting the scaffold procedure and bounding command inputs. Defer otherwise.

### provision-local-platform - DEFER
- Purpose/fit: top-level local environment bootstrap router for DDEV/Lando plus universal checks (`provision-local-platform/SKILL.md:8-55`); multi-stack and tool-dependent.
- Dependency: DDEV/Lando/Docker CLI and shell; no credential stated. Reference `references/local-platform-preflight.md:1-65` includes `ss`, `docker`, platform poweroff and direct URL checks.
- Gaps/cost/conflict: expects `presets/<preset>.md` (`:12-26`), not a demonstrated Harness interface. Duplicates much of its two adapters and refers to Docker Compose even though workflow routes only DDEV/Lando (`:1-3,37-50`). Startup/configuration is mutating; preflight reference permits poweroff only with explicit confirmation (`local-platform-preflight.md:26-39`). High combined context cost if router plus adapter are injected. Not suitable for reviewer or unprivileged worker.
- Route only when task explicitly provisions a local environment; lead/operator can select one adapter. Defer as default and avoid loading it alongside adapter unless orchestration genuinely needs both.

### semantic-memory - DEFER
- Purpose/fit: durable architecture/invariant/incident/glossary memory search and write (`git show HEAD:skills/memory-knowledge-graph/SKILL.md:1-69`; current worktree has no `skills/semantic-memory/SKILL.md`). Potentially general but project-memory-backend-specific.
- Dependency: `memorygraph` MCP with read and write operations (`search_memories`, `store_memory`, `update_memory`, `create_relationship`); no credential stated. Requires durable cross-session service.
- Gaps/cost/conflict: source status shows deleted/renamed path and no current semantic-memory directory, so the baseline blob is the only full content reviewed. Current Harness notes instead use project handoff files; the skill's mandatory write-on-task-closure could conflict with Harness requirement that handoffs/artifacts be written only to authorized paths and with lead ownership of durable decisions. Medium cost. Writes are external persistent mutations, unsuitable for read-only specialists.
- Defer until memorygraph is an approved Harness capability with clear ownership, storage scope, and persistence rules. If enabled later, route search to assigned investigator and writes only to lead/authorized memory steward.

## Summary

Strong immediate candidates are narrowly triggered `a11y-frontend-twig` and `drupal-views-safe-edit`, with adaptation to Harness role/capability boundaries. `entity-query-analyzer`, `performance-maintainability-drupal`, `codebase-search`, and PHP design are useful specialist material but need target-project/tool/version adaptation. Indexing, all provisioning skills, and semantic-memory depend on stateful services or mutation authority; defer until their required tools and authorization contracts are explicit. None of these skill instructions themselves proves that the named MCP server is installed or callable.
