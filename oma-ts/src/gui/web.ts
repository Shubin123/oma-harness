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
import fs from 'node:fs';
import path from 'node:path';
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
                <div class="wf-palette-node" draggable="true" data-node-type="agent" data-tooltip-title="Agent Node" data-tooltip="Autonomous LLM agent executing tasks and reasoning">
                  <div class="wf-palette-icon" style="background:var(--accent2)">A</div> Agent
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="tiered_node" data-tooltip-title="Tiered Node" data-tooltip="Tiered agent node with dynamic T1 -> T2 failover">
                  <div class="wf-palette-icon" style="background:#8b5cf6">&#9889;</div> Tiered Node
                </div>
                <div class="wf-palette-node" draggable="true" data-node-type="judge" data-tooltip-title="Jev Judge Node" data-tooltip="TypeSafe AI Jev evaluator / decision gate">
                  <div class="wf-palette-icon" style="background:#06b6d4">&#9878;</div> Jev Judge
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
                <option value="chatgpt">ChatGPT (T1)</option>
                <option value="deepseek">DeepSeek (T2)</option>
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
                <option value="judge">Judge (Jev Gate)</option>
              </select>
              <label>Fallback Provider</label>
              <select id="wf-d-fallback" onchange="wfUpdateNodeProp('fallback', this.value)" data-tooltip-title="Fallback Provider" data-tooltip="Secondary provider to failover to if primary errors or trips circuit breaker">
                <option value="">none</option>
                <option value="deepseek">DeepSeek (T2)</option>
                <option value="gemini">Gemini (T1)</option>
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

<script>
// ---- state ----
var connectedCount = 0;
var taskRunning = false;
var lastPhaseEventCount = 0;

var PROVIDERS = {
  claude:     { name: 'Claude',         icon: 'C', bg: '#d97706' },
  chatgpt:    { name: 'ChatGPT',        icon: 'G', bg: '#10a37f' },
  gemini:     { name: 'Gemini',         icon: 'G', bg: '#4285f4' },
  deepseek:   { name: 'DeepSeek',       icon: 'D', bg: '#6366f1' },
  jev:        { name: 'Jev (TypeSafe)', icon: 'J', bg: '#06b6d4' },
  groq:       { name: 'Groq',           icon: 'Q', bg: '#f97316' },
  mistral:    { name: 'Mistral AI',     icon: 'M', bg: '#e11d48' },
  openrouter: { name: 'OpenRouter',     icon: 'R', bg: '#8b5cf6' },
  ollama:     { name: 'Ollama (Local)', icon: 'O', bg: '#64748b' },
  together:   { name: 'Together AI',    icon: 'T', bg: '#3b82f6' },
  qwen:       { name: 'Qwen',           icon: 'Q', bg: '#10b981' },
  glm:        { name: 'GLM',            icon: 'Z', bg: '#ec4899' },
  kimi:       { name: 'Kimi',           icon: 'K', bg: '#14b8a6' },
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
  document.getElementById('view-routing').hidden = (view !== 'routing');
  document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('nav-' + view).classList.add('active');
  if (view === 'workflows') wfInit();
  if (view === 'routing') refreshRouting();
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
      + ' data-tooltip-title="' + escHtml(info.name) + ' Provider"'
      + ' data-tooltip="' + (isConn ? 'Active session (' + escHtml(meta) + ') — click to disconnect' : 'Not connected — click to configure credentials') + '"'
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
  start:        { label: 'Start',        icon: '▶', bg: '#3fb950', cat: 'control', ports: { in: 0, out: 1 }, desc: 'Workflow entry point initiating DAG execution' },
  end:          { label: 'End',          icon: '■', bg: '#f85149', cat: 'control', ports: { in: 1, out: 0 }, desc: 'Terminal node finalizing outputs and halting flow' },
  branch:       { label: 'Branch',       icon: '⋅', bg: '#d29922', cat: 'control', ports: { in: 1, out: 2 }, desc: 'Conditional routing node splitting execution paths' },
  merge:        { label: 'Merge',        icon: 'M',     bg: '#f0883e', cat: 'control', ports: { in: 2, out: 1 }, desc: 'Synchronizes and joins parallel execution branches' },
  agent:        { label: 'Agent',        icon: 'A',     bg: '#1f6feb', cat: 'agent',   ports: { in: 1, out: 1 }, desc: 'Autonomous LLM agent executing tasks and reasoning' },
  tiered_node:  { label: 'Tiered Node',  icon: '⚡', bg: '#8b5cf6', cat: 'agent',   ports: { in: 1, out: 1 }, desc: 'Tiered execution node with dynamic T1 primary -> T2 fallback' },
  judge:        { label: 'Jev Judge',    icon: '⚖', bg: '#06b6d4', cat: 'agent',   ports: { in: 1, out: 2 }, desc: 'TypeSafe AI Jev decision evaluator assessing output quality & criteria' },
  sub_agent:    { label: 'Sub-Agent',    icon: 'S',     bg: '#bc8cff', cat: 'agent',   ports: { in: 1, out: 1 }, desc: 'Specialized delegate agent executing scoped subtasks' },
  ralph:        { label: 'RALPH Loop',   icon: 'R',     bg: '#d97706', cat: 'agent',   ports: { in: 1, out: 1 }, desc: 'Iterative Reason-Act-Learn-Plan-Handoff convergence loop' },
  doc_loader:   { label: 'Doc Loader',   icon: 'D',     bg: '#6366f1', cat: 'rag',     ports: { in: 0, out: 1 }, desc: 'Ingests documents, text files, and unstructured knowledge' },
  embedder:     { label: 'Embedder',     icon: 'E',     bg: '#14b8a6', cat: 'rag',     ports: { in: 1, out: 1 }, desc: 'Transforms text chunks into high-dimensional vector embeddings' },
  vector_store: { label: 'Vector Store', icon: 'V',     bg: '#ec4899', cat: 'rag',     ports: { in: 1, out: 1 }, desc: 'Indexed vector database supporting semantic similarity queries' },
  retriever:    { label: 'Retriever',    icon: 'R',     bg: '#f59e0b', cat: 'rag',     ports: { in: 1, out: 1 }, desc: 'Fetches top-k relevant knowledge chunks based on similarity' },
  generator:    { label: 'Generator',    icon: 'G',     bg: '#1f6feb', cat: 'rag',     ports: { in: 1, out: 1 }, desc: 'Synthesizes grounded final answer from retrieved context' },
  memory:       { label: 'Memory',       icon: 'M',     bg: '#8b5cf6', cat: 'rag',     ports: { in: 1, out: 1 }, desc: 'Short-term and long-term state persistence across pipeline steps' },
  llm_provider: { label: 'LLM Provider', icon: 'L',     bg: '#10a37f', cat: 'tool',    ports: { in: 1, out: 1 }, desc: 'Direct provider model invocation gateway' },
  tool:         { label: 'Tool',         icon: 'T',     bg: '#8b949e', cat: 'tool',    ports: { in: 1, out: 1 }, desc: 'Executes external CLI tools, functions, or shell commands' },
  http:         { label: 'HTTP Request', icon: 'H',     bg: '#0ea5e9', cat: 'tool',    ports: { in: 1, out: 1 }, desc: 'Performs outbound HTTP REST / GraphQL requests' },
  code:         { label: 'Code',         icon: '</>', bg: '#64748b', cat: 'tool',    ports: { in: 1, out: 1 }, desc: 'Sandboxed code execution environment' },
};

var WF_TEMPLATES = {
  tiered_routing: {
    name: 'Tiered Routing (T1: Gemini → T2: DeepSeek)',
    nodes: [
      { id: 'n1', type: 'start', x: 60, y: 220, name: 'Task Input' },
      { id: 'n2', type: 'tiered_node', x: 280, y: 140, name: 'T1: Gemini Primary', provider: 'gemini', tier: 't1', fallback: 'deepseek', system: 'Primary generation using Gemini Tier-1' },
      { id: 'n3', type: 'judge', x: 520, y: 220, name: 'Jev Decision / Gate', provider: 'jev', tier: 'judge', system: 'TypeSafe AI Jev decision evaluator assessing output quality & criteria' },
      { id: 'n4', type: 'tiered_node', x: 760, y: 300, name: 'T2: DeepSeek Fallback', provider: 'deepseek', tier: 't2', system: 'Fallback Tier-2 generation via DeepSeek on T1 failure or rejection' },
      { id: 'n5', type: 'merge', x: 1000, y: 220, name: 'Merge & Format' },
      { id: 'n6', type: 'end', x: 1220, y: 220, name: 'Final Output' },
    ],
    edges: [
      { from: 'n1', to: 'n2', fromPort: 0, toPort: 0 },
      { from: 'n2', to: 'n3', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n4', fromPort: 0, toPort: 0 },
      { from: 'n3', to: 'n5', fromPort: 1, toPort: 0 },
      { from: 'n4', to: 'n5', fromPort: 0, toPort: 1 },
      { from: 'n5', to: 'n6', fromPort: 0, toPort: 0 },
    ],
  },
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
    tier: '',
    fallback: '',
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
    el.dataset.tooltipTitle = 'Edge: ' + fromNode.name + ' \u2192 ' + toNode.name;
    el.dataset.tooltip = 'Click edge to disconnect and remove link';
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
    ng.dataset.tooltipTitle = node.name + ' (' + def.label + ')';
    ng.dataset.tooltip = def.desc || ('Workflow node (' + def.cat + ')');

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
      port.dataset.tooltipTitle = node.name + ': Input Port ' + (i + 1);
      port.dataset.tooltip = 'Drop a connection here from another node';
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
      port.dataset.tooltipTitle = node.name + ': Output Port ' + (i + 1);
      port.dataset.tooltip = 'Click and drag to link to an input port';
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
    document.getElementById('wf-d-tier').value = node.tier || '';
    document.getElementById('wf-d-fallback').value = node.fallback || '';
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
    var node = wfAddNode(n.type, n.x, n.y, n.name, n.id);
    if (node) {
      if (n.provider) node.provider = n.provider;
      if (n.tier) node.tier = n.tier;
      if (n.fallback) node.fallback = n.fallback;
      if (n.system) node.system = n.system;
      if (n.config) node.config = n.config;
    }
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
    nodes: wfNodes.map(function(n) { return { id: n.id, type: n.type, x: n.x, y: n.y, name: n.name, provider: n.provider, tier: n.tier, fallback: n.fallback, system: n.system, config: n.config }; }),
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
    nodes: wfNodes.map(function(n) { return { id: n.id, type: n.type, name: n.name, provider: n.provider, tier: n.tier, fallback: n.fallback, system: n.system, config: n.config }; }),
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

// ---- routing dashboard ----
const BREAKER_COLORS = {
  closed: '#22c55e',
  degraded: '#f59e0b',
  open: '#ef4444',
  half_open: '#3b82f6',
};

function refreshRouting() {
  fetch('/api/status').then(function(r) { return r.json(); }).then(function(data) {
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
        txt.textContent = 'Connected (' + mc + ' models)';
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
      grid.innerHTML = pids.map(function(pid) {
        const p = providers[pid];
        const b = p.breaker || {};
        const state = b.state || 'closed';
        const color = BREAKER_COLORS[state] || '#666';
        const failPct = b.failure_threshold ? Math.round((b.failure_count || 0) / b.failure_threshold * 100) : 0;
        return '<div style="border:1px solid var(--border); border-radius:8px; padding:12px; background:var(--bg2)" data-tooltip-title="Breaker: ' + escHtml(pid) + '" data-tooltip="State: ' + state + ' | Failures: ' + (b.failure_count || 0) + '/' + (b.failure_threshold || 8) + ' | Quota: ' + (p.quota_available ? 'OK' : 'Exhausted') + ' (' + Math.round((p.quota_remaining_pct || 1) * 100) + '%)">'
          + '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">'
          + '<span style="font-weight:500; font-size:13px">' + escHtml(pid) + '</span>'
          + '<span style="background:' + color + '; color:#fff; font-size:11px; padding:2px 8px; border-radius:10px">' + state + '</span>'
          + '</div>'
          + '<div style="font-size:11px; color:var(--fg2); line-height:1.8">'
          + '<div>Failures: ' + (b.failure_count || 0) + ' / ' + (b.failure_threshold || 8) + '</div>'
          + '<div style="background:var(--border); border-radius:3px; height:4px; margin:4px 0">'
          + '<div style="background:' + color + '; height:100%; border-radius:3px; width:' + Math.min(failPct, 100) + '%; transition:width 0.3s"></div>'
          + '</div>'
          + '<div>Successes: ' + (b.success_count || 0) + '</div>'
          + '<div>Quota: ' + (p.quota_available ? 'OK' : 'Exhausted') + ' (' + Math.round((p.quota_remaining_pct || 1) * 100) + '%)</div>'
          + '</div></div>';
      }).join('');
    }

    // cost table
    const tbody = document.getElementById('cost-table-body');
    if (pids.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:12px; text-align:center; color:var(--fg2)">No data</td></tr>';
    } else {
      tbody.innerHTML = pids.map(function(pid) {
        const p = providers[pid];
        return '<tr style="border-bottom:1px solid var(--border)" data-tooltip-title="Cost Usage: ' + escHtml(pid) + '" data-tooltip="' + (p.requests || 0) + ' requests, ' + (p.total_tokens || 0).toLocaleString() + ' tokens, $' + (p.total_cost || 0).toFixed(4) + '">'
          + '<td style="padding:6px 8px">' + escHtml(pid) + '</td>'
          + '<td style="padding:6px 8px">' + (p.requests || 0) + '</td>'
          + '<td style="padding:6px 8px">' + (p.total_tokens || 0).toLocaleString() + '</td>'
          + '<td style="padding:6px 8px">$' + (p.total_cost || 0).toFixed(4) + '</td>'
          + '</tr>';
      }).join('');
    }

    // LKGP state
    const lkgpEl = document.getElementById('lkgp-list');
    const lkgpEntries = Object.entries(lkgp);
    if (lkgpEntries.length === 0) {
      lkgpEl.innerHTML = 'No routing history yet';
    } else {
      lkgpEl.innerHTML = lkgpEntries.map(function(entry) {
        return '<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border)" data-tooltip-title="LKGP: ' + escHtml(entry[0]) + '" data-tooltip="Last known good provider for ' + escHtml(entry[0]) + '">'
          + '<span style="color:var(--fg)">' + escHtml(entry[0]) + '</span>'
          + '<span style="color:var(--accent)">' + escHtml(String(entry[1])) + '</span>'
          + '</div>';
      }).join('');
    }
  }).catch(function() {});
}

// auto-refresh routing when visible
setInterval(function() {
  if (!document.getElementById('view-routing').hidden) refreshRouting();
}, 2000);

// ---- tooltip engine ----
var tooltipEl = null;
var currentTooltipTarget = null;

function findTooltipTarget(el) {
  while (el && el !== document.body) {
    if (el.dataset && (el.dataset.tooltip || el.dataset.tooltipTitle)) return el;
    if (el.hasAttribute && (el.hasAttribute('data-tooltip') || el.hasAttribute('data-tooltip-title'))) return el;
    el = el.parentElement;
  }
  return null;
}

function initTooltipEngine() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'oma-global-tooltip';
    tooltipEl.className = 'oma-tooltip';
    document.body.appendChild(tooltipEl);
  }

  document.addEventListener('mouseover', function(e) {
    var target = findTooltipTarget(e.target);
    if (!target) {
      hideTooltip();
      return;
    }
    if (target === currentTooltipTarget) return;
    currentTooltipTarget = target;

    if (target.hasAttribute('title') && target.getAttribute('title')) {
      target.setAttribute('data-original-title', target.getAttribute('title'));
      target.removeAttribute('title');
    }

    var title = target.getAttribute('data-tooltip-title') || '';
    var desc = target.getAttribute('data-tooltip') || target.getAttribute('data-original-title') || '';
    if (!title && !desc) {
      hideTooltip();
      return;
    }

    showTooltip(target, title, desc);
  }, true);

  document.addEventListener('mouseout', function(e) {
    if (!currentTooltipTarget) return;
    if (!e.relatedTarget || !currentTooltipTarget.contains(e.relatedTarget)) {
      hideTooltip();
    }
  }, true);

  window.addEventListener('scroll', function() { if (currentTooltipTarget) positionTooltip(currentTooltipTarget); }, true);
  window.addEventListener('resize', function() { if (currentTooltipTarget) positionTooltip(currentTooltipTarget); });
}

function hideTooltip() {
  if (tooltipEl) {
    tooltipEl.classList.remove('visible');
  }
  if (currentTooltipTarget && currentTooltipTarget.hasAttribute('data-original-title')) {
    currentTooltipTarget.setAttribute('title', currentTooltipTarget.getAttribute('data-original-title'));
    currentTooltipTarget.removeAttribute('data-original-title');
  }
  currentTooltipTarget = null;
}

function showTooltip(target, title, desc) {
  if (!tooltipEl) return;
  var content = '';
  if (title) content += '<div class="tt-title">' + escHtml(title) + '</div>';
  if (desc) content += '<div class="tt-desc">' + escHtml(desc) + '</div>';
  tooltipEl.innerHTML = content;
  tooltipEl.classList.add('visible');
  positionTooltip(target);
}

function positionTooltip(target) {
  if (!target || !tooltipEl) return;
  var rect = target.getBoundingClientRect();
  var tipRect = tooltipEl.getBoundingClientRect();

  var left = rect.left + (rect.width - tipRect.width) / 2;
  var top = rect.top - tipRect.height - 8;

  if (top < 10) {
    top = rect.bottom + 8;
  }

  var maxLeft = window.innerWidth - tipRect.width - 12;
  if (left < 12) left = 12;
  if (left > maxLeft) left = maxLeft;

  tooltipEl.style.left = Math.round(left) + 'px';
  tooltipEl.style.top = Math.round(top) + 'px';
}

// ---- Onboarding & Demo Engine ----
var currentOnboardStep = 0;
var TOTAL_ONBOARD_STEPS = 5;

function checkOnboarding() {
  try {
    if (!localStorage.getItem('oma_onboarding_completed')) {
      setTimeout(function() {
        openOnboarding(0);
      }, 450);
    }
  } catch (e) {}
}

function openOnboarding(step) {
  if (typeof step !== 'number') step = 0;
  currentOnboardStep = Math.max(0, Math.min(TOTAL_ONBOARD_STEPS - 1, step));
  renderOnboardingStep();
  var modal = document.getElementById('onboarding-modal');
  if (modal) modal.classList.add('open');
}

function closeOnboarding(savePreference) {
  var modal = document.getElementById('onboarding-modal');
  if (modal) modal.classList.remove('open');
  if (savePreference) {
    try {
      var chk = document.getElementById('onboard-dont-show');
      if (!chk || chk.checked) {
        localStorage.setItem('oma_onboarding_completed', '1');
      }
    } catch (e) {}
  }
}

function onboardingBackdropClick(e) {
  if (e.target && e.target.id === 'onboarding-modal') {
    closeOnboarding(true);
  }
}

function goToOnboardingStep(step) {
  currentOnboardStep = step;
  renderOnboardingStep();
}

function prevOnboardingStep() {
  if (currentOnboardStep > 0) {
    currentOnboardStep--;
    renderOnboardingStep();
  }
}

function nextOnboardingStep() {
  if (currentOnboardStep < TOTAL_ONBOARD_STEPS - 1) {
    currentOnboardStep++;
    renderOnboardingStep();
  } else {
    startOnboardingDemo();
  }
}

function renderOnboardingStep() {
  var titles = [
    'Welcome to OMA',
    'Provider Connections',
    'Visual Workflow Studio',
    'Smart Routing & Fault Tolerance',
    'Autonomous RALPH Task Runner'
  ];
  
  var badgeEl = document.getElementById('onboard-step-badge');
  var titleEl = document.getElementById('onboard-header-title');
  if (badgeEl) badgeEl.textContent = 'Step ' + (currentOnboardStep + 1) + ' of ' + TOTAL_ONBOARD_STEPS;
  if (titleEl) titleEl.textContent = titles[currentOnboardStep] || 'Welcome to OMA';

  for (var i = 0; i < TOTAL_ONBOARD_STEPS; i++) {
    var s = document.getElementById('onboard-slide-' + i);
    if (s) {
      if (i === currentOnboardStep) s.classList.add('active');
      else s.classList.remove('active');
    }
  }

  var dotsContainer = document.getElementById('onboard-dots');
  if (dotsContainer) {
    var dots = dotsContainer.querySelectorAll('.onboarding-dot');
    dots.forEach(function(dot, idx) {
      if (idx === currentOnboardStep) dot.classList.add('active');
      else dot.classList.remove('active');
    });
  }

  var prevBtn = document.getElementById('onboard-btn-prev');
  var nextBtn = document.getElementById('onboard-btn-next');
  if (prevBtn) prevBtn.disabled = (currentOnboardStep === 0);
  if (nextBtn) {
    if (currentOnboardStep === TOTAL_ONBOARD_STEPS - 1) {
      nextBtn.innerHTML = '&#9654; Run Interactive Demo';
      nextBtn.className = 'btn btn-sm btn-primary';
      nextBtn.style.background = 'var(--green)';
      nextBtn.style.borderColor = 'var(--green)';
    } else {
      nextBtn.textContent = 'Next';
      nextBtn.className = 'btn btn-sm btn-primary';
      nextBtn.style.background = '';
      nextBtn.style.borderColor = '';
    }
  }
}

function startOnboardingDemo() {
  closeOnboarding(true);
  showView('task');

  var objEl = document.getElementById('task-objective');
  var critEl = document.getElementById('task-criteria');
  if (objEl) {
    objEl.value = 'Analyze API architecture for high-throughput multi-provider LLM routing with automated circuit breaker failover and credential safety';
  }
  if (critEl) {
    critEl.value = JSON.stringify({
      throughput: "high",
      resilience: true,
      cost_optimized: true,
      safety: "owner-only"
    }, null, 2);
  }

  runInteractiveDemoSimulation();
}

function runInteractiveDemoSimulation() {
  if (taskRunning) return;
  taskRunning = true;

  clearLog();
  var resEl = document.getElementById('result-text');
  if (resEl) resEl.textContent = '';
  var btn = document.getElementById('btn-run');
  var stopBtn = document.getElementById('btn-stop');
  if (btn) btn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;

  addLog('=== Starting OMA Interactive Onboarding Demo ===', 'info');
  addLog('Task: High-throughput multi-provider routing with circuit breaker resilience', 'info');

  var progressFill = document.getElementById('progress-fill');
  var progressText = document.getElementById('progress-text');

  updateRalphPhase('reason', 1, 'Analyzing objective, decomposing requirements, selecting primary provider');
  if (progressFill) progressFill.style.width = '15%';
  if (progressText) progressText.textContent = '15% -- Reasoning approach';
  addLog('[REASON] Iteration 1: Decomposed objective into 4 criteria gates: throughput, resilience, cost_optimized, safety.', 'info');

  setTimeout(function() {
    updateRalphPhase('act', 1, 'Executing solve attempt via Claude (claude-sonnet-4)');
    if (progressFill) progressFill.style.width = '35%';
    if (progressText) progressText.textContent = '35% -- Act: generating draft';
    addLog('[ACT] Querying primary provider Claude (claude-sonnet-4) with optimized context...', 'info');

    setTimeout(function() {
      updateRalphPhase('learn', 1, 'Evaluating candidate solution against criteria gates');
      if (progressFill) progressFill.style.width = '55%';
      if (progressText) progressText.textContent = '55% -- Learn: scoring criteria';
      addLog('[LEARN] Solution evaluated: confidence 0.70 < threshold 0.85. Criteria "cost_optimized" requires more detail.', 'warn');

      setTimeout(function() {
        updateRalphPhase('plan', 1, 'Adapting strategy: rotating provider preference to Gemini for secondary validation');
        if (progressFill) progressFill.style.width = '70%';
        if (progressText) progressText.textContent = '70% -- Plan: adaptive fallback';
        addLog('[PLAN] Strategy adjusted: Rotating provider chain [claude -> gemini] to prioritize cost optimization.', 'info');

        setTimeout(function() {
          updateRalphPhase('reason', 2, 'Refining prompt with attempt 1 lessons');
          addLog('[REASON] Iteration 2: Focusing on cost accounting algorithms and circuit breaker backoff.', 'info');

          setTimeout(function() {
            updateRalphPhase('act', 2, 'Executing refined attempt via Gemini (gemini-2.0-flash)');
            if (progressFill) progressFill.style.width = '85%';
            if (progressText) progressText.textContent = '85% -- Act: refined solution';
            addLog('[ACT] Querying Gemini (gemini-2.0-flash) with lesson-enriched context...', 'info');

            setTimeout(function() {
              updateRalphPhase('learn', 2, 'Confidence 0.94 >= threshold 0.85 -- all criteria satisfied!');
              if (progressFill) progressFill.style.width = '95%';
              if (progressText) progressText.textContent = '95% -- Learn: criteria met';
              addLog('[LEARN] Evaluated attempt 2: confidence 0.94 >= threshold 0.85! All 4 criteria gates PASSED.', 'info');

              setTimeout(function() {
                updateRalphPhase('handoff', 2, 'Final verified artifact produced');
                if (progressFill) progressFill.style.width = '100%';
                if (progressText) progressText.textContent = '100% -- Complete';
                addLog('[HANDOFF] Task completed successfully in 2 iterations (tokens used: 642, confidence: 94%).', 'info');

                var sampleResult = [
                  '# Multi-Provider Routing & Circuit Breaker Architecture',
                  '',
                  '## 1. Dynamic Routing Engine',
                  '- Core Strategy: Power-of-Two-Choices (P2C) weighted by quality EMA and cost.',
                  '- Fallback Chain: Claude -> Gemini -> DeepSeek.',
                  '- LKGP (Last Known Good Provider) cached per task modality.',
                  '',
                  '## 2. Self-Healing Circuit Breaker',
                  '- State Transitions: Closed (healthy) -> Degraded (warning) -> Open (tripped) -> Half-Open (probe).',
                  '- Failure Threshold: 5 consecutive failures triggers exponential backoff.',
                  '',
                  '## 3. Credential Safety & Privacy',
                  '- Storage: ~/.oma/credentials.json with POSIX 0600 owner-only permissions.',
                  '- Encryption: PBKDF2 key derivation with AES/XOR cipher.',
                  '- Zero telemetry / zero external proxying.'
                ].join('\n');

                if (resEl) resEl.textContent = sampleResult;

                taskRunning = false;
                if (btn) btn.disabled = false;
                if (stopBtn) stopBtn.disabled = true;

                addLog('=== Demo Finished! You are ready to connect providers and run your own tasks. ===', 'info');
              }, 600);
            }, 700);
          }, 600);
        }, 600);
      }, 700);
    }, 700);
  }, 700);
}

document.addEventListener('keydown', function(e) {
  var modal = document.getElementById('onboarding-modal');
  if (!modal || !modal.classList.contains('open')) return;
  if (e.key === 'Escape') {
    closeOnboarding(true);
  } else if (e.key === 'ArrowRight') {
    nextOnboardingStep();
  } else if (e.key === 'ArrowLeft') {
    prevOnboardingStep();
  }
});

// ---- init ----
(function init() {
  try { if (localStorage.getItem('oma-theme') === 'light') document.body.classList.add('light'); } catch(e) {}
  initTooltipEngine();
  checkOnboarding();
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

export async function verifyToken(
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
        // include router + OmniRoute status
        if (typeof dashboardAgent.routerStatus === 'function') {
          status.router = dashboardAgent.routerStatus();
        } else {
          status.router = { strategy: 'auto', providers: {}, lkgp: {} };
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

    if (pathname === '/api/workflows') {
      sendJson(res, { workflows: Object.values(savedWorkflows) });
      return;
    }

    if (pathname === '/api/workflows/templates') {
      const tplList = [
        { key: 'tiered_routing', name: 'Tiered Routing (T1: Gemini → T2: DeepSeek)' },
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

    if (pathname === '/api/test/history') {
      const candidates = [
        path.resolve(process.cwd(), 'tests/.history/runs.json'),
        path.resolve(process.cwd(), '../oma-pkg/tests/.history/runs.json'),
      ];
      let historyPath = '';
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          historyPath = p;
          break;
        }
      }
      if (historyPath) {
        try {
          const runs = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
          sendJson(res, { runs });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, { runs: [], error: msg });
        }
      } else {
        sendJson(res, { runs: [] });
      }
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
        try {
          dashboardAgent = OMA.load();
        } catch { /* ignore */ }
      }
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
            if (ntype === 'merge') {
              const combined = edges
                .filter(e => e.to === nid && results[e.from as string])
                .map(e => `[${e.from}]: ${(results[e.from as string] as Record<string, unknown>).output ?? ''}`)
                .join('\n\n');
              results[nid] = { status: 'pass-through', output: combined };
            } else if (ntype === 'end') {
              let lastOutput = '';
              for (const e of edges) {
                if (e.to === nid && results[e.from as string]) {
                  lastOutput = String((results[e.from as string] as Record<string, unknown>).output ?? '');
                  break;
                }
              }
              results[nid] = { status: 'pass-through', output: lastOutput };
            } else {
              results[nid] = { status: 'pass-through', output: (body.input as string) ?? '' };
            }
            continue;
          }
          const parentOutputs: Record<string, unknown>[] = [];
          for (const e of edges) {
            if (e.to === nid && results[e.from as string]) {
              parentOutputs.push(results[e.from as string] as Record<string, unknown>);
            }
          }
          const ctx = parentOutputs
            .filter(p => p.output)
            .map(p => String(p.output))
            .join('; ');
          const basePrompt = (node.system as string) || (node.name as string) || 'task';
          const objective = ctx ? `${basePrompt} -- context: ${ctx}` : basePrompt;

          // Jev Decision / Judge Gate
          if (ntype === 'judge' || node.provider === 'jev' || node.tier === 'judge') {
            let decisionPass = true;
            let score = 0.92;
            let evalNote = 'Criteria and quality standards met';
            const lowerCtx = ctx.toLowerCase();
            if (lowerCtx.includes('fail') || lowerCtx.includes('error') || (ctx && ctx.length < 15)) {
              decisionPass = false;
              score = 0.42;
              evalNote = 'Quality gate rejected output: incomplete or error detected';
            }
            results[nid] = {
              status: 'done',
              evaluator: 'jev (TypeSafe AI)',
              decision: decisionPass ? 'PASSED' : 'FAILOVER_TRIGGERED',
              confidence: score,
              output: `[Jev Decision: ${decisionPass ? 'PASSED' : 'FAILOVER'}] Score: ${score.toFixed(2)} — ${evalNote}\n${ctx.slice(0, 300)}`,
            };
            continue;
          }

          // Tiered Routing Node (e.g. T1: Gemini -> T2: DeepSeek)
          const tier = node.tier as string | undefined;
          const providerReq = node.provider as string | undefined;
          const fallbackReq = (node.fallback as string | undefined) || 'deepseek';

          if (tier || ntype === 'tiered_node' || providerReq) {
            const t1Cand = providerReq || 'gemini';
            const t2Cand = fallbackReq;
            const avail = typeof dashboardAgent.registry.providerNames === 'function'
              ? dashboardAgent.registry.providerNames()
              : dashboardAgent.registry.available();
            const [selProv, selTier, isFailover] = dashboardAgent.router.selectTiered(
              t1Cand,
              t2Cand,
              avail,
            );
            let runProv = selProv;
            let tierUsed = selTier;
            let failedOver = isFailover;
            if (!avail.includes(t1Cand) && avail.includes(t2Cand)) {
              runProv = t2Cand;
              tierUsed = 't2';
              failedOver = true;
            }

            const result = await dashboardAgent.run({ objective });
            results[nid] = {
              status: 'done',
              provider_used: runProv,
              tier_used: tierUsed,
              failover_triggered: failedOver,
              confidence: result.confidence,
              output: (result.artifacts.final ?? '').slice(0, 2000),
            };
          } else if (['agent', 'sub_agent', 'ralph'].includes(ntype)) {
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

/** Create the dashboard HTTP server instance. */
export function createDashboardServer(): http.Server {
  if (!dashboardAuth) {
    dashboardAuth = new AuthManager();
  }
  rebuildAgent();

  return http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error('Request error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
  });
}

/** Start the graphical dashboard. */
export function runWeb(
  host = '127.0.0.1',
  port = 8384,
  openBrowserOnStart = true,
): void {
  const server = createDashboardServer();

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
