#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DASHBOARD_DIR = __dirname;

function readFile(relPath) {
  return fs.readFileSync(path.join(DASHBOARD_DIR, relPath), 'utf8');
}

function assemble() {
  const boardTab = readFile('tabs/board.html');
  const pipelinesTab = readFile('tabs/pipelines.html');
  const monitorTab = readFile('tabs/monitor.html');
  const decisionsTab = readFile('tabs/decisions.html');
  const docsTab = readFile('tabs/docs.html');
  const connectionsTab = readFile('tabs/connections.html');

  const ticketDetailModal = readFile('modals/ticket-detail.html');
  const ticketCreateModal = readFile('modals/ticket-create.html');
  const approvalModal = readFile('modals/approval.html');
  const providerCreateModal = readFile('modals/provider-create.html');
  const battlepassModal = readFile('modals/battlepass.html');

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Role-Agent Console | Neumorphic Orchestrator</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/main.css">
</head>
<body>

<div id="app">
  <!-- Mobile Sidebar Overlay Backdrop -->
  <div class="sidebar-overlay" id="sidebar-overlay"></div>

  <!-- S1: Neumorphic Left Sidebar -->
  <aside class="sidebar" id="main-sidebar">
    <div class="sidebar-header">
      <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
        <div class="app-branding">
          <div class="brand-icon" id="btn-toggle-sidebar-collapse" title="Toggle Sidebar Width">RC</div>
          <span class="branding-text">Role-Agent Console</span>
        </div>
        <button class="btn-close-sidebar" id="btn-close-sidebar" title="Close Sidebar">&times;</button>
      </div>
      <div class="session-status">
        <div class="status-dot"></div>
        <span>Operator: <strong>Serghei Rosca</strong></span>
      </div>
    </div>

    <div class="sidebar-roles">
      <div class="sidebar-section-title">9 Standard Roles</div>
      <div id="roles-list-container" style="display:flex; flex-direction:column; gap:12px;">
        <!-- Injected via JS -->
      </div>
    </div>

    <div class="sidebar-footer">
      <button class="btn-new-ticket" id="btn-open-new-ticket" title="Create New Ticket">
        <span>+</span><span class="btn-new-ticket-text"> New Ticket</span>
      </button>
    </div>
  </aside>

  <!-- Main Workspace -->
  <main class="main-area">
    <!-- Header with 6 Tabs & Controls -->
    <header class="header-bar">
      <div class="header-top-row">
        <div class="header-title-group">
          <button class="btn-menu-toggle" id="btn-menu-toggle" title="Open Roles Menu">&#9776;</button>
          <span class="header-title">Workspace</span>
        </div>

        <div class="header-actions">
          <button class="btn-battlepass" id="btn-open-battlepass">
            <span>&#x26A1; <span class="bp-text-full">BATTLE </span>PASS</span>
            <span class="bp-lvl-badge" style="font-size:10px; background:rgba(0,0,0,0.28); padding:2px 6px; border-radius:6px; border:1px solid rgba(255,255,255,0.25);">LVL 12</span>
          </button>
          <button class="btn btn-secondary" id="btn-theme-toggle" title="Toggle Light / Dark Mode">
            <span id="theme-icon">LIGHT</span>
          </button>
        </div>
      </div>

      <nav class="nav-tabs">
        <button class="tab-btn active" data-tab="tab-board">Board</button>
        <button class="tab-btn" data-tab="tab-pipelines">Pipelines</button>
        <button class="tab-btn" data-tab="tab-monitor">Monitor</button>
        <button class="tab-btn" data-tab="tab-decisions">Decisions & Escalations</button>
        <button class="tab-btn" data-tab="tab-docs">Docs</button>
        <button class="tab-btn" data-tab="tab-connections">Connections & Models</button>
      </nav>
    </header>

    <!-- Content Pages -->
    <div class="tab-content-area">
      <!-- T1: Board View -->
${boardTab.split('\\n').map(l => '      ' + l).join('\\n')}

      <!-- T2: Pipelines View -->
${pipelinesTab.split('\\n').map(l => '      ' + l).join('\\n')}

      <!-- T3: Monitor Console View -->
${monitorTab.split('\\n').map(l => '      ' + l).join('\\n')}

      <!-- T4: Decisions & Escalations View -->
${decisionsTab.split('\\n').map(l => '      ' + l).join('\\n')}

      <!-- T5: Docs Tab -->
${docsTab.split('\\n').map(l => '      ' + l).join('\\n')}

      <!-- T6: Connections & Model Defaults Tab -->
${connectionsTab.split('\\n').map(l => '      ' + l).join('\\n')}
    </div>
  </main>
</div>

<!-- Modals -->
${ticketDetailModal}

${ticketCreateModal}

${approvalModal}

${providerCreateModal}

${battlepassModal}

<!-- Modular Scripts -->
<script src="js/state.js"></script>
<script src="js/theme.js"></script>
<script src="js/layout/sidebar.js"></script>
<script src="js/layout/header.js"></script>
<script src="js/tabs/board.js"></script>
<script src="js/tabs/pipelines.js"></script>
<script src="js/tabs/monitor.js"></script>
<script src="js/tabs/decisions.js"></script>
<script src="js/tabs/docs.js"></script>
<script src="js/tabs/connections.js"></script>
<script src="js/modals/ticket-modal.js"></script>
<script src="js/modals/approval.js"></script>
<script src="js/modals/provider-modal.js"></script>
<script src="js/modals/battlepass.js"></script>
<script src="js/app.js"></script>
</body>
</html>
`;

  fs.writeFileSync(path.join(DASHBOARD_DIR, 'index.html'), indexHtml);
  console.log('Successfully assembled dashboard/index.html');
}

assemble();
