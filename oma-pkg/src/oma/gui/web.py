"""
OMA Graphical Dashboard -- the primary user interface.

A graphical SPA served at http://localhost:8384 that provides:
  - Subscription-based login for Claude, ChatGPT, Gemini
  - API key entry as fallback
  - Provider health monitoring
  - Task execution with RALPH phase visualization
  - Live log stream
  - Dark/light theme

On macOS, this is wrapped in a native pywebview window (gui/app.py).
On other platforms, it opens in the default browser.
"""

import json
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

DASHBOARD_HTML = r"""<!doctype html>
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

  /* ---- RALPH phase stepper ---- */
  .ralph-stepper {
    display: flex; align-items: center; justify-content: center;
    gap: 0; padding: 20px 16px; position: relative;
  }
  .ralph-phase {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    position: relative; z-index: 1; flex: 0 0 auto;
  }
  .ralph-node {
    width: 40px; height: 40px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 700; font-family: var(--mono);
    border: 2px solid var(--border); background: var(--bg);
    color: var(--fg2); transition: all 0.3s ease;
    position: relative;
  }
  .ralph-node.idle { border-color: var(--border); color: var(--fg2); }
  .ralph-node.active {
    border-color: var(--accent); color: var(--accent);
    background: rgba(88,166,255,0.1);
    box-shadow: 0 0 12px rgba(88,166,255,0.3);
  }
  .ralph-node.active::after {
    content: ''; position: absolute; inset: -4px;
    border: 2px solid var(--accent); border-radius: 50%;
    animation: ralph-pulse 1.5s ease-in-out infinite;
    opacity: 0;
  }
  .ralph-node.done {
    border-color: var(--green); color: var(--green);
    background: rgba(63,185,80,0.1);
  }
  .ralph-label {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.8px; color: var(--fg2); transition: color 0.3s;
  }
  .ralph-phase.active .ralph-label { color: var(--accent); }
  .ralph-phase.done .ralph-label { color: var(--green); }

  .ralph-connector {
    width: 32px; height: 2px; background: var(--border);
    margin-bottom: 20px; transition: background 0.3s;
  }
  .ralph-connector.done { background: var(--green); }
  .ralph-connector.active {
    background: linear-gradient(90deg, var(--green), var(--accent));
  }

  .ralph-iteration {
    text-align: center; margin-top: 8px;
    font-size: 11px; color: var(--fg2); font-family: var(--mono);
  }

  @keyframes ralph-pulse {
    0% { opacity: 0.6; transform: scale(1); }
    50% { opacity: 0; transform: scale(1.4); }
    100% { opacity: 0; transform: scale(1.4); }
  }

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

  /* node palette */
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

  /* SVG canvas */
  .wf-canvas-wrap {
    flex: 1; position: relative; overflow: hidden; background: var(--bg);
    background-image: radial-gradient(circle, var(--border2) 1px, transparent 1px);
    background-size: 20px 20px;
  }
  .wf-canvas-wrap svg { width: 100%; height: 100%; }

  /* SVG node styling */
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

  .wf-port {
    cursor: crosshair; transition: r 0.15s;
  }
  .wf-port:hover { r: 7; }

  .wf-edge { fill: none; stroke-width: 2; pointer-events: stroke; cursor: pointer; }
  .wf-edge:hover { stroke-width: 3; }
  .wf-edge-temp { fill: none; stroke-width: 2; stroke-dasharray: 6 4; pointer-events: none; }

  /* minimap */
  .wf-minimap {
    position: absolute; bottom: 12px; right: 12px; width: 160px; height: 100px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    overflow: hidden; opacity: 0.85; pointer-events: none;
  }
  .wf-minimap svg { width: 100%; height: 100%; }

  /* node detail panel */
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

  /* zoom indicator */
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
        <button class="nav-tab" onclick="showView('routing')" id="nav-routing">Routing</button>
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

      <!-- Routing View -->
      <div id="view-routing" hidden style="max-width:none">
        <div class="card">
          <div class="card-header">
            <h2>Routing Engine</h2>
            <span id="routing-mode-badge" class="badge badge-gray">embedded</span>
          </div>
          <div class="card-body">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px">
              <div>
                <label style="font-size:12px; color:var(--fg2)">Strategy</label>
                <select id="routing-strategy" style="width:100%; padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg); font-size:13px">
                  <option value="auto">Auto (multi-factor scoring)</option>
                  <option value="priority">Priority (first available)</option>
                  <option value="weighted">Weighted random</option>
                  <option value="round_robin">Round robin</option>
                  <option value="p2c">Power-of-two choices</option>
                  <option value="least_used">Least used</option>
                  <option value="cost_optimized">Cost optimized</option>
                  <option value="lkgp">LKGP (last known good)</option>
                  <option value="fusion">Fusion (parallel)</option>
                  <option value="pipeline">Pipeline (multi-stage)</option>
                </select>
              </div>
              <div>
                <label style="font-size:12px; color:var(--fg2)">OmniRoute Gateway</label>
                <div style="display:flex; align-items:center; gap:8px; padding:6px 0">
                  <span id="omniroute-status-dot" style="width:10px; height:10px; border-radius:50%; background:#666; display:inline-block"></span>
                  <span id="omniroute-status-text" style="font-size:13px; color:var(--fg2)">Not configured</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Circuit Breakers</h2>
          </div>
          <div class="card-body">
            <div id="breaker-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:12px">
              <div style="color:var(--fg2); font-size:13px; padding:16px; text-align:center">
                No providers active yet
              </div>
            </div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px">
          <div class="card">
            <div class="card-header">
              <h2>Cost Tracking</h2>
            </div>
            <div class="card-body">
              <div id="cost-table-area" style="font-size:13px">
                <table style="width:100%; border-collapse:collapse">
                  <thead>
                    <tr style="border-bottom:1px solid var(--border); text-align:left">
                      <th style="padding:6px 8px; font-weight:500">Provider</th>
                      <th style="padding:6px 8px; font-weight:500">Requests</th>
                      <th style="padding:6px 8px; font-weight:500">Tokens</th>
                      <th style="padding:6px 8px; font-weight:500">Cost</th>
                    </tr>
                  </thead>
                  <tbody id="cost-table-body">
                    <tr><td colspan="4" style="padding:12px; text-align:center; color:var(--fg2)">No data</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <h2>LKGP State</h2>
            </div>
            <div class="card-body">
              <div id="lkgp-list" style="font-size:13px; color:var(--fg2)">
                No routing history yet
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

        <!-- RALPH Phase Stepper -->
        <div class="card" id="ralph-card" hidden>
          <div class="card-header">
            <h2>RALPH Loop</h2>
            <span id="ralph-iteration" class="badge badge-purple">iteration 0</span>
          </div>
          <div class="card-body" style="padding:8px 16px 16px">
            <div class="ralph-stepper">
              <div class="ralph-phase" id="rp-reason">
                <div class="ralph-node idle" id="rn-reason">R</div>
                <div class="ralph-label">Reason</div>
              </div>
              <div class="ralph-connector" id="rc-ra"></div>
              <div class="ralph-phase" id="rp-act">
                <div class="ralph-node idle" id="rn-act">A</div>
                <div class="ralph-label">Act</div>
              </div>
              <div class="ralph-connector" id="rc-al"></div>
              <div class="ralph-phase" id="rp-learn">
                <div class="ralph-node idle" id="rn-learn">L</div>
                <div class="ralph-label">Learn</div>
              </div>
              <div class="ralph-connector" id="rc-lp"></div>
              <div class="ralph-phase" id="rp-plan">
                <div class="ralph-node idle" id="rn-plan">P</div>
                <div class="ralph-label">Plan</div>
              </div>
              <div class="ralph-connector" id="rc-ph"></div>
              <div class="ralph-phase" id="rp-handoff">
                <div class="ralph-node idle" id="rn-handoff">H</div>
                <div class="ralph-label">Handoff</div>
              </div>
            </div>
            <div id="ralph-detail" style="font-size:12px; color:var(--fg2); text-align:center; margin-top:4px"></div>
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
let connectedCount = 0;
let taskRunning = false;
let lastPhaseEventCount = 0;

const PROVIDERS = {
  claude:   { name: 'Claude',   icon: 'C', bg: '#d97706' },
  chatgpt:  { name: 'ChatGPT',  icon: 'G', bg: '#10a37f' },
  gemini:   { name: 'Gemini',   icon: 'G', bg: '#4285f4' },
  deepseek: { name: 'DeepSeek', icon: 'D', bg: '#6366f1' },
  glm:      { name: 'GLM',      icon: 'Z', bg: '#ec4899' },
  kimi:     { name: 'Kimi',     icon: 'K', bg: '#14b8a6' },
};

const RALPH_PHASES = ['reason', 'act', 'learn', 'plan', 'handoff'];
const RALPH_LABELS = {
  reason: 'Analyzing task state and determining approach',
  act: 'Executing solve attempt with provider',
  learn: 'Evaluating result against criteria',
  plan: 'Adjusting strategy based on lessons',
  handoff: 'Preparing handoff or continuing loop',
};

// ---- views ----
function showView(view) {
  document.getElementById('view-task').hidden = (view !== 'task');
  document.getElementById('view-connect').hidden = (view !== 'connect');
  document.getElementById('view-workflows').hidden = (view !== 'workflows');
  document.getElementById('view-routing').hidden = (view !== 'routing');
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('nav-' + view).classList.add('active');
  if (view === 'workflows') wfInit();
  if (view === 'routing') refreshRouting();
}

// ---- logging ----
function addLog(msg, level = 'info') {
  const log = document.getElementById('log');
  const ts = new Date().toLocaleTimeString();
  log.innerHTML += `<div class="log-entry"><span class="log-ts">[${ts}]</span> <span class="log-${level}">${escHtml(msg)}</span></div>`;
  log.scrollTop = log.scrollHeight;
}
function clearLog() { document.getElementById('log').innerHTML = ''; }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ---- connect panel toggles ----
function toggleConnect(id) {
  const body = document.getElementById('cb-' + id);
  body.classList.toggle('open');
}

// ---- RALPH phase rendering ----
function updateRalphPhase(currentPhase, iteration, detail) {
  const phaseOrder = RALPH_PHASES;
  const currentIdx = phaseOrder.indexOf(currentPhase);

  phaseOrder.forEach((phase, idx) => {
    const node = document.getElementById('rn-' + phase);
    const phaseEl = document.getElementById('rp-' + phase);
    if (!node || !phaseEl) return;

    node.className = 'ralph-node';
    phaseEl.className = 'ralph-phase';

    if (idx < currentIdx) {
      node.classList.add('done');
      phaseEl.classList.add('done');
    } else if (idx === currentIdx) {
      node.classList.add('active');
      phaseEl.classList.add('active');
    } else {
      node.classList.add('idle');
    }
  });

  // connectors
  const connectors = [
    { id: 'rc-ra', from: 0, to: 1 },
    { id: 'rc-al', from: 1, to: 2 },
    { id: 'rc-lp', from: 2, to: 3 },
    { id: 'rc-ph', from: 3, to: 4 },
  ];
  connectors.forEach(c => {
    const el = document.getElementById(c.id);
    if (!el) return;
    el.className = 'ralph-connector';
    if (currentIdx > c.to) el.classList.add('done');
    else if (currentIdx === c.to) el.classList.add('active');
  });

  // iteration badge
  const iterEl = document.getElementById('ralph-iteration');
  if (iterEl && iteration > 0) {
    iterEl.textContent = 'iteration ' + iteration;
  }

  // detail text
  const detailEl = document.getElementById('ralph-detail');
  if (detailEl) {
    detailEl.textContent = detail || RALPH_LABELS[currentPhase] || '';
  }
}

function resetRalphStepper() {
  RALPH_PHASES.forEach(phase => {
    const node = document.getElementById('rn-' + phase);
    const phaseEl = document.getElementById('rp-' + phase);
    if (node) node.className = 'ralph-node idle';
    if (phaseEl) phaseEl.className = 'ralph-phase';
  });
  ['rc-ra','rc-al','rc-lp','rc-ph'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = 'ralph-connector';
  });
  const iterEl = document.getElementById('ralph-iteration');
  if (iterEl) iterEl.textContent = 'iteration 0';
  const detailEl = document.getElementById('ralph-detail');
  if (detailEl) detailEl.textContent = '';
}

// ---- connect provider (subscription) ----
async function connectProvider(provider) {
  const input = document.getElementById('token-' + provider);
  const token = input.value.trim();
  if (!token) return;

  const statusEl = document.getElementById('status-' + provider);
  statusEl.innerHTML = '<div class="connect-status checking"><span class="spinner"></span> Verifying...</div>';

  try {
    const r = await fetch('/api/auth/connect', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ provider, token }),
    });
    const data = await r.json();

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
  const provider = document.getElementById('apikey-provider').value;
  const key = document.getElementById('apikey-value').value.trim();
  if (!key) return;

  const statusEl = document.getElementById('status-apikey');
  statusEl.innerHTML = '<div class="connect-status checking"><span class="spinner"></span> Saving...</div>';

  try {
    const r = await fetch('/api/auth/apikey', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ provider, api_key: key }),
    });
    const data = await r.json();
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
      body: JSON.stringify({ provider }),
    });
    addLog('Disconnected ' + PROVIDERS[provider].name);
    fetchStatus();
  } catch (e) {}
}

// ---- flush all credentials ----
async function flushAllCredentials() {
  if (!confirm('Securely wipe all stored credentials from ~/.oma/credentials.json? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/auth/flush', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ include_memory: false }),
    });
    const d = await r.json();
    if (d.ok) {
      addLog('Flushed credentials from safe storage (' + (d.details ? d.details.flushed_credentials_count : 0) + ' removed)', 'success');
      fetchStatus();
    }
  } catch (e) {
    alert('Flush failed: ' + e.message);
  }
}

// ---- sidebar providers ----
function renderProviders(data) {
  const el = document.getElementById('providers-list');
  const names = ['claude', 'chatgpt', 'gemini', 'deepseek', 'glm', 'kimi'];
  let html = '';
  connectedCount = 0;

  names.forEach(name => {
    const info = PROVIDERS[name];
    const status = (data && data[name]) || {};
    const isConn = status.status === 'logged_in';
    if (isConn) connectedCount++;

    const badge = isConn
      ? '<span class="badge badge-green" style="font-size:9px">ON</span>'
      : '';

    const meta = isConn
      ? (status.email || status.plan || 'Active')
      : 'Not connected';

    html += `
      <div class="provider-card ${isConn ? 'connected' : 'disconnected'}"
           onclick="${isConn ? `disconnect('${name}')` : `showView('connect'); setTimeout(()=>{toggleConnect('${name}');document.getElementById('cb-${name}').classList.add('open')},50)`}">
        <div class="provider-top">
          <div style="display:flex; align-items:center; gap:8px">
            <div class="provider-icon" style="background:${info.bg}">${info.icon}</div>
            <span class="provider-name">${info.name}</span>
          </div>
          ${badge}
        </div>
        <div class="provider-meta">${isConn ? meta + ' &middot; click to disconnect' : 'Click to connect'}</div>
      </div>`;
  });

  el.innerHTML = html;

  // update connect view badges
  names.forEach(name => {
    const status = (data && data[name]) || {};
    const badgeEl = document.getElementById('cc-badge-' + name);
    const cardEl = document.getElementById('cc-' + name);
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
  const hdr = document.getElementById('conn-status');
  if (connectedCount > 0) {
    hdr.className = 'badge badge-green';
    hdr.textContent = connectedCount + ' provider' + (connectedCount > 1 ? 's' : '');
  } else {
    hdr.className = 'badge badge-gray';
    hdr.textContent = '0 providers';
  }
}

// ---- task execution (async via /api/run + polling) ----
async function runTask() {
  const obj = document.getElementById('objective').value.trim();
  if (!obj) { addLog('No objective set', 'warn'); return; }

  if (connectedCount === 0) {
    addLog('No providers connected -- go to Connect tab first', 'warn');
    showView('connect');
    return;
  }

  const critRaw = document.getElementById('criteria').value.trim();
  let criteria = null;
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
  document.getElementById('ralph-card').hidden = false;
  document.getElementById('progress-card').hidden = false;
  document.getElementById('result-card').hidden = true;
  document.getElementById('step-list').innerHTML = '';
  document.getElementById('progress-fill').style.width = '0%';
  resetRalphStepper();
  addLog('Starting RALPH loop: ' + obj);

  try {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ objective: obj, criteria }),
    });
    const data = await r.json();

    if (data.error) {
      addLog('Error: ' + data.error, 'error');
      document.getElementById('task-badge').className = 'badge badge-red';
      document.getElementById('task-badge').textContent = 'error';
    } else {
      addLog(`Task complete: ${data.status} (confidence: ${(data.confidence * 100).toFixed(0)}%)`, 'success');
      document.getElementById('task-badge').className = data.status === 'done' ? 'badge badge-green' : 'badge badge-yellow';
      document.getElementById('task-badge').textContent = data.status;
      document.getElementById('progress-fill').style.width = '100%';
      document.getElementById('progress-pct').textContent = '100%';

      // mark all ralph phases as done
      RALPH_PHASES.forEach(p => {
        const node = document.getElementById('rn-' + p);
        const phaseEl = document.getElementById('rp-' + p);
        if (node) { node.className = 'ralph-node done'; }
        if (phaseEl) { phaseEl.className = 'ralph-phase done'; }
      });
      ['rc-ra','rc-al','rc-lp','rc-ph'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.className = 'ralph-connector done';
      });
      const detailEl = document.getElementById('ralph-detail');
      if (detailEl) detailEl.textContent = data.status === 'done' ? 'Task completed successfully' : 'Task parked for next worker';

      if (data.result) {
        document.getElementById('result-card').hidden = false;
        document.getElementById('result-text').textContent = data.result;
      }

      // render lessons if available
      if (data.lessons && data.lessons.length > 0) {
        const stepList = document.getElementById('step-list');
        data.lessons.forEach(l => {
          const cls = l.succeeded ? 'done' : 'pending';
          const icon = l.succeeded ? '&#10003;' : '&#10007;';
          stepList.innerHTML += `<li class="step-item">
            <div class="step-icon ${cls}">${icon}</div>
            <div>
              <div>Iteration ${l.iteration} (${l.provider || 'n/a'})</div>
              <div style="font-size:11px; color:var(--fg2)">conf delta: ${(l.confidence_delta || 0).toFixed(2)}</div>
            </div>
          </li>`;
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
  const el = document.getElementById('cmd-' + provider);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    el.style.borderColor = 'var(--green)';
    setTimeout(() => { el.style.borderColor = ''; }, 1200);
  });
}

function copyResult() {
  const text = document.getElementById('result-text').textContent;
  navigator.clipboard.writeText(text).then(() => addLog('Copied to clipboard'));
}

// ---- polling ----
async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    const data = await r.json();
    renderProviders(data.auth || {});

    // update RALPH phase if task is running
    if (data.ralph && taskRunning) {
      const phase = data.ralph.current_phase;
      const events = data.ralph.phase_events || [];
      const total = data.ralph.total_events || 0;

      if (phase && phase !== 'idle') {
        // find latest iteration from events
        let iteration = 0;
        if (events.length > 0) {
          iteration = events[events.length - 1].iteration || 0;
        }
        updateRalphPhase(phase, iteration);
      }

      // log new phase events
      if (total > lastPhaseEventCount && events.length > 0) {
        const newEvents = events.slice(-(total - lastPhaseEventCount));
        newEvents.forEach(ev => {
          if (ev.phase !== 'handoff' || (ev.data && ev.data.trigger !== 'continue')) {
            addLog(`RALPH [${ev.phase.toUpperCase()}] iteration ${ev.iteration}`, 'info');
          }
        });
        lastPhaseEventCount = total;
      }

      // update progress bar
      if (events.length > 0) {
        const lastEv = events[events.length - 1];
        if (lastEv.data && lastEv.data.confidence !== undefined) {
          const pct = Math.round(lastEv.data.confidence * 100);
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

const NODE_W = 180, NODE_H = 64;
const NODE_DEFS = {
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

// ---- workflow templates ----
const WF_TEMPLATES = {
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

// ---- workflow state ----
let wfNodes = [];
let wfEdges = [];
let wfNextId = 1;
let wfSelectedNode = null;
let wfDragging = null;
let wfConnecting = null; // { nodeId, portType:'out', portIdx }
let wfPan = { x: 0, y: 0 };
let wfZoom = 1;
let wfPanning = false;
let wfPanStart = { x: 0, y: 0 };
let wfInitDone = false;

const SVG_NS = 'http://www.w3.org/2000/svg';

function wfInit() {
  if (wfInitDone) return;
  wfInitDone = true;
  const wrap = document.getElementById('wf-canvas-wrap');
  const svg = document.getElementById('wf-svg');

  // palette drag-and-drop
  document.querySelectorAll('.wf-palette-node').forEach(el => {
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', el.dataset.nodeType);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
  wrap.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  wrap.addEventListener('drop', e => {
    e.preventDefault();
    const nodeType = e.dataTransfer.getData('text/plain');
    if (!nodeType || !NODE_DEFS[nodeType]) return;
    const rect = wrap.getBoundingClientRect();
    const x = (e.clientX - rect.left - wfPan.x) / wfZoom;
    const y = (e.clientY - rect.top - wfPan.y) / wfZoom;
    wfAddNode(nodeType, x - NODE_W / 2, y - NODE_H / 2);
  });

  // pan + zoom
  svg.addEventListener('pointerdown', e => {
    if (e.target === svg || e.target.id === 'wf-canvas-g') {
      wfPanning = true;
      wfPanStart = { x: e.clientX - wfPan.x, y: e.clientY - wfPan.y };
      wfDeselectAll();
      svg.style.cursor = 'grabbing';
      svg.setPointerCapture(e.pointerId);
    }
  });
  svg.addEventListener('pointermove', e => {
    if (wfPanning) {
      wfPan.x = e.clientX - wfPanStart.x;
      wfPan.y = e.clientY - wfPanStart.y;
      wfApplyTransform();
    }
    if (wfDragging) {
      const rect = wrap.getBoundingClientRect();
      wfDragging.node.x = (e.clientX - rect.left - wfPan.x) / wfZoom - wfDragging.ox;
      wfDragging.node.y = (e.clientY - rect.top - wfPan.y) / wfZoom - wfDragging.oy;
      wfRender();
    }
    if (wfConnecting) {
      const rect = wrap.getBoundingClientRect();
      const mx = (e.clientX - rect.left - wfPan.x) / wfZoom;
      const my = (e.clientY - rect.top - wfPan.y) / wfZoom;
      wfRenderTempEdge(mx, my);
    }
  });
  svg.addEventListener('pointerup', e => {
    if (wfPanning) {
      wfPanning = false;
      svg.style.cursor = '';
    }
    if (wfDragging) wfDragging = null;
    if (wfConnecting) {
      // check if released over a port
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target && target.classList.contains('wf-port') && target.dataset.portType === 'in') {
        const toId = target.dataset.nodeId;
        const toPort = parseInt(target.dataset.portIdx);
        if (toId !== wfConnecting.nodeId) {
          wfEdges.push({ from: wfConnecting.nodeId, to: toId, fromPort: wfConnecting.portIdx, toPort });
        }
      }
      wfConnecting = null;
      wfRender();
    }
  });

  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.08 : 0.08;
    const newZoom = Math.max(0.15, Math.min(3, wfZoom + delta));
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    wfPan.x = mx - (mx - wfPan.x) * (newZoom / wfZoom);
    wfPan.y = my - (my - wfPan.y) * (newZoom / wfZoom);
    wfZoom = newZoom;
    wfApplyTransform();
    document.getElementById('wf-zoom-label').textContent = Math.round(wfZoom * 100) + '%';
  }, { passive: false });

  // keyboard
  document.addEventListener('keydown', e => {
    if (document.getElementById('view-workflows').hidden) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      wfDeleteSelected();
    }
  });

  // load default
  loadTemplate('simple_agent');
}

function wfApplyTransform() {
  const g = document.getElementById('wf-canvas-g');
  g.setAttribute('transform', `translate(${wfPan.x},${wfPan.y}) scale(${wfZoom})`);
  wfUpdateMinimap();
}

function wfAddNode(type, x, y, name, id) {
  const def = NODE_DEFS[type];
  if (!def) return;
  const node = {
    id: id || ('n' + wfNextId++),
    type,
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
  const g = document.getElementById('wf-canvas-g');
  g.innerHTML = '';

  // edges
  wfEdges.forEach((edge, idx) => {
    const fromNode = wfNodes.find(n => n.id === edge.from);
    const toNode = wfNodes.find(n => n.id === edge.to);
    if (!fromNode || !toNode) return;
    const fromDef = NODE_DEFS[fromNode.type];
    const toDef = NODE_DEFS[toNode.type];
    const fp = wfPortPos(fromNode, 'out', edge.fromPort, fromDef.ports.out);
    const tp = wfPortPos(toNode, 'in', edge.toPort, toDef.ports.in);
    const path = wfBezier(fp.x, fp.y, tp.x, tp.y);
    const el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('d', path);
    el.setAttribute('class', 'wf-edge');
    el.setAttribute('stroke', 'var(--fg2)');
    el.setAttribute('marker-end', 'url(#wf-arrow)');
    el.addEventListener('click', () => {
      wfEdges.splice(idx, 1);
      wfRender();
    });
    g.appendChild(el);
  });

  // nodes
  wfNodes.forEach(node => {
    const def = NODE_DEFS[node.type];
    const ng = document.createElementNS(SVG_NS, 'g');
    ng.setAttribute('class', 'wf-svg-node' + (wfSelectedNode === node.id ? ' selected' : ''));
    ng.setAttribute('transform', `translate(${node.x},${node.y})`);

    // body rect
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'node-body');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('fill', 'var(--card)');
    rect.setAttribute('stroke', 'var(--border)');
    ng.appendChild(rect);

    // icon circle
    const ic = document.createElementNS(SVG_NS, 'circle');
    ic.setAttribute('cx', 26);
    ic.setAttribute('cy', NODE_H / 2);
    ic.setAttribute('r', 14);
    ic.setAttribute('fill', def.bg);
    ng.appendChild(ic);

    const it = document.createElementNS(SVG_NS, 'text');
    it.setAttribute('x', 26);
    it.setAttribute('y', NODE_H / 2 + 4);
    it.setAttribute('text-anchor', 'middle');
    it.setAttribute('class', 'node-icon-text');
    it.textContent = def.icon;
    ng.appendChild(it);

    // title
    const tt = document.createElementNS(SVG_NS, 'text');
    tt.setAttribute('x', 50);
    tt.setAttribute('y', NODE_H / 2 - 4);
    tt.setAttribute('class', 'node-title');
    tt.setAttribute('fill', 'var(--fg)');
    tt.textContent = node.name.length > 16 ? node.name.slice(0, 15) + '…' : node.name;
    ng.appendChild(tt);

    // subtitle (type)
    const st = document.createElementNS(SVG_NS, 'text');
    st.setAttribute('x', 50);
    st.setAttribute('y', NODE_H / 2 + 12);
    st.setAttribute('class', 'node-subtitle');
    st.textContent = def.label;
    ng.appendChild(st);

    // input ports
    for (let i = 0; i < def.ports.in; i++) {
      const pp = wfLocalPortPos('in', i, def.ports.in);
      const port = document.createElementNS(SVG_NS, 'circle');
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

    // output ports
    for (let i = 0; i < def.ports.out; i++) {
      const pp = wfLocalPortPos('out', i, def.ports.out);
      const port = document.createElementNS(SVG_NS, 'circle');
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
      // start connection on pointerdown
      port.addEventListener('pointerdown', e => {
        e.stopPropagation();
        wfConnecting = { nodeId: node.id, portIdx: i };
      });
      ng.appendChild(port);
    }

    // interactions
    ng.addEventListener('pointerdown', e => {
      if (e.target.classList.contains('wf-port')) return;
      e.stopPropagation();
      wfSelectNode(node.id);
      const rect2 = document.getElementById('wf-canvas-wrap').getBoundingClientRect();
      const mx = (e.clientX - rect2.left - wfPan.x) / wfZoom;
      const my = (e.clientY - rect2.top - wfPan.y) / wfZoom;
      wfDragging = { node, ox: mx - node.x, oy: my - node.y };
    });

    g.appendChild(ng);
  });

  document.getElementById('wf-node-count').textContent = wfNodes.length + ' node' + (wfNodes.length !== 1 ? 's' : '');
  wfUpdateMinimap();
}

function wfLocalPortPos(type, idx, total) {
  const spacing = NODE_H / (total + 1);
  const y = spacing * (idx + 1);
  return { x: type === 'in' ? 0 : NODE_W, y };
}

function wfPortPos(node, type, idx, total) {
  const local = wfLocalPortPos(type, idx, total);
  return { x: node.x + local.x, y: node.y + local.y };
}

function wfBezier(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

function wfRenderTempEdge(mx, my) {
  const g = document.getElementById('wf-canvas-g');
  let tempEl = g.querySelector('.wf-edge-temp');
  if (!wfConnecting) { if (tempEl) tempEl.remove(); return; }
  const fromNode = wfNodes.find(n => n.id === wfConnecting.nodeId);
  if (!fromNode) return;
  const fromDef = NODE_DEFS[fromNode.type];
  const fp = wfPortPos(fromNode, 'out', wfConnecting.portIdx, fromDef.ports.out);
  const path = wfBezier(fp.x, fp.y, mx, my);
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
  const node = wfNodes.find(n => n.id === id);
  if (node) {
    const panel = document.getElementById('wf-detail');
    panel.classList.add('open');
    document.getElementById('wf-detail-title').textContent = node.name;
    document.getElementById('wf-d-name').value = node.name;
    document.getElementById('wf-d-type').value = NODE_DEFS[node.type]?.label || node.type;
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
  const node = wfNodes.find(n => n.id === wfSelectedNode);
  if (!node) return;
  node[prop] = value;
  if (prop === 'name') {
    document.getElementById('wf-detail-title').textContent = value;
    wfRender();
  }
}

function wfDeleteSelected() {
  if (!wfSelectedNode) return;
  wfNodes = wfNodes.filter(n => n.id !== wfSelectedNode);
  wfEdges = wfEdges.filter(e => e.from !== wfSelectedNode && e.to !== wfSelectedNode);
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
  const tpl = WF_TEMPLATES[key];
  if (!tpl) return;
  wfClearCanvas();
  tpl.nodes.forEach(n => {
    wfAddNode(n.type, n.x, n.y, n.name, n.id);
  });
  // reassign wfNextId
  const maxId = Math.max(...wfNodes.map(n => parseInt(n.id.replace('n', '')) || 0));
  wfNextId = maxId + 1;
  wfEdges = tpl.edges.map(e => ({ ...e }));
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
  const wrap = document.getElementById('wf-canvas-wrap');
  const ww = wrap.clientWidth;
  const wh = wrap.clientHeight;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  wfNodes.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  });
  const pw = maxX - minX + 80;
  const ph = maxY - minY + 80;
  wfZoom = Math.min(1.5, Math.min(ww / pw, wh / ph));
  wfPan.x = (ww - pw * wfZoom) / 2 - minX * wfZoom + 40 * wfZoom;
  wfPan.y = (wh - ph * wfZoom) / 2 - minY * wfZoom + 40 * wfZoom;
  wfApplyTransform();
  document.getElementById('wf-zoom-label').textContent = Math.round(wfZoom * 100) + '%';
}

function wfUpdateMinimap() {
  const mmSvg = document.getElementById('wf-minimap-svg');
  if (!mmSvg || wfNodes.length === 0) { if (mmSvg) mmSvg.innerHTML = ''; return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  wfNodes.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  });
  const pad = 20;
  const vw = maxX - minX + pad * 2;
  const vh = maxY - minY + pad * 2;
  mmSvg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${vw} ${vh}`);
  let html = '';
  wfEdges.forEach(edge => {
    const fn = wfNodes.find(n => n.id === edge.from);
    const tn = wfNodes.find(n => n.id === edge.to);
    if (!fn || !tn) return;
    const fx = fn.x + NODE_W, fy = fn.y + NODE_H / 2;
    const tx = tn.x, ty = tn.y + NODE_H / 2;
    html += `<line x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}" stroke="var(--fg2)" stroke-width="2" opacity="0.4"/>`;
  });
  wfNodes.forEach(node => {
    const def = NODE_DEFS[node.type];
    const sel = wfSelectedNode === node.id;
    html += `<rect x="${node.x}" y="${node.y}" width="${NODE_W}" height="${NODE_H}" rx="6" fill="${def.bg}" opacity="${sel ? 0.9 : 0.5}"/>`;
  });
  mmSvg.innerHTML = html;
}

async function wfSaveWorkflow() {
  const payload = {
    name: 'Workflow ' + new Date().toLocaleTimeString(),
    nodes: wfNodes.map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, name: n.name, provider: n.provider, system: n.system, config: n.config })),
    edges: wfEdges,
  };
  try {
    const r = await fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.ok) addLog('Workflow saved: ' + (data.id || ''), 'success');
    else addLog('Save failed: ' + (data.error || ''), 'error');
  } catch (e) {
    addLog('Save error: ' + e.message, 'error');
  }
}

async function wfRunWorkflow() {
  if (wfNodes.length === 0) { addLog('No nodes in workflow', 'warn'); return; }
  const payload = {
    nodes: wfNodes.map(n => ({ id: n.id, type: n.type, name: n.name, provider: n.provider, system: n.system, config: n.config })),
    edges: wfEdges,
  };
  document.getElementById('wf-run-btn').disabled = true;
  addLog('Running workflow (' + wfNodes.length + ' nodes)...');
  try {
    const r = await fetch('/api/workflows/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.error) addLog('Workflow error: ' + data.error, 'error');
    else addLog('Workflow complete: ' + (data.status || 'done'), 'success');
  } catch (e) {
    addLog('Run error: ' + e.message, 'error');
  } finally {
    document.getElementById('wf-run-btn').disabled = false;
  }
}

// ---- routing dashboard ----
const BREAKER_COLORS = {
  closed: '#22c55e',
  degraded: '#f59e0b',
  open: '#ef4444',
  half_open: '#3b82f6',
};

function refreshRouting() {
  fetch('/api/status').then(r => r.json()).then(data => {
    const router = data.router || {};
    const providers = router.providers || {};
    const lkgp = router.lkgp || {};
    const omniroute = router.omniroute || null;

    // strategy badge
    const badge = document.getElementById('routing-mode-badge');
    if (omniroute && omniroute.available) {
      badge.textContent = 'OmniRoute';
      badge.className = 'badge badge-green';
    } else {
      badge.textContent = router.strategy || 'embedded';
      badge.className = 'badge badge-blue';
    }

    // strategy selector
    const sel = document.getElementById('routing-strategy');
    if (router.strategy && sel.value !== router.strategy) {
      sel.value = router.strategy;
    }

    // OmniRoute status
    const dot = document.getElementById('omniroute-status-dot');
    const txt = document.getElementById('omniroute-status-text');
    if (omniroute) {
      if (omniroute.available) {
        dot.style.background = '#22c55e';
        const mc = omniroute.model_count || 0;
        txt.textContent = `Connected (${mc} models)`;
        txt.style.color = 'var(--fg)';
      } else {
        dot.style.background = '#ef4444';
        txt.textContent = 'Unreachable';
        txt.style.color = 'var(--fg2)';
      }
    } else {
      dot.style.background = '#666';
      txt.textContent = 'Not configured';
      txt.style.color = 'var(--fg2)';
    }

    // circuit breakers
    const grid = document.getElementById('breaker-grid');
    const pids = Object.keys(providers);
    if (pids.length === 0) {
      grid.innerHTML = '<div style="color:var(--fg2); font-size:13px; padding:16px; text-align:center">No providers active yet</div>';
    } else {
      grid.innerHTML = pids.map(pid => {
        const p = providers[pid];
        const b = p.breaker || {};
        const state = b.state || 'closed';
        const color = BREAKER_COLORS[state] || '#666';
        const failPct = b.failure_threshold ? Math.round((b.failure_count || 0) / b.failure_threshold * 100) : 0;
        return `<div style="border:1px solid var(--border); border-radius:8px; padding:12px; background:var(--bg2)">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
            <span style="font-weight:500; font-size:13px">${escHtml(pid)}</span>
            <span style="background:${color}; color:#fff; font-size:11px; padding:2px 8px; border-radius:10px">${state}</span>
          </div>
          <div style="font-size:11px; color:var(--fg2); line-height:1.8">
            <div>Failures: ${b.failure_count || 0} / ${b.failure_threshold || 8}</div>
            <div style="background:var(--border); border-radius:3px; height:4px; margin:4px 0">
              <div style="background:${color}; height:100%; border-radius:3px; width:${Math.min(failPct, 100)}%; transition:width 0.3s"></div>
            </div>
            <div>Successes: ${b.success_count || 0}</div>
            <div>Quota: ${p.quota_available ? 'OK' : 'Exhausted'} (${Math.round((p.quota_remaining_pct || 1) * 100)}%)</div>
          </div>
        </div>`;
      }).join('');
    }

    // cost table
    const tbody = document.getElementById('cost-table-body');
    if (pids.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:12px; text-align:center; color:var(--fg2)">No data</td></tr>';
    } else {
      tbody.innerHTML = pids.map(pid => {
        const p = providers[pid];
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:6px 8px">${escHtml(pid)}</td>
          <td style="padding:6px 8px">${p.requests || 0}</td>
          <td style="padding:6px 8px">${(p.total_tokens || 0).toLocaleString()}</td>
          <td style="padding:6px 8px">$${(p.total_cost || 0).toFixed(4)}</td>
        </tr>`;
      }).join('');
    }

    // LKGP state
    const lkgpEl = document.getElementById('lkgp-list');
    const lkgpEntries = Object.entries(lkgp);
    if (lkgpEntries.length === 0) {
      lkgpEl.innerHTML = 'No routing history yet';
    } else {
      lkgpEl.innerHTML = lkgpEntries.map(([task, provider]) =>
        `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border)">
          <span style="color:var(--fg)">${escHtml(task)}</span>
          <span style="color:var(--accent)">${escHtml(String(provider))}</span>
        </div>`
      ).join('');
    }
  }).catch(() => {});
}

// auto-refresh routing when visible
setInterval(() => {
  if (!document.getElementById('view-routing').hidden) refreshRouting();
}, 2000);

// ---- init ----
(function init() {
  try { if (localStorage.getItem('oma-theme') === 'light') document.body.classList.add('light'); } catch(e) {}
  fetchStatus().then(() => {
    if (connectedCount === 0) showView('connect');
  });
  setInterval(fetchStatus, 1500);
  addLog('OMA Dashboard ready (RALPH loop enabled)');
})();
</script>
</body>
</html>"""


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle requests in separate threads for concurrent access."""
    daemon_threads = True


class DashboardHandler(BaseHTTPRequestHandler):
    """HTTP handler for the graphical dashboard."""

    agent = None
    auth_manager = None
    _task_thread = None
    _task_running = False
    _last_result = None

    def log_message(self, *args):
        pass

    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(DASHBOARD_HTML.encode())

        elif self.path == "/api/status":
            status = {}
            if self.auth_manager:
                status["auth"] = self.auth_manager.status()
            if self.agent and hasattr(self.agent, 'registry'):
                health = self.agent.registry.status_report()
                for name, h in health.items():
                    if name in status.get("auth", {}):
                        status["auth"][name]["health"] = h
            for name, info in status.get("auth", {}).items():
                if info.get("status") == "logged_in" and "health" not in info:
                    info["health"] = {
                        "success_rate": "100.0%",
                        "avg_latency_ms": "0",
                        "total_tokens": 0,
                        "in_cooldown": False,
                        "last_error": None,
                    }
            # include RALPH phase status
            if self.agent and hasattr(self.agent, 'ralph_status'):
                status["ralph"] = self.agent.ralph_status()
            else:
                status["ralph"] = {"current_phase": "idle", "phase_events": [], "total_events": 0}

            # include router + OmniRoute status
            if self.agent and hasattr(self.agent, 'router_status'):
                status["router"] = self.agent.router_status()
            else:
                status["router"] = {"strategy": "auto", "providers": {}, "lkgp": {}}

            self._send_json(status)

        elif self.path.startswith("/api/auth/verify"):
            from urllib.parse import parse_qs
            params = parse_qs(urlparse(self.path).query)
            provider = params.get("provider", [""])[0]
            if not provider:
                self._send_json({"error": "missing provider param"}, 400)
                return
            if not self.auth_manager:
                self._send_json({"error": "auth not initialized"}, 500)
                return
            cred = self.auth_manager.get_credential(provider)
            if not cred:
                self._send_json({"valid": False, "error": "no credential stored", "provider": provider})
                return
            ok, detail = self._verify_token(provider, cred.value)
            self._send_json({
                "valid": ok,
                "provider": provider,
                "detail": detail,
                "auth_type": cred.auth_type,
            })

        elif self.path == "/api/workflows":
            workflows = getattr(DashboardHandler, '_workflows', {})
            self._send_json({"workflows": list(workflows.values())})

        elif self.path == "/api/workflows/templates":
            tpl_list = []
            # mirror template keys from frontend
            names = {
                "simple_agent": "Simple Agent",
                "multi_agent": "Multi-Agent Pipeline",
                "rag_basic": "RAG: Basic",
                "rag_conversational": "RAG: Conversational",
                "rag_multi_source": "RAG: Multi-Source",
                "rag_agentic": "RAG: Agentic",
                "ralph_loop": "RALPH Loop",
                "map_reduce": "Map-Reduce",
            }
            for key, name in names.items():
                tpl_list.append({"key": key, "name": name})
            self._send_json({"templates": tpl_list})

        elif self.path == "/api/test/history":
            import pathlib
            history_path = pathlib.Path(__file__).resolve().parent.parent.parent.parent / "tests" / ".history" / "runs.json"
            if history_path.exists():
                try:
                    with open(history_path) as f:
                        runs = json.loads(f.read())
                    self._send_json({"runs": runs})
                except Exception as e:
                    self._send_json({"runs": [], "error": str(e)})
        elif self.path == "/api/storage/info":
            if not self.auth_manager:
                self._send_json({"error": "auth not initialized"}, 500)
                return
            self._send_json(self.auth_manager.storage_info())

        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/auth/connect":
            body = self._read_body()
            provider = body.get("provider", "")
            token = body.get("token", "")

            if not provider or not token:
                self._send_json({"error": "missing provider or token"}, 400)
                return

            ok, detail = self._verify_token(provider, token)
            if ok:
                if self.auth_manager:
                    self.auth_manager.store_session_token(provider, token)
                    self._rebuild_agent()
                self._send_json({"ok": True, "detail": detail})
            else:
                self._send_json({"ok": False, "error": detail or "Token verification failed"})

        elif parsed.path == "/api/auth/apikey":
            body = self._read_body()
            provider = body.get("provider", "")
            api_key = body.get("api_key", "")
            if self.auth_manager and provider and api_key:
                self.auth_manager.store_api_key(provider, api_key)
                self._rebuild_agent()
                self._send_json({"ok": True})
            else:
                self._send_json({"error": "missing provider or api_key"}, 400)

        elif parsed.path == "/api/auth/logout":
            body = self._read_body()
            provider = body.get("provider", "")
            if self.auth_manager and provider:
                self.auth_manager.logout(provider)
                self._rebuild_agent()
                self._send_json({"ok": True})
            else:
                self._send_json({"error": "missing provider"}, 400)

        elif parsed.path == "/api/auth/flush":
            body = self._read_body()
            include_mem = bool(body.get("include_memory", False))
            if self.auth_manager:
                res = self.auth_manager.flush(include_memory=include_mem)
                self._rebuild_agent()
                self._send_json({"ok": True, "details": res})
            else:
                self._send_json({"error": "auth not initialized"}, 500)

        elif parsed.path == "/api/run":
            body = self._read_body()
            objective = body.get("objective", "")
            criteria = body.get("criteria")

            if not objective:
                self._send_json({"error": "no objective"}, 400)
                return

            if not self.agent:
                self._rebuild_agent()

            if not self.agent:
                self._send_json({"error": "no providers configured"}, 400)
                return

            try:
                result = self.agent.run(objective=objective, criteria=criteria)
                DashboardHandler._last_result = result
                self._send_json({
                    "status": result.status.value,
                    "confidence": result.confidence,
                    "attempts": result.attempts,
                    "tokens_used": result.tokens_used,
                    "result": result.artifacts.get("final", "")[:5000],
                    "lessons": result.lessons[-20:],
                    "strategy": result.strategy,
                    "phase_history": result.phase_history[-20:],
                })
            except Exception as e:
                self._send_json({"error": str(e)}, 500)

        elif parsed.path == "/api/workflows":
            body = self._read_body()
            name = body.get("name", "Untitled")
            nodes = body.get("nodes", [])
            edges = body.get("edges", [])
            if not hasattr(DashboardHandler, '_workflows'):
                DashboardHandler._workflows = {}
            import hashlib, time
            wf_id = hashlib.md5(f"{name}{time.time()}".encode()).hexdigest()[:12]
            DashboardHandler._workflows[wf_id] = {
                "id": wf_id,
                "name": name,
                "nodes": nodes,
                "edges": edges,
                "created": time.time(),
            }
            self._send_json({"ok": True, "id": wf_id})

        elif parsed.path == "/api/workflows/run":
            body = self._read_body()
            nodes = body.get("nodes", [])
            edges = body.get("edges", [])
            if not nodes:
                self._send_json({"error": "no nodes in workflow"}, 400)
                return
            if not self.agent:
                self._rebuild_agent()
            if not self.agent:
                self._send_json({"error": "no providers configured"}, 400)
                return
            try:
                # topological sort for execution order
                adj = {n["id"]: [] for n in nodes}
                in_deg = {n["id"]: 0 for n in nodes}
                for e in edges:
                    adj[e["from"]].append(e["to"])
                    in_deg[e["to"]] = in_deg.get(e["to"], 0) + 1
                queue = [nid for nid, d in in_deg.items() if d == 0]
                order = []
                while queue:
                    nid = queue.pop(0)
                    order.append(nid)
                    for child in adj.get(nid, []):
                        in_deg[child] -= 1
                        if in_deg[child] == 0:
                            queue.append(child)
                node_map = {n["id"]: n for n in nodes}
                results = {}
                for nid in order:
                    node = node_map[nid]
                    ntype = node.get("type", "")
                    if ntype in ("start", "end", "merge"):
                        results[nid] = {"status": "pass-through"}
                        continue
                    # gather parent outputs
                    parent_outputs = []
                    for e in edges:
                        if e["to"] == nid and e["from"] in results:
                            parent_outputs.append(results[e["from"]])
                    # execute agent/ralph nodes via the harness
                    if ntype in ("agent", "sub_agent", "ralph"):
                        objective = node.get("system") or node.get("name", "task")
                        ctx = "; ".join(str(p.get("output", "")) for p in parent_outputs if p.get("output"))
                        if ctx:
                            objective = f"{objective} -- context: {ctx}"
                        result = self.agent.run(objective=objective)
                        results[nid] = {
                            "status": result.status.value,
                            "confidence": result.confidence,
                            "output": result.artifacts.get("final", "")[:2000],
                        }
                    else:
                        results[nid] = {"status": "skipped", "type": ntype}
                self._send_json({
                    "status": "done",
                    "node_results": results,
                    "execution_order": order,
                })
            except Exception as e:
                self._send_json({"error": str(e)}, 500)

        elif parsed.path == "/api/stop":
            DashboardHandler._task_running = False
            self._send_json({"ok": True})

        else:
            self.send_error(404)

    def _verify_token(self, provider: str, token: str) -> tuple[bool, str]:
        """
        Verify a subscription token or API key actually works by making a test request.
        Returns (success, detail_or_error).
        """
        import urllib.error
        import urllib.request
        from oma.providers.auth import clean_token

        token = clean_token(provider, token)
        if not token:
            return False, "Empty token"

        try:
            if provider == "claude":
                req = urllib.request.Request(
                    "https://claude.ai/api/organizations",
                    headers={
                        "Cookie": f"sessionKey={token}",
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept": "application/json",
                        "Origin": "https://claude.ai",
                        "Referer": "https://claude.ai/",
                    },
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    if data and len(data) > 0:
                        org_name = data[0].get("name", "")
                        return True, f"Organization: {org_name}" if org_name else "Session valid"
                    return False, "No organizations found -- token may be invalid"

            elif provider == "chatgpt":
                req = urllib.request.Request(
                    "https://chatgpt.com/api/auth/session",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept": "application/json",
                    },
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    email = data.get("user", {}).get("email", "")
                    return True, f"Account: {email}" if email else "Session valid"

            elif provider == "gemini":
                req = urllib.request.Request(
                    "https://gemini.google.com/",
                    headers={
                        "Cookie": f"__Secure-1PSID={token}",
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    },
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    html = resp.read().decode("utf-8")
                    import re
                    if re.search(r'"SNlM0e"', html):
                        return True, "Google session valid"
                    return True, "Cookie accepted (could not fully verify)"

            elif provider == "deepseek":
                req = urllib.request.Request(
                    "https://api.deepseek.com/models",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Accept": "application/json",
                    },
                )
                with urllib.request.urlopen(req, timeout=15) as resp:
                    if resp.status == 200:
                        return True, "DeepSeek API valid"
                    return False, f"DeepSeek returned status {resp.status}"

            else:
                return True, "Token stored"

        except urllib.error.HTTPError as e:
            code = e.code
            if code == 401 or code == 403:
                return False, f"Authentication failed (HTTP {code}) -- token is invalid or expired"
            return False, f"HTTP error {code} -- check token and try again"
        except urllib.error.URLError as e:
            return False, f"Could not reach {provider} servers -- check your network"
        except Exception as e:
            return False, f"Verification error: {str(e)[:200]}"

    def _rebuild_agent(self):
        """Rebuild the agent with current credentials."""
        try:
            from oma.agent import OMA
            DashboardHandler.agent = OMA.from_credentials(self.auth_manager)
        except Exception:
            try:
                from oma.agent import OMA
                DashboardHandler.agent = OMA.from_env()
            except Exception:
                DashboardHandler.agent = None


def run_web(host="127.0.0.1", port=8384, open_browser=True):
    """Start the graphical dashboard."""
    from oma.providers.auth import AuthManager

    auth = AuthManager()
    DashboardHandler.auth_manager = auth

    try:
        from oma.agent import OMA
        DashboardHandler.agent = OMA.from_credentials(auth)
    except Exception:
        try:
            from oma.agent import OMA
            DashboardHandler.agent = OMA.from_env()
        except Exception:
            DashboardHandler.agent = None

    server = ThreadedHTTPServer((host, port), DashboardHandler)
    url = f"http://{host}:{port}"
    print(f"OMA Dashboard: {url}")

    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    run_web()
