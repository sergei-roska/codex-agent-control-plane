// --- PREVIEW-ONLY ROLE ROSTER & ICONS (prototype tabs; Board/Sidebar use GET /roles) ---
const ROLES = [
  "project-manager",
  "architect",
  "developer",
  "devops",
  "performance",
  "qa",
  "reviewer",
  "security",
  "tech-writer"
];

const ROLE_NAMES = {
  "project-manager": "Project Manager",
  "architect": "Architect",
  "developer": "Developer",
  "devops": "DevOps Engineer",
  "performance": "Performance Engineer",
  "qa": "QA Engineer",
  "reviewer": "Code Reviewer",
  "security": "Security Engineer",
  "tech-writer": "Technical Writer"
};

const ROLE_ICONS = {
  "project-manager": "&#x1F4CB;",       // Clipboard / Delivery Lead & Intake
  "architect": "&#x1F3DB;&#xFE0F;",    // Classical Building / Architecture
  "developer": "&#x1F4BB;",            // Laptop / Code
  "devops": "&#x2699;&#xFE0F;",        // Gear / Infrastructure
  "performance": "&#x26A1;",           // High Voltage / Fast
  "qa": "&#x1F9EA;",                   // Test Tube / QA
  "reviewer": "&#x1F50D;",             // Magnifying glass / Code Review
  "security": "&#x1F6E1;&#xFE0F;",     // Shield / Guardrail
  "tech-writer": "&#x1F4DD;"          // Memo / Docs
};

const ROLE_COLORS = {
  "project-manager": "#f97316",
  "architect": "var(--accent-blue)",
  "developer": "var(--accent-green)",
  "devops": "var(--accent-amber)",
  "performance": "var(--accent-crimson, #e11d48)",
  "qa": "var(--accent-cyan)",
  "reviewer": "var(--accent-purple)",
  "security": "var(--accent-red)",
  "tech-writer": "#6366f1"
};

// --- STATE MANAGEMENT ---
// Fixture data below (tickets, pipelines, logs, decisions, ...) feeds only the prototype preview tabs.
const state = {
  activeTab: 'tab-board',
  boardView: 'status',
  providers: [
    { id: 'claude', name: 'Claude (Anthropic)', status: 'connected', tag: 'Flagship / Reasoning', method: 'oauth', endpoint: 'https://api.anthropic.com/v1' },
    { id: 'codex', name: 'Codex (OpenAI)', status: 'connected', tag: 'Flagship / o-Series', method: 'oauth', endpoint: 'https://api.openai.com/v1' },
    { id: 'gemini', name: 'Gemini (Google)', status: 'connected', tag: 'Flagship / Multimodal', method: 'api', endpoint: 'https://generativelanguage.googleapis.com/v1beta' }
  ],
  roleDefaults: {
    "project-manager": { provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "max" },
    "architect": { provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "max" },
    "developer": { provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "max" },
    "devops": { provider: "Gemini (Google)", model: "gemini-2.5-flash", tier: "default" },
    "performance": { provider: "Gemini (Google)", model: "gemini-2.5-flash", tier: "default" },
    "qa": { provider: "Gemini (Google)", model: "gemini-2.5-flash", tier: "default" },
    "reviewer": { provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "elevated" },
    "security": { provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "max" },
    "tech-writer": { provider: "Gemini (Google)", model: "gemini-2.5-flash", tier: "default" }
  },
  tickets: [
    {
      id: "TICKET-141",
      title: "Normalize requirements & sprint intake baseline",
      description: "Perform dual-track intake triage, generate WBS/INVEST packages, and evaluate Definition of Ready.",
      role: "project-manager",
      status: "done",
      priority: "High",
      created: "2026-08-21 09:30",
      metrics: {
        totalCost: 0.0462,
        promptCost: 0.0247,
        completionCost: 0.0215,
        totalTokens: 24100,
        promptTokens: 19800,
        completionTokens: 4300,
        cachedTokens: 8200,
        roleBreakdown: [
          {
            role: "project-manager",
            provider: "Gemini (Google)",
            model: "gemini-2.5-pro",
            promptTokens: 19800,
            completionTokens: 4300,
            totalTokens: 24100,
            cost: 0.0462,
            percentage: 100.0
          }
        ]
      },
      attempts: [
        { num: 1, role: "project-manager", provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "max", outcome: "Succeeded", started: "09:30:15", finished: "09:34:00" }
      ],
      runLog: [
        "09:30:15 - Intake triage initiated for sprint roadmap",
        "09:32:00 - WBS decomposition and INVEST story slicing completed",
        "09:34:00 - Handed off ready work packages to Architect. Status changed to done."
      ],
      turns: [
        { type: "Thought", content: "Evaluating Definition of Ready and calculating CPM schedule baseline." },
        { type: "Action", content: "route_subagents(target='architect')" },
        { type: "Observation", content: "Handoff acknowledged." }
      ]
    },
    {
      id: "TICKET-142",
      title: "Design orchestrator state machine & event bus",
      description: "Define the core state machine transitions between 9 roles and persistent JSON schema.",
      role: "architect",
      status: "done",
      priority: "High",
      created: "2026-08-21 10:15",
      metrics: {
        totalCost: 0.0682,
        promptCost: 0.0435,
        completionCost: 0.0247,
        totalTokens: 53850,
        promptTokens: 44700,
        completionTokens: 9150,
        cachedTokens: 18400,
        roleBreakdown: [
          {
            role: "architect",
            provider: "Gemini (Google)",
            model: "gemini-2.5-pro",
            promptTokens: 14200,
            completionTokens: 3850,
            totalTokens: 18050,
            cost: 0.0370,
            percentage: 54.3
          },
          {
            role: "reviewer",
            provider: "Gemini (Google)",
            model: "gemini-2.5-pro",
            promptTokens: 18500,
            completionTokens: 1200,
            totalTokens: 19700,
            cost: 0.0291,
            percentage: 42.7
          },
          {
            role: "tech-writer",
            provider: "Gemini (Google)",
            model: "gemini-2.5-flash",
            promptTokens: 12000,
            completionTokens: 4100,
            totalTokens: 16100,
            cost: 0.0021,
            percentage: 3.0
          }
        ]
      },
      attempts: [
        { num: 1, role: "architect", provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "max", outcome: "Succeeded", started: "10:15:20", finished: "10:18:40" }
      ],
      runLog: [
        "10:15:20 - Claimed ticket TICKET-142",
        "10:16:00 - Generating state machine diagram",
        "10:18:40 - Output validated. Status changed to done."
      ],
      turns: [
        { type: "Thought", content: "Need to verify role taxonomy across universal multi-cli packs." },
        { type: "Action", content: "view_file('agents/architect.md')" },
        { type: "Observation", content: "All 9 roles matched exactly." }
      ]
    },
    {
      id: "TICKET-143",
      title: "Implement MySQL MCP read-only guardrail",
      description: "Ensure that local-memory and MySQL connections enforce strict read-only queries.",
      role: "security",
      status: "in_progress",
      priority: "High",
      created: "2026-08-21 11:30",
      metrics: {
        totalCost: 0.0535,
        promptCost: 0.0280,
        completionCost: 0.0255,
        totalTokens: 27500,
        promptTokens: 22400,
        completionTokens: 5100,
        cachedTokens: 14000,
        roleBreakdown: [
          {
            role: "security",
            provider: "Gemini (Google)",
            model: "gemini-2.5-pro",
            promptTokens: 22400,
            completionTokens: 5100,
            totalTokens: 27500,
            cost: 0.0535,
            percentage: 100.0
          }
        ]
      },
      attempts: [
        { num: 1, role: "security", provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "max", outcome: "In Progress", started: "11:30:10", finished: "-" }
      ],
      runLog: [
        "11:30:10 - Running static security scanner on mcp/mcp-servers.json",
        "11:32:00 - Checking environment variable fallback guards"
      ],
      turns: [
        { type: "Thought", content: "Scanning mcp configs for fallback credentials." },
        { type: "Action", content: "grep_search('MYSQL_')" },
        { type: "Observation", content: "Credentials come strictly from environment." }
      ]
    },
    {
      id: "TICKET-144",
      title: "Database schema migration execution",
      description: "Execute schema updates on staging database instance for session persistence.",
      role: "devops",
      status: "waiting_human",
      priority: "High",
      created: "2026-08-21 12:00",
      metrics: {
        totalCost: 0.0011,
        promptCost: 0.0006,
        completionCost: 0.0005,
        totalTokens: 10000,
        promptTokens: 8400,
        completionTokens: 1600,
        cachedTokens: 4200,
        roleBreakdown: [
          {
            role: "devops",
            provider: "Gemini (Google)",
            model: "gemini-2.5-flash",
            promptTokens: 8400,
            completionTokens: 1600,
            totalTokens: 10000,
            cost: 0.0011,
            percentage: 100.0
          }
        ]
      },
      attempts: [
        { num: 1, role: "devops", provider: "Gemini (Google)", model: "gemini-2.5-flash", tier: "default", outcome: "In Progress", started: "12:00:05", finished: "-" }
      ],
      runLog: [
        "12:00:05 - Staging environment prepared",
        "12:01:00 - Escalated to human operator: DB migration requires explicit approval."
      ],
      turns: [
        { type: "Thought", content: "Applying schema requires human verification." },
        { type: "Action", content: "trigger_escalation(id='ESC-901')" }
      ]
    },
    {
      id: "TICKET-145",
      title: "Benchmark memory search indexing latency",
      description: "Profile LanceDB vector search against 50k local embeddings.",
      role: "performance",
      status: "blocked",
      priority: "Normal",
      created: "2026-08-21 13:20",
      metrics: {
        totalCost: 0.0317,
        promptCost: 0.0240,
        completionCost: 0.0077,
        totalTokens: 38200,
        promptTokens: 34700,
        completionTokens: 3500,
        cachedTokens: 9600,
        roleBreakdown: [
          {
            role: "performance",
            provider: "Gemini (Google)",
            model: "gemini-2.5-flash (Attempt 1)",
            promptTokens: 16500,
            completionTokens: 2100,
            totalTokens: 18600,
            cost: 0.0019,
            percentage: 6.0
          },
          {
            role: "performance",
            provider: "Gemini (Google)",
            model: "gemini-2.5-pro (Attempt 2)",
            promptTokens: 18200,
            completionTokens: 1400,
            totalTokens: 19600,
            cost: 0.0298,
            percentage: 94.0
          }
        ]
      },
      attempts: [
        { num: 1, role: "performance", provider: "Gemini (Google)", model: "gemini-2.5-flash", tier: "default", outcome: "Failed", started: "13:20:10", finished: "13:22:15" },
        { num: 2, role: "performance", provider: "Gemini (Google)", model: "gemini-2.5-pro", tier: "max", outcome: "In Progress", started: "13:25:00", finished: "-" }
      ],
      runLog: [
        "13:20:10 - Profiling lance indexer memory",
        "13:22:15 - Process blocked: LanceDB lockfile timeout."
      ],
      turns: [
        { type: "Thought", content: "Index lock held by another process." }
      ]
    },
    {
      id: "TICKET-146",
      title: "Write technical reference for role agent console",
      description: "Compile final API documentation and user guide in markdown format.",
      role: "tech-writer",
      status: "backlog",
      priority: "Normal",
      created: "2026-08-21 14:00",
      metrics: {
        totalCost: 0,
        promptCost: 0,
        completionCost: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        roleBreakdown: []
      },
      attempts: [],
      runLog: [
        "14:00:00 - Ticket created in Backlog. Awaiting prioritization."
      ],
      turns: []
    },
    {
      id: "TICKET-147",
      title: "Implement rate limiter MCP tool and Redis token bucket",
      description: "Create rate limiter tool with sliding window algorithm for LLM provider failover.",
      acceptanceCriteria: "- Limit requests per minute according to provider tier\n- Graceful fallback on token exhaustion\n- Unit tests coverage >= 95%",
      role: "developer",
      status: "pending",
      priority: "High",
      jiraIssue: "PROJ-244",
      jiraParents: "EPIC-10",
      confluence: "https://wiki.corp.internal/spec/rate-limiter",
      created: "2026-08-21 14:30",
      metrics: {
        totalCost: 0,
        promptCost: 0,
        completionCost: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        roleBreakdown: []
      },
      attempts: [],
      runLog: [
        "14:30:00 - Moved to Pending queue by Operator. Ready for agent dispatch."
      ],
      turns: []
    }
  ],

  pipelines: [
    {
      id: "PIPE-01",
      name: "Feature Pipeline: Orchestrator Core",
      steps: [
        { role: "project-manager", status: "succeeded" },
        { role: "architect", status: "succeeded" },
        { role: "developer", status: "succeeded" },
        { role: "reviewer", status: "running" },
        { role: "qa", status: "pending" }
      ]
    },
    {
      id: "PIPE-02",
      name: "Security & Deployment Audit",
      steps: [
        { role: "security", status: "running" },
        { role: "devops", status: "pending" },
        { role: "tech-writer", status: "pending" }
      ]
    }
  ],
  logs: [
    { time: "14:10:05", type: "agent", role: "architect", ticket: "TICKET-142", msg: "Architecture decision record ADR-002 published.", level: "info" },
    { time: "14:12:30", type: "agent", role: "security", ticket: "TICKET-143", msg: "Scanning dependencies for CVE disclosures.", level: "info" },
    { time: "14:13:15", type: "system", role: "system", ticket: "SYSTEM", msg: "MCP server 'mysql-mcp' healthcheck OK (latency 12ms).", level: "info" },
    { time: "14:15:10", type: "agent", role: "devops", ticket: "TICKET-144", msg: "Waiting for human approval on staging DB migration.", level: "warning" },
    { time: "14:17:02", type: "system", role: "system", ticket: "SYSTEM", msg: "Circuit breaker retry counter incremented for worker pool alpha.", level: "warning" },
    { time: "14:18:42", type: "agent", role: "performance", ticket: "TICKET-145", msg: "LanceDB lockfile timeout detected during benchmark.", level: "error" },
    { time: "14:19:30", type: "system", role: "system", ticket: "SYSTEM", msg: "Subprocess adapter timeout after 300s: [agy reviewer --task=TICKET-146].", level: "error" }
  ],
  decisions: [
    {
      id: "ADR-001",
      title: "Standardize on 9-Role Standard Taxonomy",
      role: "architect",
      date: "2026-08-21",
      summary: "Standardize across project-manager, architect, developer, devops, performance, qa, reviewer, security, tech-writer."
    },
    {
      id: "ADR-002",
      title: "Read-only MySQL MCP Enforcement",
      role: "security",
      date: "2026-08-21",
      summary: "Enforce strict read-only queries with explicit environment variable requirements."
    }
  ],
  escalations: [
    {
      id: "ESC-901",
      type: "command_approval",
      ticketId: "TICKET-144",
      role: "devops",
      category: "Destructive Action / Deploy",
      urgency: "High",
      reason: "Apply schema migration script to staging database",
      description: "Migration alters table schemas and indexes. Read lock required for 2-5 minutes.",
      command: "npm run db:migrate -- --env=staging --dry-run=false",
      targetEnv: "staging",
      options: {
        dryRun: true,
        snapshot: true,
        timeout: "5m"
      }
    },
    {
      id: "ESC-902",
      type: "decision_fork",
      ticketId: "TICKET-142",
      role: "architect",
      category: "Architecture Fork & Strategy",
      urgency: "Medium",
      reason: "Real-time telemetry transport protocol selection",
      description: "Architect identified 3 viable transport protocols for live agent log streaming. Human operator decision is required to lock the baseline architecture.",
      options: [
        {
          id: "opt-sse",
          title: "Server-Sent Events (SSE) via HTTP/2",
          desc: "Native browser auto-reconnect, lowest infrastructure overhead, unidirectional event streaming with HTTP/2 multiplexing.",
          tags: ["Recommended", "Low Complexity", "HTTP/2"],
          selected: true
        },
        {
          id: "opt-ws",
          title: "WebSocket Full-Duplex Gateway",
          desc: "Bidirectional JSON/binary frames, lowest latency for high-frequency traffic. Requires dedicated connection manager and Redis backplane.",
          tags: ["High Concurrency", "Bidirectional", "Extra Infra"],
          selected: false
        },
        {
          id: "opt-poll",
          title: "HTTP Short-Polling Fallback",
          desc: "Standard periodic GET requests with client caching. Simplest fallback for restrictive corporate proxy environments.",
          tags: ["Fallback Only", "Higher CPU Load"],
          selected: false
        }
      ]
    },
    {
      id: "ESC-903",
      type: "requirements_clarification",
      ticketId: "TICKET-141",
      role: "project-manager",
      category: "Ambiguous Requirements / Intake",
      urgency: "Medium",
      reason: "Clarification needed on subscription expiration & data retention policy",
      description: "Track 2 Socratic intake identified missing edge cases regarding unpaid invoice grace periods and workspace retention.",
      questions: [
        {
          id: "q_grace",
          title: "Grace period duration before workspace lock",
          type: "select",
          options: [
            "7 days with daily warning emails (Recommended)",
            "3 days soft grace period",
            "0 days (Immediate access suspension)",
            "14 days enterprise grace period"
          ]
        },
        {
          id: "q_retention",
          title: "Retention policy for agent task history & vector embeddings",
          type: "radio",
          options: [
            "Retain in cold storage for 30 days then purge (Recommended)",
            "Retain indefinitely in read-only mode",
            "Immediate hard wipe upon cancellation"
          ]
        },
        {
          id: "q_export",
          title: "Enable automated self-service GDPR / JSON data export link?",
          type: "checkbox",
          label: "Allow customer self-service export before purge",
          checked: true
        }
      ]
    },
    {
      id: "ESC-904",
      type: "credentials_request",
      ticketId: "TICKET-147",
      role: "developer",
      category: "Missing Environment Credentials",
      urgency: "High",
      reason: "Stripe Webhook Signing Secret required for payment test suite",
      description: "Unit and integration test suite requires HMAC signature verification against incoming webhook events.",
      secretKey: "STRIPE_WEBHOOK_SECRET",
      service: "Stripe Payments API",
      targetEnv: "development / test",
      scope: "read_events, webhook_sign"
    },
    {
      id: "ESC-905",
      type: "circuit_breaker",
      ticketId: "TICKET-145",
      role: "qa",
      category: "Circuit Breaker / Flaky Failure",
      urgency: "Critical",
      reason: "Automated retry limit (2/2) exhausted on Auth E2E Suite",
      description: "Circuit breaker tripped after 2 consecutive automated test failures in sandbox runner.",
      traceback: "FAIL: test_oauth_pkce_callback_flow (tests.e2e.test_auth)\nAssertionError: Expected status 200 OK, got 429 Too Many Requests.\n  File \"tests/e2e/test_auth.py\", line 84, in test_oauth_pkce_callback_flow\n    self.assertEqual(res.status_code, 200)\nAttempts: 2/2 exhausted. Circuit breaker escalated to Human-in-the-Loop.",
      strategies: [
        {
          id: "strat-retry",
          title: "Reset retry counter & rerun with 30s exponential backoff",
          desc: "Clear rate limiter mock cache and trigger attempt 1 again.",
          selected: true
        },
        {
          id: "strat-flaky",
          title: "Mark test as Quarantined Flaky & Force Pass Quality Gate",
          desc: "Bypass test failure, isolate test in quarantine suite, and proceed to Tech Writer.",
          selected: false
        },
        {
          id: "strat-abort",
          title: "Abort task & move ticket to Blocked for developer fix",
          desc: "Halt pipeline immediately and notify ticket assignee.",
          selected: false
        }
      ]
    },
    {
      id: "ESC-906",
      type: "security_override",
      ticketId: "TICKET-143",
      role: "security",
      category: "Security Exception / CVE Whitelist",
      urgency: "High",
      reason: "Vulnerability CVE-2024-21538 in build-time devDependency @rollup/plugin-terser",
      description: "Security scanner detected high severity CVE during dependency audit.",
      cveId: "CVE-2024-21538",
      severity: "High (CVSS 7.5)",
      package: "@rollup/plugin-terser@0.4.4 (devDependencies)",
      assessment: "ReDoS vulnerability occurs during code minification. Isolated to local build step only; zero runtime exposure for production end-users. Upstream patch is pending release.",
      durations: [
        "30 days temporary exception",
        "Until next minor/major release",
        "Permanent exception (Build-only devDependency)"
      ]
    },
    {
      id: "ESC-907",
      type: "scope_baseline_change",
      ticketId: "TICKET-141",
      role: "project-manager",
      category: "Scope Baseline Deviation (>30%)",
      urgency: "Medium",
      reason: "Scope expansion detected during WBS decomposition for Multi-Tenant Auth",
      description: "Initial estimate of 40 Story Points (5 days) expanded to 58 Story Points (+45% increase) due to enterprise SAML 2.0 and SCIM auto-provisioning requirements.",
      baseline: {
        originalPoints: "40 SP",
        revisedPoints: "58 SP (+45%)",
        originalDays: "5 days",
        revisedDays: "8 days (+3d)"
      },
      options: [
        {
          id: "scope-approve",
          title: "Approve Full Scope Expansion (+18 SP, +3 days)",
          desc: "Incorporate SAML 2.0 and SCIM auto-provisioning into current sprint roadmap.",
          selected: true
        },
        {
          id: "scope-mvp",
          title: "Approve MVP Only (Defer SCIM to Sprint 12)",
          desc: "Deliver SAML 2.0 only, reducing scope delta to +5 SP (1 day delay).",
          selected: false
        },
        {
          id: "scope-reject",
          title: "Reject Scope Change (Enforce Strict 40 SP Baseline)",
          desc: "Do not add enterprise auth features; keep original commitment.",
          selected: false
        }
      ]
    }
  ],
  docs: [
    {
      id: "doc-1",
      title: "Architecture-Overview.md",
      content: "# Role-Agent Console Architecture\n\n## Summary\nThe Role-Agent Console orchestrates specialized AI agents interacting through standard JSON output contracts.\n\n### 9-Role Taxonomy\n1. **project-manager**: Dual-track intake, WBS decomposition & Quality Gate orchestration.\n2. **architect**: System design & state orchestration.\n3. **developer**: Code implementation.\n4. **devops**: Deployment & runtime.\n5. **performance**: Latency & memory optimization.\n6. **qa**: Automated testing.\n7. **reviewer**: Code quality inspection.\n8. **security**: Guardrails & vulnerability checks.\n9. **tech-writer**: Documentation & specs."
    },
    {
      id: "doc-2",
      title: "Security-Guardrails.md",
      content: "# Security Guardrails & MCP Access\n\n- MySQL MCP instances are strictly read-only.\n- Sensitive database mutations require human authorization via Escalation Modal (M3).\n- Multi-provider fallback keeps pipelines fault-tolerant."
    },
    {
      id: "doc-3",
      title: "Delivery-Pipelines.md",
      content: "# Standard Delivery Pipelines & Presets\n\n## Full End-to-End Lifecycle\nGoverning workflow defined in subagent_team_spec.md and subagent_pipeline_flow.png:\nproject-manager -> architect -> developer(s) (parallel) -> Quality Gate (reviewer + qa + security in parallel) -> performance -> devops -> tech-writer -> Final Delivery.\n\n## Pipeline Presets (Specialized Subsets)\nSpecialized subsets optimized for specific task workflows:\n\n- **feature**: architect -> developer -> reviewer -> qa\n- **bugfix**: developer -> reviewer -> qa\n- **security**: security -> developer -> qa\n- **performance**: performance -> developer -> qa\n- **environment**: devops -> qa\n- **debt**: architect -> reviewer -> developer -> reviewer -> qa\n- **audit**: reviewer -> security -> performance -> architect\n- **docs**: tech-writer -> reviewer -> qa\n\n## Pipelines Tab Display\nThe Pipelines tab renders active pipeline instances, displaying step-by-step agent roles and their execution statuses."
    },
    {
      id: "doc-4",
      title: "Role-Definitions.md",
      content: "# 9-Role Taxonomy & Operational Workflows\n\n## Overview\nThe multi-agent console operates with 9 specialized roles, each with strict responsibilities and execution boundaries.\n\n### 1. project-manager (Delivery Orchestrator)\n- **What**: Intake orchestration, requirements engineering, INVEST decomposition, schedule & Quality Gate management.\n- **How**: Uses 26 PM skills to normalize raw requests, split stories (INVEST), author Gherkin criteria, and verify Definition of Ready before engineering handoff.\n\n### 2. architect (Technical Lead)\n- **What**: System design, data models, contract freezing, task decomposition, blast-radius analysis, and technical arbitration.\n- **How (Task Decomposition)**: Inspects repository AST conventions (ast-grep), locks schemas/DTOs (freeze-contract), maps requirements to exact files/symbols (decompose-task), calculates downstream impacts (analyze-blast-radius), and bounds write surfaces for parallel developer dispatch.\n\n### 3. developer (Code Implementation)\n- **What**: Feature implementation, unit test creation, refactoring.\n- **How**: Operates strictly within assigned file boundaries and frozen contracts, running in parallel instances when write surfaces are decoupled, and returns git patches with validation evidence.\n\n### 4. qa (Automated Verification)\n- **What**: Independent testing and behavioral verification.\n- **How**: Executes automated test suites and Gherkin scenarios (Given/When/Then), validates edge cases, and provides independent test verdicts.\n\n### 5. reviewer (Code Quality & Static Analysis)\n- **What**: Code inspection, architectural compliance, maintainability.\n- **How**: Audits diffs, verifies adherence to conventions, linting rules, and prevents regressions or technical debt introduction.\n\n### 6. security (Threat Modeling & Guardrails)\n- **What**: Vulnerability scanning, trust boundary mapping, MCP access safety.\n- **How**: Maps perimeter trust boundaries, checks CVEs, sanitizes inputs, and enforces read-only access for database MCPs.\n\n### 7. performance (Profiling & Optimization)\n- **What**: Latency, throughput, and memory profiling.\n- **How**: Measures cold vs warm cache baselines, profiles database queries, benchmarks critical paths, and validates NFR targets.\n\n### 8. devops (Operations & CI/CD)\n- **What**: Environment setup, containerization, build pipelines, migrations.\n- **How**: Configures Docker/Lando runtimes, automated CI workflows, reversible database migration scripts, and staging rollout checks.\n\n### 9. tech-writer (Documentation & Specs)\n- **What**: API specifications, architecture records, release notes.\n- **How**: Records ADRs in docs/adr/, updates READMEs, OpenAPI contracts, and maintainer guides based on implementation artifacts."
    }
  ],
  selectedDocId: "doc-1",
  docRawView: false
};

// --- HELPER LOGIC ---
const MODEL_DISPLAY_NAMES = {
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.0-flash-thinking': 'Gemini 2.0 Flash Thinking',
  'gemini-1.5-pro': 'Gemini 1.5 Pro',
  'gemini-1.5-flash': 'Gemini 1.5 Flash',
  'claude-3-7-sonnet': 'Claude 3.7 Sonnet',
  'claude-3-5-sonnet': 'Claude 3.5 Sonnet',
  'claude-3-5-haiku': 'Claude 3.5 Haiku',
  'claude-3-opus': 'Claude 3 Opus',
  'o3-mini': 'o3-mini',
  'o1': 'o1',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  'deepseek-r1': 'DeepSeek R1',
  'deepseek-v3': 'DeepSeek V3',
  'qwen-2.5-coder-32b': 'Qwen 2.5 Coder 32B',
  'qwen-2.5-72b': 'Qwen 2.5 72B',
  'qwen2.5-coder:14b': 'Qwen 2.5 Coder 14B',
  'llama3.3:70b': 'Llama 3.3 70B',
  'deepseek-r1:14b': 'DeepSeek R1 14B'
};

function formatModelName(modelId) {
  if (!modelId) return 'N/A';
  if (MODEL_DISPLAY_NAMES[modelId]) return MODEL_DISPLAY_NAMES[modelId];
  const attemptMatch = modelId.match(/^(.*?)(\s*\(Attempt\s*\d+\))$/i);
  if (attemptMatch && MODEL_DISPLAY_NAMES[attemptMatch[1]]) {
    return `${MODEL_DISPLAY_NAMES[attemptMatch[1]]}${attemptMatch[2]}`;
  }
  return modelId;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatInlineMd(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdown(md) {
  if (!md) return '';

  const lines = md.split('\n');
  const processedLines = [];
  let inUl = false;
  let inOl = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (/^###\s+(.*)$/.test(line)) {
      if (inUl) { processedLines.push('</ul>'); inUl = false; }
      if (inOl) { processedLines.push('</ol>'); inOl = false; }
      const text = escapeHtml(line.replace(/^###\s+/, ''));
      processedLines.push(`<h3>${formatInlineMd(text)}</h3>`);
      continue;
    }
    if (/^##\s+(.*)$/.test(line)) {
      if (inUl) { processedLines.push('</ul>'); inUl = false; }
      if (inOl) { processedLines.push('</ol>'); inOl = false; }
      const text = escapeHtml(line.replace(/^##\s+/, ''));
      processedLines.push(`<h2>${formatInlineMd(text)}</h2>`);
      continue;
    }
    if (/^#\s+(.*)$/.test(line)) {
      if (inUl) { processedLines.push('</ul>'); inUl = false; }
      if (inOl) { processedLines.push('</ol>'); inOl = false; }
      const text = escapeHtml(line.replace(/^#\s+/, ''));
      processedLines.push(`<h1>${formatInlineMd(text)}</h1>`);
      continue;
    }

    // Unordered List Items
    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (ulMatch) {
      if (inOl) { processedLines.push('</ol>'); inOl = false; }
      if (!inUl) { processedLines.push('<ul>'); inUl = true; }
      const text = escapeHtml(ulMatch[1]);
      processedLines.push(`<li>${formatInlineMd(text)}</li>`);
      continue;
    }

    // Ordered List Items
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (olMatch) {
      if (inUl) { processedLines.push('</ul>'); inUl = false; }
      if (!inOl) { processedLines.push('<ol>'); inOl = true; }
      const text = escapeHtml(olMatch[1]);
      processedLines.push(`<li>${formatInlineMd(text)}</li>`);
      continue;
    }

    // Close any open lists on normal lines
    if (inUl) { processedLines.push('</ul>'); inUl = false; }
    if (inOl) { processedLines.push('</ol>'); inOl = false; }

    if (line.trim() !== '') {
      const escaped = escapeHtml(line);
      processedLines.push(`<p>${formatInlineMd(escaped)}</p>`);
    }
  }

  if (inUl) processedLines.push('</ul>');
  if (inOl) processedLines.push('</ol>');

  return processedLines.join('\n');
}
