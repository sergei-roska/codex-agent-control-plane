# External integrations backlog

Status: planned for a future phase; outside the current beta and live-project pilot.
This file records product direction only. Each provider still needs a bounded
design, security review, implementation scope, and acceptance evidence before work
starts.

## Shared integration surface

- Separate integrations into two classes:
  - **Required baseline for every work project:** Slack, Jira/Confluence
    (Atlassian), and Figma. Project setup must show their connection readiness
    and must not mark a project ready to run while any baseline connection is
    unavailable.
  - **Situational, project-specific:** additional services enabled only when a
    project has a use case, such as Salesforce, Google Tag Manager, a cookie
    consent manager, or hosted Git for remote push/PR operations. Their absence
    must not block unrelated project work.
- Keep core runtime requirements (Codex/OpenAI account and the configured
  workspace/repository) in the existing runtime and Connections & Models setup.
  The Integrations tab should distinguish project-required connections from
  optional project-specific connections and show which tasks depend on each.
- Design a provider-neutral integration manager with separate service adapters.
  Standardize connection lifecycle, project-level enablement, account/resource
  selection, capability and scope declarations, token refresh/revocation, health
  state, audit events, and provenance on retrieved data. Provider adapters still
  own each service's API, OAuth details, data model, rate limits, and errors; do
  not assume one universal API can connect arbitrary services.
- Bind connections and grants to an orchestrator project/workspace so one
  project's Salesforce or consent-management credentials cannot silently become
  available to another project. A project declares which providers and
  capabilities its runs may use; roles receive only the approved operations.
- Keep the manager independent of the agent transport. Native orchestrator
  adapters are acceptable; an MCP gateway can be considered where it gives a
  useful, bounded tool contract, but MCP is not itself a substitute for
  provider-specific adapters or authorization.
- Add a dedicated **Integrations** dashboard tab for Atlassian, Slack, Figma,
  Google Tag Manager, and any later external services. Keep **Connections &
  Models** focused on Codex/OpenAI account health and model defaults.
- Show each provider's connection state, selected account/workspace, granted
  scopes, last successful access, refresh/disconnect actions, and recoverable
  errors. Never display tokens or secrets.
- Start authorization in the browser and complete the provider's supported OAuth
  flow through the local orchestrator callback. Prefer PKCE where the provider
  supports it; verify exact grant types, redirect requirements, and minimum
  scopes during provider design.
- Encrypt tokens at rest, support revocation/disconnect, constrain outbound
  hosts, and audit provider requests without recording credentials or sensitive
  content. Imported content is evidence, not an instruction or permission grant.
- Start with read access. Any external write capability needs its own explicit
  scope, candidate or resource binding, idempotency, and human authorization.

## Provider work items

| ID | Class | Provider | Initial capability | Authorization and boundary | Status |
| --- | --- | --- | --- | --- | --- |
| INT-0 | Shared foundation | Integration manager and adapter contract | Define the provider registry, normalized connection state, project-level grants, capability discovery, resource selection, audit/provenance, and the adapter contract before adding many services. | Isolate credentials by project/workspace; least privilege by provider and operation; transport choice (native or MCP) is a separate decision. | planned |
| INT-1 | Required baseline | Slack | Select a workspace and approved channels; retrieve relevant channel/thread context for a ticket with source links and timestamps. Consider notifications or message posting only in a later separately authorized slice. | Browser OAuth; minimum read scopes; channel selection; no message writes initially. | planned |
| INT-2 | Required baseline | Figma | Retrieve selected design file metadata, frames or design context, and comments as ticket evidence; preserve links and source provenance. | Browser OAuth; user-selected team/files; read-only initially. | planned |
| INT-3 | Situational | Google Tag Manager | Inspect selected account/container/workspace configuration and changesets to support implementation and review tasks. | Google browser OAuth; minimum account/container read scopes; publishing or submitting a workspace is a separate future write workflow with explicit human approval. | planned |
| INT-4 | Required baseline | Atlassian (Jira/Confluence) | Consolidate the existing Jira/Confluence connection and source-selection UI into the new Integrations tab. Preserve the current read-only Jira/Confluence behavior and internal ticket tracking. | Reuse the existing browser authorization flow and encrypted token storage; do not add Jira writes. | planned |
| INT-5 | Situational | GitHub or Bitbucket | Evaluate repository and pull request integration to complete the existing branch, commit, and push workflow. Prioritize the hosting provider used by the target project. | Separate provider auth and egress policy; PR creation is an outward write requiring candidate-bound authorization and idempotent delivery. | planned |
| INT-6 | Situational | Salesforce | Discover project use cases, then support selected CRM records and related context for delivery tasks; keep writes out of the initial slice. | Provider-specific browser authorization and object/record scopes; select the Salesforce org per project and restrict records/fields to the approved use case. | planned |
| INT-7 | Situational | Cookie consent manager (for example, CookieYes or Cookiebot) | Identify the CMP used by each project and evaluate reading consent configuration, categories, and scan/audit findings. Choose one provider for a focused first adapter after API and account-access discovery. | Provider-specific auth and site/container selection; no production banner or consent-policy publishing in the initial slice. | planned |

## Shared acceptance evidence

- Each provider has tested connect, consent, callback, refresh, disconnect,
  revoked-token, insufficient-scope, provider-outage, and no-account states.
- The Integrations tab works at desktop and narrow viewport sizes and clearly
  distinguishes linked accounts and granted access.
- API calls use only the selected account/resources and documented minimum
  scopes. Tokens and private content do not enter prompts, browser storage,
  telemetry, or logs.
- Read-only access cannot invoke a write endpoint. Any later write feature has
  separate authorization, resource binding, confirmation, audit, and replay-safe
  behavior.
- Provider fixtures cover deterministic tests; live checks use a dedicated test
  account and record exactly which provider actions were exercised.

## Additional situational candidate

GitHub/Bitbucket is a recommended situational connector because the orchestrator
already manages local Git delivery and the beta plan identifies pull request
creation as a possible next delivery step. It should follow the provider used by
the active project, not add both integrations without a demonstrated need.

Slack, Jira/Confluence, and Figma form the required baseline. Salesforce, cookie
consent platforms, GTM, and remote Git hosting are situational. The integration
manager should enable only the relevant situational adapters for a project
instead of adding every provider to every role pack. Missing baseline connections
block project readiness; missing situational connectors remain non-blocking for
unrelated workflows.
