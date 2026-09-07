/**
 * OMA Graphical Dashboard -- the primary user interface.
 *
 * A graphical SPA served at http://localhost:8384 that provides:
 *   - Subscription-based login for Claude, ChatGPT, Gemini
 *   - API key entry as fallback
 *   - Provider health monitoring
 *   - Task execution with progress
 *   - RALPH phase visualization (Reason, Act, Learn, Plan, Handoff)
 *   - Live log stream
 *   - Dark/light theme
 *
 * On all platforms, opens in the default browser.
 */

import http from 'node:http';
import { execSync } from 'node:child_process';
import { OMA } from '../agent.js';
import { AuthManager } from '../providers/auth.js';

// ---- inline SPA ----

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OMA - Open Multi Agent</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --fg: #c9d1d9; --fg2: #8b949e;
    --card: #161b22; --border: #30363d; --border2: #21262d;
    --accent: #58a6ff; --accent2: #1f6feb; --green: #3fb950; --red: #f85149;
    --yellow: #d29922; --purple: #bc8cff; --orange: #f0883e;
    --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    --radius: 10px; --radius-sm: 6px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--sans); background: var(--bg); color: var(--fg);
    line-height: 1.5; min-height: 100vh;
  }

  .app { display: flex; flex-direction: column; min-height: 100vh; }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 24px; border-bottom: 1px solid var(--border);
    background: var(--bg2);
  }
  .header h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
  .header h1 span { color: var(--accent); }
  .header-right { display: flex; gap: 12px; align-items: center; }

  .main { display: grid; grid-template-columns: 300px 1fr; flex: 1; }
  @media (max-width: 900px) { .main { grid-template-columns: 1fr; } }

  .sidebar {
    border-right: 1px solid var(--border); padding: 20px;
    background: var(--bg2); overflow-y: auto;
  }

  .content { padding: 20px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }

  /* ---- cards ---- */
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: hidden;
  }
  .card-header {
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  .card-header h2 {
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.8px; color: var(--fg2);
  }
  .card-body { padding: 16px; }

  /* ---- providers sidebar ---- */
  .section-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 1px; color: var(--fg2); margin-bottom: 12px;
  }

  .provider-card {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 12px; margin-bottom: 8px;
    transition: border-color 0.2s; cursor: pointer;
  }
  .provider-card:hover { border-color: var(--accent); }
  .provider-card.connected { border-left: 3px solid var(--green); }
  .provider-card.disconnected { border-left: 3px solid var(--fg2); }
  .provider-card.selected { border-color: var(--accent); background: rgba(88,166,255,0.05); }

  .provider-top { display: flex; align-items: center; justify-content: space-between; }
  .provider-name { font-weight: 600; font-size: 13px; }
  .provider-icon {
    width: 22px; height: 22px; border-radius: 5px; display: flex;
    align-items: center; justify-content: center; font-size: 12px;
    font-weight: 700; color: #fff;
  }
  .provider-meta { font-size: 11px; color: var(--fg2); margin-top: 4px; }

  /* ---- buttons ---- */
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: var(--radius-sm);
    font-size: 12px; font-weight: 500; cursor: pointer;
    border: 1px solid transparent; transition: all 0.15s;
    font-family: var(--sans); line-height: 1.4;
  }
  .btn-primary { background: var(--accent2); color: #fff; }
  .btn-primary:hover { background: var(--accent); }
  .btn-success { background: rgba(63,185,80,0.15); color: var(--green); border-color: rgba(63,185,80,0.3); }
  .btn-danger { background: rgba(248,81,73,0.1); color: var(--red); border-color: rgba(248,81,73,0.2); }
  .btn-danger:hover { background: rgba(248,81,73,0.2); }
  .btn-ghost { background: transparent; color: var(--fg2); border-color: var(--border); }
  .btn-ghost:hover { color: var(--fg); border-color: var(--fg2); }
  .btn-sm { padding: 4px 10px; font-size: 11px; }
  .btn-lg { padding: 10px 24px; font-size: 14px; border-radius: var(--radius); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ---- badge ---- */
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 12px;
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .badge-green { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-red { background: rgba(248,81,73,0.15); color: var(--red); }
  .badge-yellow { background: rgba(210,153,34,0.15); color: var(--yellow); }
  .badge-blue { background: rgba(88,166,255,0.15); color: var(--accent); }
  .badge-gray { background: rgba(139,148,158,0.15); color: var(--fg2); }
  .badge-purple { background: rgba(188,140,255,0.15); color: var(--purple); }

  /* ---- RALPH stepper ---- */
  .ralph-stepper {
    display: flex; align-items: center; justify-content: center;
    gap: 0; padding: 16px 8px;
  }
  .ralph-phase {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    position: relative;
  }
  .ralph-node {
    width: 36px; height: 36px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; color: var(--fg2);
    background: var(--bg); border: 2px solid var(--border);
    transition: all 0.3s;
  }
  .ralph-node.active {
    border-color: var(--accent); color: var(--accent);
    background: rgba(88,166,255,0.1);
    animation: ralph-pulse 1.5s ease-in-out infinite;
  }
  .ralph-node.done {
    border-color: var(--green); color: var(--green);
    background: rgba(63,185,80,0.1);
  }
  .ralph-connector {
    width: 24px; height: 2px; background: var(--border);
    transition: background 0.3s;
  }
  .ralph-connector.done { background: var(--green); }
  .ralph-connector.active { background: var(--accent); }
  .ralph-label {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--fg2); margin-top: 2px;
  }

  @keyframes ralph-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(88,166,255,0.3); }
    50% { box-shadow: 0 0 0 6px rgba(88,166,255,0); }
  }

  /* ---- setup view ---- */
  .setup-view { max-width: 640px; }
  .setup-view h2 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .setup-view .subtitle { font-size: 14px; color: var(--fg2); margin-bottom: 24px; }

  .connect-card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); margin-bottom: 12px; overflow: hidden;
  }
  .connect-card.is-connected { border-left: 3px solid var(--green); }

  .connect-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px; cursor: pointer;
  }
  .connect-header:hover { background: rgba(88,166,255,0.03); }
  .connect-left { display: flex; align-items: center; gap: 10px; }
  .connect-icon {
    width: 32px; height: 32px; border-radius: 8px; display: flex;
    align-items: center; justify-content: center; font-size: 15px;
    font-weight: 700; color: #fff;
  }
  .connect-name { font-weight: 600; font-size: 15px; }
  .connect-desc { font-size: 12px; color: var(--fg2); }

  .connect-body {
    padding: 0 18px 18px; display: none;
  }
  .connect-body.open { display: block; }

  .connect-instructions {
    background: var(--bg); border: 1px solid var(--border2); border-radius: var(--radius-sm);
    padding: 14px; margin-bottom: 14px; font-size: 13px; line-height: 1.7;
  }
  .connect-instructions ol { padding-left: 20px; }
  .connect-instructions li { margin-bottom: 4px; }
  .connect-instructions code {
    background: rgba(88,166,255,0.1); padding: 1px 6px; border-radius: 3px;
    font-family: var(--mono); font-size: 12px; color: var(--accent);
  }

  .token-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .token-row input {
    flex: 1; background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 8px 12px; color: var(--fg);
    font-size: 13px; font-family: var(--mono); outline: none;
  }
  .token-row input:focus { border-color: var(--accent); }
  .token-row input::placeholder { color: var(--fg2); font-family: var(--sans); }

  .connect-status {
    font-size: 12px; padding: 8px 12px; border-radius: var(--radius-sm);
    margin-top: 8px;
  }
  .connect-status.ok { background: rgba(63,185,80,0.1); color: var(--green); }
  .connect-status.fail { background: rgba(248,81,73,0.1); color: var(--red); }
  .connect-status.checking { background: rgba(88,166,255,0.1); color: var(--accent); }

  /* ---- task input ---- */
  .task-input-area { display: flex; flex-direction: column; gap: 12px; }
  .input-group { display: flex; flex-direction: column; gap: 4px; }
  .input-group label { font-size: 12px; font-weight: 500; color: var(--fg2); }
  .input-group input, .input-group textarea {
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 10px 14px; color: var(--fg); font-size: 14px; font-family: var(--sans);
    outline: none; transition: border-color 0.2s;
  }
  .input-group input:focus, .input-group textarea:focus { border-color: var(--accent); }
  .input-group textarea { resize: vertical; min-height: 80px; }
  .task-actions { display: flex; gap: 8px; }

  /* ---- progress ---- */
  .progress-bar { width: 100%; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 0.3s; }
  .step-list { list-style: none; }
  .step-item {
    display: flex; align-items: flex-start; gap: 10px; padding: 8px 0;
    border-bottom: 1px solid var(--border2); font-size: 13px;
  }
  .step-item:last-child { border-bottom: none; }
  .step-icon {
    width: 20px; height: 20px; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; font-size: 10px;
    flex-shrink: 0; margin-top: 2px;
  }
  .step-icon.done { background: rgba(63,185,80,0.2); color: var(--green); }
  .step-icon.active { background: rgba(88,166,255,0.2); color: var(--accent); }
  .step-icon.pending { background: var(--border); color: var(--fg2); }

  /* ---- log ---- */
  .log-area {
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 12px; font-family: var(--mono); font-size: 11px; line-height: 1.8;
    max-height: 250px; overflow-y: auto; white-space: pre-wrap;
  }
  .log-entry { padding: 1px 0; }
  .log-ts { color: var(--fg2); }
  .log-info { color: var(--accent); }
  .log-warn { color: var(--yellow); }
  .log-error { color: var(--red); }
  .log-success { color: var(--green); }

  /* ---- DAG Workflow Editor ---- */
  .wf-editor { display: flex; flex-direction: column; height: calc(100vh - 130px); gap: 0; }
  .wf-toolbar {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0;
    flex-shrink: 0;
  }
  .wf-toolbar .btn { font-size: 11px; padding: 4px 10px; }
  .wf-toolbar select {
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--fg); font-size: 12px; padding: 4px 8px; font-family: var(--sans);
    outline: none; cursor: pointer;
  }
  .wf-toolbar select:focus { border-color: var(--accent); }
  .wf-toolbar-sep { width: 1px; height: 20px; background: var(--border); }
  .wf-toolbar-label { font-size: 11px; color: var(--fg2); font-weight: 500; }

  .wf-body { display: flex; flex: 1; min-height: 0; border: 1px solid var(--border); border-top: none; border-radius: 0 0 var(--radius) var(--radius); overflow: hidden; }

  .wf-palette {
    width: 200px; background: var(--bg2); border-right: 1px solid var(--border);
    overflow-y: auto; flex-shrink: 0; padding: 8px;
  }
  .wf-palette-section { margin-bottom: 12px; }
  .wf-palette-title {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px;
    color: var(--fg2); margin-bottom: 6px; padding: 0 4px;
  }
  .wf-palette-node {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    border-radius: var(--radius-sm); cursor: grab; font-size: 12px;
    color: var(--fg); transition: background 0.15s; user-select: none;
    border: 1px solid transparent; margin-bottom: 2px;
  }
  .wf-palette-node:hover { background: rgba(88,166,255,0.06); border-color: var(--border); }
  .wf-palette-node:active { cursor: grabbing; }
  .wf-palette-icon {
    width: 24px; height: 24px; border-radius: 6px; display: flex;
    align-items: center; justify-content: center; font-size: 11px;
    font-weight: 700; color: #fff; flex-shrink: 0;
  }

  .wf-canvas-wrap {
    flex: 1; position: relative; overflow: hidden; background: var(--bg);
    background-image: radial-gradient(circle, var(--border2) 1px, transparent 1px);
    background-size: 20px 20px;
  }
  .wf-canvas-wrap svg { width: 100%; height: 100%; }

  .wf-svg-node { cursor: grab; }
  .wf-svg-node:active { cursor: grabbing; }
  .wf-svg-node rect.node-body {
    rx: 10; ry: 10; stroke-width: 1.5;
    transition: filter 0.15s, stroke 0.15s;
  }
  .wf-svg-node:hover rect.node-body { filter: brightness(1.1); }
  .wf-svg-node.selected rect.node-body { stroke: var(--accent) !important; stroke-width: 2.5; filter: drop-shadow(0 0 8px rgba(88,166,255,0.3)); }
  .wf-svg-node text { font-family: var(--sans); pointer-events: none; }
  .wf-svg-node .node-title { font-size: 12px; font-weight: 600; }
  .wf-svg-node .node-subtitle { font-size: 10px; fill: var(--fg2); }
  .wf-svg-node .node-icon-text { font-size: 11px; font-weight: 700; fill: #fff; font-family: var(--mono); }

  .wf-port { cursor: crosshair; transition: r 0.15s; }
  .wf-port:hover { r: 7; }

  .wf-edge { fill: none; stroke-width: 2; pointer-events: stroke; cursor: pointer; }
  .wf-edge:hover { stroke-width: 3; }
  .wf-edge-temp { fill: none; stroke-width: 2; stroke-dasharray: 6 4; pointer-events: none; }

  .wf-minimap {
    position: absolute; bottom: 12px; right: 12px; width: 160px; height: 100px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    overflow: hidden; opacity: 0.85; pointer-events: none;
  }
  .wf-minimap svg { width: 100%; height: 100%; }

  .wf-detail {
    width: 260px; background: var(--bg2); border-left: 1px solid var(--border);
    overflow-y: auto; flex-shrink: 0; padding: 14px; display: none;
  }
  .wf-detail.open { display: block; }
  .wf-detail-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
  .wf-detail label { font-size: 11px; font-weight: 500; color: var(--fg2); display: block; margin-bottom: 3px; margin-top: 10px; }
  .wf-detail input, .wf-detail select, .wf-detail textarea {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 6px 10px; color: var(--fg); font-size: 12px; font-family: var(--sans); outline: none;
  }
  .wf-detail input:focus, .wf-detail select:focus, .wf-detail textarea:focus { border-color: var(--accent); }
  .wf-detail textarea { resize: vertical; min-height: 60px; font-family: var(--mono); }

  .wf-zoom {
    position: absolute; bottom: 12px; left: 12px; font-size: 11px; color: var(--fg2);
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 3px 8px; font-family: var(--mono);
  }

  /* ---- theme ---- */
  .theme-toggle {
    background: none; border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--fg2); cursor: pointer; padding: 6px 10px; font-size: 14px;
  }
  .theme-toggle:hover { color: var(--fg); border-color: var(--fg2); }

  body.light {
    --bg: #ffffff; --bg2: #f6f8fa; --fg: #1f2328; --fg2: #656d76;
    --card: #ffffff; --border: #d0d7de; --border2: #eaecef;
    --accent: #0969da; --accent2: #0550ae; --green: #1a7f37; --red: #cf222e;
    --yellow: #9a6700; --purple: #8250df; --orange: #bc4c00;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.6s linear infinite;
  }

  .nav-tabs { display: flex; gap: 0; margin-bottom: 0; }
  .nav-tab {
    padding: 10px 20px; font-size: 13px; font-weight: 500;
    color: var(--fg2); cursor: pointer; border: none; background: none;
    border-bottom: 2px solid transparent; font-family: var(--sans);
  }
  .nav-tab:hover { color: var(--fg); }
  .nav-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <h1><span>OMA</span> Open Multi Agent</h1>
    <div class="header-right">
      <div class="nav-tabs">
        <button class="nav-tab active" onclick="showView('task')" id="nav-task">Task</button>
        <button class="nav-tab" onclick="showView('workflows')" id="nav-workflows">Workflows</button>
        <button class="nav-tab" onclick="showView('connect')" id="nav-connect">Connect</button>
      </div>
      <span id="conn-status" class="badge badge-gray">0 providers</span>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">&#9681;</button>
    </div>
  </div>

  <div class="main">
    <div class="sidebar">
      <div class="section-title">Providers</div>
      <div id="providers-list"></div>
      <div style="margin-top:16px">
        <button class="btn btn-primary btn-sm" onclick="showView('connect')" style="width:100%">
          + Connect Provider
        </button>
      </div>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border)">
        <div class="section-title" style="margin-bottom:8px">Safe Storage</div>
        <div id="storage-info" style="font-size:11px; color:var(--fg2); line-height:1.5; margin-bottom:10px">
          <div><span style="color:var(--fg)">File:</span> <code>~/.oma/credentials.json</code></div>
          <div><span style="color:var(--fg)">Mode:</span> <code>0600 (owner-only)</code></div>
          <div><span style="color:var(--fg)">Encrypted:</span> PBKDF2 + XOR</div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="flushAllCredentials()" style="width:100%; color:#f85149; border-color:#f8514944" title="Securely wipe all stored credentials from disk">
          &#128465; Flush Credentials
        </button>
      </div>
    </div>

    <div class="content">
      <!-- Connect View -->
      <div id="view-connect" class="setup-view" hidden>
        <h2>Connect Your Subscriptions</h2>
        <p class="subtitle">
          Use your existing paid subscriptions (Claude Pro, ChatGPT Plus, Gemini Advanced).
          No API keys needed -- OMA connects through your browser session.
        </p>

        <!-- Claude -->
        <div class="connect-card" id="cc-claude">
          <div class="connect-header" onclick="toggleConnect('claude')">
            <div class="connect-left">
              <div class="connect-icon" style="background:#d97706">C</div>
              <div>
                <div class="connect-name">Claude</div>
                <div class="connect-desc">claude.ai -- Claude Pro / Team / Enterprise</div>
              </div>
            </div>
            <span id="cc-badge-claude" class="badge badge-gray">not connected</span>
          </div>
          <div class="connect-body" id="cb-claude">
            <div class="connect-instructions">
              <strong style="font-size:12px; color:var(--accent)">Quick grab:</strong>
              <span style="font-size:12px; color:var(--fg2)"> Open
                <a href="https://claude.ai" target="_blank" style="color:var(--accent)">claude.ai</a>,
                press <code>F12</code>, go to Console, paste this and hit Enter:
              </span>
              <div style="display:flex; gap:6px; margin-top:8px; align-items:center">
                <code id="cmd-claude" style="flex:1; display:block; padding:8px 10px; background:var(--bg);
                  border:1px solid var(--border2); border-radius:4px; font-size:11px; white-space:nowrap;
                  overflow-x:auto; user-select:all">document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('sessionKey='))?.split('=').slice(1).join('=')</code>
                <button class="btn btn-sm btn-ghost" onclick="copyCmd('claude')" title="Copy command">&#128203;</button>
              </div>
              <details style="margin-top:10px; font-size:12px; color:var(--fg2)">
                <summary style="cursor:pointer; color:var(--accent)">Manual method</summary>
                <ol style="padding-left:20px; margin-top:6px; line-height:1.8">
                  <li>Go to <code>Application</code> tab &rarr; <code>Cookies</code> &rarr; <code>https://claude.ai</code></li>
                  <li>Find <code>sessionKey</code> and copy its Value</li>
                </ol>
              </details>
            </div>
            <div class="token-row">
              <input type="password" id="token-claude" placeholder="Paste sessionKey value here">
              <button class="btn btn-primary" onclick="connectProvider('claude')">Connect</button>
            </div>
            <div id="status-claude"></div>
          </div>
        </div>

        <!-- ChatGPT -->
        <div class="connect-card" id="cc-chatgpt">
          <div class="connect-header" onclick="toggleConnect('chatgpt')">
            <div class="connect-left">
              <div class="connect-icon" style="background:#10a37f">G</div>
              <div>
                <div class="connect-name">ChatGPT</div>
                <div class="connect-desc">chatgpt.com -- ChatGPT Plus / Team</div>
              </div>
            </div>
            <span id="cc-badge-chatgpt" class="badge badge-gray">not connected</span>
          </div>
          <div class="connect-body" id="cb-chatgpt">
            <div class="connect-instructions">
              <strong style="font-size:12px; color:var(--accent)">Quick grab:</strong>
              <span style="font-size:12px; color:var(--fg2)"> Open
                <a href="https://chatgpt.com" target="_blank" style="color:var(--accent)">chatgpt.com</a>,
                press <code>F12</code>, go to Console, paste this and hit Enter:
              </span>
              <div style="display:flex; gap:6px; margin-top:8px; align-items:center">
                <code id="cmd-chatgpt" style="flex:1; display:block; padding:8px 10px; background:var(--bg);
                  border:1px solid var(--border2); border-radius:4px; font-size:11px; white-space:nowrap;
                  overflow-x:auto; user-select:all">fetch('/api/auth/session').then(r=>r.json()).then(d=>console.log(d.accessToken))</code>
                <button class="btn btn-sm btn-ghost" onclick="copyCmd('chatgpt')" title="Copy command">&#128203;</button>
              </div>
              <details style="margin-top:10px; font-size:12px; color:var(--fg2)">
                <summary style="cursor:pointer; color:var(--accent)">Manual method</summary>
                <ol style="padding-left:20px; margin-top:6px; line-height:1.8">
                  <li><code>Application</code> &rarr; <code>Cookies</code> &rarr; <code>https://chatgpt.com</code></li>
                  <li>Copy value of <code>__Secure-next-auth.session-token</code></li>
                </ol>
              </details>
            </div>
            <div class="token-row">
              <input type="password" id="token-chatgpt" placeholder="Paste access token or session cookie">
              <button class="btn btn-primary" onclick="connectProvider('chatgpt')">Connect</button>
            </div>
            <div id="status-chatgpt"></div>
          </div>
        </div>

        <!-- Gemini -->
        <div class="connect-card" id="cc-gemini">
          <div class="connect-header" onclick="toggleConnect('gemini')">
            <div class="connect-left">
              <div class="connect-icon" style="background:#4285f4">G</div>
              <div>
                <div class="connect-name">Gemini</div>
                <div class="connect-desc">gemini.google.com -- Gemini Advanced</div>
              </div>
            </div>
            <span id="cc-badge-gemini" class="badge badge-gray">not connected</span>
          </div>
          <div class="connect-body" id="cb-gemini">
            <div class="connect-instructions">
              <strong style="font-size:12px; color:var(--accent)">Quick grab:</strong>
              <span style="font-size:12px; color:var(--fg2)"> Open
                <a href="https://gemini.google.com" target="_blank" style="color:var(--accent)">gemini.google.com</a>,
                press <code>F12</code>, go to Console, paste this and hit Enter:
              </span>
              <div style="display:flex; gap:6px; margin-top:8px; align-items:center">
                <code id="cmd-gemini" style="flex:1; display:block; padding:8px 10px; background:var(--bg);
                  border:1px solid var(--border2); border-radius:4px; font-size:11px; white-space:nowrap;
                  overflow-x:auto; user-select:all">document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('__Secure-1PSID='))?.split('=').slice(1).join('=')</code>
                <button class="btn btn-sm btn-ghost" onclick="copyCmd('gemini')" title="Copy command">&#128203;</button>
              </div>
              <details style="margin-top:10px; font-size:12px; color:var(--fg2)">
                <summary style="cursor:pointer; color:var(--accent)">Manual method</summary>
                <ol style="padding-left:20px; margin-top:6px; line-height:1.8">
                  <li><code>Application</code> &rarr; <code>Cookies</code> &rarr; <code>https://gemini.google.com</code></li>
                  <li>Copy value of <code>__Secure-1PSID</code></li>
                </ol>
              </details>
            </div>
            <div class="token-row">
              <input type="password" id="token-gemini" placeholder="Paste __Secure-1PSID value here">
              <button class="btn btn-primary" onclick="connectProvider('gemini')">Connect</button>
            </div>
            <div id="status-gemini"></div>
          </div>
        </div>

        <!-- API Keys section -->
        <div style="margin-top:24px; padding-top:20px; border-top:1px solid var(--border)">
          <div class="section-title" style="margin-bottom:8px">Or use API Keys</div>
          <p style="font-size:13px; color:var(--fg2); margin-bottom:12px">
            For providers without subscription login, or if you prefer direct API access.
          </p>
          <div class="connect-card" id="cc-apikey">
            <div class="connect-header" onclick="toggleConnect('apikey')">
              <div class="connect-left">
                <div class="connect-icon" style="background:var(--fg2)">&#128273;</div>
                <div>
                  <div class="connect-name">API Keys</div>
                  <div class="connect-desc">DeepSeek, GLM, Kimi, or any provider</div>
                </div>
              </div>
              <span class="badge badge-gray">manual</span>
            </div>
            <div class="connect-body" id="cb-apikey">
              <div class="input-group" style="margin-bottom:10px">
                <label>Provider</label>
                <select id="apikey-provider" style="background:var(--bg); border:1px solid var(--border);
                  border-radius:var(--radius-sm); padding:8px 12px; color:var(--fg); font-size:13px; outline:none;">
                  <option value="claude">Claude</option>
                  <option value="chatgpt">ChatGPT / OpenAI</option>
                  <option value="gemini">Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="glm">GLM</option>
                  <option value="kimi">Kimi</option>
                </select>
              </div>
              <div class="token-row">
                <input type="password" id="apikey-value" placeholder="sk-... or API key">
                <button class="btn btn-primary" onclick="connectApiKey()">Save</button>
              </div>
              <div id="status-apikey"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Workflow Editor View -->
      <div id="view-workflows" hidden style="max-width:none">
        <div class="wf-editor">
          <div class="wf-toolbar">
            <select id="wf-template-select" onchange="loadTemplate(this.value)">
              <option value="">-- Load Template --</option>
              <option value="simple_agent">Simple Agent</option>
              <option value="multi_agent">Multi-Agent Pipeline</option>
              <option value="rag_basic">RAG: Basic</option>
              <option value="rag_conversational">RAG: Conversational</option>
              <option value="rag_multi_source">RAG: Multi-Source</option>
              <option value="rag_agentic">RAG: Agentic</option>
              <option value="ralph_loop">RALPH Loop</option>
              <option value="map_reduce">Map-Reduce</option>
            </select>
            <div class="wf-toolbar-sep"></div>
            <button class="btn btn-ghost" onclick="wfZoomIn()" title="Zoom in">+</button>
            <button class="btn btn-ghost" onclick="wfZoomOut()" title="Zoom out">&minus;</button>
            <button class="btn btn-ghost" onclick="wfFitView()" title="Fit to view">Fit</button>
            <div class="wf-toolbar-sep"></div>
            <button class="btn btn-ghost" onclick="wfDeleteSelected()" title="Delete selected">&#128465;</button>
            <button class="btn btn-ghost" onclick="wfClearCanvas()" title="Clear all">Clear</button>
            <div style="flex:1"></div>
            <span class="wf-toolbar-label" id="wf-node-count">0 nodes</span>
            <div class="wf-toolbar-sep"></div>
            <button class="btn btn-primary" onclick="wfRunWorkflow()" id="wf-run-btn">&#9654; Run</button>
            <button class="btn btn-success" onclick="wfSaveWorkflow()">Save</button>
          </div>
          <div class="wf-body">
            <div class="wf-palette">
              <div class="wf-palette-section">
                <div class="wf-palette-title">Control</div>
                <div class="wf-palette-node" draggable="true" data-node-type="start">
                  <div class="wf-palette-icon" style="background:var(--green)">&#9654;</div> Start
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="end">
                  <div class="wf-palette-icon" style="background:var(--red)">&#9632;</div> End
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="branch">
                  <div class="wf-palette-icon" style="background:var(--yellow)">&#8901;</div> Branch
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="merge">
                  <div class="wf-palette-icon" style="background:var(--orange)">M</div> Merge
                </div>
              </div>
              <div class="wf-palette-section">
                <div class="wf-palette-title">Agents</div>
                <div class="wf-palette-node" draggable="true" data-node-type="agent">
                  <div class="wf-palette-icon" style="background:var(--accent2)">A</div> Agent
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="sub_agent">
                  <div class="wf-palette-icon" style="background:var(--purple)">S</div> Sub-Agent
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="ralph">
                  <div class="wf-palette-icon" style="background:#d97706">R</div> RALPH Loop
                </div>
              </div>
              <div class="wf-palette-section">
                <div class="wf-palette-title">RAG</div>
                <div class="wf-palette-node" draggable="true" data-node-type="doc_loader">
                  <div class="wf-palette-icon" style="background:#6366f1">D</div> Doc Loader
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="embedder">
                  <div class="wf-palette-icon" style="background:#14b8a6">E</div> Embedder
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="vector_store">
                  <div class="wf-palette-icon" style="background:#ec4899">V</div> Vector Store
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="retriever">
                  <div class="wf-palette-icon" style="background:#f59e0b">R</div> Retriever
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="generator">
                  <div class="wf-palette-icon" style="background:var(--accent2)">G</div> Generator
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="memory">
                  <div class="wf-palette-icon" style="background:#8b5cf6">M</div> Memory
                </div>
              </div>
              <div class="wf-palette-section">
                <div class="wf-palette-title">Tools</div>
                <div class="wf-palette-node" draggable="true" data-node-type="llm_provider">
                  <div class="wf-palette-icon" style="background:#10a37f">L</div> LLM Provider
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="tool">
                  <div class="wf-palette-icon" style="background:var(--fg2)">T</div> Tool
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="http">
                  <div class="wf-palette-icon" style="background:#0ea5e9">H</div> HTTP Request
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="code">
                  <div class="wf-palette-icon" style="background:#64748b">&#60;/&#62;</div> Code
                </div>
              </div>
            </div>
            <div class="wf-canvas-wrap" id="wf-canvas-wrap">
              <svg id="wf-svg" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <marker id="wf-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                    <path d="M0,0 L8,3 L0,6 Z" fill="var(--fg2)" />
                  </marker>
                  <marker id="wf-arrow-active" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                    <path d="M0,0 L8,3 L0,6 Z" fill="var(--accent)" />
                  </marker>
                </defs>
                <g id="wf-canvas-g"></g>
              </svg>
              <div class="wf-zoom" id="wf-zoom-label">100%</div>
              <div class="wf-minimap" id="wf-minimap">
                <svg id="wf-minimap-svg" xmlns="http://www.w3.org/2000/svg"></svg>
              </div>
            </div>
            <div class="wf-detail" id="wf-detail">
              <div class="wf-detail-title" id="wf-detail-title">Node</div>
              <label>Name</label>
              <input id="wf-d-name" oninput="wfUpdateNodeProp('name', this.value)">
              <label>Type</label>
              <input id="wf-d-type" disabled>
              <label>Provider</label>
              <select id="wf-d-provider" onchange="wfUpdateNodeProp('provider', this.value)">
                <option value="">auto</option>
                <option value="claude">Claude</option>
                <option value="chatgpt">ChatGPT</option>
                <option value="gemini">Gemini</option>
                <option value="deepseek">DeepSeek</option>
                <option value="glm">GLM</option>
                <option value="kimi">Kimi</option>
              </select>
              <label>System Prompt</label>
              <textarea id="wf-d-system" oninput="wfUpdateNodeProp('system', this.value)" placeholder="Optional system prompt..."></textarea>
              <label>Config (JSON)</label>
              <textarea id="wf-d-config" oninput="wfUpdateNodeProp('config', this.value)" placeholder='{"temperature": 0.3}'></textarea>
              <div style="margin-top:14px">
                <button class="btn btn-danger btn-sm" onclick="wfDeleteSelected()" style="width:100%">Delete Node</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Task View -->
      <div id="view-task">
        <div class="card">
          <div class="card-header">
            <h2>Task</h2>
            <span id="task-badge" class="badge badge-gray">idle</span>
          </div>
          <div class="card-body">
            <div class="task-input-area">
              <div class="input-group">
                <label>Objective</label>
                <textarea id="objective" placeholder="Describe what you want done...&#10;e.g., Analyze the top 10 HN posts today"></textarea>
              </div>
              <div class="input-group">
                <label>Criteria (optional JSON)</label>
                <input type="text" id="criteria" placeholder='{"accuracy": true, "depth": 0.8}'>
              </div>
              <div class="task-actions">
                <button class="btn btn-primary btn-lg" id="run-btn" onclick="runTask()">&#9654; Run</button>
                <button class="btn btn-danger" id="stop-btn" onclick="stopTask()" disabled>&#9632; Stop</button>
              </div>
            </div>
          </div>
        </div>

        <!-- RALPH Phase Card -->
        <div class="card" id="ralph-card" hidden>
          <div class="card-header">
            <h2>RALPH Loop</h2>
            <div style="display:flex; align-items:center; gap:8px">
              <span id="ralph-iteration" class="badge badge-purple">iteration 0</span>
              <span id="ralph-detail" style="font-size:11px; color:var(--fg2)"></span>
            </div>
          </div>
          <div class="card-body">
            <div class="ralph-stepper">
              <div class="ralph-phase"><div class="ralph-node" id="rn-reason">R</div><div class="ralph-label">Reason</div></div>
              <div class="ralph-connector" id="rc-reason-act"></div>
              <div class="ralph-phase"><div class="ralph-node" id="rn-act">A</div><div class="ralph-label">Act</div></div>
              <div class="ralph-connector" id="rc-act-learn"></div>
              <div class="ralph-phase"><div class="ralph-node" id="rn-learn">L</div><div class="ralph-label">Learn</div></div>
              <div class="ralph-connector" id="rc-learn-plan"></div>
              <div class="ralph-phase"><div class="ralph-node" id="rn-plan">P</div><div class="ralph-label">Plan</div></div>
              <div class="ralph-connector" id="rc-plan-handoff"></div>
              <div class="ralph-phase"><div class="ralph-node" id="rn-handoff">H</div><div class="ralph-label">Handoff</div></div>
            </div>
          </div>
        </div>

        <div class="card" id="progress-card" hidden>
          <div class="card-header">
            <h2>Progress</h2>
            <span id="progress-pct" style="font-family:var(--mono); font-size:12px; color:var(--fg2)">0%</span>
          </div>
          <div class="card-body">
            <div class="progress-bar" style="margin-bottom:16px">
              <div class="progress-fill" id="progress-fill" style="width:0%"></div>
            </div>
            <ul class="step-list" id="step-list"></ul>
          </div>
        </div>

        <div class="card" id="result-card" hidden>
          <div class="card-header">
            <h2>Result</h2>
            <button class="btn btn-sm btn-ghost" onclick="copyResult()">Copy</button>
          </div>
          <div class="card-body">
            <div id="result-text" style="white-space:pre-wrap; font-size:13px; line-height:1.6;"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Log</h2>
            <button class="btn btn-sm btn-ghost" onclick="clearLog()">Clear</button>
          </div>
          <div class="card-body" style="padding:0">
            <div class="log-area" id="log"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
// ---- state ----
var connectedCount = 0;
var taskRunning = false;
var lastPhaseEventCount = 0;

var PROVIDERS = {
  claude:   { name: 'Claude',   icon: 'C', bg: '#d97706' },
  chatgpt:  { name: 'ChatGPT',  icon: 'G', bg: '#10a37f' },
  gemini:   { name: 'Gemini',   icon: 'G', bg: '#4285f4' },
  deepseek: { name: 'DeepSeek', icon: 'D', bg: '#6366f1' },
  glm:      { name: 'GLM',      icon: 'Z', bg: '#ec4899' },
  kimi:     { name: 'Kimi',     icon: 'K', bg: '#14b8a6' },
};

var RALPH_PHASES = ['reason', 'act', 'learn', 'plan', 'handoff'];
var RALPH_LABELS = {
  reason: 'Analyzing state and approach',
  act: 'Executing with provider',
  learn: 'Evaluating result',
  plan: 'Adjusting strategy',
  handoff: 'Checking completion',
};

// ---- views ----
function showView(view) {
  document.getElementById('view-task').hidden = (view !== 'task');
  document.getElementById('view-connect').hidden = (view !== 'connect');
  document.getElementById('view-workflows').hidden = (view !== 'workflows');
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('nav-' + view).classList.add('active');
  if (view === 'workflows') wfInit();
}

// ---- logging ----
function addLog(msg, level) {
  level = level || 'info';
  var log = document.getElementById('log');
  var ts = new Date().toLocaleTimeString();
  log.innerHTML += '<div class="log-entry"><span class="log-ts">[' + ts + ']</span> <span class="log-' + level + '">' + escHtml(msg) + '</span></div>';
  log.scrollTop = log.scrollHeight;
}
function clearLog() { document.getElementById('log').innerHTML = ''; }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ---- RALPH stepper ----
function updateRalphPhase(currentPhase, iteration, detail) {
  document.getElementById('ralph-iteration').textContent = 'iteration ' + iteration;
  document.getElementById('ralph-detail').textContent = detail || RALPH_LABELS[currentPhase] || '';

  var phaseIndex = RALPH_PHASES.indexOf(currentPhase);

  RALPH_PHASES.forEach(function(phase, i) {
    var node = document.getElementById('rn-' + phase);
    if (!node) return;
    node.classList.remove('active', 'done');
    if (i < phaseIndex) {
      node.classList.add('done');
    } else if (i === phaseIndex) {
      node.classList.add('active');
    }
  });

  // connectors
  var connectorPairs = [
    ['rc-reason-act', 0],
    ['rc-act-learn', 1],
    ['rc-learn-plan', 2],
    ['rc-plan-handoff', 3],
  ];
  connectorPairs.forEach(function(pair) {
    var el = document.getElementById(pair[0]);
    if (!el) return;
    el.classList.remove('done', 'active');
    if (pair[1] < phaseIndex) {
      el.classList.add('done');
    } else if (pair[1] === phaseIndex) {
      el.classList.add('active');
    }
  });
}

function resetRalphStepper() {
  RALPH_PHASES.forEach(function(phase) {
    var node = document.getElementById('rn-' + phase);
    if (node) { node.classList.remove('active', 'done'); }
  });
  ['rc-reason-act', 'rc-act-learn', 'rc-learn-plan', 'rc-plan-handoff'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { el.classList.remove('done', 'active'); }
  });
  document.getElementById('ralph-iteration').textContent = 'iteration 0';
  document.getElementById('ralph-detail').textContent = '';
}

// ---- connect panel toggles ----
function toggleConnect(id) {
  var body = document.getElementById('cb-' + id);
  body.classList.toggle('open');
}

// ---- connect provider (subscription) ----
async function connectProvider(provider) {
  var input = document.getElementById('token-' + provider);
  var token = input.value.trim();
  if (!token) return;

  var statusEl = document.getElementById('status-' + provider);
  statusEl.innerHTML = '<div class="connect-status checking"><span class="spinner"></span> Verifying...</div>';

  try {
    var r = await fetch('/api/auth/connect', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ provider: provider, token: token }),
    });
    var data = await r.json();

    if (data.ok) {
      statusEl.innerHTML = '<div class="connect-status ok">Connected' + (data.detail ? ' -- ' + escHtml(data.detail) : '') + '</div>';
      addLog(PROVIDERS[provider].name + ' connected via subscription', 'success');
      input.value = '';
      fetchStatus();
    } else {
      statusEl.innerHTML = '<div class="connect-status fail">' + escHtml(data.error || 'Connection failed') + '</div>';
      addLog(PROVIDERS[provider].name + ' connection failed: ' + (data.error || 'unknown'), 'error');
    }
  } catch (e) {
    statusEl.innerHTML = '<div class="connect-status fail">Network error: ' + escHtml(e.message) + '</div>';
  }
}

// ---- connect API key ----
async function connectApiKey() {
  var provider = document.getElementById('apikey-provider').value;
  var key = document.getElementById('apikey-value').value.trim();
  if (!key) return;

  var statusEl = document.getElementById('status-apikey');
  statusEl.innerHTML = '<div class="connect-status checking"><span class="spinner"></span> Saving...</div>';

  try {
    var r = await fetch('/api/auth/apikey', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ provider: provider, api_key: key }),
    });
    var data = await r.json();
    if (data.ok) {
      statusEl.innerHTML = '<div class="connect-status ok">' + PROVIDERS[provider].name + ' API key saved</div>';
      addLog(PROVIDERS[provider].name + ' API key saved', 'success');
      document.getElementById('apikey-value').value = '';
      fetchStatus();
    } else {
      statusEl.innerHTML = '<div class="connect-status fail">' + escHtml(data.error || 'Failed') + '</div>';
    }
  } catch (e) {
    statusEl.innerHTML = '<div class="connect-status fail">' + escHtml(e.message) + '</div>';
  }
}

// ---- disconnect ----
async function disconnect(provider) {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ provider: provider }),
    });
    addLog('Disconnected ' + PROVIDERS[provider].name);
    fetchStatus();
  } catch (e) {}
}

// ---- flush all credentials ----
async function flushAllCredentials() {
  if (!confirm('Securely wipe all stored credentials from ~/.oma/credentials.json? This cannot be undone.')) return;
  try {
    var r = await fetch('/api/auth/flush', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ include_memory: false }),
    });
    var d = await r.json();
    if (d.ok) {
      addLog('Flushed credentials from safe storage (' + (d.details ? d.details.flushedCredentialsCount : 0) + ' removed)', 'success');
      fetchStatus();
    }
  } catch (e) {
    alert('Flush failed: ' + e.message);
  }
}

// ---- sidebar providers ----
function renderProviders(data) {
  var el = document.getElementById('providers-list');
  var names = ['claude', 'chatgpt', 'gemini', 'deepseek', 'glm', 'kimi'];
  var html = '';
  connectedCount = 0;

  names.forEach(function(name) {
    var info = PROVIDERS[name];
    var status = (data && data[name]) || {};
    var isConn = status.status === 'logged_in';
    if (isConn) connectedCount++;

    var badge = isConn
      ? '<span class="badge badge-green" style="font-size:9px">ON</span>'
      : '';

    var meta = isConn
      ? (status.email || status.plan || 'Active')
      : 'Not connected';

    html += '<div class="provider-card ' + (isConn ? 'connected' : 'disconnected') + '"'
      + ' onclick="' + (isConn ? "disconnect('" + name + "')" : "showView('connect'); setTimeout(function(){toggleConnect('" + name + "');document.getElementById('cb-" + name + "').classList.add('open')},50)") + '">'
      + '<div class="provider-top">'
      + '<div style="display:flex; align-items:center; gap:8px">'
      + '<div class="provider-icon" style="background:' + info.bg + '">' + info.icon + '</div>'
      + '<span class="provider-name">' + info.name + '</span>'
      + '</div>' + badge + '</div>'
      + '<div class="provider-meta">' + (isConn ? meta + ' &middot; click to disconnect' : 'Click to connect') + '</div>'
      + '</div>';
  });

  el.innerHTML = html;

  // update connect view badges
  names.forEach(function(name) {
    var status = (data && data[name]) || {};
    var badgeEl = document.getElementById('cc-badge-' + name);
    var cardEl = document.getElementById('cc-' + name);
    if (badgeEl && status.status === 'logged_in') {
      badgeEl.className = 'badge badge-green';
      badgeEl.textContent = 'connected';
      if (cardEl) cardEl.classList.add('is-connected');
    } else if (badgeEl) {
      badgeEl.className = 'badge badge-gray';
      badgeEl.textContent = 'not connected';
      if (cardEl) cardEl.classList.remove('is-connected');
    }
  });

  // header badge
  var hdr = document.getElementById('conn-status');
  if (connectedCount > 0) {
    hdr.className = 'badge badge-green';
    hdr.textContent = connectedCount + ' provider' + (connectedCount > 1 ? 's' : '');
  } else {
    hdr.className = 'badge badge-gray';
    hdr.textContent = '0 providers';
  }
}

// ---- task execution ----
async function runTask() {
  var obj = document.getElementById('objective').value.trim();
  if (!obj) { addLog('No objective set', 'warn'); return; }

  if (connectedCount === 0) {
    addLog('No providers connected -- go to Connect tab first', 'warn');
    showView('connect');
    return;
  }

  var critRaw = document.getElementById('criteria').value.trim();
  var criteria = null;
  if (critRaw) {
    try { criteria = JSON.parse(critRaw); }
    catch (e) { addLog('Invalid JSON in criteria field', 'error'); return; }
  }

  taskRunning = true;
  lastPhaseEventCount = 0;
  document.getElementById('run-btn').disabled = true;
  document.getElementById('stop-btn').disabled = false;
  document.getElementById('task-badge').className = 'badge badge-blue';
  document.getElementById('task-badge').textContent = 'running';
  document.getElementById('progress-card').hidden = false;
  document.getElementById('result-card').hidden = true;
  document.getElementById('ralph-card').hidden = false;
  document.getElementById('step-list').innerHTML = '';
  document.getElementById('progress-fill').style.width = '0%';
  resetRalphStepper();
  addLog('Starting RALPH loop: ' + obj);

  try {
    var r = await fetch('/api/run', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ objective: obj, criteria: criteria }),
    });
    var data = await r.json();

    if (data.error) {
      addLog('Error: ' + data.error, 'error');
      document.getElementById('task-badge').className = 'badge badge-red';
      document.getElementById('task-badge').textContent = 'error';
    } else {
      addLog('Task complete: ' + data.status + ' (confidence: ' + (data.confidence * 100).toFixed(0) + '%)', 'success');
      document.getElementById('task-badge').className = 'badge badge-green';
      document.getElementById('task-badge').textContent = data.status;
      document.getElementById('progress-fill').style.width = '100%';
      document.getElementById('progress-pct').textContent = '100%';

      // mark all ralph nodes done
      RALPH_PHASES.forEach(function(phase) {
        var node = document.getElementById('rn-' + phase);
        if (node) { node.classList.remove('active'); node.classList.add('done'); }
      });
      ['rc-reason-act', 'rc-act-learn', 'rc-learn-plan', 'rc-plan-handoff'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) { el.classList.remove('active'); el.classList.add('done'); }
      });

      if (data.result) {
        document.getElementById('result-card').hidden = false;
        document.getElementById('result-text').textContent = data.result;
      }

      // render lessons as step items
      if (data.lessons && data.lessons.length > 0) {
        var stepList = document.getElementById('step-list');
        data.lessons.forEach(function(lesson) {
          var icon = lesson.succeeded ? 'done' : 'pending';
          var symbol = lesson.succeeded ? '&#10003;' : '&#10007;';
          var desc = 'Iteration ' + lesson.iteration
            + (lesson.provider ? ' (' + lesson.provider + ')' : '')
            + (lesson.confidence_delta ? ' delta=' + lesson.confidence_delta.toFixed(2) : '');
          stepList.innerHTML += '<li class="step-item"><div class="step-icon ' + icon + '">' + symbol + '</div><div>' + escHtml(desc) + '</div></li>';
        });
      }
    }
  } catch (e) {
    addLog('Error: ' + e.message, 'error');
    document.getElementById('task-badge').className = 'badge badge-red';
    document.getElementById('task-badge').textContent = 'error';
  } finally {
    taskRunning = false;
    document.getElementById('run-btn').disabled = false;
    document.getElementById('stop-btn').disabled = true;
  }
}

async function stopTask() {
  addLog('Stop requested', 'warn');
  try { await fetch('/api/stop', {method: 'POST'}); } catch (e) {}
}

function copyCmd(provider) {
  var el = document.getElementById('cmd-' + provider);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(function() {
    el.style.borderColor = 'var(--green)';
    setTimeout(function() { el.style.borderColor = ''; }, 1200);
  });
}

function copyResult() {
  var text = document.getElementById('result-text').textContent;
  navigator.clipboard.writeText(text).then(function() { addLog('Copied to clipboard'); });
}

// ---- polling ----
async function fetchStatus() {
  try {
    var r = await fetch('/api/status');
    var data = await r.json();
    renderProviders(data.auth || {});

    // update ralph stepper from status
    if (taskRunning && data.ralph) {
      var rp = data.ralph;
      if (rp.current_phase && rp.current_phase !== 'idle') {
        var evts = rp.phase_events || [];
        var lastEvt = evts.length > 0 ? evts[evts.length - 1] : null;
        var iteration = lastEvt ? lastEvt.iteration : 0;
        updateRalphPhase(rp.current_phase, iteration);
      }

      // log new phase events
      var totalEvents = rp.total_events || 0;
      if (totalEvents > lastPhaseEventCount) {
        var evts = rp.phase_events || [];
        var newEvents = evts.slice(lastPhaseEventCount - totalEvents);
        newEvents.forEach(function(evt) {
          addLog('RALPH: ' + evt.phase + ' (iteration ' + evt.iteration + ')', 'info');
        });
        lastPhaseEventCount = totalEvents;
      }

      // update progress bar from confidence
      if (data.ralph.phase_events && data.ralph.phase_events.length > 0) {
        var lastEvent = data.ralph.phase_events[data.ralph.phase_events.length - 1];
        if (lastEvent.data && typeof lastEvent.data.confidence === 'number') {
          var pct = Math.round(lastEvent.data.confidence * 100);
          document.getElementById('progress-fill').style.width = pct + '%';
          document.getElementById('progress-pct').textContent = pct + '%';
        }
      }
    }
  } catch (e) {}
}

// ---- theme ----
function toggleTheme() {
  document.body.classList.toggle('light');
  try { localStorage.setItem('oma-theme', document.body.classList.contains('light') ? 'light' : 'dark'); } catch(e) {}
}

// ===========================================================================
// DAG Workflow Editor
// ===========================================================================

var NODE_W = 180, NODE_H = 64;
var NODE_DEFS = {
  start:        { label: 'Start',        icon: '▶', bg: '#3fb950', cat: 'control', ports: { in: 0, out: 1 } },
  end:          { label: 'End',          icon: '■', bg: '#f85149', cat: 'control', ports: { in: 1, out: 0 } },
  branch:       { label: 'Branch',       icon: '⋅', bg: '#d29922', cat: 'control', ports: { in: 1, out: 2 } },
  merge:        { label: 'Merge',        icon: 'M',     bg: '#f0883e', cat: 'control', ports: { in: 2, out: 1 } },
  agent:        { label: 'Agent',        icon: 'A',     bg: '#1f6feb', cat: 'agent',   ports: { in: 1, out: 1 } },
  sub_agent:    { label: 'Sub-Agent',    icon: 'S',     bg: '#bc8cff', cat: 'agent',   ports: { in: 1, out: 1 } },
  ralph:        { label: 'RALPH Loop',   icon: 'R',     bg: '#d97706', cat: 'agent',   ports: { in: 1, out: 1 } },
  doc_loader:   { label: 'Doc Loader',   icon: 'D',     bg: '#6366f1', cat: 'rag',     ports: { in: 0, out: 1 } },
  embedder:     { label: 'Embedder',     icon: 'E',     bg: '#14b8a6', cat: 'rag',     ports: { in: 1, out: 1 } },
  vector_store: { label: 'Vector Store', icon: 'V',     bg: '#ec4899', cat: 'rag',     ports: { in: 1, out: 1 } },
  retriever:    { label: 'Retriever',    icon: 'R',     bg: '#f59e0b', cat: 'rag',     ports: { in: 1, out: 1 } },
  generator:    { label: 'Generator',    icon: 'G',     bg: '#1f6feb', cat: 'rag',     ports: { in: 1, out: 1 } },
  memory:       { label: 'Memory',       icon: 'M',     bg: '#8b5cf6', cat: 'rag',     ports: { in: 1, out: 1 } },
  llm_provider: { label: 'LLM Provider', icon: 'L',     bg: '#10a37f', cat: 'tool',    ports: { in: 1, out: 1 } },
  tool:         { label: 'Tool',         icon: 'T',     bg: '#8b949e', cat: 'tool',    ports: { in: 1, out: 1 } },
  http:         { label: 'HTTP Request', icon: 'H',     bg: '#0ea5e9', cat: 'tool',    ports: { in: 1, out: 1 } },
  code:         { label: 'Code',         icon: '</>', bg: '#64748b', cat: 'tool',    ports: { in: 1, out: 1 } },
};

var WF_TEMPLATES = {
  simple_agent: {
    name: 'Simple Agent',
    nodes: [
      { id: 'n1', type: 'start', x: 80, y: 200, name: 'Start' },
      { id: 'n2', type: 'agent', x: 340, y: 200, name: 'Agent' },
      { id: 'n3', type: 'end', x: 600, y: 200, name: 'End' },
    ],
    edges: [{ from: 'n1', to: 'n2', fromPort: 0, toPort: 0 }, { from: 'n2', to: 'n3', fromPort: 0, toPort: 0 }],
  },
  multi_agent: {
    name: 'Multi-Agent Pipeline',
    nodes: [
      { id: 'n1', type: 'start', x: 60, y: 200, name: 'Start' },
      { id: 'n2', type: 'agent', x: 280, y: 200, name: 'Planner' },
      { id: 'n3', type: 'sub_agent', x: 500, y: 120, name: 'Worker A' },
      { id: 'n4', type: 'sub_agent', x: 500, y: 280, name: 'Worker B' },
      { id: 'n5', type: 'merge', x: 720, y: 200, name: 'Merge' },
      { id: 'n6', type: 'agent', x: 940, y: 200, name: 'Reviewer' },
      { id: 'n7', type: 'end', x: 1160, y: 200, name: 'End' },
    ],
    edges: [
      { from: 'n1', to: 'n2', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n3', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n5', fromPort: 0, toPort: 0 },
      { from: 'n4', to: 'n5', fromPort: 0, toPort: 1 },
      { from: 'n5', to: 'n6', fromPort: 0, toPort: 0 },
      { from: 'n6', to: 'n7', fromPort: 0, toPort: 0 },
    ],
  },
  rag_basic: {
    name: 'RAG: Basic',
    nodes: [
      { id: 'n1', type: 'doc_loader', x: 60, y: 200, name: 'Load Docs' },
      { id: 'n2', type: 'embedder', x: 280, y: 200, name: 'Embed' },
      { id: 'n3', type: 'vector_store', x: 500, y: 200, name: 'Store' },
      { id: 'n4', type: 'retriever', x: 720, y: 200, name: 'Retrieve' },
      { id: 'n5', type: 'generator', x: 940, y: 200, name: 'Generate' },
    ],
    edges: [
      { from: 'n1', to: 'n2', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n3', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n4', to: 'n5', fromPort: 0, toPort: 0 },
    ],
  },
  rag_conversational: {
    name: 'RAG: Conversational',
    nodes: [
      { id: 'n1', type: 'doc_loader', x: 60, y: 160, name: 'Load Docs' },
      { id: 'n2', type: 'embedder', x: 280, y: 160, name: 'Embed' },
      { id: 'n3', type: 'vector_store', x: 500, y: 160, name: 'Store' },
      { id: 'n4', type: 'retriever', x: 720, y: 160, name: 'Retrieve' },
      { id: 'n5', type: 'memory', x: 720, y: 310, name: 'Conv Memory' },
      { id: 'n6', type: 'generator', x: 940, y: 220, name: 'Generate' },
    ],
    edges: [
      { from: 'n1', to: 'n2', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n3', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n4', to: 'n6', fromPort: 0, toPort: 0 },
      { from: 'n5', to: 'n6', fromPort: 0, toPort: 0 },
    ],
  },
  rag_multi_source: {
    name: 'RAG: Multi-Source',
    nodes: [
      { id: 'n1', type: 'doc_loader', x: 60, y: 100, name: 'PDF Loader' },
      { id: 'n2', type: 'doc_loader', x: 60, y: 240, name: 'Web Scraper' },
      { id: 'n3', type: 'doc_loader', x: 60, y: 380, name: 'DB Connector' },
      { id: 'n4', type: 'merge', x: 300, y: 240, name: 'Merge Sources' },
      { id: 'n5', type: 'embedder', x: 520, y: 240, name: 'Embed' },
      { id: 'n6', type: 'vector_store', x: 740, y: 240, name: 'Store' },
      { id: 'n7', type: 'retriever', x: 960, y: 240, name: 'Retrieve' },
      { id: 'n8', type: 'generator', x: 1180, y: 240, name: 'Generate' },
    ],
    edges: [
      { from: 'n1', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n4', to: 'n5', fromPort: 0, toPort: 0 },
      { from: 'n5', to: 'n6', fromPort: 0, toPort: 0 },
      { from: 'n6', to: 'n7', fromPort: 0, toPort: 0 },
      { from: 'n7', to: 'n8', fromPort: 0, toPort: 0 },
    ],
  },
  rag_agentic: {
    name: 'RAG: Agentic',
    nodes: [
      { id: 'n1', type: 'start', x: 60, y: 220, name: 'Query' },
      { id: 'n2', type: 'ralph', x: 280, y: 220, name: 'RALPH Agent' },
      { id: 'n3', type: 'branch', x: 500, y: 220, name: 'Needs RAG?' },
      { id: 'n4', type: 'retriever', x: 720, y: 120, name: 'Retrieve' },
      { id: 'n5', type: 'generator', x: 720, y: 320, name: 'Direct Gen' },
      { id: 'n6', type: 'merge', x: 940, y: 220, name: 'Combine' },
      { id: 'n7', type: 'end', x: 1160, y: 220, name: 'Response' },
    ],
    edges: [
      { from: 'n1', to: 'n2', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n3', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n5', fromPort: 1, toPort: 0 },
      { from: 'n4', to: 'n6', fromPort: 0, toPort: 0 },
      { from: 'n5', to: 'n6', fromPort: 0, toPort: 1 },
      { from: 'n6', to: 'n7', fromPort: 0, toPort: 0 },
    ],
  },
  ralph_loop: {
    name: 'RALPH Loop',
    nodes: [
      { id: 'n1', type: 'start', x: 60, y: 200, name: 'Input' },
      { id: 'n2', type: 'ralph', x: 300, y: 200, name: 'Reason' },
      { id: 'n3', type: 'agent', x: 520, y: 200, name: 'Act' },
      { id: 'n4', type: 'sub_agent', x: 740, y: 200, name: 'Learn' },
      { id: 'n5', type: 'agent', x: 960, y: 200, name: 'Plan' },
      { id: 'n6', type: 'end', x: 1180, y: 200, name: 'Handoff' },
    ],
    edges: [
      { from: 'n1', to: 'n2', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n3', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n4', to: 'n5', fromPort: 0, toPort: 0 },
      { from: 'n5', to: 'n6', fromPort: 0, toPort: 0 },
    ],
  },
  map_reduce: {
    name: 'Map-Reduce',
    nodes: [
      { id: 'n1', type: 'start', x: 60, y: 220, name: 'Input' },
      { id: 'n2', type: 'code', x: 280, y: 220, name: 'Chunker' },
      { id: 'n3', type: 'sub_agent', x: 500, y: 100, name: 'Map 1' },
      { id: 'n4', type: 'sub_agent', x: 500, y: 220, name: 'Map 2' },
      { id: 'n5', type: 'sub_agent', x: 500, y: 340, name: 'Map 3' },
      { id: 'n6', type: 'merge', x: 720, y: 220, name: 'Reduce' },
      { id: 'n7', type: 'agent', x: 940, y: 220, name: 'Summarize' },
      { id: 'n8', type: 'end', x: 1160, y: 220, name: 'Output' },
    ],
    edges: [
      { from: 'n1', to: 'n2', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n3', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n5', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n6', fromPort: 0, toPort: 0 },
      { from: 'n4', to: 'n6', fromPort: 0, toPort: 0 },
      { from: 'n5', to: 'n6', fromPort: 0, toPort: 0 },
      { from: 'n6', to: 'n7', fromPort: 0, toPort: 0 },
      { from: 'n7', to: 'n8', fromPort: 0, toPort: 0 },
    ],
  },
};

var wfNodes = [];
var wfEdges = [];
var wfNextId = 1;
var wfSelectedNode = null;
var wfDragging = null;
var wfConnecting = null;
var wfPan = { x: 0, y: 0 };
var wfZoom = 1;
var wfPanning = false;
var wfPanStart = { x: 0, y: 0 };
var wfInitDone = false;

var SVG_NS = 'http://www.w3.org/2000/svg';

function wfInit() {
  if (wfInitDone) return;
  wfInitDone = true;
  var wrap = document.getElementById('wf-canvas-wrap');
  var svg = document.getElementById('wf-svg');

  document.querySelectorAll('.wf-palette-node').forEach(function(el) {
    el.addEventListener('dragstart', function(e) {
      e.dataTransfer.setData('text/plain', el.dataset.nodeType);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
  wrap.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  wrap.addEventListener('drop', function(e) {
    e.preventDefault();
    var nodeType = e.dataTransfer.getData('text/plain');
    if (!nodeType || !NODE_DEFS[nodeType]) return;
    var rect = wrap.getBoundingClientRect();
    var x = (e.clientX - rect.left - wfPan.x) / wfZoom;
    var y = (e.clientY - rect.top - wfPan.y) / wfZoom;
    wfAddNode(nodeType, x - NODE_W / 2, y - NODE_H / 2);
  });

  svg.addEventListener('pointerdown', function(e) {
    if (e.target === svg || e.target.id === 'wf-canvas-g') {
      wfPanning = true;
      wfPanStart = { x: e.clientX - wfPan.x, y: e.clientY - wfPan.y };
      wfDeselectAll();
      svg.style.cursor = 'grabbing';
      svg.setPointerCapture(e.pointerId);
    }
  });
  svg.addEventListener('pointermove', function(e) {
    if (wfPanning) {
      wfPan.x = e.clientX - wfPanStart.x;
      wfPan.y = e.clientY - wfPanStart.y;
      wfApplyTransform();
    }
    if (wfDragging) {
      var rect = wrap.getBoundingClientRect();
      wfDragging.node.x = (e.clientX - rect.left - wfPan.x) / wfZoom - wfDragging.ox;
      wfDragging.node.y = (e.clientY - rect.top - wfPan.y) / wfZoom - wfDragging.oy;
      wfRender();
    }
    if (wfConnecting) {
      var rect = wrap.getBoundingClientRect();
      var mx = (e.clientX - rect.left - wfPan.x) / wfZoom;
      var my = (e.clientY - rect.top - wfPan.y) / wfZoom;
      wfRenderTempEdge(mx, my);
    }
  });
  svg.addEventListener('pointerup', function(e) {
    if (wfPanning) {
      wfPanning = false;
      svg.style.cursor = '';
    }
    if (wfDragging) wfDragging = null;
    if (wfConnecting) {
      var target = document.elementFromPoint(e.clientX, e.clientY);
      if (target && target.classList.contains('wf-port') && target.dataset.portType === 'in') {
        var toId = target.dataset.nodeId;
        var toPort = parseInt(target.dataset.portIdx);
        if (toId !== wfConnecting.nodeId) {
          wfEdges.push({ from: wfConnecting.nodeId, to: toId, fromPort: wfConnecting.portIdx, toPort: toPort });
        }
      }
      wfConnecting = null;
      wfRender();
    }
  });

  wrap.addEventListener('wheel', function(e) {
    e.preventDefault();
    var delta = e.deltaY > 0 ? -0.08 : 0.08;
    var newZoom = Math.max(0.15, Math.min(3, wfZoom + delta));
    var rect = wrap.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    wfPan.x = mx - (mx - wfPan.x) * (newZoom / wfZoom);
    wfPan.y = my - (my - wfPan.y) * (newZoom / wfZoom);
    wfZoom = newZoom;
    wfApplyTransform();
    document.getElementById('wf-zoom-label').textContent = Math.round(wfZoom * 100) + '%';
  }, { passive: false });

  document.addEventListener('keydown', function(e) {
    if (document.getElementById('view-workflows').hidden) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      wfDeleteSelected();
    }
  });

  loadTemplate('simple_agent');
}

function wfApplyTransform() {
  var g = document.getElementById('wf-canvas-g');
  g.setAttribute('transform', 'translate(' + wfPan.x + ',' + wfPan.y + ') scale(' + wfZoom + ')');
  wfUpdateMinimap();
}

function wfAddNode(type, x, y, name, id) {
  var def = NODE_DEFS[type];
  if (!def) return;
  var node = {
    id: id || ('n' + wfNextId++),
    type: type,
    x: x || 100,
    y: y || 100,
    name: name || def.label,
    provider: '',
    system: '',
    config: '',
  };
  wfNodes.push(node);
  wfRender();
  return node;
}

function wfRender() {
  var g = document.getElementById('wf-canvas-g');
  g.innerHTML = '';

  wfEdges.forEach(function(edge, idx) {
    var fromNode = wfNodes.find(function(n) { return n.id === edge.from; });
    var toNode = wfNodes.find(function(n) { return n.id === edge.to; });
    if (!fromNode || !toNode) return;
    var fromDef = NODE_DEFS[fromNode.type];
    var toDef = NODE_DEFS[toNode.type];
    var fp = wfPortPos(fromNode, 'out', edge.fromPort, fromDef.ports.out);
    var tp = wfPortPos(toNode, 'in', edge.toPort, toDef.ports.in);
    var path = wfBezier(fp.x, fp.y, tp.x, tp.y);
    var el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('d', path);
    el.setAttribute('class', 'wf-edge');
    el.setAttribute('stroke', 'var(--fg2)');
    el.setAttribute('marker-end', 'url(#wf-arrow)');
    el.addEventListener('click', function() {
      wfEdges.splice(idx, 1);
      wfRender();
    });
    g.appendChild(el);
  });

  wfNodes.forEach(function(node) {
    var def = NODE_DEFS[node.type];
    var ng = document.createElementNS(SVG_NS, 'g');
    ng.setAttribute('class', 'wf-svg-node' + (wfSelectedNode === node.id ? ' selected' : ''));
    ng.setAttribute('transform', 'translate(' + node.x + ',' + node.y + ')');

    var rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'node-body');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('fill', 'var(--card)');
    rect.setAttribute('stroke', 'var(--border)');
    ng.appendChild(rect);

    var ic = document.createElementNS(SVG_NS, 'circle');
    ic.setAttribute('cx', 26);
    ic.setAttribute('cy', NODE_H / 2);
    ic.setAttribute('r', 14);
    ic.setAttribute('fill', def.bg);
    ng.appendChild(ic);

    var it = document.createElementNS(SVG_NS, 'text');
    it.setAttribute('x', 26);
    it.setAttribute('y', NODE_H / 2 + 4);
    it.setAttribute('text-anchor', 'middle');
    it.setAttribute('class', 'node-icon-text');
    it.textContent = def.icon;
    ng.appendChild(it);

    var tt = document.createElementNS(SVG_NS, 'text');
    tt.setAttribute('x', 50);
    tt.setAttribute('y', NODE_H / 2 - 4);
    tt.setAttribute('class', 'node-title');
    tt.setAttribute('fill', 'var(--fg)');
    tt.textContent = node.name.length > 16 ? node.name.slice(0, 15) + '…' : node.name;
    ng.appendChild(tt);

    var st = document.createElementNS(SVG_NS, 'text');
    st.setAttribute('x', 50);
    st.setAttribute('y', NODE_H / 2 + 12);
    st.setAttribute('class', 'node-subtitle');
    st.textContent = def.label;
    ng.appendChild(st);

    for (var i = 0; i < def.ports.in; i++) {
      var pp = wfLocalPortPos('in', i, def.ports.in);
      var port = document.createElementNS(SVG_NS, 'circle');
      port.setAttribute('cx', pp.x);
      port.setAttribute('cy', pp.y);
      port.setAttribute('r', 5);
      port.setAttribute('fill', 'var(--bg)');
      port.setAttribute('stroke', 'var(--accent)');
      port.setAttribute('stroke-width', '2');
      port.setAttribute('class', 'wf-port');
      port.dataset.nodeId = node.id;
      port.dataset.portType = 'in';
      port.dataset.portIdx = i;
      ng.appendChild(port);
    }

    for (var i = 0; i < def.ports.out; i++) {
      var pp = wfLocalPortPos('out', i, def.ports.out);
      var port = document.createElementNS(SVG_NS, 'circle');
      port.setAttribute('cx', pp.x);
      port.setAttribute('cy', pp.y);
      port.setAttribute('r', 5);
      port.setAttribute('fill', 'var(--accent)');
      port.setAttribute('stroke', 'var(--accent)');
      port.setAttribute('stroke-width', '2');
      port.setAttribute('class', 'wf-port');
      port.dataset.nodeId = node.id;
      port.dataset.portType = 'out';
      port.dataset.portIdx = i;
      (function(nodeRef, portIdx) {
        port.addEventListener('pointerdown', function(e) {
          e.stopPropagation();
          wfConnecting = { nodeId: nodeRef.id, portIdx: portIdx };
        });
      })(node, i);
      ng.appendChild(port);
    }

    (function(nodeRef) {
      ng.addEventListener('pointerdown', function(e) {
        if (e.target.classList.contains('wf-port')) return;
        e.stopPropagation();
        wfSelectNode(nodeRef.id);
        var rect2 = document.getElementById('wf-canvas-wrap').getBoundingClientRect();
        var mx = (e.clientX - rect2.left - wfPan.x) / wfZoom;
        var my = (e.clientY - rect2.top - wfPan.y) / wfZoom;
        wfDragging = { node: nodeRef, ox: mx - nodeRef.x, oy: my - nodeRef.y };
      });
    })(node);

    g.appendChild(ng);
  });

  document.getElementById('wf-node-count').textContent = wfNodes.length + ' node' + (wfNodes.length !== 1 ? 's' : '');
  wfUpdateMinimap();
}

function wfLocalPortPos(type, idx, total) {
  var spacing = NODE_H / (total + 1);
  var y = spacing * (idx + 1);
  return { x: type === 'in' ? 0 : NODE_W, y: y };
}

function wfPortPos(node, type, idx, total) {
  var local = wfLocalPortPos(type, idx, total);
  return { x: node.x + local.x, y: node.y + local.y };
}

function wfBezier(x1, y1, x2, y2) {
  var dx = Math.abs(x2 - x1) * 0.5;
  return 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
}

function wfRenderTempEdge(mx, my) {
  var g = document.getElementById('wf-canvas-g');
  var tempEl = g.querySelector('.wf-edge-temp');
  if (!wfConnecting) { if (tempEl) tempEl.remove(); return; }
  var fromNode = wfNodes.find(function(n) { return n.id === wfConnecting.nodeId; });
  if (!fromNode) return;
  var fromDef = NODE_DEFS[fromNode.type];
  var fp = wfPortPos(fromNode, 'out', wfConnecting.portIdx, fromDef.ports.out);
  var path = wfBezier(fp.x, fp.y, mx, my);
  if (!tempEl) {
    tempEl = document.createElementNS(SVG_NS, 'path');
    tempEl.setAttribute('class', 'wf-edge-temp');
    tempEl.setAttribute('stroke', 'var(--accent)');
    g.appendChild(tempEl);
  }
  tempEl.setAttribute('d', path);
}

function wfSelectNode(id) {
  wfSelectedNode = id;
  wfRender();
  var node = wfNodes.find(function(n) { return n.id === id; });
  if (node) {
    var panel = document.getElementById('wf-detail');
    panel.classList.add('open');
    document.getElementById('wf-detail-title').textContent = node.name;
    document.getElementById('wf-d-name').value = node.name;
    document.getElementById('wf-d-type').value = NODE_DEFS[node.type] ? NODE_DEFS[node.type].label : node.type;
    document.getElementById('wf-d-provider').value = node.provider || '';
    document.getElementById('wf-d-system').value = node.system || '';
    document.getElementById('wf-d-config').value = node.config || '';
  }
}

function wfDeselectAll() {
  wfSelectedNode = null;
  document.getElementById('wf-detail').classList.remove('open');
  wfRender();
}

function wfUpdateNodeProp(prop, value) {
  if (!wfSelectedNode) return;
  var node = wfNodes.find(function(n) { return n.id === wfSelectedNode; });
  if (!node) return;
  node[prop] = value;
  if (prop === 'name') {
    document.getElementById('wf-detail-title').textContent = value;
    wfRender();
  }
}

function wfDeleteSelected() {
  if (!wfSelectedNode) return;
  wfNodes = wfNodes.filter(function(n) { return n.id !== wfSelectedNode; });
  wfEdges = wfEdges.filter(function(e) { return e.from !== wfSelectedNode && e.to !== wfSelectedNode; });
  wfSelectedNode = null;
  document.getElementById('wf-detail').classList.remove('open');
  wfRender();
}

function wfClearCanvas() {
  wfNodes = [];
  wfEdges = [];
  wfSelectedNode = null;
  wfNextId = 1;
  document.getElementById('wf-detail').classList.remove('open');
  wfRender();
}

function loadTemplate(key) {
  var tpl = WF_TEMPLATES[key];
  if (!tpl) return;
  wfClearCanvas();
  tpl.nodes.forEach(function(n) {
    wfAddNode(n.type, n.x, n.y, n.name, n.id);
  });
  var maxId = Math.max.apply(null, wfNodes.map(function(n) { return parseInt(n.id.replace('n', '')) || 0; }));
  wfNextId = maxId + 1;
  wfEdges = tpl.edges.map(function(e) { return { from: e.from, to: e.to, fromPort: e.fromPort, toPort: e.toPort }; });
  wfRender();
  wfFitView();
  document.getElementById('wf-template-select').value = key;
  addLog('Loaded template: ' + tpl.name);
}

function wfZoomIn() {
  wfZoom = Math.min(3, wfZoom + 0.15);
  wfApplyTransform();
  document.getElementById('wf-zoom-label').textContent = Math.round(wfZoom * 100) + '%';
}

function wfZoomOut() {
  wfZoom = Math.max(0.15, wfZoom - 0.15);
  wfApplyTransform();
  document.getElementById('wf-zoom-label').textContent = Math.round(wfZoom * 100) + '%';
}

function wfFitView() {
  if (wfNodes.length === 0) { wfPan = { x: 40, y: 40 }; wfZoom = 1; wfApplyTransform(); return; }
  var wrap = document.getElementById('wf-canvas-wrap');
  var ww = wrap.clientWidth;
  var wh = wrap.clientHeight;
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  wfNodes.forEach(function(n) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  });
  var pw = maxX - minX + 80;
  var ph = maxY - minY + 80;
  wfZoom = Math.min(1.5, Math.min(ww / pw, wh / ph));
  wfPan.x = (ww - pw * wfZoom) / 2 - minX * wfZoom + 40 * wfZoom;
  wfPan.y = (wh - ph * wfZoom) / 2 - minY * wfZoom + 40 * wfZoom;
  wfApplyTransform();
  document.getElementById('wf-zoom-label').textContent = Math.round(wfZoom * 100) + '%';
}

function wfUpdateMinimap() {
  var mmSvg = document.getElementById('wf-minimap-svg');
  if (!mmSvg || wfNodes.length === 0) { if (mmSvg) mmSvg.innerHTML = ''; return; }
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  wfNodes.forEach(function(n) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  });
  var pad = 20;
  var vw = maxX - minX + pad * 2;
  var vh = maxY - minY + pad * 2;
  mmSvg.setAttribute('viewBox', (minX - pad) + ' ' + (minY - pad) + ' ' + vw + ' ' + vh);
  var html = '';
  wfEdges.forEach(function(edge) {
    var fn = wfNodes.find(function(n) { return n.id === edge.from; });
    var tn = wfNodes.find(function(n) { return n.id === edge.to; });
    if (!fn || !tn) return;
    var fx = fn.x + NODE_W, fy = fn.y + NODE_H / 2;
    var tx = tn.x, ty = tn.y + NODE_H / 2;
    html += '<line x1="' + fx + '" y1="' + fy + '" x2="' + tx + '" y2="' + ty + '" stroke="var(--fg2)" stroke-width="2" opacity="0.4"/>';
  });
  wfNodes.forEach(function(node) {
    var def = NODE_DEFS[node.type];
    var sel = wfSelectedNode === node.id;
    html += '<rect x="' + node.x + '" y="' + node.y + '" width="' + NODE_W + '" height="' + NODE_H + '" rx="6" fill="' + def.bg + '" opacity="' + (sel ? 0.9 : 0.5) + '"/>';
  });
  mmSvg.innerHTML = html;
}

async function wfSaveWorkflow() {
  var payload = {
    name: 'Workflow ' + new Date().toLocaleTimeString(),
    nodes: wfNodes.map(function(n) { return { id: n.id, type: n.type, x: n.x, y: n.y, name: n.name, provider: n.provider, system: n.system, config: n.config }; }),
    edges: wfEdges,
  };
  try {
    var r = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await r.json();
    if (data.ok) addLog('Workflow saved: ' + (data.id || ''), 'success');
    else addLog('Save failed: ' + (data.error || ''), 'error');
  } catch (e) {
    addLog('Save error: ' + e.message, 'error');
  }
}

async function wfRunWorkflow() {
  if (wfNodes.length === 0) { addLog('No nodes in workflow', 'warn'); return; }
  var payload = {
    nodes: wfNodes.map(function(n) { return { id: n.id, type: n.type, name: n.name, provider: n.provider, system: n.system, config: n.config }; }),
    edges: wfEdges,
  };
  document.getElementById('wf-run-btn').disabled = true;
  addLog('Running workflow (' + wfNodes.length + ' nodes)...');
  try {
    var r = await fetch('/api/workflows/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await r.json();
    if (data.error) addLog('Workflow error: ' + data.error, 'error');
    else addLog('Workflow complete: ' + (data.status || 'done'), 'success');
  } catch (e) {
    addLog('Run error: ' + e.message, 'error');
  } finally {
    document.getElementById('wf-run-btn').disabled = false;
  }
}

// ---- init ----
(function init() {
  try { if (localStorage.getItem('oma-theme') === 'light') document.body.classList.add('light'); } catch(e) {}
  fetchStatus().then(function() {
    if (connectedCount === 0) showView('connect');
  });
  setInterval(fetchStatus, 1500);
  addLog('OMA Dashboard ready (RALPH loop enabled)');
})();
</script>
</body>
</html>`;

// ---- HTTP server ----

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let dashboardAgent: OMA | null = null;
let dashboardAuth: AuthManager | null = null;
let taskRunning = false;
const savedWorkflows: Record<string, Record<string, unknown>> = {};

function sendJson(
  res: http.ServerResponse,
  data: Record<string, unknown>,
  status = 200,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function verifyToken(
  provider: string,
  token: string,
): Promise<[boolean, string]> {
  try {
    if (provider === 'claude') {
      const resp = await fetch('https://claude.ai/api/organizations', {
        headers: {
          Cookie: `sessionKey=${token}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          Origin: 'https://claude.ai',
          Referer: 'https://claude.ai/',
        },
      });
      if (!resp.ok) {
        return [false, `Authentication failed (HTTP ${resp.status}) - token is invalid or expired`];
      }
      const data = (await resp.json()) as Array<Record<string, string>>;
      if (data && data.length > 0) {
        const orgName = data[0].name ?? '';
        return [true, orgName ? `Organization: ${orgName}` : 'Session valid'];
      }
      return [false, 'No organizations found - token may be invalid'];
    }

    if (provider === 'chatgpt') {
      const resp = await fetch('https://chatgpt.com/api/auth/session', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
      });
      if (!resp.ok) {
        return [false, `Authentication failed (HTTP ${resp.status}) - token is invalid or expired`];
      }
      const data = (await resp.json()) as Record<string, Record<string, string>>;
      const email = data.user?.email ?? '';
      return [true, email ? `Account: ${email}` : 'Session valid'];
    }

    if (provider === 'gemini') {
      const resp = await fetch('https://gemini.google.com/', {
        headers: {
          Cookie: `__Secure-1PSID=${token}`,
          'User-Agent': USER_AGENT,
        },
      });
      if (!resp.ok) {
        return [false, `HTTP error ${resp.status} - check token and try again`];
      }
      const html = await resp.text();
      if (/"SNlM0e"/.test(html)) {
        return [true, 'Google session valid'];
      }
      return [true, 'Cookie accepted (could not fully verify)'];
    }

    // for other providers, just accept
    return [true, 'Token stored'];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return [false, `Verification error: ${msg.slice(0, 200)}`];
  }
}

function rebuildAgent(): void {
  try {
    if (dashboardAuth) {
      dashboardAgent = OMA.fromCredentials(dashboardAuth);
    } else {
      dashboardAgent = OMA.fromEnv();
    }
  } catch {
    try {
      dashboardAgent = OMA.fromEnv();
    } catch {
      dashboardAgent = null;
    }
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ---- GET ----
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') {
      const html = Buffer.from(DASHBOARD_HTML, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
      });
      res.end(html);
      return;
    }

    if (pathname === '/api/status') {
      const status: Record<string, unknown> = {};
      if (dashboardAuth) {
        status.auth = dashboardAuth.status();
      }
      if (dashboardAgent) {
        const health = dashboardAgent.registry.statusReport();
        const auth = (status.auth ?? {}) as Record<string, Record<string, unknown>>;
        for (const [name, h] of Object.entries(health)) {
          if (auth[name]) {
            auth[name].health = h;
          }
        }
        // include ralph status
        status.ralph = dashboardAgent.ralphStatus();
      }
      const auth = (status.auth ?? {}) as Record<string, Record<string, unknown>>;
      for (const [name, info] of Object.entries(auth)) {
        if (info.status === 'logged_in' && !info.health) {
          info.health = {
            success_rate: '100.0%',
            avg_latency_ms: '0',
            total_tokens: 0,
            in_cooldown: false,
            last_error: null,
          };
        }
      }
      sendJson(res, status);
      return;
    }

    if (pathname === '/api/storage/info') {
      if (!dashboardAuth) {
        sendJson(res, { error: 'auth not initialized' }, 500);
        return;
      }
      sendJson(res, dashboardAuth.storageInfo());
      return;
    }

    if (pathname === '/api/workflows') {
      sendJson(res, { workflows: Object.values(savedWorkflows) });
      return;
    }

    if (pathname === '/api/workflows/templates') {
      const tplList = [
        { key: 'simple_agent', name: 'Simple Agent' },
        { key: 'multi_agent', name: 'Multi-Agent Pipeline' },
        { key: 'rag_basic', name: 'RAG: Basic' },
        { key: 'rag_conversational', name: 'RAG: Conversational' },
        { key: 'rag_multi_source', name: 'RAG: Multi-Source' },
        { key: 'rag_agentic', name: 'RAG: Agentic' },
        { key: 'ralph_loop', name: 'RALPH Loop' },
        { key: 'map_reduce', name: 'Map-Reduce' },
      ];
      sendJson(res, { templates: tplList });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // ---- POST ----
  if (req.method === 'POST') {
    const body = await readBody(req);

    if (pathname === '/api/auth/connect') {
      const provider = (body.provider ?? '') as string;
      const token = (body.token ?? '') as string;
      if (!provider || !token) {
        sendJson(res, { error: 'missing provider or token' }, 400);
        return;
      }

      const [ok, detail] = await verifyToken(provider, token);
      if (ok) {
        dashboardAuth?.storeSessionToken(provider, token);
        rebuildAgent();
        sendJson(res, { ok: true, detail });
      } else {
        sendJson(res, { ok: false, error: detail || 'Token verification failed' });
      }
      return;
    }

    if (pathname === '/api/auth/apikey') {
      const provider = (body.provider ?? '') as string;
      const apiKey = (body.api_key ?? '') as string;
      if (dashboardAuth && provider && apiKey) {
        dashboardAuth.storeApiKey(provider, apiKey);
        rebuildAgent();
        sendJson(res, { ok: true });
      } else {
        sendJson(res, { error: 'missing provider or api_key' }, 400);
      }
      return;
    }

    if (pathname === '/api/auth/logout') {
      const provider = (body.provider ?? '') as string;
      if (dashboardAuth && provider) {
        dashboardAuth.logout(provider);
        rebuildAgent();
        sendJson(res, { ok: true });
      } else {
        sendJson(res, { error: 'missing provider' }, 400);
      }
      return;
    }

    if (pathname === '/api/auth/flush') {
      const includeMemory = Boolean(body.include_memory);
      if (dashboardAuth) {
        const details = dashboardAuth.flush(includeMemory);
        rebuildAgent();
        sendJson(res, { ok: true, details });
      } else {
        sendJson(res, { error: 'auth not initialized' }, 500);
      }
      return;
    }

    if (pathname === '/api/run') {
      const objective = (body.objective ?? '') as string;
      const criteria = body.criteria as Record<string, unknown> | undefined;

      if (!objective) {
        sendJson(res, { error: 'no objective' }, 400);
        return;
      }

      if (!dashboardAgent) {
        rebuildAgent();
      }
      if (!dashboardAgent) {
        sendJson(res, { error: 'no providers configured' }, 400);
        return;
      }

      try {
        taskRunning = true;
        const result = await dashboardAgent.run({ objective, criteria });
        taskRunning = false;

        sendJson(res, {
          status: result.status,
          confidence: result.confidence,
          attempts: result.attempts,
          tokens_used: result.tokens_used,
          result: (result.artifacts.final ?? '').slice(0, 5000),
          lessons: result.lessons,
          strategy: result.strategy,
          phase_history: result.phase_history,
        });
      } catch (err: unknown) {
        taskRunning = false;
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, { error: msg }, 500);
      }
      return;
    }

    if (pathname === '/api/workflows') {
      const wfName = (body.name ?? 'Untitled') as string;
      const nodes = (body.nodes ?? []) as Array<Record<string, unknown>>;
      const edges = (body.edges ?? []) as Array<Record<string, unknown>>;
      const { createHash } = await import('node:crypto');
      const wfId = createHash('md5').update(`${wfName}${Date.now()}`).digest('hex').slice(0, 12);
      savedWorkflows[wfId] = {
        id: wfId,
        name: wfName,
        nodes,
        edges,
        created: Date.now(),
      };
      sendJson(res, { ok: true, id: wfId });
      return;
    }

    if (pathname === '/api/workflows/run') {
      const nodes = (body.nodes ?? []) as Array<Record<string, unknown>>;
      const edges = (body.edges ?? []) as Array<Record<string, unknown>>;
      if (nodes.length === 0) {
        sendJson(res, { error: 'no nodes in workflow' }, 400);
        return;
      }
      if (!dashboardAgent) rebuildAgent();
      if (!dashboardAgent) {
        sendJson(res, { error: 'no providers configured' }, 400);
        return;
      }
      try {
        // topological sort
        const adj: Record<string, string[]> = {};
        const inDeg: Record<string, number> = {};
        for (const n of nodes) {
          const nid = n.id as string;
          adj[nid] = [];
          inDeg[nid] = 0;
        }
        for (const e of edges) {
          const from = e.from as string;
          const to = e.to as string;
          adj[from].push(to);
          inDeg[to] = (inDeg[to] ?? 0) + 1;
        }
        const queue: string[] = [];
        for (const [nid, d] of Object.entries(inDeg)) {
          if (d === 0) queue.push(nid);
        }
        const order: string[] = [];
        while (queue.length > 0) {
          const nid = queue.shift()!;
          order.push(nid);
          for (const child of (adj[nid] ?? [])) {
            inDeg[child]--;
            if (inDeg[child] === 0) queue.push(child);
          }
        }
        const nodeMap: Record<string, Record<string, unknown>> = {};
        for (const n of nodes) nodeMap[n.id as string] = n;
        const results: Record<string, Record<string, unknown>> = {};
        for (const nid of order) {
          const node = nodeMap[nid];
          const ntype = (node.type ?? '') as string;
          if (['start', 'end', 'merge'].includes(ntype)) {
            results[nid] = { status: 'pass-through' };
            continue;
          }
          const parentOutputs: Record<string, unknown>[] = [];
          for (const e of edges) {
            if (e.to === nid && results[e.from as string]) {
              parentOutputs.push(results[e.from as string]);
            }
          }
          if (['agent', 'sub_agent', 'ralph'].includes(ntype)) {
            let objective = ((node.system as string) || (node.name as string) || 'task');
            const ctx = parentOutputs
              .filter(p => p.output)
              .map(p => String(p.output))
              .join('; ');
            if (ctx) objective = `${objective} -- context: ${ctx}`;
            const result = await dashboardAgent.run({ objective });
            results[nid] = {
              status: result.status,
              confidence: result.confidence,
              output: (result.artifacts.final ?? '').slice(0, 2000),
            };
          } else {
            results[nid] = { status: 'skipped', type: ntype };
          }
        }
        sendJson(res, {
          status: 'done',
          node_results: results,
          execution_order: order,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, { error: msg }, 500);
      }
      return;
    }

    if (pathname === '/api/stop') {
      taskRunning = false;
      sendJson(res, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

/** Open a URL in the default browser (cross-platform). */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync(`open "${url}"`, { timeout: 5000 });
    } else if (platform === 'linux') {
      execSync(`xdg-open "${url}"`, { timeout: 5000 });
    } else if (platform === 'win32') {
      execSync(`start "${url}"`, { timeout: 5000 });
    }
  } catch { /* ignore */ }
}

/** Start the graphical dashboard. */
export function runWeb(
  host = '127.0.0.1',
  port = 8384,
  openBrowserOnStart = true,
): void {
  dashboardAuth = new AuthManager();

  // try to build agent from stored credentials, fallback to env
  try {
    dashboardAgent = OMA.fromCredentials(dashboardAuth);
  } catch {
    try {
      dashboardAgent = OMA.fromEnv();
    } catch {
      dashboardAgent = null;
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error('Request error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    console.log(`OMA Dashboard: ${url}`);

    if (openBrowserOnStart) {
      setTimeout(() => openBrowser(url), 500);
    }
  });

  // graceful shutdown
  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
}
