export const DASHBOARD_HTML = String.raw`<!doctype html>
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

  #view-workflows > .card { padding: 16px; }
  #view-workflows > .card input, #view-workflows > .card select {
    background:var(--bg);color:var(--fg);border:1px solid var(--border);
    border-radius:var(--radius-sm);padding:6px 8px;
  }
  #view-workflows > .card label { font-size:12px;color:var(--fg2); }
  #project-status { font-size:12px;color:var(--accent); }
  #wf-output { min-height:60px; }
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

  /* ---- tooltip ---- */
  .oma-tooltip {
    position: fixed; z-index: 9999; pointer-events: none; opacity: 0;
    transform: translateY(4px); transition: opacity 0.15s ease, transform 0.15s ease;
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); padding: 8px 12px; font-size: 12px;
    line-height: 1.4; color: var(--fg); max-width: 300px; word-break: break-word;
  }
  .oma-tooltip.visible { opacity: 1; transform: translateY(0); }
  .oma-tooltip .tt-title { font-weight: 600; color: var(--accent); margin-bottom: 2px; }
  .oma-tooltip .tt-desc { color: var(--fg2); }

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

  /* ---- Onboarding Demo Modal ---- */
  .onboarding-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(6px);
    z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    padding: 20px;
    opacity: 0; pointer-events: none;
    transition: opacity 0.25s ease;
  }
  .onboarding-backdrop.open {
    opacity: 1; pointer-events: auto;
  }
  .onboarding-card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 14px;
    width: 100%; max-width: 660px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    display: flex; flex-direction: column;
    overflow: hidden;
    transform: scale(0.95);
    transition: transform 0.25s ease;
  }
  .onboarding-backdrop.open .onboarding-card {
    transform: scale(1);
  }
  .onboarding-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 22px;
    border-bottom: 1px solid var(--border);
    background: var(--card);
  }
  .onboarding-header-left {
    display: flex; align-items: center; gap: 10px;
  }
  .onboarding-step-badge {
    background: rgba(88, 166, 255, 0.15);
    color: var(--accent);
    font-size: 11px; font-weight: 700;
    padding: 3px 8px; border-radius: 12px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .onboarding-header h3 {
    font-size: 15px; font-weight: 600; color: var(--fg);
  }
  .onboarding-close {
    background: none; border: none; color: var(--fg2);
    font-size: 20px; cursor: pointer; padding: 2px 6px;
    border-radius: var(--radius-sm); transition: color 0.15s; line-height: 1;
  }
  .onboarding-close:hover { color: var(--fg); background: var(--bg); }
  .onboarding-body {
    padding: 22px;
    min-height: 290px;
    display: flex; flex-direction: column;
    justify-content: space-between;
  }
  .onboarding-slide {
    display: none; animation: fadeIn 0.2s ease-in-out;
  }
  .onboarding-slide.active {
    display: block;
  }
  .onboarding-hero {
    display: flex; align-items: flex-start; gap: 16px; margin-bottom: 14px;
  }
  .onboarding-hero-icon {
    font-size: 28px; width: 52px; height: 52px; border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(88, 166, 255, 0.1); border: 1px solid rgba(88, 166, 255, 0.25);
    flex-shrink: 0;
  }
  .onboarding-hero-text h4 {
    font-size: 17px; font-weight: 700; color: var(--fg); margin-bottom: 5px;
  }
  .onboarding-hero-text p {
    font-size: 13px; color: var(--fg2); line-height: 1.5;
  }
  .onboarding-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px;
    margin: 14px 0;
  }
  .onboarding-feature-item {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 10px 12px;
  }
  .onboarding-feature-item .title {
    font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 4px;
    display: flex; align-items: center; gap: 6px;
  }
  .onboarding-feature-item .desc {
    font-size: 11px; color: var(--fg2); line-height: 1.35;
  }
  .onboarding-highlight-box {
    background: rgba(88, 166, 255, 0.06); border: 1px solid rgba(88, 166, 255, 0.2);
    border-radius: var(--radius-sm); padding: 10px 14px; margin-top: 10px;
    font-size: 12px; color: var(--fg); line-height: 1.45;
  }
  .onboarding-highlight-box code {
    font-family: var(--mono); background: var(--bg); padding: 1px 4px; border-radius: 3px; font-size: 11px;
  }
  .onboarding-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 22px;
    border-top: 1px solid var(--border);
    background: var(--card);
  }
  .onboarding-footer-left {
    display: flex; align-items: center; gap: 16px;
  }
  .onboarding-dots {
    display: flex; gap: 6px; align-items: center;
  }
  .onboarding-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--border); cursor: pointer; transition: all 0.2s;
  }
  .onboarding-dot.active {
    width: 22px; border-radius: 4px; background: var(--accent);
  }
  .onboarding-footer-right {
    display: flex; gap: 8px; align-items: center;
  }
  .onboarding-checkbox-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; color: var(--fg2); cursor: pointer; user-select: none;
  }
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <h1><span>OMA</span> Open Multi Agent</h1>
    <div class="header-right">
      <div class="nav-tabs">
        <button class="nav-tab active" onclick="showView('task')" id="nav-task" data-tooltip-title="Task Execution" data-tooltip="Single-prompt autonomous solver powered by RALPH loop">Task</button>
        <button class="nav-tab" onclick="showView('workflows')" id="nav-workflows" data-tooltip-title="DAG Workflow Canvas" data-tooltip="Visual node-based pipeline builder for multi-agent & RAG architectures">Workflows</button>
        <button class="nav-tab" onclick="showView('connect')" id="nav-connect" data-tooltip-title="Provider Authentication" data-tooltip="Connect Claude, ChatGPT, Gemini subscriptions or API keys">Connect</button>
        <button class="nav-tab" onclick="showView('routing')" id="nav-routing" data-tooltip-title="Smart Router Dashboard" data-tooltip="Inspect routing strategies, circuit breakers, and token cost tracking">Routing</button>
      </div>
      <button class="btn btn-sm btn-ghost" onclick="openOnboarding(0)" id="btn-tour" style="display:flex; align-items:center; gap:5px; padding:3px 9px; font-size:12px;" data-tooltip-title="Quick Tour" data-tooltip="Start or replay the guided onboarding walkthrough and live demo">&#9654; Tour</button>
      <span id="conn-status" class="badge badge-gray" data-tooltip-title="Active Connections" data-tooltip="Number of authenticated LLM providers available for routing">0 providers</span>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme" data-tooltip-title="Toggle Theme" data-tooltip="Switch between Dark and Light mode">&#9681;</button>
    </div>
  </div>

  <div class="main">
    <div class="sidebar">
      <div class="section-title">Providers</div>
      <div class="provider-card"><strong>Testing process</strong><div id="test-process-status" role="status">Checking…</div></div>
      <div id="providers-list"></div>
      <div style="margin-top:16px">
        <button class="btn btn-primary btn-sm" onclick="showView('connect')" style="width:100%" data-tooltip-title="Add Provider" data-tooltip="Configure new provider credentials or subscriptions">
          + Connect Provider
        </button>
      </div>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border)">
        <div class="section-title" style="margin-bottom:8px">Safe Storage</div>
        <div id="storage-info" style="font-size:11px; color:var(--fg2); line-height:1.5; margin-bottom:10px" data-tooltip-title="Encrypted Vault" data-tooltip="Credentials encrypted on disk using PBKDF2 + XOR with 0600 file permissions">
          <div><span style="color:var(--fg)">File:</span> <code>~/.oma/credentials.json</code></div>
          <div><span style="color:var(--fg)">Mode:</span> <code>0600 (owner-only)</code></div>
          <div><span style="color:var(--fg)">Encrypted:</span> PBKDF2 + XOR</div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="flushAllCredentials()" style="width:100%; color:#f85149; border-color:#f8514944" title="Securely wipe all stored credentials from disk" data-tooltip-title="Wipe Credentials" data-tooltip="Securely zero out and delete all saved credentials from local storage">
          &#128465; Flush Credentials
        </button>
      </div>
    </div>

    <div class="content">
      <!-- Connect View -->
      <div id="view-connect" class="setup-view" hidden>
<div class="card"><div class="card-body"><strong>Codex subscription</strong><p>Use the existing local Codex login. Credentials stay on this computer.</p><button class="btn btn-primary" onclick="connectCodex()">Link Codex and test a message</button><span id="status-codex" role="status"></span></div></div>
<div class="card"><div class="card-body"><strong>Claude Code subscription</strong><p>Use the existing local Claude Code login with bounded usage.</p><button class="btn btn-primary" onclick="connectClaudeCLI()">Link Claude Code and test a message</button><span id="status-claude-cli" role="status"></span></div></div>

        <h2>Connect Your Subscriptions</h2>
        <p class="subtitle">
          Use your existing paid subscriptions (Claude Pro, ChatGPT Plus, Gemini Advanced).
          No API keys needed -- OMA connects through your browser session.
        </p>

        <!-- Claude -->
        <div class="connect-card" id="cc-claude" data-tooltip-title="Claude Subscription" data-tooltip="Connect your paid claude.ai Pro, Team, or Enterprise subscription">
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
                  overflow-x:auto; user-select:all" data-tooltip-title="Extraction Command" data-tooltip="JavaScript snippet to extract your Claude sessionKey cookie">document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('sessionKey='))?.split('=').slice(1).join('=')</code>
                <button class="btn btn-sm btn-ghost" onclick="copyCmd('claude')" title="Copy command" data-tooltip-title="Copy Script" data-tooltip="Copy the extraction snippet to your clipboard">&#128203;</button>
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
              <input type="password" id="token-claude" placeholder="Paste sessionKey value here" data-tooltip-title="Claude Session Key" data-tooltip="Paste sessionKey cookie extracted from claude.ai">
              <button class="btn btn-primary" onclick="connectProvider('claude')" data-tooltip-title="Connect Claude" data-tooltip="Verify sessionKey against Claude organizations API and store credentials">Connect</button>
            </div>
            <div id="status-claude"></div>
          </div>
        </div>

        <!-- ChatGPT -->
        <div class="connect-card" id="cc-chatgpt" data-tooltip-title="ChatGPT Subscription" data-tooltip="Connect your paid chatgpt.com Plus or Team subscription">
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
                  overflow-x:auto; user-select:all" data-tooltip-title="Extraction Command" data-tooltip="JavaScript snippet to fetch your ChatGPT accessToken via session endpoint">fetch('/api/auth/session').then(r=>r.json()).then(d=>console.log(d.accessToken))</code>
                <button class="btn btn-sm btn-ghost" onclick="copyCmd('chatgpt')" title="Copy command" data-tooltip-title="Copy Script" data-tooltip="Copy the extraction snippet to your clipboard">&#128203;</button>
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
              <input type="password" id="token-chatgpt" placeholder="Paste access token or session cookie" data-tooltip-title="ChatGPT Access Token" data-tooltip="Paste accessToken or session cookie from chatgpt.com">
              <button class="btn btn-primary" onclick="connectProvider('chatgpt')" data-tooltip-title="Connect ChatGPT" data-tooltip="Verify accessToken against OpenAI session API and store credentials">Connect</button>
            </div>
            <div id="status-chatgpt"></div>
          </div>
        </div>

        <!-- Gemini -->
        <div class="connect-card" id="cc-gemini" data-tooltip-title="Gemini Subscription" data-tooltip="Connect your Google Gemini Advanced subscription">
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
                  overflow-x:auto; user-select:all" data-tooltip-title="Extraction Command" data-tooltip="JavaScript snippet to extract your Google __Secure-1PSID cookie">document.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('__Secure-1PSID='))?.split('=').slice(1).join('=')</code>
                <button class="btn btn-sm btn-ghost" onclick="copyCmd('gemini')" title="Copy command" data-tooltip-title="Copy Script" data-tooltip="Copy the extraction snippet to your clipboard">&#128203;</button>
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
              <input type="password" id="token-gemini" placeholder="Paste __Secure-1PSID value here" data-tooltip-title="Gemini Cookie" data-tooltip="Paste __Secure-1PSID cookie extracted from gemini.google.com">
              <button class="btn btn-primary" onclick="connectProvider('gemini')" data-tooltip-title="Connect Gemini" data-tooltip="Test session validity against Google Gemini and store credentials">Connect</button>
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
          <div class="connect-card" id="cc-apikey" data-tooltip-title="Direct API Keys" data-tooltip="Configure standard direct API keys for providers without subscription sessions">
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
                  border-radius:var(--radius-sm); padding:8px 12px; color:var(--fg); font-size:13px; outline:none;" data-tooltip-title="Provider Choice" data-tooltip="Choose which provider this API key belongs to">
                  <option value="claude">Claude</option>
                  <option value="chatgpt">ChatGPT / OpenAI</option>
                  <option value="gemini">Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="jev">Jev (TypeSafe AI)</option>
                  <option value="groq">Groq</option>
                  <option value="mistral">Mistral AI</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="ollama">Ollama (Local)</option>
                  <option value="together">Together AI</option>
                  <option value="qwen">Qwen (DashScope)</option>
                  <option value="glm">GLM</option>
                  <option value="kimi">Kimi</option>
                </select>
              </div>
              <div class="token-row">
                <input type="password" id="apikey-value" placeholder="sk-... or API key" data-tooltip-title="API Key Value" data-tooltip="Enter provider secret key (sk-... or equivalent)">
                <button class="btn btn-primary" onclick="connectApiKey()" data-tooltip-title="Save Key" data-tooltip="Encrypt and save API key into credentials vault">Save</button>
              </div>
              <div id="status-apikey"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Workflow Editor View -->
      <div id="view-workflows" hidden style="max-width:none">
        <div class="card" style="margin-bottom:12px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <label for="project-select">Project</label><select id="project-select" onchange="projectSelect(this.value)"></select>
            <input id="project-name" placeholder="New project name" aria-label="New project name">
            <button class="btn btn-ghost" onclick="projectCreate()">Create project</button>
            <button class="btn btn-ghost" onclick="projectCommand('/cleanup')">Laya cleanup</button>
            <button class="btn btn-ghost" onclick="projectExport()">Export projects</button><label class="btn btn-ghost">Import<input type="file" accept=".json" hidden onchange="projectImport(event)"></label>
            <span id="project-status" role="status" aria-live="polite"></span><label>Primary tier <input id="tier-primary" value="codex" size="8" onchange="projectSave().catch(projectError)"></label>
            <label>Fallback tier <input id="tier-fallback" value="claude" size="8" onchange="projectSave().catch(projectError)"></label>
            <label>Claude calls/run <input id="claude-call-cap" type="number" min="0" value="2" style="width:60px" onchange="projectSave().catch(projectError)"></label>
            <label>Claude tokens/run <input id="claude-token-cap" type="number" min="0" value="8000" style="width:85px" onchange="projectSave().catch(projectError)"></label>
            <span id="claude-usage">Claude: 0 calls / 0 tokens</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:12px">
            <div class="input-group"><label for="wf-input">Workflow input</label><textarea id="wf-input" placeholder="Input passed to the Start node" onchange="projectSave().catch(projectError)"></textarea>
              <label for="wf-output">Step outputs</label><pre id="wf-output" style="white-space:pre-wrap;max-height:180px;overflow:auto" tabindex="0">Run a workflow to see outputs.</pre></div>
            <div><strong>Project tasks</strong><div id="project-tasks"></div><div class="input-group" style="margin-top:8px"><input id="project-task-title" placeholder="Task title" aria-label="Task title"><button class="btn btn-ghost" onclick="projectAddTask()">Add task</button></div><pre id="project-cleanup" style="white-space:pre-wrap;max-height:150px;overflow:auto"></pre></div>
            <div><strong>Saved conversation</strong><div id="project-history" role="log" aria-live="polite" style="height:220px;overflow:auto;white-space:pre-wrap"></div>
              <form onsubmit="event.preventDefault(); projectCommand()" class="input-group"><label for="project-command">Message or command</label><input id="project-command" placeholder="/help, /input, /run, /output, /task add…" autocomplete="off"><button id="project-send" class="btn btn-primary" type="submit">Send</button></form></div>
          </div>
        </div>

        <div class="wf-editor">
          <div class="wf-toolbar">
            <select id="wf-template-select" onchange="loadTemplate(this.value)" data-tooltip-title="Workflow Templates" data-tooltip="Load preconfigured pipeline templates (Simple Agent, RAG, RALPH Loop, Map-Reduce)">
              <option value="">-- Load Template --</option>
              <option value="tiered_routing">Tiered Routing (T1: Gemini → T2: DeepSeek)</option>
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
            <button class="btn btn-ghost" onclick="wfZoomIn()" title="Zoom in" data-tooltip-title="Zoom In" data-tooltip="Enlarge workflow canvas magnification (+)">+</button>
            <button class="btn btn-ghost" onclick="wfZoomOut()" title="Zoom out" data-tooltip-title="Zoom Out" data-tooltip="Reduce workflow canvas magnification (-)">−</button>
            <button class="btn btn-ghost" onclick="wfFitView()" title="Fit to view" data-tooltip-title="Fit to View" data-tooltip="Reset pan and zoom to fit entire graph on screen">Fit</button>
            <div class="wf-toolbar-sep"></div>
            <button class="btn btn-ghost" onclick="wfDeleteSelected()" title="Delete selected" data-tooltip-title="Delete Selected" data-tooltip="Remove currently selected node or connection">&#128465;</button>
            <button class="btn btn-ghost" onclick="wfClearCanvas()" title="Clear all" data-tooltip-title="Clear Canvas" data-tooltip="Clear all nodes and reset to empty graph">Clear</button>
            <div style="flex:1"></div>
            <span class="wf-toolbar-label" id="wf-node-count" data-tooltip-title="Node Count" data-tooltip="Total number of nodes placed on the canvas">0 nodes</span>
            <div class="wf-toolbar-sep"></div>
            <button class="btn btn-primary" onclick="wfRunWorkflow()" id="wf-run-btn" data-tooltip-title="Run Workflow" data-tooltip="Execute workflow DAG across configured providers">&#9654; Run</button>
            <span id="wf-run-status" role="status" aria-live="polite" class="wf-toolbar-label">Idle</span>
            <button class="btn btn-success" onclick="wfSaveWorkflow()" data-tooltip-title="Save Workflow" data-tooltip="Persist workflow topology and configuration">Save</button>
          </div>
          <div class="wf-body">
            <div class="wf-palette">
              <div class="wf-palette-section">
                <div class="wf-palette-title">Control</div>
                <div class="wf-palette-node" draggable="true" data-node-type="start" data-tooltip-title="Start Node" data-tooltip="Workflow entry point — initiates execution flow">
                  <div class="wf-palette-icon" style="background:var(--green)">&#9654;</div> Start
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="end" data-tooltip-title="End Node" data-tooltip="Workflow terminal — finalizes execution outputs">
                  <div class="wf-palette-icon" style="background:var(--red)">&#9632;</div> End
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="branch" data-tooltip-title="Branch Node" data-tooltip="Conditional router — forks execution into multiple paths">
                  <div class="wf-palette-icon" style="background:var(--yellow)">&#8901;</div> Branch
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="merge" data-tooltip-title="Merge Node" data-tooltip="Synchronizer — joins parallel execution branches">
                  <div class="wf-palette-icon" style="background:var(--orange)">M</div> Merge
                </div>
              </div>
              <div class="wf-palette-section">
                <div class="wf-palette-title">Agents & Routing</div>
                <div class="wf-palette-node" draggable="true" data-node-type="classifier" data-tooltip-title="Laya Classifier Node" data-tooltip="Local System 1 Laya classifier encapsulating tasks and routing to agents/sub-agents">
                  <div class="wf-palette-icon" style="background:#10b981">🧠</div> Laya Classifier
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="agent" data-tooltip-title="Agent Node" data-tooltip="Autonomous LLM agent executing tasks and reasoning">
                  <div class="wf-palette-icon" style="background:var(--accent2)">A</div> Agent
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="tiered_node" data-tooltip-title="Tiered Node" data-tooltip="Tiered agent node with dynamic T1 -> T2 failover">
                  <div class="wf-palette-icon" style="background:#8b5cf6">&#9889;</div> Tiered Node
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="judge" data-tooltip-title="Judge Node" data-tooltip="System 1 quality gate / decision evaluator (Laya / Jev)">
                  <div class="wf-palette-icon" style="background:#06b6d4">&#9878;</div> Judge Gate
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="sub_agent" data-tooltip-title="Sub-Agent Node" data-tooltip="Scoped delegate sub-agent for specialized subtasks">
                  <div class="wf-palette-icon" style="background:var(--purple)">S</div> Sub-Agent
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="ralph" data-tooltip-title="RALPH Loop Node" data-tooltip="Iterative Reason-Act-Learn-Plan-Handoff convergence loop">
                  <div class="wf-palette-icon" style="background:#d97706">R</div> RALPH Loop
                </div>
              </div>
              <div class="wf-palette-section">
                <div class="wf-palette-title">RAG</div>
                <div class="wf-palette-node" draggable="true" data-node-type="doc_loader" data-tooltip-title="Doc Loader Node" data-tooltip="Loads documents, text, code, or knowledge files">
                  <div class="wf-palette-icon" style="background:#6366f1">D</div> Doc Loader
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="embedder" data-tooltip-title="Embedder Node" data-tooltip="Computes vector embeddings for text and queries">
                  <div class="wf-palette-icon" style="background:#14b8a6">E</div> Embedder
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="vector_store" data-tooltip-title="Vector Store Node" data-tooltip="Stores and indexes high-dimensional vectors">
                  <div class="wf-palette-icon" style="background:#ec4899">V</div> Vector Store
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="retriever" data-tooltip-title="Retriever Node" data-tooltip="Finds nearest-neighbor chunks relevant to query">
                  <div class="wf-palette-icon" style="background:#f59e0b">R</div> Retriever
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="generator" data-tooltip-title="Generator Node" data-tooltip="Synthesizes responses using retrieved context and prompt">
                  <div class="wf-palette-icon" style="background:var(--accent2)">G</div> Generator
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="memory" data-tooltip-title="Memory Node" data-tooltip="Maintains working and conversation memory across steps">
                  <div class="wf-palette-icon" style="background:#8b5cf6">M</div> Memory
                </div>
              </div>
              <div class="wf-palette-section">
                <div class="wf-palette-title">Tools</div>
                <div class="wf-palette-node" draggable="true" data-node-type="llm_provider" data-tooltip-title="LLM Provider Node" data-tooltip="Direct interface to Claude, ChatGPT, Gemini, etc.">
                  <div class="wf-palette-icon" style="background:#10a37f">L</div> LLM Provider
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="tool" data-tooltip-title="Tool Node" data-tooltip="Custom tool or shell execution hook">
                  <div class="wf-palette-icon" style="background:var(--fg2)">T</div> Tool
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="http" data-tooltip-title="HTTP Node" data-tooltip="Makes HTTP REST / webhook requests">
                  <div class="wf-palette-icon" style="background:#0ea5e9">H</div> HTTP Request
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="code" data-tooltip-title="Code Node" data-tooltip="Executes custom code snippet or transform logic">
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
              <input id="wf-d-name" oninput="wfUpdateNodeProp('name', this.value)" data-tooltip-title="Node Name" data-tooltip="Display label and identifier for this workflow node">
              <label>Type</label>
              <input id="wf-d-type" disabled data-tooltip-title="Node Type" data-tooltip="Immutable node specification and port topology">
              <label>Provider</label>
              <select id="wf-d-provider" onchange="wfUpdateNodeProp('provider', this.value)" data-tooltip-title="Provider Assignment" data-tooltip="Pin node execution to a specific provider or use auto routing">
                <option value="">auto</option>
                <option value="gemini">Gemini (T1)</option>
                <option value="claude">Claude (T1)</option>
                <option value="codex">Codex subscription</option>
                <option value="chatgpt">ChatGPT (T1)</option>
                <option value="deepseek">DeepSeek (T2)</option>
                <option value="laya">Laya - Convai (Local Classifier)</option>
                <option value="jev">Jev - TypeSafe AI (Judge)</option>
                <option value="groq">Groq (T2)</option>
                <option value="mistral">Mistral AI (T2)</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama">Ollama (Local)</option>
                <option value="together">Together AI</option>
                <option value="qwen">Qwen (DashScope)</option>
                <option value="glm">GLM</option>
                <option value="kimi">Kimi</option>
              </select>
              <label>Tier</label>
              <select id="wf-d-tier" onchange="wfUpdateNodeProp('tier', this.value)" data-tooltip-title="Routing Tier" data-tooltip="Execution tier priority: T1 primary, T2 fallback, or Judge decision gate">
                <option value="">auto</option>
                <option value="t1">T1 (Primary)</option>
                <option value="t2">T2 (Fallback)</option>
                <option value="judge">Judge (Laya / Jev Gate)</option>
                <option value="classifier">Classifier (Task Encapsulation)</option>
              </select>
              <label>Fallback Provider</label>
              <select id="wf-d-fallback" onchange="wfUpdateNodeProp('fallback', this.value)" data-tooltip-title="Fallback Provider" data-tooltip="Secondary provider to failover to if primary errors or trips circuit breaker">
                <option value="">none</option>
                <option value="deepseek">DeepSeek (T2)</option>
                <option value="gemini">Gemini (T1)</option>
                <option value="laya">Laya (Local Classifier)</option>
                <option value="jev">Jev (Judge)</option>
                <option value="groq">Groq (T2)</option>
                <option value="mistral">Mistral (T2)</option>
                <option value="openrouter">OpenRouter</option>
                <option value="ollama">Ollama (Local)</option>
              </select>
              <label>System Prompt</label>
              <textarea id="wf-d-system" oninput="wfUpdateNodeProp('system', this.value)" placeholder="Optional system prompt..." data-tooltip-title="System Prompt" data-tooltip="Custom system instructions injected when this node runs"></textarea>
              <label>Config (JSON)</label>
              <textarea id="wf-d-config" oninput="wfUpdateNodeProp('config', this.value)" placeholder='{"temperature": 0.3}' data-tooltip-title="Node Configuration" data-tooltip="Optional JSON configuration parameters (e.g. temperature, max_tokens)"></textarea>
              <div style="margin-top:14px">
                <button class="btn btn-danger btn-sm" onclick="wfDeleteSelected()" style="width:100%" data-tooltip-title="Delete Node" data-tooltip="Permanently remove selected node and attached connections">Delete Node</button>
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
            <span id="routing-mode-badge" class="badge badge-gray" data-tooltip-title="Routing Mode" data-tooltip="Current routing backend: Embedded local router or OmniRoute gateway">embedded</span>
          </div>
          <div class="card-body">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px">
              <div>
                <label style="font-size:12px; color:var(--fg2)">Strategy</label>
                <select id="routing-strategy" style="width:100%; padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg); font-size:13px" data-tooltip-title="Routing Strategy" data-tooltip="Provider selection algorithm: Auto (scoring), Priority, Weighted, Round Robin, P2C, Least Used, Cost Optimized, LKGP, Fusion, Pipeline">
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
                <div style="display:flex; align-items:center; gap:8px; padding:6px 0" data-tooltip-title="OmniRoute Gateway" data-tooltip="Integration status with external OmniRoute high-availability LLM gateway">
                  <span id="omniroute-status-dot" style="width:10px; height:10px; border-radius:50%; background:#666; display:inline-block"></span>
                  <span id="omniroute-status-text" style="font-size:13px; color:var(--fg2)">Not configured</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card" data-tooltip-title="Circuit Breakers" data-tooltip="Fault-tolerance breakers monitoring provider errors, tripping open on failures to protect pipeline">
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
          <div class="card" data-tooltip-title="Cost Tracking" data-tooltip="Real-time accounting of API requests, token consumption, and dollar costs">
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

          <div class="card" data-tooltip-title="LKGP State" data-tooltip="Last Known Good Provider cache remembered across task types and modalities">
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
            <span id="task-badge" class="badge badge-gray" data-tooltip-title="Task Status" data-tooltip="Execution state: idle, running, completed, or failed">idle</span>
          </div>
          <div class="card-body">
            <div class="task-input-area">
              <div class="input-group">
                <label>Objective</label>
                <textarea id="objective" placeholder="Describe what you want done...&#10;e.g., Analyze the top 10 HN posts today" data-tooltip-title="Task Objective" data-tooltip="Goal or prompt for the autonomous agent to solve using available tools and providers"></textarea>
              </div>
              <div class="input-group">
                <label>Criteria (optional JSON)</label>
                <input type="text" id="criteria" placeholder='{"accuracy": true, "depth": 0.8}' data-tooltip-title="Acceptance Criteria" data-tooltip="Optional verification constraints and thresholds evaluated during the Learn phase">
              </div>
              <div class="task-actions">
                <button class="btn btn-primary btn-lg" id="run-btn" onclick="runTask()" data-tooltip-title="Run Task" data-tooltip="Start RALPH convergence loop to execute and verify objective">&#9654; Run</button>
                <button class="btn btn-danger" id="stop-btn" onclick="stopTask()" disabled data-tooltip-title="Stop Task" data-tooltip="Abort active task execution and park current iteration state">&#9632; Stop</button>
              </div>
            </div>
          </div>
        </div>

        <!-- RALPH Phase Stepper -->
        <div class="card" id="ralph-card" hidden data-tooltip-title="RALPH Loop" data-tooltip="Reason -> Act -> Learn -> Plan -> Handoff iterative convergence engine">
          <div class="card-header">
            <h2>RALPH Loop</h2>
            <span id="ralph-iteration" class="badge badge-purple" data-tooltip-title="Iteration Count" data-tooltip="Current loop iteration index">iteration 0</span>
          </div>
          <div class="card-body" style="padding:8px 16px 16px">
            <div class="ralph-stepper">
              <div class="ralph-phase" id="rp-reason" data-tooltip-title="Reason Phase" data-tooltip="Analyzes current task context and determines optimal execution approach">
                <div class="ralph-node idle" id="rn-reason">R</div>
                <div class="ralph-label">Reason</div>
              </div>
              <div class="ralph-connector" id="rc-ra"></div>
              <div class="ralph-phase" id="rp-act" data-tooltip-title="Act Phase" data-tooltip="Dispatches tool calls and prompts to selected LLM provider">
                <div class="ralph-node idle" id="rn-act">A</div>
                <div class="ralph-label">Act</div>
              </div>
              <div class="ralph-connector" id="rc-al"></div>
              <div class="ralph-phase" id="rp-learn" data-tooltip-title="Learn Phase" data-tooltip="Evaluates results against criteria, updates lessons learned, and computes confidence score">
                <div class="ralph-node idle" id="rn-learn">L</div>
                <div class="ralph-label">Learn</div>
              </div>
              <div class="ralph-connector" id="rc-lp"></div>
              <div class="ralph-phase" id="rp-plan" data-tooltip-title="Plan Phase" data-tooltip="Adjusts execution plan and determines next steps based on lessons learned">
                <div class="ralph-node idle" id="rn-plan">P</div>
                <div class="ralph-label">Plan</div>
              </div>
              <div class="ralph-connector" id="rc-ph"></div>
              <div class="ralph-phase" id="rp-handoff" data-tooltip-title="Handoff Phase" data-tooltip="Prepares final deliverable or hands off to next iteration if criteria not yet met">
                <div class="ralph-node idle" id="rn-handoff">H</div>
                <div class="ralph-label">Handoff</div>
              </div>
            </div>
            <div id="ralph-detail" style="font-size:12px; color:var(--fg2); text-align:center; margin-top:4px" data-tooltip-title="Phase Activity" data-tooltip="Live status message of the active RALPH phase"></div>
          </div>
        </div>

        <div class="card" id="progress-card" hidden data-tooltip-title="Confidence & Progress" data-tooltip="Convergence confidence percentage and step progression timeline">
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
            <button class="btn btn-sm btn-ghost" onclick="copyResult()" data-tooltip-title="Copy Output" data-tooltip="Copy the complete formatted task result to your clipboard">Copy</button>
          </div>
          <div class="card-body">
            <div id="result-text" style="white-space:pre-wrap; font-size:13px; line-height:1.6;"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Log</h2>
            <button class="btn btn-sm btn-ghost" onclick="clearLog()" data-tooltip-title="Clear Logs" data-tooltip="Empty all entries from the execution activity log">Clear</button>
          </div>
          <div class="card-body" style="padding:0">
            <div class="log-area" id="log"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Onboarding Demo Modal -->
<div id="onboarding-modal" class="onboarding-backdrop" onclick="onboardingBackdropClick(event)">
  <div class="onboarding-card">
    <div class="onboarding-header">
      <div class="onboarding-header-left">
        <span class="onboarding-step-badge" id="onboard-step-badge">Step 1 of 5</span>
        <h3 id="onboard-header-title">Welcome to OMA</h3>
      </div>
      <button class="onboarding-close" onclick="closeOnboarding(true)" title="Close Walkthrough">&times;</button>
    </div>
    <div class="onboarding-body" id="onboard-body">
      <!-- Slide 0: Welcome -->
      <div class="onboarding-slide active" id="onboard-slide-0">
        <div class="onboarding-hero">
          <div class="onboarding-hero-icon">&#128640;</div>
          <div class="onboarding-hero-text">
            <h4>Autonomous Multi-Agent Harness</h4>
            <p>Coordinate Claude, ChatGPT, Gemini, DeepSeek, and custom models in a unified, local-first execution environment with zero API markup.</p>
          </div>
        </div>
        <div class="onboarding-grid">
          <div class="onboarding-feature-item">
            <div class="title">&#128260; RALPH Loop</div>
            <div class="desc">Reason, Act, Learn, Plan, Handoff loop with self-correcting multi-attempt convergence.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#128272; Zero Markup</div>
            <div class="desc">Connect directly to your personal web subscription sessions or private API keys.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#9889; Resilient Routing</div>
            <div class="desc">10 smart routing strategies, self-healing circuit breakers, and cost accounting.</div>
          </div>
        </div>
        <div class="onboarding-highlight-box">
          &#10024; This quick tour will introduce model connections, visual workflows, smart routing, and let you run an interactive demo.
        </div>
      </div>

      <!-- Slide 1: Connect -->
      <div class="onboarding-slide" id="onboard-slide-1">
        <div class="onboarding-hero">
          <div class="onboarding-hero-icon">&#128274;</div>
          <div class="onboarding-hero-text">
            <h4>Connect Subscriptions &amp; Keys</h4>
            <p>Authenticate with zero vendor lock-in. Use your web subscriptions or enter standard API keys.</p>
          </div>
        </div>
        <div class="onboarding-grid">
          <div class="onboarding-feature-item">
            <div class="title">&#127760; Sessional Cookies</div>
            <div class="desc">Claude (<code>sessionKey</code>), ChatGPT (<code>session-token</code>), Gemini (<code>SNlM0e</code>).</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#128477; Direct API Keys</div>
            <div class="desc">OpenAI, Anthropic, DeepSeek, GLM, Moonshot Kimi, and OmniRoute gateway.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#128737; Encrypted Vault</div>
            <div class="desc">Owner-only (0600) local storage in <code>~/.oma/credentials.json</code>. Wipeable anytime.</div>
          </div>
        </div>
        <div class="onboarding-highlight-box">
          &#128161; Head to the <strong>Connect</strong> tab to configure your accounts, or enter keys via CLI with <code>oma auth add &lt;provider&gt; &lt;key&gt;</code>.
        </div>
      </div>

      <!-- Slide 2: Workflows -->
      <div class="onboarding-slide" id="onboard-slide-2">
        <div class="onboarding-hero">
          <div class="onboarding-hero-icon">&#127912;</div>
          <div class="onboarding-hero-text">
            <h4>Visual Workflow Studio (DAGs)</h4>
            <p>Compose custom multi-agent architectures visually on a freeform SVG canvas with draggable nodes and ports.</p>
          </div>
        </div>
        <div class="onboarding-grid">
          <div class="onboarding-feature-item">
            <div class="title">&#129513; 8 Node Types</div>
            <div class="desc">Agent, LLM Provider, Router, Sanitizer, Memory, Tool, Evaluator, and Condition nodes.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#128203; Built-in Templates</div>
            <div class="desc">RAG (Conversational &amp; Multi-Source), Multi-Agent Pipeline, Map-Reduce, and RALPH Loop.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#128640; Live Execution</div>
            <div class="desc">Run workflows directly with real-time visual step updates or export to JSON for sharing.</div>
          </div>
        </div>
        <div class="onboarding-highlight-box">
          &#128161; Check the <strong>Workflows</strong> tab toolbar templates dropdown to instantly instantiate pre-built pipelines.
        </div>
      </div>

      <!-- Slide 3: Routing -->
      <div class="onboarding-slide" id="onboard-slide-3">
        <div class="onboarding-hero">
          <div class="onboarding-hero-icon">&#9889;</div>
          <div class="onboarding-hero-text">
            <h4>Intelligent Routing &amp; Fault Tolerance</h4>
            <p>Automatically distribute workload across models and heal gracefully during rate limits or outages.</p>
          </div>
        </div>
        <div class="onboarding-grid">
          <div class="onboarding-feature-item">
            <div class="title">&#128256; 10 Strategies</div>
            <div class="desc">Priority, Weighted, Round-Robin, P2C, Least-Used, Cost-Optimized, LKGP, Auto, Fusion, Pipeline.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#128295; Circuit Breakers</div>
            <div class="desc">Auto-trips on repeated errors, probes via Half-Open state, and restores when healthy.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#128202; Cost &amp; Quota Tracking</div>
            <div class="desc">Real-time ledger tracking input/output tokens and expenditure per provider.</div>
          </div>
        </div>
        <div class="onboarding-highlight-box">
          &#128161; The <strong>Routing</strong> tab displays live health indicators, active circuit breakers, and cost analytics.
        </div>
      </div>

      <!-- Slide 4: Task & Demo -->
      <div class="onboarding-slide" id="onboard-slide-4">
        <div class="onboarding-hero">
          <div class="onboarding-hero-icon">&#129302;</div>
          <div class="onboarding-hero-text">
            <h4>Autonomous RALPH Execution</h4>
            <p>Watch OMA reason through objectives, learn from intermediate evaluations, and adapt plans until goals are met.</p>
          </div>
        </div>
        <div class="onboarding-grid">
          <div class="onboarding-feature-item">
            <div class="title">&#129504; Reason &amp; Act</div>
            <div class="desc">Analyzes criteria, selects provider strategy, and executes candidate solution.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#129327; Learn &amp; Plan</div>
            <div class="desc">Scores output, records lessons, and dynamically reorders provider fallback chains.</div>
          </div>
          <div class="onboarding-feature-item">
            <div class="title">&#128075; Handoff</div>
            <div class="desc">Parks gracefully on budget exhaustion or emits final verified output artifact.</div>
          </div>
        </div>
        <div class="onboarding-highlight-box" style="background:rgba(63,185,80,0.1); border-color:rgba(63,185,80,0.3);">
          &#128640; <strong>Ready to see it in action?</strong> Click <strong>Run Interactive Demo</strong> below to experience a live simulated RALPH execution right now!
        </div>
      </div>
    </div>
    <div class="onboarding-footer">
      <div class="onboarding-footer-left">
        <div class="onboarding-dots" id="onboard-dots">
          <div class="onboarding-dot active" onclick="goToOnboardingStep(0)"></div>
          <div class="onboarding-dot" onclick="goToOnboardingStep(1)"></div>
          <div class="onboarding-dot" onclick="goToOnboardingStep(2)"></div>
          <div class="onboarding-dot" onclick="goToOnboardingStep(3)"></div>
          <div class="onboarding-dot" onclick="goToOnboardingStep(4)"></div>
        </div>
        <label class="onboarding-checkbox-label">
          <input type="checkbox" id="onboard-dont-show" checked> Don't show again
        </label>
      </div>
      <div class="onboarding-footer-right">
        <button class="btn btn-sm btn-ghost" onclick="closeOnboarding(true)" id="onboard-btn-skip">Skip Tour</button>
        <button class="btn btn-sm btn-ghost" onclick="prevOnboardingStep()" id="onboard-btn-prev" disabled>Back</button>
        <button class="btn btn-sm btn-primary" onclick="nextOnboardingStep()" id="onboard-btn-next">Next</button>
      </div>
    </div>
  </div>
</div>

<script src="/dashboard.js"></script>
</body>
</html>`;
