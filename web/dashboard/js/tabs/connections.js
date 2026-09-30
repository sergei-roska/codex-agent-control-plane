// --- CONNECTIONS & MODELS TAB ---

const PROVIDER_MODELS = {
  "Gemini (Google)": [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.0-flash-thinking", name: "Gemini 2.0 Flash Thinking" },
    { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
    { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" }
  ],
  "Claude (Anthropic)": [
    { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
    { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
    { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
    { id: "claude-3-opus", name: "Claude 3 Opus" }
  ],
  "Codex (OpenAI)": [
    { id: "o3-mini", name: "o3-mini" },
    { id: "o1", name: "o1" },
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" }
  ],
  "DeepSeek (DeepSeek AI)": [
    { id: "deepseek-reasoner", name: "DeepSeek R1 (Reasoner)" },
    { id: "deepseek-chat", name: "DeepSeek V3 (Chat)" }
  ],
  "Qwen 2.5 (Alibaba)": [
    { id: "qwen-2.5-coder-32b", name: "Qwen 2.5 Coder 32B" },
    { id: "qwen-2.5-72b", name: "Qwen 2.5 72B Instruct" },
    { id: "qwen-max", name: "Qwen Max" }
  ],
  "Ollama (Local Node)": [
    { id: "qwen2.5-coder:14b", name: "Qwen 2.5 Coder 14B" },
    { id: "llama3.3:70b", name: "Llama 3.3 70B" },
    { id: "deepseek-r1:14b", name: "DeepSeek R1 14B" },
    { id: "mistral:latest", name: "Mistral 7B" }
  ],
  "Groq (LPU Engine)": [
    { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile" },
    { id: "deepseek-r1-distill-llama-70b", name: "DeepSeek R1 Distill 70B" },
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant" }
  ],
  "Mistral AI": [
    { id: "codestral-latest", name: "Codestral Latest" },
    { id: "mistral-large-latest", name: "Mistral Large 2411" },
    { id: "mistral-small-latest", name: "Mistral Small" }
  ],
  "xAI (Grok)": [
    { id: "grok-2-1212", name: "Grok 2" },
    { id: "grok-2-vision-1212", name: "Grok 2 Vision" },
    { id: "grok-beta", name: "Grok Beta" }
  ],
  "OpenRouter": [
    { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet (Router)" },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1 (Router)" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B (Router)" }
  ],
  "Together AI": [
    { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1 (Together)" },
    { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo" }
  ],
  "LM Studio / vLLM (Local)": [
    { id: "local-model", name: "Loaded Local Model" },
    { id: "qwen2.5-coder", name: "Qwen 2.5 Coder (Local)" }
  ]
};

const PROVIDER_ICONS = {
  "claude": "&#x1F916;",
  "codex": "&#x26A1;",
  "gemini": "&#x2728;",
  "deepseek": "&#x1F9E0;",
  "qwen": "&#x1F30F;",
  "ollama": "&#x1F4BB;",
  "groq": "&#x26A1;",
  "mistral": "&#x1F3A8;",
  "xai": "&#x2728;",
  "openrouter": "&#x1F500;",
  "together": "&#x1F91D;",
  "lmstudio": "&#x1F4BE;",
  "custom": "&#x2699;&#xFE0F;"
};

function getProviderIcon(provider) {
  const provId = provider.id || '';
  if (provId.includes('claude')) return PROVIDER_ICONS['claude'];
  if (provId.includes('codex')) return PROVIDER_ICONS['codex'];
  if (provId.includes('gemini')) return PROVIDER_ICONS['gemini'];
  if (provId.includes('deepseek')) return PROVIDER_ICONS['deepseek'];
  if (provId.includes('qwen')) return PROVIDER_ICONS['qwen'];
  if (provId.includes('ollama')) return PROVIDER_ICONS['ollama'];
  if (provId.includes('groq')) return PROVIDER_ICONS['groq'];
  if (provId.includes('mistral')) return PROVIDER_ICONS['mistral'];
  if (provId.includes('xai')) return PROVIDER_ICONS['xai'];
  if (provId.includes('openrouter')) return PROVIDER_ICONS['openrouter'];
  if (provId.includes('together')) return PROVIDER_ICONS['together'];
  if (provId.includes('lmstudio')) return PROVIDER_ICONS['lmstudio'];
  return PROVIDER_ICONS['custom'] || '&#x2699;&#xFE0F;';
}

function renderConnections() {
  const grid = document.getElementById('providers-grid');
  if (grid) {
    grid.innerHTML = state.providers.map(p => {
      const isCore = ['claude', 'codex', 'gemini'].includes(p.id);
      const icon = getProviderIcon(p);

      const methodTag = p.method === 'oauth' ? 'OAuth 2.0 CLI' : 'API Key';
      let badge = `<span class="status-badge connected">Connected</span>`;
      let btnHtml = `
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary btn-reauth" data-id="${p.id}" style="flex:1; font-size:11px;">Configure / Reauth</button>
          <button class="btn btn-danger btn-disconnect" data-id="${p.id}" style="flex:1; font-size:11px;">Disconnect</button>
          ${!isCore ? `<button class="btn btn-secondary btn-remove-provider" data-id="${p.id}" title="Remove Provider" style="padding:6px 10px; font-size:11px; color:var(--accent-red);">&#x1F5D1;</button>` : ''}
        </div>
      `;

      if (p.status === 'disconnected') {
        badge = `<span class="status-badge disconnected">Disconnected</span>`;
        btnHtml = `
          <div style="display:flex; gap:8px;">
            <button class="btn btn-primary btn-connect" data-id="${p.id}" style="flex:1;">Connect / Configure</button>
            ${!isCore ? `<button class="btn btn-secondary btn-remove-provider" data-id="${p.id}" title="Remove Provider" style="padding:6px 10px; font-size:11px; color:var(--accent-red);">&#x1F5D1;</button>` : ''}
          </div>
        `;
      }

      return `
        <div class="provider-card">
          <div class="provider-header">
            <div style="display:flex; align-items:center; gap:10px;">
              <div class="provider-icon-badge">${icon}</div>
              <div>
                <div class="provider-title">${p.name}</div>
                <div style="font-size:10px; color:var(--text-muted); font-weight:600; margin-top:2px;">${p.tag || 'AI Agent Provider'} &bull; <span style="color:var(--accent-blue); font-family:var(--font-mono);">${methodTag}</span></div>
              </div>
            </div>
            ${badge}
          </div>
          <p style="font-size:12px; color:var(--text-secondary); margin:0;">CLI agent daemon &amp; protocol configured for dispatch.</p>
          <div style="margin-top:auto;">${btnHtml}</div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.btn-connect').forEach(btn => {
      btn.addEventListener('click', () => {
        if (typeof openProviderModalForEdit === 'function') {
          openProviderModalForEdit(btn.dataset.id);
        } else {
          const p = state.providers.find(x => x.id === btn.dataset.id);
          if (p) { p.status = 'connected'; renderConnections(); }
        }
      });
    });

    grid.querySelectorAll('.btn-disconnect').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = state.providers.find(x => x.id === btn.dataset.id);
        if (p) { p.status = 'disconnected'; renderConnections(); }
      });
    });

    grid.querySelectorAll('.btn-reauth').forEach(btn => {
      btn.addEventListener('click', () => {
        if (typeof openProviderModalForEdit === 'function') {
          openProviderModalForEdit(btn.dataset.id);
        } else {
          alert("Provider handshake verified successfully.");
        }
      });
    });

    grid.querySelectorAll('.btn-remove-provider').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.id;
        const targetProv = state.providers.find(x => x.id === targetId);
        if (targetProv && confirm(`Remove provider "${targetProv.name}"?`)) {
          state.providers = state.providers.filter(x => x.id !== targetId);

          // Reset any role default referencing removed provider to Gemini Pro
          Object.keys(state.roleDefaults).forEach(role => {
            if (state.roleDefaults[role].provider === targetProv.name) {
              state.roleDefaults[role].provider = "Gemini (Google)";
              state.roleDefaults[role].model = "gemini-2.5-pro";
            }
          });

          renderConnections();
          if (typeof renderSidebarRoles === 'function') renderSidebarRoles();
        }
      });
    });
  }

  const tbody = document.getElementById('role-defaults-body');
  if (tbody) {
    tbody.innerHTML = ROLES.map(role => {
      const current = state.roleDefaults[role];
      const isProviderConnected = state.providers.some(p => p.name === current.provider && p.status === 'connected');
      const warningBadge = !isProviderConnected ? `<span class="badge" style="color:var(--accent-red);">Offline</span>` : `<span class="badge" style="color:var(--accent-green);">Ready</span>`;
      const roleDisplayName = (typeof ROLE_NAMES !== 'undefined' && ROLE_NAMES[role]) ? ROLE_NAMES[role] : role;
      const roleIcon = (typeof ROLE_ICONS !== 'undefined' && ROLE_ICONS[role]) ? ROLE_ICONS[role] : '';

      const providerOptions = state.providers.map(p => {
        const methodTag = p.method === 'oauth' ? 'OAuth' : 'API';
        return `<option value="${p.name}" ${current.provider === p.name ? 'selected' : ''}>${p.name} [${methodTag}]</option>`;
      }).join('');

      const availableModels = PROVIDER_MODELS[current.provider] || [
        { id: current.model || 'gemini-2.5-pro', name: typeof formatModelName === 'function' ? formatModelName(current.model || 'gemini-2.5-pro') : (current.model || 'gemini-2.5-pro') }
      ];
      const modelIds = availableModels.map(m => m.id);
      if (!modelIds.includes(current.model)) {
        current.model = availableModels[0].id;
      }

      const modelOptions = availableModels.map(m => `
        <option value="${m.id}" ${current.model === m.id ? 'selected' : ''}>${m.name}</option>
      `).join('');

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:16px;">${roleIcon}</span>
              <div>
                <div style="font-weight:700; color:var(--text-primary); font-size:13px;">${roleDisplayName}</div>
                <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${role}</div>
              </div>
            </div>
          </td>
          <td>
            <select class="select-input role-provider-select" data-role="${role}">
              ${providerOptions}
            </select>
          </td>
          <td>
            <select class="select-input role-model-select" data-role="${role}">
              ${modelOptions}
            </select>
          </td>
          <td>
            <select class="select-input role-tier-select" data-role="${role}">
              <option value="max" ${current.tier === 'max' ? 'selected' : ''}>High Effort</option>
              <option value="elevated" ${current.tier === 'elevated' ? 'selected' : ''}>Medium Effort</option>
              <option value="default" ${current.tier === 'default' ? 'selected' : ''}>Low Effort</option>
            </select>
          </td>
          <td style="text-align: center;">${warningBadge}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.role-provider-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const role = e.target.dataset.role;
        const newProv = e.target.value;
        state.roleDefaults[role].provider = newProv;
        const models = PROVIDER_MODELS[newProv] || [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }];
        state.roleDefaults[role].model = models[0].id;
        renderConnections();
        if (typeof renderSidebarRoles === 'function') renderSidebarRoles();
      });
    });

    tbody.querySelectorAll('.role-model-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const role = e.target.dataset.role;
        state.roleDefaults[role].model = e.target.value;
        if (typeof renderSidebarRoles === 'function') renderSidebarRoles();
      });
    });

    tbody.querySelectorAll('.role-tier-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const role = e.target.dataset.role;
        state.roleDefaults[role].tier = e.target.value;
      });
    });
  }
}
