# M5 implementation decisions

Date: 2026-09-30. Status: complete; evidence in [acceptance.md](acceptance.md). Scope: [beta plan M5](../beta-master-plan.md#m5-make-openai-defaults-configurable).
Direction: [dashboard-plan.md, Model settings](../dashboard-plan.md#model-settings-direction);
screens: [connections.md](../m0/screens/connections.md), [provider-modal.md](../m0/screens/provider-modal.md).
Runs in parallel with [M4](../m4/implementation.md). Lead decisions; workers implement them.

## Scope boundary

- OpenAI through the installed Codex App Server and its ChatGPT OAuth account only. No API keys,
  no other providers, no OAuth simulation, no token storage. "Add provider" stays unavailable.
- Catalog from App Server `model/list`; per-role saved defaults (model, reasoning effort,
  service tier) with immutable history; validation before dispatch; pinned per run; requested and
  reported settings recorded per turn.
- Editing defaults never changes an active or resumed run.

## Verified protocol facts (codex-cli 0.159.0 generated schema)

- `model/list` params `{ cursor?, limit?, includeHidden? }` -> `{ data: Model[], nextCursor }`.
  Model: `id, model, displayName, description, hidden, isDefault, defaultReasoningEffort,
  supportedReasoningEfforts: [{ reasoningEffort, description }], serviceTiers: [{ id, name,
  description }], defaultServiceTier|null, upgrade|null, upgradeInfo|null`. Effort and tier are open strings.
- `thread/start`/`thread/resume` accept `model`, `serviceTier` (no effort); responses report
  `model`, `reasoningEffort`, `serviceTier`. `turn/start` accepts `model`, `effort`, `serviceTier`.
- `account/read` -> `{ account: { type: 'chatgpt', email, planType } | other | null,
  requiresOpenaiAuth }`; `account/rateLimits/read` -> primary/secondary windows
  `{ usedPercent, windowDurationMins, resetsAt }`, credits, `ordinaryUsageAllowed`.
- Today the client sends `model`/`effort` from the role object only, never `serviceTier`; the
  profile model regex excludes dots; efforts are a closed set low|medium|high|xhigh.

## D-M5-1 Catalog (`src/model-catalog.js`)

- `appServer.listModels()` (new public method) pages `model/list` with `includeHidden: false`
  until `nextCursor` is null (max 20 pages). The catalog caches 5 minutes; `refresh()` forces.
- Normalized entry: `{ model, displayName, description, isDefault, efforts: [id],
  defaultEffort, serviceTiers: [{ id, name, description }], defaultServiceTier, upgrade }`
  (`model` is the value passed to turns).
- Status `{ state: 'ok'|'unavailable', fetchedAt, error: { code, message }|null }`. Errors never
  crash the server.
- `validateSelection({ model, effort, serviceTier })` -> `{ ok, errors: [{ field, message }] }`:
  model present in the catalog; effort in its efforts; serviceTier null or one of its tier ids
  (`'default'` is treated as standard and stored as null). Catalog unavailable -> not ok with code
  `catalog_unavailable` (fail closed).
- Profile validation relaxes: model `^[a-z0-9][a-z0-9._-]{0,63}$`, effort `^[a-z0-9_-]{1,32}$`;
  actual support is validated against the catalog at save and at submit.

## D-M5-2 Settings store (migration 3 `role_settings`)

```sql
CREATE TABLE role_settings_revisions (
  settings_revision_id TEXT PRIMARY KEY, pack_id TEXT NOT NULL, role_runtime_id TEXT NOT NULL,
  model TEXT NOT NULL, effort TEXT NOT NULL, service_tier TEXT,
  supersedes_id TEXT, actor TEXT NOT NULL, command_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX role_settings_rev_role_idx ON role_settings_revisions (pack_id, role_runtime_id, created_at);
CREATE TABLE role_settings_current (
  pack_id TEXT NOT NULL, role_runtime_id TEXT NOT NULL, settings_revision_id TEXT NOT NULL,
  PRIMARY KEY (pack_id, role_runtime_id)
);
```

- `saveRoleDefault({ packId, roleRuntimeId, model, effort, serviceTier, commandId,
  expectedRevisionId })`: validates against the catalog, the role exists in that pack, optimistic
  `expectedRevisionId` (null = no saved default yet), commandId idempotency as M2. Stale -> 409
  `stale_version`. `resetRoleDefault` deletes only the current pointer (history keeps every
  revision) and records event `role_default_reset`.
- `effectiveDefault(packId, roleRuntimeId, profileRole)` -> saved current revision or the profile
  values, with `source: 'saved'|'profile'` and `settingsRevisionId|null`.
- Events `role_default_saved`, `role_default_reset` (ids only).

## D-M5-3 Account health

`GET /account` -> `{ status: 'connected'|'requires_auth'|'unsupported_account'|'unavailable',
account: { type, planType, email }|null, rateLimits: { primary, secondary, ordinaryUsageAllowed }|null,
appServerVersion, checkedAt }`. `connected` only for `type: 'chatgpt'`. Cached 30 s;
`POST /account/refresh` (session + originGuard) bypasses the cache at most every 10 s. The UI shows
setup instructions (`codex login` in a terminal, then restart) when not connected. No probe turn.

## D-M5-4 Per-turn settings in the App Server client

- Role objects may carry `serviceTier`. `thread/start` and `thread/resume` send `serviceTier`
  when set; `turn/start` sends `model`, `effort`, `serviceTier` when set.
- Usage entries add `requested_json` `{ model, effort, serviceTier }` and `reported_json`
  `{ model, reasoningEffort, serviceTier }` (from the thread response) as nullable columns via the
  idempotent PRAGMA pattern. Existing `model`/`effort` columns keep their current meaning.

## D-M5-5 Integration with M4 and M3 (pinning)

- Settings are keyed by `(packId, roleRuntimeId)`. The delivery pack coordinator
  `dlv-project-manager` is configurable like any role; the legacy lead `orch-lead` is configurable
  under pack `legacy-orch`.
- At Submit, the controller resolves effective defaults for the active pack's coordinator, all
  specialists and repair profiles, and validates each against the catalog. Any failure refuses
  the submit with 409 `settings_invalid` and `details: [{ roleRuntimeId, field, message }]`
  (catalog unavailable -> 503 `catalog_unavailable`). Nothing is queued.
- Snapshot `roles` entries become `{ model, effort, serviceTier, sandbox, source,
  settingsRevisionId }`; snapshot adds `rolePackVersion`, `catalogFetchedAt`.
- The snapshot is pinned in the run and passed to the lead run as `delivery.settings`. The graph
  pins it in state like the plan: `decide` uses the coordinator entry for the lead turn; each
  dispatch sends `effectiveSettings` for the target role in the A2A message metadata; the role
  service applies it only when it names that role and passes format validation. Intake uses the
  coordinator entry. Resume never changes it.
- Legacy CLI runs (no `delivery`) keep today's behavior: profile values only.

## D-M5-7 Audit hardening (decided after the M4/M5 audit)

- Delivery runs on the `legacy-orch` pack also resolve, validate and pin settings through the
  settings store under pack `legacy-orch` (lead `orch-lead` + orch-* roles). Only CLI/A2A runs
  without `delivery` keep profile values.
- The role pack is pinned per run: the controller and the lead executor select the pack and
  orchestrator from `run.settings.rolePack` (runs without it are `legacy-orch`); the server keeps
  both delivery orchestrators available; an unknown pinned pack fails the run `role_pack_unavailable`.
- `validateSelection` also applies the pinning format rules (`normalizeEffectiveSettings`), so a
  model id the runtime cannot pin is rejected at save/submit; at runtime a pinned entry that does
  not normalize fails the turn instead of silently falling back to profile values.
- `effectiveSettings` received by a role endpoint is applied only after the format check and,
  when the catalog status is ok, a catalog check; with the catalog unavailable the format check
  alone applies (delivery runs were validated at submit).
- An unavailable catalog result is cached for 10 s.
- `reported` is null when no thread response was received on that turn; the UI shows "not
  reported" and no difference badge. A null tier is shown as "Default (not sent)", with the
  model's `defaultServiceTier` when advertised; "Standard" is not claimed.

## D-M5-6 API and UI

- `GET /models` -> `{ catalog: status, models: [entries] }`; `POST /models/refresh`.
- `GET /settings/roles` -> `{ pack: { packId, version }, roles: [{ roleRuntimeId, publicId|null,
  displayName, kind, profile: { model, effort, serviceTier }, current: { settingsRevisionId, model,
  effort, serviceTier, createdAt }|null, effective: { model, effort, serviceTier, source },
  valid: bool, errors }] }`.
- `PUT /settings/roles/:roleRuntimeId` `{ commandId, expectedRevisionId|null, model, effort,
  serviceTier|null }`; `DELETE /settings/roles/:roleRuntimeId` `{ commandId, expectedRevisionId }`
  resets to the profile; `GET /settings/roles/:roleRuntimeId/history`.
- Connections tab: one OpenAI (Codex, ChatGPT sign-in) card with the real account status, plan,
  email, rate-limit windows and App Server version; setup instructions when not connected; Add
  Provider disabled ("Only OpenAI through Codex is supported in beta"). Role defaults table with
  Model (catalog), Reasoning effort (model's supported values), Speed (only when the model
  advertises service tiers; "Standard" = null), source badge, Save/Reset, history. Banner: "Changes
  apply to new runs only; running and resumed work keeps its pinned settings". Invalid saved
  defaults (e.g. a model removed from the catalog) are flagged. Tier presence is not proof of
  entitlement: tooltip says so.
- Run Settings tab (M3) shows the pinned snapshot and, per attempt, requested vs reported settings.

## Verification plan

Fake protocol with a scripted catalog: save/reset/history with idempotency and staleness; invalid
model/effort/tier rejected; catalog unavailable fails closed on save and submit; a default change
after submit does not alter the running or resumed run (asserted from the requested settings of
its turns) while a new run uses it; serviceTier sent only when set; account states rendered
truthfully. No live model call.
