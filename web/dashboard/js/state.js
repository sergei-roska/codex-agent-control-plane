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
// Fixture data below feeds only non-API prototype preview tabs (not decisions or docs).
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
        totalCost: null,
        promptCost: null,
        completionCost: null,
        totalTokens: null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        roleBreakdown: []
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
        totalCost: null,
        promptCost: null,
        completionCost: null,
        totalTokens: null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        roleBreakdown: []
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
        totalCost: null,
        promptCost: null,
        completionCost: null,
        totalTokens: null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        roleBreakdown: []
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
        totalCost: null,
        promptCost: null,
        completionCost: null,
        totalTokens: null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        roleBreakdown: []
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
        totalCost: null,
        promptCost: null,
        completionCost: null,
        totalTokens: null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        roleBreakdown: []
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
        totalCost: null,
        promptCost: null,
        completionCost: null,
        totalTokens: null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
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
        totalCost: null,
        promptCost: null,
        completionCost: null,
        totalTokens: null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
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
  logs: [],
  decisions: [],
  escalations: [],
  docs: [],
  selectedDocId: null,
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
