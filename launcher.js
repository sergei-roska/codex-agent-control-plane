'use strict';

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { ClientFactory } = require('@a2a-js/sdk/client');
const { TaskState } = require('@a2a-js/sdk');
const { readAuthToken } = require('./src/local-auth');
const { parseCheckCommand } = require('./src/acceptance');
const { CodexAppServer } = require('./src/codex-app-server');
const { loadRoles, createLeadRole } = require('./src/role-catalog');

const app = express();
const PORT = Number(process.env.LAUNCHER_PORT) || 8080;

let orchestratorProcess = null;
let serverLogs = [];
let serverStatus = 'stopped'; // 'stopped' | 'starting' | 'running'
let cachedLimits = null;
let lastLimitsFetch = 0;

// Automatically detect active orchestrator on port 3000
async function checkOrchestratorAlive() {
  try {
    const res = await fetch('http://127.0.0.1:3000/orchestrator/agent-card.json', { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      serverStatus = 'running';
      return;
    }
  } catch (_) {}
  if (serverStatus !== 'starting' && !orchestratorProcess) {
    serverStatus = 'stopped';
  }
}
checkOrchestratorAlive();
setInterval(checkOrchestratorAlive, 2000);

app.use(express.json());

// Main UI: modern orchestrator console interface
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex A2A Control Plane</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #090a10;
      --bg-surface: #11131f;
      --bg-card: #161928;
      --bg-elevated: #1e2235;
      --bg-input: #0c0e17;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-card: rgba(255, 255, 255, 0.12);
      --border-focus: #6366f1;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --primary-glow: rgba(99, 102, 241, 0.25);
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.25);
      --danger: #f43f5e;
      --danger-hover: #e11d48;
      --warning: #f59e0b;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    /* Navigation / Header */
    .navbar {
      height: 64px;
      border-bottom: 1px solid var(--border-subtle);
      background: rgba(17, 19, 31, 0.85);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      font-size: 17px;
      letter-spacing: -0.02em;
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 16px;
      box-shadow: 0 0 16px var(--primary-glow);
    }
    .brand-subtitle {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-dim);
      margin-left: 4px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
    }

    .server-status-pill {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      transition: all 0.25s ease;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-dim);
    }
    .status-dot.active {
      background: var(--success);
      box-shadow: 0 0 10px var(--success);
      animation: pulse 2s infinite;
    }
    .status-dot.starting {
      background: var(--warning);
      box-shadow: 0 0 10px var(--warning);
      animation: pulse 1s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); opacity: 0.8; }
      50% { transform: scale(1.15); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.8; }
    }

    /* Main content */
    .main-container {
      max-width: 1340px;
      width: 100%;
      margin: 24px auto;
      padding: 0 24px 48px;
      display: grid;
      grid-template-columns: 460px 1fr;
      gap: 24px;
      flex-grow: 1;
    }
    @media (max-width: 1050px) {
      .main-container { grid-template-columns: 1fr; }
    }

    .panel {
      background: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: var(--radius-lg);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.4);
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .panel-title {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Forms and inputs */
    .field-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .field-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
    }
    .field-label kbd {
      font-family: inherit;
      font-size: 11px;
      background: var(--bg-elevated);
      padding: 2px 5px;
      border-radius: 4px;
      color: var(--text-dim);
    }

    input, textarea {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      color: var(--text-main);
      padding: 12px 14px;
      font-family: inherit;
      font-size: 14px;
      line-height: 1.5;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }
    textarea { resize: vertical; min-height: 110px; }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 11px 18px;
      border-radius: var(--radius-md);
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      border: none;
      transition: all 0.18s ease;
      user-select: none;
    }
    .btn:hover:not(:disabled) {
      transform: translateY(-1px);
    }
    .btn:active:not(:disabled) {
      transform: translateY(0);
    }
    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      filter: grayscale(0.5);
    }

    .btn-primary {
      background: var(--primary);
      color: #fff;
      box-shadow: 0 4px 14px var(--primary-glow);
    }
    .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }

    .btn-success {
      background: var(--success);
      color: #052e16;
      box-shadow: 0 4px 14px var(--success-glow);
    }
    .btn-danger {
      background: var(--danger);
      color: #fff;
    }
    .btn-danger:hover:not(:disabled) { background: var(--danger-hover); }

    .btn-secondary {
      background: var(--bg-elevated);
      color: var(--text-main);
      border: 1px solid var(--border-subtle);
    }
    .btn-secondary:hover:not(:disabled) { background: var(--bg-surface); }

    .btn-group { display: flex; gap: 10px; }

    /* Quick prompt chips */
    .chips-group {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .chip {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      padding: 4px 9px;
      border-radius: 6px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s;
    }
    .chip:hover {
      background: var(--bg-surface);
      color: var(--primary);
      border-color: var(--primary);
    }

    /* Terminal / Log console */
    .terminal-window {
      background: #0b0c14;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .terminal-bar {
      height: 32px;
      background: #141724;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
    }
    .terminal-dots {
      display: flex;
      gap: 6px;
    }
    .terminal-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .dot-red { background: #ef4444; }
    .dot-yellow { background: #f59e0b; }
    .dot-green { background: #10b981; }
    .terminal-title {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-dim);
    }
    .terminal-actions {
      display: flex;
      gap: 8px;
    }
    .terminal-btn {
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 11px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .terminal-btn:hover { color: var(--text-main); background: var(--bg-elevated); }

    .terminal-body {
      padding: 14px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12.5px;
      color: #94a3b8;
      line-height: 1.55;
      overflow-y: auto;
      max-height: 240px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .terminal-body::-webkit-scrollbar { width: 6px; }
    .terminal-body::-webkit-scrollbar-thumb { background: #262b42; border-radius: 3px; }

    /* Task output window */
    .task-viewer {
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 16px;
      min-height: 220px;
      max-height: 480px;
      overflow-y: auto;
      font-size: 13.5px;
      line-height: 1.6;
      white-space: pre-wrap;
      color: var(--text-main);
    }
    .task-viewer::-webkit-scrollbar { width: 6px; }
    /* Current task card (Goal) */
    .active-goal-box {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(99, 102, 241, 0.04));
      border: 1px solid rgba(99, 102, 241, 0.35);
      border-radius: var(--radius-md);
      padding: 12px 16px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
      animation: fadeIn 0.25s ease;
    }
    .active-goal-icon {
      font-size: 18px;
      line-height: 1.2;
      flex-shrink: 0;
    }
    .active-goal-content {
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow: hidden;
      flex: 1;
    }
    .active-goal-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 700;
      color: var(--primary);
    }
    .active-goal-text {
      font-size: 13.5px;
      font-weight: 500;
      color: var(--text-main);
      line-height: 1.5;
      word-break: break-word;
    }
    .active-goal-subtext {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
      margin-top: 2px;
      padding-top: 4px;
      border-top: 1px dashed rgba(255, 255, 255, 0.08);
    }

    /* Human decision card */
    .decision-banner {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(245, 158, 11, 0.04));
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: var(--radius-md);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      animation: fadeIn 0.25s ease;
    }
    .decision-banner h4 {
      color: var(--warning);
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .decision-options {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .option-pill {
      background: var(--bg-elevated);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: var(--text-main);
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .option-pill:hover {
      background: var(--warning);
      color: #111;
      border-color: var(--warning);
    }

    /* Rate limits widget */
    .limits-card {
      background: #0d0f18;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-top: 4px;
    }
    .limits-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .limits-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .limit-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .limit-info {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 500;
    }
    .limit-value {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      color: var(--primary);
    }
    .progress-bar-bg {
      height: 7px;
      background: #1e2235;
      border-radius: 999px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--success);
      transition: width 0.4s ease, background-color 0.4s ease;
    }
    .progress-bar-fill.warning { background: var(--warning); }
    .progress-bar-fill.danger { background: var(--danger); }
    .limit-reset {
      font-size: 11px;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }

    .about-card {
      background: #0d0f18;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 4px;
    }
    .about-text {
      font-size: 12px;
      line-height: 1.55;
      color: var(--text-muted);
    }
    .about-team summary {
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .about-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
      max-height: 360px;
      overflow-y: auto;
    }
    .about-role {
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .about-role-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .about-role-name {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-main);
    }
    .about-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--border-card);
      color: var(--text-muted);
    }
    .about-badge.write {
      color: var(--warning);
      border-color: var(--warning);
    }
    .about-model {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10.5px;
      color: var(--text-dim);
    }
    .about-desc {
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--text-muted);
      overflow-wrap: anywhere;
    }
    .about-extra {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10.5px;
      color: var(--text-dim);
      overflow-wrap: anywhere;
    }

    .hidden { display: none !important; }

    /* Task statuses */
    .task-meta-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      color: var(--text-muted);
    }
    .acceptance-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .acceptance-accepted { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .acceptance-rejected { background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }
    .acceptance-none { background: var(--bg-elevated); color: var(--text-dim); }

    /* History modal */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      z-index: 1000;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 24px;
      animation: fadeIn 0.2s ease;
    }
    .modal-card {
      background: var(--bg-card);
      border: 1px solid var(--border-card);
      border-radius: var(--radius-lg);
      width: 100%;
      max-width: 680px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      overflow: hidden;
    }
    .modal-header {
      padding: 18px 24px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .modal-title {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .modal-close-btn {
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      line-height: 1;
    }
    .modal-close-btn:hover {
      color: var(--text-main);
      background: var(--bg-elevated);
    }
    .modal-body {
      padding: 20px 24px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .history-item {
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      transition: border-color 0.15s;
    }
    .history-item:hover {
      border-color: var(--border-focus);
    }
    .history-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: var(--text-muted);
    }
    .history-item-goal {
      font-size: 13.5px;
      font-weight: 500;
      color: var(--text-main);
      line-height: 1.45;
    }
    .history-item-meta {
      display: flex;
      gap: 14px;
      font-size: 11.5px;
      color: var(--text-dim);
      font-family: 'JetBrains Mono', monospace;
    }
    .history-item-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 4px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
      padding-top: 8px;
    }
    .btn-sm {
      padding: 5px 12px;
      font-size: 12px;
      border-radius: var(--radius-sm);
    }
    .btn-secondary {
      background: var(--bg-elevated);
      color: var(--text-main);
      border: 1px solid var(--border-subtle);
      cursor: pointer;
      font-weight: 500;
      transition: background 0.15s, border-color 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-secondary:hover {
      background: #282d44;
      border-color: var(--border-card);
    }
    .btn-danger-outline {
      background: rgba(244, 63, 94, 0.1);
      color: var(--danger);
      border: 1px solid rgba(244, 63, 94, 0.3);
      cursor: pointer;
      font-weight: 500;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn-danger-outline:hover {
      background: var(--danger);
      color: #fff;
    }
    .history-active-banner {
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.25);
      border-radius: var(--radius-sm);
      padding: 8px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12.5px;
      color: var(--warning);
      margin-bottom: 8px;
    }
  </style>
</head>
<body>

  <!-- Navigation -->
  <nav class="navbar">
    <div class="brand">
      <div class="brand-icon">⚡</div>
      <span>Codex Control Plane</span>
      <span class="brand-subtitle">Universal A2A</span>
    </div>
    
    <div id="serverPill" class="server-status-pill">
      <span id="serverDot" class="status-dot"></span>
      <span id="serverStatusText">Checking connection...</span>
    </div>
  </nav>

  <!-- Workspace -->
  <main class="main-container">
    
    <!-- Panel 1: Environment and Server -->
    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">
          <span>📁</span> Workspace & Server
        </h2>
        <span style="font-size: 12px; color: var(--text-dim);" id="portHint">port 3000</span>
      </div>

      <div class="field-group">
        <label class="field-label">Project path (CODEX_WORKSPACE):</label>
        <input type="text" id="workspaceInput" value="${process.cwd()}" spellcheck="false">
      </div>

      <div class="btn-group">
        <button id="startBtn" class="btn btn-success" onclick="startServer()">
          <span>▶</span> Start Server
        </button>
        <button id="stopBtn" class="btn btn-danger" onclick="stopServer()" disabled>
          <span>■</span> Stop
        </button>
      </div>

      <!-- Process log terminal -->
      <div class="terminal-window">
        <div class="terminal-bar">
          <div class="terminal-dots">
            <span class="terminal-dot dot-red"></span>
            <span class="terminal-dot dot-yellow"></span>
            <span class="terminal-dot dot-green"></span>
          </div>
          <span class="terminal-title">orchestrator.stdout</span>
          <div class="terminal-actions">
            <button class="terminal-btn" onclick="clearLogs()">Clear</button>
          </div>
        </div>
        <div class="terminal-body" id="serverLogsBody">Orchestrator is not running.</div>
      </div>

      <!-- Usage limits widget (5h and weekly) -->
      <div class="limits-card">
        <div class="limits-header">
          <div class="limits-title">
            <span>📊</span> Account Limits (<span id="planTypeBadge" style="text-transform: capitalize; color: var(--primary);">ChatGPT</span>)
          </div>
          <button class="terminal-btn" onclick="fetchLimits(true)" title="Refresh limits">↻ Refresh</button>
        </div>

        <!-- Active account information -->
        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; padding: 6px 10px; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); font-family: 'JetBrains Mono', monospace;">
          <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            <span>👤</span>
            <span id="accountEmail" style="color: var(--text-main);">loading...</span>
          </div>
          <span id="accountType" style="color: var(--primary); text-transform: uppercase; font-size: 10px; font-weight: 600;">OAuth</span>
        </div>

        <!-- 5h limit -->
        <div class="limit-item">
          <div class="limit-info">
            <span class="limit-name">5-hour limit (5h)</span>
            <span class="limit-value" id="fiveHourVal">...</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="fiveHourBar" style="width: 0%;"></div>
          </div>
          <div class="limit-reset" id="fiveHourReset">Reset: loading...</div>
        </div>

        <!-- Weekly limit -->
        <div class="limit-item">
          <div class="limit-info">
            <span class="limit-name">Weekly limit (Weekly)</span>
            <span class="limit-value" id="weeklyVal">...</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="weeklyBar" style="width: 0%;"></div>
          </div>
          <div class="limit-reset" id="weeklyReset">Reset: loading...</div>
        </div>
      </div>
      <div class="about-card">
        <div class="limits-title">
          <span>🧭</span> About Orchestrator
        </div>
        <p class="about-text">Local A2A server that executes tasks using a team of Codex agents. The lead operates in read-only mode: analyzes the goal, breaks down work into bounded assignments, and delegates them to roles over the A2A protocol. Each role is an independent Codex invocation with its own model, reasoning effort, and sandbox. Writer roles work on the workspace one at a time, and the server tracks which files were actually modified. At the end, results undergo acceptance checks if specified. State is persisted in SQLite, allowing tasks to pause for human decisions or rate limits and resume after restart.</p>
        <details class="about-team" open>
          <summary id="aboutTeamSummary">Team</summary>
          <div class="about-list" id="aboutTeamList"></div>
        </details>
        <div class="limit-reset hidden" id="aboutTeamError"></div>
      </div>
    </section>

    <!-- Panel 2: Task Dispatcher -->
    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">
          <span>🚀</span> Task Dispatch (A2A Dispatch)
        </h2>
        <div style="display: flex; gap: 10px; align-items: center;">
          <button class="btn btn-secondary btn-sm" onclick="openHistoryModal()">
            <span>📜</span> History (<span id="historyCountBadge">0</span>)
          </button>
          <span id="activeTaskIdDisplay" style="font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-dim);">no active task</span>
        </div>
      </div>

      <div class="field-group">
        <label class="field-label">
          <span>Team Goal:</span>
          <kbd>Ctrl+Enter to dispatch</kbd>
        </label>
        <textarea id="taskGoal" rows="4" placeholder="Describe the goal, for example: Analyze the project and fix validation error in src/..."></textarea>
        <div class="chips-group">
          <span class="chip" onclick="setGoal('Analyze project architecture and draft improvement plan')">Architecture analysis</span>
          <span class="chip" onclick="setGoal('Run tests and fix failing errors')">Run & fix tests</span>
          <span class="chip" onclick="setGoal('Review code for vulnerabilities and contract compliance')">Security audit</span>
        </div>
      </div>

      <div class="field-group">
        <label class="field-label">Acceptance Checks:</label>
        <input type="text" id="taskChecks" placeholder="npm test, node --check src/server.js" spellcheck="false">
        <div class="chips-group">
          <span class="chip" onclick="addCheck('npm test')">+ npm test</span>
          <span class="chip" onclick="addCheck('node --check src/server.js')">+ check server.js</span>
          <span class="chip" onclick="clearChecks()">clear checks</span>
        </div>
      </div>

      <div style="display: flex; gap: 10px;">
        <button id="dispatchBtn" class="btn btn-primary" onclick="dispatchTask()" disabled style="flex: 1; padding: 13px;">
          <span>⚡</span> Dispatch task via Lead
        </button>
        <button id="continueBtn" class="btn btn-secondary hidden" onclick="continueTask()" disabled style="padding: 13px;">
          <span>↻</span> Continue task
        </button>
      </div>

      <!-- Lead decision request card -->
      <div id="decisionCard" class="decision-banner hidden">
        <h4>⚠️ Lead requests human decision</h4>
        <p id="decisionQuestion" style="font-size: 13.5px; color: var(--text-main);"></p>
        
        <div class="field-group">
          <label class="field-label">Available options (click to select):</label>
          <div id="decisionOptionsList" class="decision-options"></div>
        </div>

        <div style="display: flex; gap: 8px;">
          <input type="text" id="decisionId" placeholder="Decision ID" readonly style="flex: 1; font-family: monospace; font-size: 12px;">
          <input type="text" id="decisionChoice" placeholder="Selected option (optionId)" style="flex: 1; font-family: monospace;">
        </div>
        
        <textarea id="decisionAnswer" rows="2" placeholder="Additional explanation or response text..."></textarea>
        
        <button class="btn btn-primary" onclick="submitDecision()" style="align-self: flex-start;">
          Submit answer and continue
        </button>
      </div>

      <!-- Result output -->
      <div class="field-group" style="flex-grow: 1;">
        <div class="task-meta-bar">
          <span id="taskStatusLabel">Status: waiting to start</span>
          <span id="acceptanceBadge" class="acceptance-pill acceptance-none">no checks</span>
        </div>

        <!-- Archive mode banner -->
        <div id="archiveViewingBanner" class="history-active-banner hidden">
          <span>👁 Archive mode: viewing task from history</span>
          <button class="btn btn-secondary btn-sm" style="font-size: 11px; padding: 2px 8px;" onclick="returnToLatestTask()">
            Back to active task ->
          </button>
        </div>

        <!-- Active goal card -->
        <div id="activeTaskGoalBox" class="active-goal-box hidden">
          <span class="active-goal-icon">🎯</span>
          <div class="active-goal-content">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div class="active-goal-title" id="activeGoalHeaderTitle">Current task / Goal:</div>
              <span style="display: flex; gap: 6px;">
              <button id="closeTaskBtn" class="btn btn-secondary btn-sm" style="font-size: 11px; padding: 2px 8px;" onclick="closeTaskView()">
                <span>✕</span> Close
              </button>
              <button id="deleteCurrentTaskBtn" class="btn btn-secondary btn-sm hidden" style="color: var(--danger); font-size: 11px; padding: 2px 8px;" onclick="deleteCurrentTask()">
                <span>🗑</span> Delete
              </button>
              </span>
            </div>
            <div class="active-goal-text" id="activeTaskGoalText"></div>
            <div id="activeTaskSubText" class="active-goal-subtext hidden"></div>
          </div>
        </div>

        <div class="task-viewer" id="taskOutputArea">Task dispatch results, specialist reports, and the final verdict will appear here.</div>
      </div>
    </section>

  </main>

  <!-- Task history modal -->
  <div id="historyModal" class="modal-overlay hidden" onclick="if(event.target === this) closeHistoryModal()">
    <div class="modal-card">
      <div class="modal-header">
        <h3 class="modal-title">
          <span>📜</span> Workspace task history
        </h3>
        <button class="modal-close-btn" onclick="closeHistoryModal()">✕</button>
      </div>
      <div class="modal-body" id="historyListContainer">
        <div style="text-align: center; color: var(--text-dim); padding: 20px;">Loading history...</div>
      </div>
    </div>
  </div>

  <script>
    let currentTaskId = null;

    function setGoal(text) {
      document.getElementById('taskGoal').value = text;
      document.getElementById('taskGoal').focus();
    }
    function addCheck(cmd) {
      const el = document.getElementById('taskChecks');
      el.value = el.value ? el.value + ', ' + cmd : cmd;
    }
    function clearChecks() {
      document.getElementById('taskChecks').value = '';
    }
    function clearLogs() {
      document.getElementById('serverLogsBody').innerText = '';
    }

    // Ctrl+Enter for quick dispatch
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const btn = document.getElementById('dispatchBtn');
        if (!btn.disabled) dispatchTask();
      }
    });

    let serverRunning = false;
    let displayedTaskTerminal = false;

    function updateContinueBtn() {
      const btn = document.getElementById('continueBtn');
      if (displayedTaskTerminal && currentTaskId) {
        btn.classList.remove('hidden');
        btn.disabled = !serverRunning;
      } else {
        btn.classList.add('hidden');
        btn.disabled = true;
      }
    }

    async function updateStatus() {
      try {
        const res = await fetch('/api/server/status');
        const data = await res.json();

        const dot = document.getElementById('serverDot');
        const text = document.getElementById('serverStatusText');
        const pill = document.getElementById('serverPill');
        const startBtn = document.getElementById('startBtn');
        const stopBtn = document.getElementById('stopBtn');
        const dispatchBtn = document.getElementById('dispatchBtn');

        dot.className = 'status-dot';
        serverRunning = data.status === 'running';
        updateContinueBtn();

        if (data.status === 'running') {
          dot.classList.add('active');
          text.innerText = 'Orchestrator active';
          pill.style.borderColor = 'rgba(16, 185, 129, 0.4)';
          startBtn.disabled = true;
          stopBtn.disabled = false;
          dispatchBtn.disabled = false;
        } else if (data.status === 'starting') {
          dot.classList.add('starting');
          text.innerText = 'Starting process...';
          pill.style.borderColor = 'rgba(245, 158, 11, 0.4)';
          startBtn.disabled = true;
          stopBtn.disabled = false;
          dispatchBtn.disabled = true;
        } else {
          text.innerText = 'Server stopped';
          pill.style.borderColor = 'var(--border-subtle)';
          startBtn.disabled = false;
          stopBtn.disabled = true;
          dispatchBtn.disabled = true;
        }

        const logsBody = document.getElementById('serverLogsBody');
        if (data.logs && data.logs.length) {
          logsBody.innerText = data.logs.join('');
          logsBody.scrollTop = logsBody.scrollHeight;
        }

        if (data.status === 'running') {
          await syncActiveTask();
        }
        await fetchHistoryCount();
      } catch (_) {}
    }

    let viewingArchivedTaskId = null;
    let dismissedTaskId = null;

    function isActiveState(state) {
      return state === 'TASK_STATE_SUBMITTED' || state === 1
        || state === 'TASK_STATE_WORKING' || state === 2
        || state === 'TASK_STATE_INPUT_REQUIRED' || state === 6
        || state === 'TASK_STATE_AUTH_REQUIRED' || state === 8;
    }

    function isTerminalState(state) {
      return state === 'TASK_STATE_COMPLETED' || state === 3
        || state === 'TASK_STATE_FAILED' || state === 4
        || state === 'TASK_STATE_CANCELED' || state === 5
        || state === 'TASK_STATE_REJECTED' || state === 7;
    }

    async function syncActiveTask() {
      if (viewingArchivedTaskId) return;
      try {
        const res = await fetch('/api/tasks/latest');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.leadTask) return;
        if (dismissedTaskId && data.leadTask.id === dismissedTaskId && isTerminalState(data.leadTask.state)) return;
        if (!isTerminalState(data.leadTask.state) || data.leadTask.id !== dismissedTaskId) dismissedTaskId = null;
        renderTaskView(data.leadTask, data.workers || [], false);
      } catch (_) {}
    }

    function renderTaskView(leadTask, workers = [], isArchive = false) {
      if (!leadTask) return;

      currentTaskId = leadTask.id;
      document.getElementById('activeTaskIdDisplay').innerText = 'ID: ' + leadTask.id;
      displayedTaskTerminal = isTerminalState(leadTask.state);
      updateContinueBtn();
      const resetBadge = document.getElementById('acceptanceBadge');
      resetBadge.className = 'acceptance-pill acceptance-none';
      resetBadge.innerText = 'no checks';

      const goalBox = document.getElementById('activeTaskGoalBox');
      const goalTextEl = document.getElementById('activeTaskGoalText');
      const goalSubEl = document.getElementById('activeTaskSubText');
      const goalHeaderTitle = document.getElementById('activeGoalHeaderTitle');
      const deleteBtn = document.getElementById('deleteCurrentTaskBtn');
      const archiveBanner = document.getElementById('archiveViewingBanner');

      if (isArchive) {
        archiveBanner.classList.remove('hidden');
        goalHeaderTitle.innerText = 'Archived task / Goal:';
      } else {
        archiveBanner.classList.add('hidden');
        goalHeaderTitle.innerText = 'Current task / Goal:';
      }

      if (leadTask.goal) {
        goalTextEl.innerText = leadTask.goal;
        if (leadTask.lastInstruction && leadTask.lastInstruction !== leadTask.goal) {
          goalSubEl.innerText = 'Follow-up: ' + leadTask.lastInstruction;
          goalSubEl.classList.remove('hidden');
        } else {
          goalSubEl.classList.add('hidden');
        }
        if (leadTask.continuesFrom) {
          const prefix = 'continuation of ' + leadTask.continuesFrom.slice(0, 8) + '...';
          goalSubEl.innerText = goalSubEl.classList.contains('hidden') ? prefix : prefix + ' | ' + goalSubEl.innerText;
          goalSubEl.classList.remove('hidden');
        }
        goalBox.classList.remove('hidden');
      } else {
        goalBox.classList.add('hidden');
      }

      const state = leadTask.state;
      const isWorking = state === 'TASK_STATE_WORKING' || state === 2;
      const isInputRequired = state === 'TASK_STATE_INPUT_REQUIRED' || state === 6;
      const isCompleted = state === 'TASK_STATE_COMPLETED' || state === 3;
      const isFailed = state === 'TASK_STATE_FAILED' || state === 4;

      if (isCompleted || isFailed) {
        deleteBtn.classList.remove('hidden');
      } else {
        deleteBtn.classList.add('hidden');
      }

      const statusLabel = document.getElementById('taskStatusLabel');
      const out = document.getElementById('taskOutputArea');
      const dispatchBtn = document.getElementById('dispatchBtn');

      const goalBanner = leadTask.goal ? '🎯 Goal: ' + leadTask.goal + '\\n\\n' : '';

      if (isWorking) {
        statusLabel.innerText = 'Status: task in progress...';
        dispatchBtn.disabled = true;
        document.getElementById('decisionCard').classList.add('hidden');

        let workerStatusText = '';
        if (workers && workers.length) {
          workerStatusText = '\\n\\nRound specialists:\\n' + workers.map(w => {
            const icon = w.state === 'finished' ? '✅' : w.state === 'submitted' ? '⏳' : '📋';
            return '  ' + icon + ' ' + w.role + ': ' + w.state;
          }).join('\\n');
        }

        out.innerText = goalBanner + '>>> Task dispatched to Lead Orchestrator (LangGraph).\\nLead analyzes goal, creates assignments, and coordinates specialists...' + workerStatusText;

      } else if (isInputRequired) {
        statusLabel.innerText = 'Status: human decision required (paused)';
        dispatchBtn.disabled = false;

        const pause = leadTask.metadata?.pause || {};
        document.getElementById('decisionCard').classList.remove('hidden');
        const isErrorPause = pause.kind === 'error';
        
        let promptText = isErrorPause
          ? 'Lead paused due to an error: ' + (pause.message || 'Error') + '\\nSend a message to retry the step.'
          : (pause.question || pause.message || 'Waiting for response');
          
        document.getElementById('decisionQuestion').innerText = promptText;
        document.getElementById('decisionId').value = pause.decisionId || '';

        const optContainer = document.getElementById('decisionOptionsList');
        optContainer.innerHTML = '';
        if (pause.options && pause.options.length) {
          pause.options.forEach(opt => {
            const pill = document.createElement('span');
            pill.className = 'option-pill';
            pill.innerText = opt.id + ': ' + opt.description;
            pill.onclick = () => selectOption(opt.id);
            optContainer.appendChild(pill);
          });
        }

        const msgText = extractParts(leadTask.status?.message?.parts);
        out.innerText = goalBanner + '⚠️ TASK PAUSED\\nLead is waiting for human decision before continuing.\\n\\n' + msgText;

      } else if (isCompleted) {
        statusLabel.innerText = 'Status: COMPLETED SUCCESSFULLY';
        dispatchBtn.disabled = false;
        document.getElementById('decisionCard').classList.add('hidden');

        const artifact = leadTask.artifacts?.at(-1);
        const artifactText = extractParts(artifact?.parts);
        const disposition = artifact?.metadata?.acceptance?.disposition;

        const accBadge = document.getElementById('acceptanceBadge');
        if (disposition === 'accepted') {
          accBadge.className = 'acceptance-pill acceptance-accepted';
          accBadge.innerText = 'Acceptance: Passed';
        } else if (disposition === 'rejected') {
          accBadge.className = 'acceptance-pill acceptance-rejected';
          accBadge.innerText = 'Acceptance: Rejected';
        } else {
          accBadge.className = 'acceptance-pill acceptance-none';
          accBadge.innerText = 'Acceptance: ' + (disposition || 'n/a');
        }

        const msgText = extractParts(leadTask.status?.message?.parts);
        out.innerText = goalBanner + '✅ WORK COMPLETED\\n' + (artifactText || msgText || 'Completed without additional text.');

      } else if (isFailed) {
        statusLabel.innerText = 'Status: FAILED';
        dispatchBtn.disabled = false;
        document.getElementById('decisionCard').classList.add('hidden');
        const msgText = extractParts(leadTask.status?.message?.parts);
        out.innerText = goalBanner + '❌ Task failed with an error:\\n\\n' + msgText;
      } else {
        statusLabel.innerText = 'Status: ' + state;
        dispatchBtn.disabled = false;
        document.getElementById('decisionCard').classList.add('hidden');
        const msgText = extractParts(leadTask.status?.message?.parts);
        out.innerText = goalBanner + msgText;
      }
    }

    async function fetchHistoryCount() {
      try {
        const res = await fetch('/api/tasks/history');
        if (!res.ok) return;
        const data = await res.json();
        const badge = document.getElementById('historyCountBadge');
        if (badge && data.tasks) badge.innerText = data.tasks.length;
      } catch (_) {}
    }

    async function openHistoryModal() {
      const modal = document.getElementById('historyModal');
      const container = document.getElementById('historyListContainer');
      modal.classList.remove('hidden');
      container.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 20px;">Loading history...</div>';

      try {
        const res = await fetch('/api/tasks/history');
        if (!res.ok) throw new Error('Failed to load history');
        const data = await res.json();
        const tasks = data.tasks || [];

        if (tasks.length === 0) {
          container.innerHTML = '<div style="text-align: center; color: var(--text-dim); padding: 30px;">History is empty. Dispatched tasks will appear here.</div>';
          return;
        }

        container.innerHTML = '';
        tasks.forEach(t => {
          const item = document.createElement('div');
          item.className = 'history-item';

          const isWorking = t.state === 'TASK_STATE_WORKING' || t.state === 2;
          const isInputReq = t.state === 'TASK_STATE_INPUT_REQUIRED' || t.state === 6;
          const isCompleted = t.state === 'TASK_STATE_COMPLETED' || t.state === 3;
          const isFailed = t.state === 'TASK_STATE_FAILED' || t.state === 4;

          let statusBadge = '<span class="acceptance-pill acceptance-none">' + escapeHtml(String(t.state)) + '</span>';
          if (isWorking) statusBadge = '<span class="acceptance-pill" style="background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3);">In Progress</span>';
          else if (isInputReq) statusBadge = '<span class="acceptance-pill" style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3);">Awaiting Decision</span>';
          else if (isCompleted) statusBadge = '<span class="acceptance-pill acceptance-accepted">Success</span>';
          else if (isFailed) statusBadge = '<span class="acceptance-pill acceptance-rejected">Failed</span>';

          const dateStr = t.updatedAt ? new Date(t.updatedAt).toLocaleString('en-US') : '';
          const canDelete = isCompleted || isFailed;

          item.innerHTML = ''
            + '<div class="history-item-header">'
            + '  <span>' + statusBadge + '</span>'
            + '  <span>' + dateStr + '</span>'
            + '</div>'
            + '<div class="history-item-goal">' + escapeHtml(t.goal) + '</div>'
            + '<div class="history-item-meta">'
            + '  <span>ID: ' + t.id.slice(0, 8) + '...</span>'
            + '  <span>Specialists: ' + t.workerCount + '</span>'
            + '  <span>Acceptance: ' + (t.disposition || 'n/a') + '</span>'
            + (t.continuesFrom ? '  <span>continuation ' + escapeHtml(t.continuesFrom.slice(0, 8)) + '...</span>' : '')
            + '</div>'
            + '<div class="history-item-actions"></div>';

          const actions = item.querySelector('.history-item-actions');
          if (canDelete) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-danger-outline btn-sm';
            delBtn.textContent = '🗑 Delete';
            delBtn.addEventListener('click', () => deleteTaskItem(t.id, t.goal));
            actions.appendChild(delBtn);
          }
          const openBtn = document.createElement('button');
          openBtn.className = 'btn btn-secondary btn-sm';
          openBtn.textContent = '👁 Open';
          openBtn.addEventListener('click', () => selectArchivedTask(t.id));
          actions.appendChild(openBtn);
          container.appendChild(item);
        });

      } catch (err) {
        container.innerHTML = '<div style="color: var(--danger); text-align: center; padding: 20px;">Failed to load history: ' + escapeHtml(err.message) + '</div>';
      }
    }

    function closeHistoryModal() {
      document.getElementById('historyModal').classList.add('hidden');
    }

    async function selectArchivedTask(taskId) {
      closeHistoryModal();
      try {
        const res = await fetch('/api/tasks/' + taskId);
        if (!res.ok) throw new Error('Task not found');
        const data = await res.json();
        viewingArchivedTaskId = taskId;
        renderTaskView(data.leadTask, data.workers || [], true);
      } catch (err) {
        alert('Failed to open task: ' + err.message);
      }
    }

    function showEmptyState() {
      document.getElementById('activeTaskGoalBox').classList.add('hidden');
      document.getElementById('archiveViewingBanner').classList.add('hidden');
      document.getElementById('decisionCard').classList.add('hidden');
      document.getElementById('taskOutputArea').innerText = 'Task dispatch results, specialist reports, and the final verdict will appear here.';
      document.getElementById('taskStatusLabel').innerText = 'Status: waiting to start';
      const badge = document.getElementById('acceptanceBadge');
      badge.className = 'acceptance-pill acceptance-none';
      badge.innerText = 'no checks';
      document.getElementById('activeTaskIdDisplay').innerText = 'no active task';
      currentTaskId = null;
      displayedTaskTerminal = false;
      updateContinueBtn();
    }

    async function closeTaskView() {
      const closing = currentTaskId;
      dismissedTaskId = closing;
      viewingArchivedTaskId = null;
      showEmptyState();
      try {
        const res = await fetch('/api/tasks/latest');
        if (!res.ok) return;
        const data = await res.json();
        if (data.leadTask && isTerminalState(data.leadTask.state)) dismissedTaskId = data.leadTask.id;
      } catch (_) {}
    }

    async function returnToLatestTask() {
      viewingArchivedTaskId = null;
      try {
        const res = await fetch('/api/tasks/latest');
        if (!res.ok) throw new Error('latest');
        const data = await res.json();
        if (data.leadTask && isActiveState(data.leadTask.state)) {
          dismissedTaskId = null;
          renderTaskView(data.leadTask, data.workers || [], false);
          return;
        }
        dismissedTaskId = data.leadTask ? data.leadTask.id : null;
      } catch (_) {}
      showEmptyState();
    }

    async function deleteTaskItem(taskId, goalText) {
      if (!confirm('Delete task from database?\\n' + (goalText ? '"' + goalText + '"' : taskId))) return;

      try {
        const res = await fetch('/api/tasks/' + taskId, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete task');

        if (viewingArchivedTaskId === taskId || currentTaskId === taskId) {
          viewingArchivedTaskId = null;
          document.getElementById('taskOutputArea').innerText = 'Task deleted from database.';
          document.getElementById('taskStatusLabel').innerText = 'Status: task deleted';
          document.getElementById('activeTaskIdDisplay').innerText = '';
          document.getElementById('activeTaskGoalBox').classList.add('hidden');
          document.getElementById('archiveViewingBanner').classList.add('hidden');
          currentTaskId = null;
          syncActiveTask();
        }

        fetchHistoryCount();
        openHistoryModal();
      } catch (err) {
        alert('Failed to delete: ' + err.message);
      }
    }

    async function deleteCurrentTask() {
      if (!currentTaskId) return;
      const goalEl = document.getElementById('activeTaskGoalText');
      const goal = goalEl ? goalEl.innerText : currentTaskId;
      await deleteTaskItem(currentTaskId, goal);
    }

    function escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function startServer() {
      const workspace = document.getElementById('workspaceInput').value.trim();
      if (!workspace) return alert('Specify project path!');

      const startBtn = document.getElementById('startBtn');
      const stopBtn = document.getElementById('stopBtn');
      const text = document.getElementById('serverStatusText');
      const dot = document.getElementById('serverDot');
      const logs = document.getElementById('serverLogsBody');

      startBtn.disabled = true;
      dot.className = 'status-dot starting';
      text.innerText = 'Starting process...';
      logs.innerText = '[LAUNCHER] Initializing server startup...\\n';

      try {
        const res = await fetch('/api/server/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace })
        });
        const data = await res.json();
        if (!data.success) {
          logs.innerText += '[ERROR] ' + (data.message || data.error || 'Failed to start server') + '\\n';
        }
      } catch (err) {
        logs.innerText += '[NETWORK ERROR] No connection to launcher: ' + err.message + '\\n';
      }
      setTimeout(updateStatus, 800);
    }

    async function stopServer() {
      const stopBtn = document.getElementById('stopBtn');
      const text = document.getElementById('serverStatusText');
      stopBtn.disabled = true;
      text.innerText = 'Stopping...';

      try {
        await fetch('/api/server/stop', { method: 'POST' });
      } catch (err) {
        alert('Failed to stop: ' + err.message);
      }
      setTimeout(updateStatus, 500);
    }

    async function dispatchTask() {
      const goal = document.getElementById('taskGoal').value.trim();
      if (!goal) return alert('Enter task goal!');

      const checksRaw = document.getElementById('taskChecks').value.trim();
      const checks = checksRaw ? checksRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      currentTaskId = null;
      viewingArchivedTaskId = null;
      dismissedTaskId = null;
      document.getElementById('archiveViewingBanner').classList.add('hidden');
      document.getElementById('decisionCard').classList.add('hidden');
      await executeA2A({ goal, checks });
    }

    async function continueTask() {
      const goal = document.getElementById('taskGoal').value.trim();
      if (!goal) return alert('Enter task goal!');
      if (!currentTaskId || !displayedTaskTerminal) return;

      const checksRaw = document.getElementById('taskChecks').value.trim();
      const checks = checksRaw ? checksRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

      const continueFrom = currentTaskId;
      currentTaskId = null;
      viewingArchivedTaskId = null;
      dismissedTaskId = null;
      displayedTaskTerminal = false;
      updateContinueBtn();
      document.getElementById('archiveViewingBanner').classList.add('hidden');
      document.getElementById('decisionCard').classList.add('hidden');
      await executeA2A({ goal, checks, continueFrom });
    }

    async function submitDecision() {
      const decisionId = document.getElementById('decisionId').value;
      const choice = document.getElementById('decisionChoice').value.trim();
      const answer = document.getElementById('decisionAnswer').value.trim();

      document.getElementById('decisionCard').classList.add('hidden');
      await executeA2A({
        goal: answer || choice || 'Approved',
        taskId: currentTaskId,
        decision: decisionId,
        choice: choice || undefined
      });
    }

    function selectOption(id) {
      document.getElementById('decisionChoice').value = id;
    }

    async function executeA2A(payload) {
      const out = document.getElementById('taskOutputArea');
      const statusLabel = document.getElementById('taskStatusLabel');
      const dispatchBtn = document.getElementById('dispatchBtn');

      if (payload.goal) {
        document.getElementById('activeTaskGoalText').innerText = payload.goal;
        document.getElementById('activeTaskSubText').classList.add('hidden');
        document.getElementById('activeTaskGoalBox').classList.remove('hidden');
      }

      dispatchBtn.disabled = true;
      statusLabel.innerText = 'Status: task in progress...';
      const goalBanner = payload.goal ? '🎯 Goal: ' + payload.goal + '\\n\\n' : '';
      out.innerText = goalBanner + '>>> Task dispatched to Lead Orchestrator (LangGraph).\\nLead analyzes goal, creates assignments, and delegates them to specialists...\\nPlease do not close this page.';

      try {
        const res = await fetch('/api/task/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        const task = data.result;
        currentTaskId = task.id || currentTaskId;
        document.getElementById('activeTaskIdDisplay').innerText = currentTaskId ? 'ID: ' + currentTaskId : '';

        const state = task.status?.state;
        const msgText = extractParts(task.status?.message?.parts);

        const isInputRequired = state === 'TASK_STATE_INPUT_REQUIRED' || state === 6 || state === '6';
        const isCompleted = state === 'TASK_STATE_COMPLETED' || state === 3 || state === '3';
        const isFailed = state === 'TASK_STATE_FAILED' || state === 4 || state === '4';

        if (isInputRequired) {
          statusLabel.innerText = 'Status: Input required (paused)';
          const pause = task.metadata?.pause || {};
          
          document.getElementById('decisionCard').classList.remove('hidden');
          const isErrorPause = pause.kind === 'error';
          
          let promptText = isErrorPause
            ? 'Error during Lead step: ' + (pause.message || 'Error') + '\\nSend a message to retry the step.'
            : (pause.question || pause.message || 'Waiting for response');
            
          document.getElementById('decisionQuestion').innerText = promptText;
          document.getElementById('decisionId').value = pause.decisionId || '';

          if (isErrorPause && !document.getElementById('decisionAnswer').value) {
            document.getElementById('decisionAnswer').value = 'Retry without trailing slashes in allowedFiles';
          }

          const optContainer = document.getElementById('decisionOptionsList');
          optContainer.innerHTML = '';
          if (pause.options && pause.options.length) {
            pause.options.forEach(opt => {
              const pill = document.createElement('span');
              pill.className = 'option-pill';
              pill.innerText = opt.id + ': ' + opt.description;
              pill.onclick = () => selectOption(opt.id);
              optContainer.appendChild(pill);
            });
          }

          out.innerText = goalBanner + '⚠️ TASK PAUSED\\nLead is waiting for response before continuing.\\n\\n' + msgText;

        } else if (isCompleted) {
          statusLabel.innerText = 'Status: COMPLETED SUCCESSFULLY';
          const artifact = task.artifacts?.at(-1);
          const artifactText = extractParts(artifact?.parts);
          const disposition = artifact?.metadata?.acceptance?.disposition;

          const accBadge = document.getElementById('acceptanceBadge');
          if (disposition === 'accepted') {
            accBadge.className = 'acceptance-pill acceptance-accepted';
            accBadge.innerText = 'Acceptance: Passed';
          } else if (disposition === 'rejected') {
            accBadge.className = 'acceptance-pill acceptance-rejected';
            accBadge.innerText = 'Acceptance: Rejected';
          } else {
            accBadge.className = 'acceptance-pill acceptance-none';
            accBadge.innerText = 'Acceptance: ' + (disposition || 'n/a');
          }

          out.innerText = goalBanner + '✅ WORK COMPLETED\\n' + (artifactText || msgText || 'Completed without additional text.');

        } else if (isFailed) {
          statusLabel.innerText = 'Status: FAILED';
          out.innerText = goalBanner + '❌ Task failed with an error:\\n\\n' + msgText;
        } else {
          statusLabel.innerText = 'Status: ' + state;
          out.innerText = goalBanner + 'Response status: ' + state + '\\n\\n' + msgText;
        }

      } catch (err) {
        statusLabel.innerText = 'Status: error';
        out.innerText = '❌ Execution error:\\n' + err.message;
      } finally {
        dispatchBtn.disabled = false;
      }
    }

    function extractParts(parts) {
      if (!Array.isArray(parts)) return '';
      return parts.map(p => p.content?.$case === 'text' ? p.content.value : (p.text || '')).filter(Boolean).join('\\n');
    }

    async function fetchLimits(force = false) {
      try {
        const res = await fetch('/api/limits' + (force ? '?force=1' : ''));
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success) return;

        if (data.email) {
          document.getElementById('accountEmail').innerText = data.email;
        }
        if (data.planType) {
          document.getElementById('planTypeBadge').innerText = data.planType;
          document.getElementById('accountType').innerText = data.planType;
        }

        if (data.primary) {
          const used = data.primary.usedPercent !== undefined ? data.primary.usedPercent : 0;
          const bar = document.getElementById('fiveHourBar');
          bar.style.width = Math.min(used, 100) + '%';
          bar.className = 'progress-bar-fill' + (used > 85 ? ' danger' : used > 60 ? ' warning' : '');
          document.getElementById('fiveHourVal').innerText = used + '%';

          if (data.primary.resetsAt) {
            const date = new Date(data.primary.resetsAt * 1000);
            document.getElementById('fiveHourReset').innerText = 'Resets at ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        }

        if (data.secondary) {
          const used = data.secondary.usedPercent !== undefined ? data.secondary.usedPercent : 0;
          const bar = document.getElementById('weeklyBar');
          bar.style.width = Math.min(used, 100) + '%';
          bar.className = 'progress-bar-fill' + (used > 85 ? ' danger' : used > 60 ? ' warning' : '');
          document.getElementById('weeklyVal').innerText = used + '%';

          if (data.secondary.resetsAt) {
            const date = new Date(data.secondary.resetsAt * 1000);
            document.getElementById('weeklyReset').innerText = 'Resets: ' + date.toLocaleDateString([], { day: '2-digit', month: '2-digit' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        }
      } catch (_) {}
    }

    setInterval(updateStatus, 1000);
    updateStatus();

    function addAboutRow(list, agent, isLead) {
      const row = document.createElement('div');
      row.className = 'about-role';
      const head = document.createElement('div');
      head.className = 'about-role-head';
      const name = document.createElement('span');
      name.className = 'about-role-name';
      name.textContent = agent.name;
      head.appendChild(name);
      if (isLead) {
        const lead = document.createElement('span');
        lead.className = 'about-badge';
        lead.textContent = 'lead';
        head.appendChild(lead);
      }
      const write = agent.sandbox === 'workspace-write';
      const badge = document.createElement('span');
      badge.className = 'about-badge' + (write ? ' write' : '');
      badge.textContent = write ? 'write' : 'read';
      head.appendChild(badge);
      const model = document.createElement('span');
      model.className = 'about-model';
      model.textContent = agent.model + ' · ' + agent.effort;
      head.appendChild(model);
      row.appendChild(head);
      const desc = document.createElement('div');
      desc.className = 'about-desc';
      desc.textContent = agent.description;
      row.appendChild(desc);
      const tools = agent.tools || {};
      const extra = [];
      if (tools.mcpServers && tools.mcpServers.length > 0) extra.push('MCP: ' + tools.mcpServers.join(', '));
      if (tools.skills) extra.push('skills');
      if (extra.length > 0) {
        const line = document.createElement('div');
        line.className = 'about-extra';
        line.textContent = extra.join(' · ');
        row.appendChild(line);
      }
      list.appendChild(row);
    }

    async function loadTeam() {
      const errEl = document.getElementById('aboutTeamError');
      try {
        const res = await fetch('/api/team');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        const list = document.getElementById('aboutTeamList');
        list.textContent = '';
        addAboutRow(list, data.lead, true);
        data.roles.forEach(function (r) { addAboutRow(list, r, false); });
        document.getElementById('aboutTeamSummary').textContent = 'Team (' + (data.roles.length + 1) + ' agents)';
      } catch (e) {
        errEl.textContent = 'Failed to load team: ' + e.message;
        errEl.classList.remove('hidden');
      }
    }
    loadTeam();

    setInterval(fetchLimits, 30000);
    fetchLimits();
  </script>
</body>
</html>`);
});

// API: Server status
app.get('/api/server/status', (req, res) => {
  res.json({
    status: serverStatus,
    logs: serverLogs.slice(-200)
  });
});

function freePort3000() {
  try {
    const { execSync } = require('child_process');
    const pids = execSync('lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null || true', { encoding: 'utf8' }).trim();
    if (pids) {
      for (const raw of pids.split('\n')) {
        const pid = parseInt(raw.trim(), 10);
        if (pid && pid !== process.pid) {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

// API: Start orchestrator server
app.post('/api/server/start', async (req, res) => {
  // If orchestrator is already running and responds, record status
  try {
    const ping = await fetch('http://127.0.0.1:3000/orchestrator/agent-card.json', { signal: AbortSignal.timeout(800) });
    if (ping.ok) {
      serverStatus = 'running';
      return res.json({ success: true, message: 'Orchestrator is already running' });
    }
  } catch (_) {}

  // Clean up dangling processes on port 3000 before startup
  freePort3000();
  await new Promise(r => setTimeout(r, 200));

  const workspace = req.body.workspace || process.cwd();
  if (!fs.existsSync(workspace)) {
    return res.status(400).json({ success: false, message: 'Specified folder does not exist: ' + workspace });
  }

  serverStatus = 'starting';
  serverLogs = [`[LAUNCHER] Starting orchestrator for workspace: ${workspace}\n`];

  orchestratorProcess = spawn('node', ['src/server.js'], {
    cwd: __dirname,
    env: { ...process.env, CODEX_WORKSPACE: workspace }
  });

  orchestratorProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    serverLogs.push(text);
    if (text.includes('listening at') || text.includes('Codex Universal A2A')) {
      serverStatus = 'running';
    }
  });

  orchestratorProcess.stderr.on('data', (chunk) => {
    serverLogs.push(chunk.toString());
  });

  orchestratorProcess.on('close', (code) => {
    serverLogs.push(`\n[LAUNCHER] Server process exited (code: ${code})\n`);
    orchestratorProcess = null;
    serverStatus = 'stopped';
  });

  // Fast polling for port 3000 readiness
  let attempts = 0;
  const pollTimer = setInterval(async () => {
    attempts++;
    try {
      const ping = await fetch('http://127.0.0.1:3000/orchestrator/agent-card.json', { signal: AbortSignal.timeout(500) });
      if (ping.ok) {
        serverStatus = 'running';
        clearInterval(pollTimer);
      }
    } catch (_) {}
    if (attempts > 20) clearInterval(pollTimer);
  }, 400);

  res.json({ success: true });
});

// API: Stop server
app.post('/api/server/stop', (req, res) => {
  serverLogs.push('\n[LAUNCHER] Stopping server process...\n');
  if (orchestratorProcess) {
    try { orchestratorProcess.kill('SIGTERM'); } catch (_) {}
    const proc = orchestratorProcess;
    setTimeout(() => {
      if (orchestratorProcess === proc) {
        try { orchestratorProcess.kill('SIGKILL'); } catch (_) {}
      }
    }, 2000);
    orchestratorProcess = null;
  }

  // Force release port 3000 if process hangs
  freePort3000();

  serverStatus = 'stopped';
  serverLogs.push('[LAUNCHER] Orchestrator server stopped.\n');
  res.json({ success: true });
});

// API: Send A2A task directly via verified SDK
app.post('/api/task/send', async (req, res) => {
  try {
    if (serverStatus !== 'running') {
      return res.status(400).json({ success: false, error: 'Orchestrator server is not running!' });
    }

    const { goal, checks, taskId, continueFrom, decision, choice } = req.body;
    if (taskId && continueFrom) {
      return res.status(400).json({ success: false, error: 'taskId and continueFrom are mutually exclusive' });
    }
    const baseUrl = 'http://127.0.0.1:3000';
    const authToken = readAuthToken(process.env.CODEX_A2A_TOKEN_FILE ? { filePath: process.env.CODEX_A2A_TOKEN_FILE } : undefined);
    const client = await new ClientFactory().createFromUrl(baseUrl, '/orchestrator/agent-card.json');
    const requestOptions = { serviceParameters: { Authorization: `Bearer ${authToken}` } };

    let contextId = '';
    const lookupId = taskId || continueFrom;
    if (lookupId) {
      const existing = await client.getTask({ tenant: '', id: lookupId }, requestOptions);
      contextId = existing?.contextId || '';
    }

    const messageMetadata = {};
    if (choice !== undefined && choice !== '') messageMetadata.choice = choice;
    if (decision !== undefined && decision !== '') messageMetadata.decisionId = decision;
    if (Array.isArray(checks) && checks.length > 0) {
      messageMetadata.acceptance = {
        requiredChecks: checks.map((cmd, idx) => parseCheckCommand(cmd, idx))
      };
    }

    const result = await client.sendMessage({
      tenant: '',
      message: {
        messageId: `web-${Date.now()}`,
        contextId,
        taskId: taskId || '',
        role: 1, // USER
        parts: [{ content: { $case: 'text', value: goal || '' }, mediaType: 'text/plain', filename: '', metadata: undefined }],
        metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
        extensions: [],
        referenceTaskIds: continueFrom ? [continueFrom] : [],
      },
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
      metadata: undefined,
    }, requestOptions);

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

function formatLeadTask(db, lead) {
  let goal = '';
  let lastInstruction = '';
  let continuesFrom = '';
  if (lead.history) {
    try {
      const history = JSON.parse(lead.history);
      const userMsgs = history.filter(m => m.role === 'ROLE_USER' || m.role === 1 || m.role === 'user');
      if (userMsgs.length > 0) {
        const firstMsg = userMsgs[0];
        if (Array.isArray(firstMsg.referenceTaskIds) && typeof firstMsg.referenceTaskIds[0] === 'string') {
          continuesFrom = firstMsg.referenceTaskIds[0];
        }
        for (const part of firstMsg.parts || []) {
          const text = part.text || part.content?.value;
          if (typeof text === 'string' && text.trim()) {
            goal = text.trim();
            break;
          }
        }
        if (userMsgs.length > 1) {
          const lastMsg = userMsgs[userMsgs.length - 1];
          for (const part of lastMsg.parts || []) {
            const text = part.text || part.content?.value;
            if (typeof text === 'string' && text.trim()) {
              lastInstruction = text.trim();
              break;
            }
          }
        }
      }
    } catch (_) {}
  }

  const workers = db.prepare("SELECT role, state, task_id, updated_at FROM dispatch_journal WHERE run_id = ? ORDER BY created_at ASC").all(lead.id);

  return {
    leadTask: {
      id: lead.id,
      goal: goal || null,
      lastInstruction: lastInstruction || null,
      continuesFrom: continuesFrom || null,
      state: lead.status_state,
      status: lead.status ? JSON.parse(lead.status) : null,
      artifacts: lead.artifacts ? JSON.parse(lead.artifacts) : [],
      metadata: lead.metadata ? JSON.parse(lead.metadata) : {},
      updatedAt: lead.status_last_updated
    },
    workers
  };
}

// API: Get latest task state
app.get('/api/tasks/latest', (req, res) => {
  try {
    const dbPath = path.join(__dirname, '.runtime/state.sqlite');
    if (!fs.existsSync(dbPath)) return res.json({ leadTask: null, workers: [] });
    
    const db = new Database(dbPath, { readonly: true });
    try {
      const lead = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' ORDER BY status_last_updated DESC LIMIT 1").get();
      if (!lead) return res.json({ leadTask: null, workers: [] });

      res.json(formatLeadTask(db, lead));
    } finally {
      db.close();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: List all tasks in history
app.get('/api/tasks/history', (req, res) => {
  try {
    const dbPath = path.join(__dirname, '.runtime/state.sqlite');
    if (!fs.existsSync(dbPath)) return res.json({ tasks: [] });

    const db = new Database(dbPath, { readonly: true });
    try {
      const leads = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' ORDER BY status_last_updated DESC").all();
      const tasks = leads.map(lead => {
        let goal = '';
        let continuesFrom = null;
        if (lead.history) {
          try {
            const h = JSON.parse(lead.history);
            const userMsg = h.find(m => m.role === 'ROLE_USER' || m.role === 1 || m.role === 'user');
            if (userMsg && Array.isArray(userMsg.referenceTaskIds) && typeof userMsg.referenceTaskIds[0] === 'string') {
              continuesFrom = userMsg.referenceTaskIds[0];
            }
            if (userMsg && Array.isArray(userMsg.parts)) {
              for (const part of userMsg.parts) {
                const text = part.text || part.content?.value;
                if (typeof text === 'string' && text.trim()) {
                  goal = text.trim();
                  break;
                }
              }
            }
          } catch (_) {}
        }
        const workerCount = db.prepare("SELECT count(*) as c FROM dispatch_journal WHERE run_id = ?").get(lead.id).c;
        let disposition = null;
        if (lead.artifacts) {
          try {
            const arts = JSON.parse(lead.artifacts);
            disposition = arts?.at(-1)?.metadata?.acceptance?.disposition || null;
          } catch (_) {}
        }
        return {
          id: lead.id,
          goal: goal || '(no description)',
          state: lead.status_state,
          updatedAt: lead.status_last_updated,
          workerCount,
          disposition,
          continuesFrom
        };
      });
      res.json({ tasks });
    } finally {
      db.close();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Details of a specific task by ID
app.get('/api/tasks/:id', (req, res) => {
  try {
    const taskId = req.params.id;
    const dbPath = path.join(__dirname, '.runtime/state.sqlite');
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

    const db = new Database(dbPath, { readonly: true });
    try {
      const lead = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' AND id = ?").get(taskId);
      if (!lead) return res.status(404).json({ error: 'Task not found' });

      res.json(formatLeadTask(db, lead));
    } finally {
      db.close();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Safe deletion of a task and its records
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const taskId = req.params.id;
    const dbPath = path.join(__dirname, '.runtime/state.sqlite');
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: 'Database not found' });

    const db = new Database(dbPath);
    try {
      const lead = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' AND id = ?").get(taskId);
      if (!lead) return res.status(404).json({ error: 'Task not found' });

      const deletableStates = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'];
      if (!deletableStates.includes(lead.status_state)) {
        return res.status(400).json({ error: 'Cannot delete an active task!' });
      }

      const deleteTx = db.transaction(() => {
        const workers = db.prepare("SELECT task_id FROM dispatch_journal WHERE run_id = ?").all(taskId).map(r => r.task_id);
        if (workers.length > 0) {
          const placeholders = workers.map(() => '?').join(',');
          db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...workers);
          try { db.prepare(`DELETE FROM writer_executions WHERE task_id IN (${placeholders})`).run(...workers); } catch (_) {}
        }
        db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
        db.prepare("DELETE FROM dispatch_journal WHERE run_id = ?").run(taskId);
        try { db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(taskId); } catch (_) {}
        try { db.prepare("DELETE FROM writes WHERE thread_id = ?").run(taskId); } catch (_) {}
        try { db.prepare("DELETE FROM usage_ledger WHERE run_id = ?").run(taskId); } catch (_) {}
        try { db.prepare("DELETE FROM writer_executions WHERE task_id = ?").run(taskId); } catch (_) {}
      });

      deleteTx();
      res.json({ success: true, deletedId: taskId });
    } finally {
      db.close();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: team description for the "about" card
app.get('/api/team', (req, res) => {
  try {
    const pick = (r) => ({
      name: r.name,
      description: r.description,
      model: r.model,
      effort: r.effort,
      sandbox: r.sandbox,
      tools: { mcpServers: r.tools.mcpServers, skills: r.tools.skills },
    });
    res.json({
      lead: pick(createLeadRole()),
      roles: Array.from(loadRoles().values()).map(pick),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Fetch 5h and weekly account limits via Codex App Server
app.get('/api/limits', async (req, res) => {
  const force = req.query.force === '1';
  const now = Date.now();
  if (!force && cachedLimits && (now - lastLimitsFetch < 30_000)) {
    return res.json(cachedLimits);
  }

  try {
    const server = new CodexAppServer({ cwd: process.cwd() });
    try {
      const [data, accountData] = await Promise.all([
        server.readRateLimits(),
        server.getAccount().catch(() => null)
      ]);
      const r = data?.rateLimits;
      if (r) {
        cachedLimits = {
          success: true,
          email: accountData?.account?.email || null,
          planType: accountData?.account?.planType || r.planType || 'plus',
          primary: r.primary || null,    // 5h
          secondary: r.secondary || null // weekly
        };
        lastLimitsFetch = now;
        return res.json(cachedLimits);
      }
    } finally {
      await server.close();
    }
  } catch (err) {
    if (cachedLimits) return res.json(cachedLimits);
    return res.status(500).json({ success: false, error: err.message });
  }

  res.json({ success: false, primary: null, secondary: null });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Launcher listening at: http://127.0.0.1:${PORT}`);
});
