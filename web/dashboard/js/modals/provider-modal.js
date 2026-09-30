// --- ADD & CONFIGURE PROVIDER MODAL (OPENCODE / KILOCODE STYLE) ---

const PRESET_PROVIDERS = {
  "claude": {
    name: "Claude (Anthropic)",
    tag: "Flagship / Reasoning",
    defaultMethod: "oauth",
    endpoint: "https://api.anthropic.com/v1",
    oauthProfiles: [
      { id: "claude-cli", name: "Claude Code CLI (claude auth login)" },
      { id: "anthropic-console", name: "Anthropic Console OAuth (SSO)" },
      { id: "device-auth", name: "Device Code Flow (Browser Auth)" }
    ],
    models: [
      { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
      { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
      { id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
      { id: "claude-3-opus", name: "Claude 3 Opus" }
    ]
  },
  "codex": {
    name: "Codex (OpenAI)",
    tag: "Flagship / o-Series",
    defaultMethod: "oauth",
    endpoint: "https://api.openai.com/v1",
    oauthProfiles: [
      { id: "codex-cli", name: "OpenAI Codex CLI (codex login)" },
      { id: "chatgpt-oauth", name: "ChatGPT Plus / Team OAuth" },
      { id: "azure-entra", name: "Azure OpenAI Entra ID OAuth" }
    ],
    models: [
      { id: "o3-mini", name: "o3-mini" },
      { id: "o1", name: "o1" },
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini" }
    ]
  },
  "gemini": {
    name: "Gemini (Google)",
    tag: "Flagship / Multimodal",
    defaultMethod: "api",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    oauthProfiles: [
      { id: "gcloud-auth", name: "Google Cloud CLI (gcloud auth)" },
      { id: "gemini-cli", name: "Gemini CLI Session (gemini login)" },
      { id: "google-workspace", name: "Google Workspace / Vertex SSO" }
    ],
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.0-flash-thinking", name: "Gemini 2.0 Flash Thinking" },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" }
    ]
  },
  "deepseek": {
    name: "DeepSeek (DeepSeek AI)",
    tag: "Asian / Reasoner",
    defaultMethod: "api",
    endpoint: "https://api.deepseek.com/v1",
    oauthProfiles: [
      { id: "deepseek-cli", name: "DeepSeek CLI Daemon (agnt login)" },
      { id: "deepseek-cloud", name: "DeepSeek Cloud Platform OAuth" }
    ],
    models: [
      { id: "deepseek-reasoner", name: "DeepSeek R1 (Reasoner)" },
      { id: "deepseek-chat", name: "DeepSeek V3 (Chat)" }
    ]
  },
  "qwen": {
    name: "Qwen 2.5 (Alibaba)",
    tag: "Asian / Cloud",
    defaultMethod: "api",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    oauthProfiles: [
      { id: "aliyun-cli", name: "Alibaba Cloud CLI (aliyun auth)" },
      { id: "dashscope-oauth", name: "DashScope Enterprise SSO" }
    ],
    models: [
      { id: "qwen-2.5-coder-32b", name: "Qwen 2.5 Coder 32B" },
      { id: "qwen-2.5-72b", name: "Qwen 2.5 72B Instruct" },
      { id: "qwen-max", name: "Qwen Max" }
    ]
  },
  "ollama": {
    name: "Ollama (Local Node)",
    tag: "Local CLI",
    defaultMethod: "api",
    endpoint: "http://localhost:11434/v1",
    oauthProfiles: [
      { id: "ollama-cli", name: "Local Ollama Node Daemon" },
      { id: "tailscale-node", name: "Tailscale Local Mesh Node" }
    ],
    models: [
      { id: "qwen2.5-coder:14b", name: "Qwen 2.5 Coder 14B" },
      { id: "llama3.3:70b", name: "Llama 3.3 70B" },
      { id: "deepseek-r1:14b", name: "DeepSeek R1 14B" },
      { id: "mistral:latest", name: "Mistral 7B" }
    ]
  },
  "groq": {
    name: "Groq (LPU Engine)",
    tag: "Fast LPU",
    defaultMethod: "api",
    endpoint: "https://api.groq.com/openai/v1",
    oauthProfiles: [
      { id: "groq-cli", name: "Groq CLI Cloud Token" },
      { id: "groq-sso", name: "Groq Enterprise SSO" }
    ],
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile" },
      { id: "deepseek-r1-distill-llama-70b", name: "DeepSeek R1 Distill 70B" },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant" }
    ]
  },
  "mistral": {
    name: "Mistral AI",
    tag: "European Flagship",
    defaultMethod: "api",
    endpoint: "https://api.mistral.ai/v1",
    oauthProfiles: [
      { id: "mistral-cli", name: "Mistral CLI Auth Handshake" },
      { id: "la-plateforme-sso", name: "La Plateforme SSO" }
    ],
    models: [
      { id: "codestral-latest", name: "Codestral Latest" },
      { id: "mistral-large-latest", name: "Mistral Large 2411" },
      { id: "mistral-small-latest", name: "Mistral Small" }
    ]
  },
  "xai": {
    name: "xAI (Grok)",
    tag: "Reasoner",
    defaultMethod: "api",
    endpoint: "https://api.x.ai/v1",
    oauthProfiles: [
      { id: "xai-cli", name: "xAI CLI Token Session" },
      { id: "x-sso", name: "X / xAI SSO Authentication" }
    ],
    models: [
      { id: "grok-2-1212", name: "Grok 2" },
      { id: "grok-2-vision-1212", name: "Grok 2 Vision" },
      { id: "grok-beta", name: "Grok Beta" }
    ]
  },
  "openrouter": {
    name: "OpenRouter",
    tag: "Unified Router",
    defaultMethod: "api",
    endpoint: "https://openrouter.ai/api/v1",
    oauthProfiles: [
      { id: "openrouter-cli", name: "OpenRouter PKCE CLI Auth" },
      { id: "openrouter-oauth", name: "OpenRouter OAuth 2.0 Handshake" }
    ],
    models: [
      { id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet (Router)" },
      { id: "deepseek/deepseek-r1", name: "DeepSeek R1 (Router)" },
      { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B (Router)" }
    ]
  },
  "together": {
    name: "Together AI",
    tag: "Open Source Engine",
    defaultMethod: "api",
    endpoint: "https://api.together.xyz/v1",
    oauthProfiles: [
      { id: "together-cli", name: "Together CLI Auth Handshake" },
      { id: "together-sso", name: "Together AI SSO" }
    ],
    models: [
      { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1 (Together)" },
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Turbo" }
    ]
  },
  "lmstudio": {
    name: "LM Studio / vLLM (Local)",
    tag: "Local Inference",
    defaultMethod: "api",
    endpoint: "http://localhost:1234/v1",
    oauthProfiles: [
      { id: "lmstudio-daemon", name: "LM Studio Server Daemon" },
      { id: "vllm-endpoint", name: "Local vLLM Socket Endpoint" }
    ],
    models: [
      { id: "local-model", name: "Loaded Local Model" },
      { id: "qwen2.5-coder", name: "Qwen 2.5 Coder (Local)" }
    ]
  },
  "custom": {
    name: "Custom OpenAI-Compatible",
    tag: "Custom API",
    defaultMethod: "api",
    endpoint: "https://api.custom-ai.internal/v1",
    oauthProfiles: [
      { id: "custom-oauth", name: "Custom OAuth 2.0 / OIDC Provider" },
      { id: "custom-cli", name: "Custom CLI Auth Script" }
    ],
    models: [
      { id: "custom-model", name: "Custom Model (Default)" }
    ]
  }
};

let activePresetKey = 'claude';
let activeMethod = 'api';
let isOAuthAuthorized = false;

function validateProviderName() {
  const nameInput = document.getElementById('provider-name-input');
  const nameError = document.getElementById('provider-name-error');
  const submitBtn = document.getElementById('btn-submit-add-provider');
  const editIdInput = document.getElementById('provider-edit-id');
  if (!nameInput) return true;

  const name = nameInput.value.trim();
  const editId = editIdInput ? editIdInput.value.trim() : '';

  if (!name) {
    if (nameError) nameError.style.display = 'none';
    nameInput.style.borderColor = '';
    return false;
  }

  const isDuplicate = state.providers.some(p =>
    p.id !== editId && p.name.trim().toLowerCase() === name.toLowerCase()
  );

  if (isDuplicate) {
    if (nameError) {
      nameError.style.display = 'block';
      nameError.textContent = `A provider named "${name}" already exists. Please choose a unique name (e.g. "${name} (Work)" or "${name} (Home)").`;
    }
    nameInput.style.borderColor = 'var(--accent-red)';
    if (submitBtn) submitBtn.disabled = true;
    return false;
  } else {
    if (nameError) nameError.style.display = 'none';
    nameInput.style.borderColor = '';
    if (submitBtn) submitBtn.disabled = false;
    return true;
  }
}

function populatePresetData(key) {
  const preset = PRESET_PROVIDERS[key];
  if (!preset) return;

  activePresetKey = key;

  const nameInput = document.getElementById('provider-name-input');
  const endpointInput = document.getElementById('provider-endpoint-input');
  const tagInput = document.getElementById('provider-tag-input');
  const modelSelect = document.getElementById('provider-model-select');
  const oauthProfileSelect = document.getElementById('provider-oauth-profile');
  const editIdInput = document.getElementById('provider-edit-id');

  const isAdding = !editIdInput || !editIdInput.value;
  const alreadyExists = isAdding && state.providers.some(p => p.name.toLowerCase() === preset.name.toLowerCase());

  if (nameInput) {
    if (alreadyExists) {
      // Suggest distinct name like Gemini (Work) or Claude (Secondary)
      nameInput.value = `${preset.name} (Work)`;
    } else {
      nameInput.value = preset.name;
    }
  }

  if (endpointInput) endpointInput.value = preset.endpoint;
  if (tagInput) {
    if (alreadyExists) {
      tagInput.value = activeMethod === 'oauth' ? 'CLI Daemon' : 'Direct API';
    } else {
      tagInput.value = preset.tag;
    }
  }

  if (modelSelect) {
    modelSelect.innerHTML = preset.models.map(m => `
      <option value="${m.id}">${m.name}</option>
    `).join('');
  }

  if (oauthProfileSelect && preset.oauthProfiles) {
    oauthProfileSelect.innerHTML = preset.oauthProfiles.map(op => `
      <option value="${op.id}">${op.name}</option>
    `).join('');
  }

  // Highlight active preset card
  const presetCards = document.querySelectorAll('.preset-card');
  presetCards.forEach(card => {
    if (card.dataset.preset === key) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }
  });

  // Reset test feedback
  const testResult = document.getElementById('provider-test-result');
  if (testResult) testResult.style.display = 'none';

  validateProviderName();
}

function setConnectionMethod(method) {
  activeMethod = method;
  const apiOption = document.getElementById('method-option-api');
  const oauthOption = document.getElementById('method-option-oauth');
  const apiFields = document.getElementById('section-api-fields');
  const oauthFields = document.getElementById('section-oauth-fields');

  if (method === 'api') {
    if (apiOption) apiOption.classList.add('active');
    if (oauthOption) oauthOption.classList.remove('active');
    if (apiFields) apiFields.style.display = 'flex';
    if (oauthFields) oauthFields.style.display = 'none';
  } else {
    if (oauthOption) oauthOption.classList.add('active');
    if (apiOption) apiOption.classList.remove('active');
    if (oauthFields) oauthFields.style.display = 'flex';
    if (apiFields) apiFields.style.display = 'none';
  }

  validateProviderName();
}

function openProviderModalForEdit(providerId) {
  const formAddProvider = document.getElementById('form-add-provider');
  const modalAddProvider = document.getElementById('modal-add-provider');
  const modalTitle = document.getElementById('provider-modal-title');
  const submitBtn = document.getElementById('btn-submit-add-provider');
  const editIdInput = document.getElementById('provider-edit-id');
  const oauthStatusText = document.getElementById('oauth-status-text');
  const btnOAuthAuth = document.getElementById('btn-oauth-authorize');
  const testResult = document.getElementById('provider-test-result');
  const advancedSection = document.getElementById('section-provider-advanced');
  const advancedChevron = document.getElementById('advanced-chevron');

  const provider = state.providers.find(p => p.id === providerId);
  if (!provider) return;

  if (formAddProvider) formAddProvider.reset();
  if (editIdInput) editIdInput.value = provider.id;

  if (modalTitle) modalTitle.textContent = `Configure Provider: ${provider.name}`;
  if (submitBtn) submitBtn.textContent = 'Save & Connect';

  // Find preset key matching provider ID or Name
  let matchedKey = 'custom';
  if (PRESET_PROVIDERS[provider.id]) {
    matchedKey = provider.id;
  } else {
    const foundKey = Object.keys(PRESET_PROVIDERS).find(k =>
      provider.name.toLowerCase().includes(k) || provider.id.toLowerCase().includes(k)
    );
    if (foundKey) matchedKey = foundKey;
  }

  populatePresetData(matchedKey);

  const initialMethod = provider.method || (matchedKey === 'claude' || matchedKey === 'codex' ? 'oauth' : 'api');
  setConnectionMethod(initialMethod);

  const nameInput = document.getElementById('provider-name-input');
  const endpointInput = document.getElementById('provider-endpoint-input');
  const tagInput = document.getElementById('provider-tag-input');

  if (nameInput) nameInput.value = provider.name;
  if (endpointInput && provider.endpoint) endpointInput.value = provider.endpoint;
  if (tagInput && provider.tag) tagInput.value = provider.tag;

  isOAuthAuthorized = (provider.status === 'connected' && initialMethod === 'oauth');
  if (oauthStatusText) {
    if (isOAuthAuthorized) {
      oauthStatusText.textContent = 'Authenticated (Active CLI Session Token)';
      oauthStatusText.style.color = 'var(--accent-green)';
    } else {
      oauthStatusText.textContent = 'Ready for OAuth Handshake';
      oauthStatusText.style.color = 'var(--text-primary)';
    }
  }
  if (btnOAuthAuth) btnOAuthAuth.textContent = isOAuthAuthorized ? 'Re-authorize' : 'Authorize Now';
  if (testResult) testResult.style.display = 'none';
  if (advancedSection) advancedSection.style.display = 'none';
  if (advancedChevron) advancedChevron.innerHTML = '&#x25B6;';

  validateProviderName();

  if (modalAddProvider) modalAddProvider.classList.add('open');
}

function initProviderModalEvents() {
  const addProviderBtn = document.getElementById('btn-add-provider');
  const formAddProvider = document.getElementById('form-add-provider');
  const modalAddProvider = document.getElementById('modal-add-provider');
  const presetGrid = document.getElementById('provider-preset-grid');
  const toggleKeyBtn = document.getElementById('btn-toggle-key-visibility');
  const apiKeyInput = document.getElementById('provider-api-key');
  const toggleAdvancedBtn = document.getElementById('btn-toggle-provider-advanced');
  const advancedSection = document.getElementById('section-provider-advanced');
  const advancedChevron = document.getElementById('advanced-chevron');
  const btnOAuthAuth = document.getElementById('btn-oauth-authorize');
  const oauthStatusText = document.getElementById('oauth-status-text');
  const btnTestConnection = document.getElementById('btn-test-provider-connection');
  const testResult = document.getElementById('provider-test-result');
  const modalTitle = document.getElementById('provider-modal-title');
  const submitBtn = document.getElementById('btn-submit-add-provider');
  const editIdInput = document.getElementById('provider-edit-id');
  const nameInput = document.getElementById('provider-name-input');

  // Realtime name validation
  if (nameInput) {
    nameInput.addEventListener('input', validateProviderName);
    nameInput.addEventListener('blur', validateProviderName);
  }

  // Open modal for NEW provider
  if (addProviderBtn) {
    addProviderBtn.addEventListener('click', () => {
      if (formAddProvider) formAddProvider.reset();
      if (editIdInput) editIdInput.value = '';
      if (modalTitle) modalTitle.textContent = 'Add New Agent Provider';
      if (submitBtn) submitBtn.textContent = 'Add Provider';

      populatePresetData('deepseek');
      setConnectionMethod('api');
      isOAuthAuthorized = false;

      if (oauthStatusText) {
        oauthStatusText.textContent = 'Ready for OAuth Handshake';
        oauthStatusText.style.color = 'var(--text-primary)';
      }
      if (btnOAuthAuth) btnOAuthAuth.textContent = 'Authorize Now';
      if (testResult) testResult.style.display = 'none';
      if (advancedSection) advancedSection.style.display = 'none';
      if (advancedChevron) advancedChevron.innerHTML = '&#x25B6;';

      validateProviderName();

      if (modalAddProvider) modalAddProvider.classList.add('open');
    });
  }

  // Preset selection
  if (presetGrid) {
    presetGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.preset-card');
      if (card && card.dataset.preset) {
        populatePresetData(card.dataset.preset);
      }
    });
  }

  // Method switching
  const methodApi = document.getElementById('method-option-api');
  const methodOAuth = document.getElementById('method-option-oauth');

  if (methodApi) {
    methodApi.addEventListener('click', () => setConnectionMethod('api'));
  }
  if (methodOAuth) {
    methodOAuth.addEventListener('click', () => setConnectionMethod('oauth'));
  }

  // Toggle API Key visibility
  if (toggleKeyBtn && apiKeyInput) {
    toggleKeyBtn.addEventListener('click', () => {
      if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleKeyBtn.innerHTML = '&#x1F576;&#xFE0F;';
      } else {
        apiKeyInput.type = 'password';
        toggleKeyBtn.innerHTML = '&#x1F441;';
      }
    });
  }

  // Toggle Advanced section
  if (toggleAdvancedBtn && advancedSection) {
    toggleAdvancedBtn.addEventListener('click', () => {
      const isHidden = advancedSection.style.display === 'none' || !advancedSection.style.display;
      advancedSection.style.display = isHidden ? 'flex' : 'none';
      if (advancedChevron) {
        advancedChevron.innerHTML = isHidden ? '&#x25BC;' : '&#x25B6;';
      }
    });
  }

  // OAuth authorization simulation
  if (btnOAuthAuth) {
    btnOAuthAuth.addEventListener('click', () => {
      btnOAuthAuth.disabled = true;
      btnOAuthAuth.textContent = 'Authenticating...';
      if (oauthStatusText) oauthStatusText.textContent = 'Opening provider authorization handshake...';

      setTimeout(() => {
        isOAuthAuthorized = true;
        btnOAuthAuth.disabled = false;
        btnOAuthAuth.textContent = 'Re-authorize';
        if (oauthStatusText) {
          oauthStatusText.textContent = 'Authenticated (Active CLI Session Token)';
          oauthStatusText.style.color = 'var(--accent-green)';
        }
      }, 700);
    });
  }

  // Test Handshake connection simulation
  if (btnTestConnection) {
    btnTestConnection.addEventListener('click', () => {
      btnTestConnection.disabled = true;
      btnTestConnection.textContent = 'Testing...';

      setTimeout(() => {
        btnTestConnection.disabled = false;
        btnTestConnection.textContent = 'Test Handshake';

        if (testResult) {
          testResult.style.display = 'block';
          testResult.style.background = 'rgba(16, 185, 129, 0.12)';
          testResult.style.border = '1px solid var(--accent-green)';
          testResult.style.color = 'var(--accent-green)';
          const latency = Math.floor(Math.random() * 60 + 35);
          const methodLabel = activeMethod === 'oauth' ? 'OAuth 2.0 CLI Token' : 'API Key Header';
          testResult.textContent = `Connection verified: 200 OK (${methodLabel}, Latency: ${latency}ms)`;
        }
      }, 550);
    });
  }

  // Form submit -> Add or Update Provider
  if (formAddProvider) {
    formAddProvider.addEventListener('submit', (e) => {
      e.preventDefault();

      if (!validateProviderName()) {
        if (nameInput) nameInput.focus();
        return;
      }

      const tagInput = document.getElementById('provider-tag-input');
      const modelSelect = document.getElementById('provider-model-select');
      const customModelInput = document.getElementById('provider-custom-model');
      const endpointInput = document.getElementById('provider-endpoint-input');
      const editId = editIdInput ? editIdInput.value.trim() : '';

      const name = (nameInput && nameInput.value.trim()) ? nameInput.value.trim() : 'Custom Provider';
      const customModel = customModelInput ? customModelInput.value.trim() : '';
      const selectedModel = customModel || (modelSelect ? modelSelect.value : 'default-model');
      const tag = (tagInput && tagInput.value.trim()) ? tagInput.value.trim() : (activeMethod === 'api' ? 'API Key' : 'OAuth 2.0 / CLI');
      const endpoint = endpointInput ? endpointInput.value.trim() : '';

      if (editId) {
        // Updating existing provider
        const existing = state.providers.find(p => p.id === editId);
        if (existing) {
          const oldName = existing.name;
          existing.name = name;
          existing.status = 'connected';
          existing.tag = tag;
          existing.method = activeMethod;
          existing.endpoint = endpoint;

          // Cascade name change across role defaults
          if (oldName !== name) {
            Object.keys(state.roleDefaults).forEach(role => {
              if (state.roleDefaults[role].provider === oldName) {
                state.roleDefaults[role].provider = name;
              }
            });
            if (typeof PROVIDER_MODELS !== 'undefined' && PROVIDER_MODELS[oldName]) {
              PROVIDER_MODELS[name] = PROVIDER_MODELS[oldName];
            }
          }
        }
      } else {
        // Adding new provider
        const newId = `p-${Date.now()}`;
        const newProvider = {
          id: newId,
          name: name,
          status: 'connected',
          tag: tag,
          method: activeMethod,
          endpoint: endpoint,
          isCustom: true
        };
        state.providers.push(newProvider);
      }

      // Register models in PROVIDER_MODELS for role routing
      if (typeof PROVIDER_MODELS !== 'undefined') {
        const preset = PRESET_PROVIDERS[activePresetKey];
        const existingList = (preset && preset.models) ? [...preset.models] : (PROVIDER_MODELS[name] ? [...PROVIDER_MODELS[name]] : []);

        if (customModel && !existingList.some(m => m.id === customModel)) {
          existingList.unshift({ id: customModel, name: customModel });
        }

        if (existingList.length === 0) {
          existingList.push({ id: selectedModel, name: selectedModel });
        }

        PROVIDER_MODELS[name] = existingList;
      }

      if (modalAddProvider) modalAddProvider.classList.remove('open');
      if (typeof renderConnections === 'function') renderConnections();
      if (typeof renderSidebarRoles === 'function') renderSidebarRoles();
    });
  }
}
