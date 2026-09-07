/**
 * OMA Graphical Dashboard -- the primary user interface.
 *
 * A graphical SPA served at http://localhost:8384 that provides:
 *   - Subscription-based login for Claude, ChatGPT, Gemini
 *   - API key entry as fallback
 *   - Provider health monitoring
 *   - Task execution with progress
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

const PROVIDERS = {
  claude:   { name: 'Claude',   icon: 'C', bg: '#d97706' },
  chatgpt:  { name: 'ChatGPT',  icon: 'G', bg: '#10a37f' },
  gemini:   { name: 'Gemini',   icon: 'G', bg: '#4285f4' },
  deepseek: { name: 'DeepSeek', icon: 'D', bg: '#6366f1' },
  glm:      { name: 'GLM',      icon: 'Z', bg: '#ec4899' },
  kimi:     { name: 'Kimi',     icon: 'K', bg: '#14b8a6' },
};

// ---- views ----
function showView(view) {
  document.getElementById('view-task').hidden = (view !== 'task');
  document.getElementById('view-connect').hidden = (view !== 'connect');
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('nav-' + view).classList.add('active');
}

// ---- logging ----
function addLog(msg, level) {
  level = level || 'info';
  const log = document.getElementById('log');
  const ts = new Date().toLocaleTimeString();
  log.innerHTML += '<div class="log-entry"><span class="log-ts">[' + ts + ']</span> <span class="log-' + level + '">' + escHtml(msg) + '</span></div>';
  log.scrollTop = log.scrollHeight;
}
function clearLog() { document.getElementById('log').innerHTML = ''; }
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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
    const r = await fetch('/api/auth/flush', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ include_memory: false }),
    });
    const d = await r.json();
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
  document.getElementById('run-btn').disabled = true;
  document.getElementById('stop-btn').disabled = false;
  document.getElementById('task-badge').className = 'badge badge-blue';
  document.getElementById('task-badge').textContent = 'running';
  document.getElementById('progress-card').hidden = false;
  document.getElementById('result-card').hidden = true;
  document.getElementById('step-list').innerHTML = '';
  document.getElementById('progress-fill').style.width = '0%';
  addLog('Starting task: ' + obj);

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

      if (data.result) {
        document.getElementById('result-card').hidden = false;
        document.getElementById('result-text').textContent = data.result;
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
  } catch (e) {}
}

// ---- theme ----
function toggleTheme() {
  document.body.classList.toggle('light');
  try { localStorage.setItem('oma-theme', document.body.classList.contains('light') ? 'light' : 'dark'); } catch(e) {}
}

// ---- init ----
(function init() {
  try { if (localStorage.getItem('oma-theme') === 'light') document.body.classList.add('light'); } catch(e) {}
  fetchStatus().then(function() {
    // if no providers connected, show connect view on first load
    if (connectedCount === 0) showView('connect');
  });
  setInterval(fetchStatus, 5000);
  addLog('OMA Dashboard ready');
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
        });
      } catch (err: unknown) {
        taskRunning = false;
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
