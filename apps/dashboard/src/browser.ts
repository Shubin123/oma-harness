// @ts-nocheck
// Legacy dashboard interactions; new storage and delivery modules are strictly typed.
import { BrowserProjects } from "./storage.js";
import {
  createProject,
  appendMessage,
  applyCommand,
  conversationMessages,
  newId,
  migrateProject,
} from "@oma/shared";
import { LayaClassifier } from "@oma/core/core/layaClassifier";

// ---- state ----
var connectedCount = 0;
var taskRunning = false;
var lastPhaseEventCount = 0;

var PROVIDERS = {
  codex: { name: "Codex subscription", icon: "O", bg: "#10a37f" },
  claude: { name: "Claude", icon: "C", bg: "#d97706" },
  chatgpt: { name: "ChatGPT", icon: "G", bg: "#10a37f" },
  gemini: { name: "Gemini", icon: "G", bg: "#4285f4" },
  deepseek: { name: "DeepSeek", icon: "D", bg: "#6366f1" },
  laya: { name: "Laya (Convai)", icon: "L", bg: "#10b981" },
  jev: { name: "Jev (TypeSafe)", icon: "J", bg: "#06b6d4" },
  groq: { name: "Groq", icon: "Q", bg: "#f97316" },
  mistral: { name: "Mistral AI", icon: "M", bg: "#e11d48" },
  openrouter: { name: "OpenRouter", icon: "R", bg: "#8b5cf6" },
  ollama: { name: "Ollama (Local)", icon: "O", bg: "#64748b" },
  together: { name: "Together AI", icon: "T", bg: "#3b82f6" },
  qwen: { name: "Qwen", icon: "Q", bg: "#10b981" },
  glm: { name: "GLM", icon: "Z", bg: "#ec4899" },
  kimi: { name: "Kimi", icon: "K", bg: "#14b8a6" },
};

var RALPH_PHASES = ["reason", "act", "learn", "plan", "handoff"];
var RALPH_LABELS = {
  reason: "Analyzing state and approach",
  act: "Executing with provider",
  learn: "Evaluating result",
  plan: "Adjusting strategy",
  handoff: "Checking completion",
};

// ---- views ----
function showView(view) {
  document.getElementById("view-task").hidden = view !== "task";
  document.getElementById("view-connect").hidden = view !== "connect";
  document.getElementById("view-workflows").hidden = view !== "workflows";
  document.getElementById("view-routing").hidden = view !== "routing";
  document.querySelectorAll(".nav-tab").forEach(function (t) {
    t.classList.remove("active");
  });
  document.getElementById("nav-" + view).classList.add("active");
  if (view === "workflows") {
    wfInit();
    wfRender();
    wfFitView();
  }
  if (view === "routing") refreshRouting();
}

// ---- logging ----
function addLog(msg, level) {
  level = level || "info";
  var log = document.getElementById("log");
  var ts = new Date().toLocaleTimeString();
  log.innerHTML +=
    '<div class="log-entry"><span class="log-ts">[' +
    ts +
    ']</span> <span class="log-' +
    level +
    '">' +
    escHtml(msg) +
    "</span></div>";
  log.scrollTop = log.scrollHeight;
}
function clearLog() {
  document.getElementById("log").innerHTML = "";
}
function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- RALPH stepper ----
function updateRalphPhase(currentPhase, iteration, detail) {
  document.getElementById("ralph-iteration").textContent =
    "iteration " + iteration;
  document.getElementById("ralph-detail").textContent =
    detail || RALPH_LABELS[currentPhase] || "";

  var phaseIndex = RALPH_PHASES.indexOf(currentPhase);

  RALPH_PHASES.forEach(function (phase, i) {
    var node = document.getElementById("rn-" + phase);
    if (!node) return;
    node.classList.remove("active", "done");
    if (i < phaseIndex) {
      node.classList.add("done");
    } else if (i === phaseIndex) {
      node.classList.add("active");
    }
  });

  // connectors
  var connectorPairs = [
    ["rc-reason-act", 0],
    ["rc-act-learn", 1],
    ["rc-learn-plan", 2],
    ["rc-plan-handoff", 3],
  ];
  connectorPairs.forEach(function (pair) {
    var el = document.getElementById(pair[0]);
    if (!el) return;
    el.classList.remove("done", "active");
    if (pair[1] < phaseIndex) {
      el.classList.add("done");
    } else if (pair[1] === phaseIndex) {
      el.classList.add("active");
    }
  });
}

function resetRalphStepper() {
  RALPH_PHASES.forEach(function (phase) {
    var node = document.getElementById("rn-" + phase);
    if (node) {
      node.classList.remove("active", "done");
    }
  });
  ["rc-reason-act", "rc-act-learn", "rc-learn-plan", "rc-plan-handoff"].forEach(
    function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.classList.remove("done", "active");
      }
    },
  );
  document.getElementById("ralph-iteration").textContent = "iteration 0";
  document.getElementById("ralph-detail").textContent = "";
}

// ---- connect panel toggles ----
function toggleConnect(id) {
  var body = document.getElementById("cb-" + id);
  body.classList.toggle("open");
}

// ---- connect provider (subscription) ----
async function connectProvider(provider) {
  var input = document.getElementById("token-" + provider);
  var token = input.value.trim();
  if (!token) return;

  var statusEl = document.getElementById("status-" + provider);
  statusEl.innerHTML =
    '<div class="connect-status checking"><span class="spinner"></span> Verifying...</div>';

  try {
    var r = await fetch("/api/auth/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: provider, token: token }),
    });
    var data = await r.json();

    if (data.ok) {
      statusEl.innerHTML =
        '<div class="connect-status ok">Connected' +
        (data.detail ? " -- " + escHtml(data.detail) : "") +
        "</div>";
      addLog(
        PROVIDERS[provider].name + " connected via subscription",
        "success",
      );
      input.value = "";
      fetchStatus();
    } else {
      statusEl.innerHTML =
        '<div class="connect-status fail">' +
        escHtml(data.error || "Connection failed") +
        "</div>";
      addLog(
        PROVIDERS[provider].name +
          " connection failed: " +
          (data.error || "unknown"),
        "error",
      );
    }
  } catch (e) {
    statusEl.innerHTML =
      '<div class="connect-status fail">Network error: ' +
      escHtml(e.message) +
      "</div>";
  }
}

// ---- connect API key ----
async function connectApiKey() {
  var provider = document.getElementById("apikey-provider").value;
  var key = document.getElementById("apikey-value").value.trim();
  if (!key) return;

  var statusEl = document.getElementById("status-apikey");
  statusEl.innerHTML =
    '<div class="connect-status checking"><span class="spinner"></span> Saving...</div>';

  try {
    var r = await fetch("/api/auth/apikey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: provider, api_key: key }),
    });
    var data = await r.json();
    if (data.ok) {
      statusEl.innerHTML =
        '<div class="connect-status ok">' +
        PROVIDERS[provider].name +
        " API key saved</div>";
      addLog(PROVIDERS[provider].name + " API key saved", "success");
      document.getElementById("apikey-value").value = "";
      fetchStatus();
    } else {
      statusEl.innerHTML =
        '<div class="connect-status fail">' +
        escHtml(data.error || "Failed") +
        "</div>";
    }
  } catch (e) {
    statusEl.innerHTML =
      '<div class="connect-status fail">' + escHtml(e.message) + "</div>";
  }
}

// ---- disconnect ----
async function disconnect(provider) {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: provider }),
    });
    addLog("Disconnected " + PROVIDERS[provider].name);
    fetchStatus();
  } catch (e) {}
}

// ---- flush all credentials ----
async function flushAllCredentials() {
  if (
    !confirm(
      "Securely wipe all stored credentials from ~/.oma/credentials.json? This cannot be undone.",
    )
  )
    return;
  try {
    var r = await fetch("/api/auth/flush", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include_memory: false }),
    });
    var d = await r.json();
    if (d.ok) {
      addLog(
        "Flushed credentials from safe storage (" +
          (d.details ? d.details.flushedCredentialsCount : 0) +
          " removed)",
        "success",
      );
      fetchStatus();
    }
  } catch (e) {
    alert("Flush failed: " + e.message);
  }
}

// ---- sidebar providers ----
function renderProviders(data) {
  var el = document.getElementById("providers-list");
  var names = ["claude", "chatgpt", "gemini", "deepseek", "glm", "kimi"];
  if (data && data.codex && data.codex.status === "logged_in")
    names.unshift("codex");
  var html = "";
  connectedCount = 0;

  names.forEach(function (name) {
    var info = PROVIDERS[name];
    var status = (data && data[name]) || {};
    var isConn = status.status === "logged_in";
    if (isConn) connectedCount++;

    var badge = isConn
      ? '<span class="badge badge-green" style="font-size:9px">ON</span>'
      : "";

    var meta = isConn
      ? status.email || status.plan || "Active"
      : "Not connected";

    html +=
      '<div class="provider-card ' +
      (isConn ? "connected" : "disconnected") +
      '"' +
      ' data-tooltip-title="' +
      escHtml(info.name) +
      ' Provider"' +
      ' data-tooltip="' +
      (isConn
        ? "Active session (" + escHtml(meta) + ") — click to disconnect"
        : "Not connected — click to configure credentials") +
      '"' +
      ' onclick="' +
      (isConn
        ? "disconnect('" + name + "')"
        : "showView('connect'); setTimeout(function(){toggleConnect('" +
          name +
          "');document.getElementById('cb-" +
          name +
          "').classList.add('open')},50)") +
      '">' +
      '<div class="provider-top">' +
      '<div style="display:flex; align-items:center; gap:8px">' +
      '<div class="provider-icon" style="background:' +
      info.bg +
      '">' +
      info.icon +
      "</div>" +
      '<span class="provider-name">' +
      info.name +
      "</span>" +
      "</div>" +
      badge +
      "</div>" +
      '<div class="provider-meta">' +
      (isConn ? meta + " &middot; click to disconnect" : "Click to connect") +
      "</div>" +
      "</div>";
  });

  el.innerHTML = html;

  // update connect view badges
  names.forEach(function (name) {
    var status = (data && data[name]) || {};
    var badgeEl = document.getElementById("cc-badge-" + name);
    var cardEl = document.getElementById("cc-" + name);
    if (badgeEl && status.status === "logged_in") {
      badgeEl.className = "badge badge-green";
      badgeEl.textContent = "connected";
      if (cardEl) cardEl.classList.add("is-connected");
    } else if (badgeEl) {
      badgeEl.className = "badge badge-gray";
      badgeEl.textContent = "not connected";
      if (cardEl) cardEl.classList.remove("is-connected");
    }
  });

  // header badge
  var hdr = document.getElementById("conn-status");
  if (connectedCount > 0) {
    hdr.className = "badge badge-green";
    hdr.textContent =
      connectedCount + " provider" + (connectedCount > 1 ? "s" : "");
  } else {
    hdr.className = "badge badge-gray";
    hdr.textContent = "0 providers";
  }
}

// ---- task execution ----
async function runTask() {
  var obj = document.getElementById("objective").value.trim();
  if (!obj) {
    addLog("No objective set", "warn");
    return;
  }

  if (connectedCount === 0) {
    addLog("No providers connected -- go to Connect tab first", "warn");
    showView("connect");
    return;
  }

  var critRaw = document.getElementById("criteria").value.trim();
  var criteria = null;
  if (critRaw) {
    try {
      criteria = JSON.parse(critRaw);
    } catch (e) {
      addLog("Invalid JSON in criteria field", "error");
      return;
    }
  }

  taskRunning = true;
  lastPhaseEventCount = 0;
  document.getElementById("run-btn").disabled = true;
  document.getElementById("stop-btn").disabled = false;
  document.getElementById("task-badge").className = "badge badge-blue";
  document.getElementById("task-badge").textContent = "running";
  document.getElementById("progress-card").hidden = false;
  document.getElementById("result-card").hidden = true;
  document.getElementById("ralph-card").hidden = false;
  document.getElementById("step-list").innerHTML = "";
  document.getElementById("progress-fill").style.width = "0%";
  resetRalphStepper();
  addLog("Starting RALPH loop: " + obj);

  try {
    var r = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective: obj, criteria: criteria }),
    });
    var data = await r.json();

    if (data.error) {
      addLog("Error: " + data.error, "error");
      document.getElementById("task-badge").className = "badge badge-red";
      document.getElementById("task-badge").textContent = "error";
    } else {
      addLog(
        "Task complete: " +
          data.status +
          " (confidence: " +
          (data.confidence * 100).toFixed(0) +
          "%)",
        "success",
      );
      document.getElementById("task-badge").className = "badge badge-green";
      document.getElementById("task-badge").textContent = data.status;
      document.getElementById("progress-fill").style.width = "100%";
      document.getElementById("progress-pct").textContent = "100%";

      // mark all ralph nodes done
      RALPH_PHASES.forEach(function (phase) {
        var node = document.getElementById("rn-" + phase);
        if (node) {
          node.classList.remove("active");
          node.classList.add("done");
        }
      });
      [
        "rc-reason-act",
        "rc-act-learn",
        "rc-learn-plan",
        "rc-plan-handoff",
      ].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.classList.remove("active");
          el.classList.add("done");
        }
      });

      if (data.result) {
        document.getElementById("result-card").hidden = false;
        document.getElementById("result-text").textContent = data.result;
      }

      // render lessons as step items
      if (data.lessons && data.lessons.length > 0) {
        var stepList = document.getElementById("step-list");
        data.lessons.forEach(function (lesson) {
          var icon = lesson.succeeded ? "done" : "pending";
          var symbol = lesson.succeeded ? "&#10003;" : "&#10007;";
          var desc =
            "Iteration " +
            lesson.iteration +
            (lesson.provider ? " (" + lesson.provider + ")" : "") +
            (lesson.confidence_delta
              ? " delta=" + lesson.confidence_delta.toFixed(2)
              : "");
          stepList.innerHTML +=
            '<li class="step-item"><div class="step-icon ' +
            icon +
            '">' +
            symbol +
            "</div><div>" +
            escHtml(desc) +
            "</div></li>";
        });
      }
    }
  } catch (e) {
    addLog("Error: " + e.message, "error");
    document.getElementById("task-badge").className = "badge badge-red";
    document.getElementById("task-badge").textContent = "error";
  } finally {
    taskRunning = false;
    document.getElementById("run-btn").disabled = false;
    document.getElementById("stop-btn").disabled = true;
  }
}

async function stopTask() {
  addLog("Stop requested", "warn");
  try {
    await fetch("/api/stop", { method: "POST" });
  } catch (e) {}
}

function copyCmd(provider) {
  var el = document.getElementById("cmd-" + provider);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(function () {
    el.style.borderColor = "var(--green)";
    setTimeout(function () {
      el.style.borderColor = "";
    }, 1200);
  });
}

function copyResult() {
  var text = document.getElementById("result-text").textContent;
  navigator.clipboard.writeText(text).then(function () {
    addLog("Copied to clipboard");
  });
}

// ---- polling ----
async function fetchStatus() {
  try {
    var r = await fetch("/api/status");
    var data = await r.json();
    renderProviders(data.auth || {});
    const testing = data.testing || {};
    document.getElementById("test-process-status").textContent =
      (testing.alive ? "Watching · " : "Stopped · ") +
      (testing.status || "not running") +
      (testing.passed !== undefined
        ? " · " + testing.passed + " passed / " + testing.failed + " failed"
        : "");

    // update ralph stepper from status
    if (taskRunning && data.ralph) {
      var rp = data.ralph;
      if (rp.current_phase && rp.current_phase !== "idle") {
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
        newEvents.forEach(function (evt) {
          addLog(
            "RALPH: " + evt.phase + " (iteration " + evt.iteration + ")",
            "info",
          );
        });
        lastPhaseEventCount = totalEvents;
      }

      // update progress bar from confidence
      if (data.ralph.phase_events && data.ralph.phase_events.length > 0) {
        var lastEvent =
          data.ralph.phase_events[data.ralph.phase_events.length - 1];
        if (lastEvent.data && typeof lastEvent.data.confidence === "number") {
          var pct = Math.round(lastEvent.data.confidence * 100);
          document.getElementById("progress-fill").style.width = pct + "%";
          document.getElementById("progress-pct").textContent = pct + "%";
        }
      }
    }
  } catch (e) {}
}

// ---- theme ----
function toggleTheme() {
  document.body.classList.toggle("light");
  try {
    localStorage.setItem(
      "oma-theme",
      document.body.classList.contains("light") ? "light" : "dark",
    );
  } catch (e) {}
}

// ===========================================================================
// DAG Workflow Editor
// ===========================================================================

var NODE_W = 180,
  NODE_H = 64;
var NODE_DEFS = {
  start: {
    label: "Start",
    icon: "▶",
    bg: "#3fb950",
    cat: "control",
    ports: { in: 0, out: 1 },
    desc: "Workflow entry point initiating DAG execution",
  },
  end: {
    label: "End",
    icon: "■",
    bg: "#f85149",
    cat: "control",
    ports: { in: 1, out: 0 },
    desc: "Terminal node finalizing outputs and halting flow",
  },
  branch: {
    label: "Branch",
    icon: "⋅",
    bg: "#d29922",
    cat: "control",
    ports: { in: 1, out: 2 },
    desc: "Conditional routing node splitting execution paths",
  },
  merge: {
    label: "Merge",
    icon: "M",
    bg: "#f0883e",
    cat: "control",
    ports: { in: 2, out: 1 },
    desc: "Synchronizes and joins parallel execution branches",
  },
  classifier: {
    label: "Laya Classifier",
    icon: "🧠",
    bg: "#10b981",
    cat: "agent",
    ports: { in: 1, out: 2 },
    desc: "Local System 1 Laya classifier encapsulating tasks and routing to agents/sub-agents",
  },
  agent: {
    label: "Agent",
    icon: "A",
    bg: "#1f6feb",
    cat: "agent",
    ports: { in: 1, out: 1 },
    desc: "Autonomous LLM agent executing tasks and reasoning",
  },
  tiered_node: {
    label: "Tiered Node",
    icon: "⚡",
    bg: "#8b5cf6",
    cat: "agent",
    ports: { in: 1, out: 1 },
    desc: "Tiered execution node with dynamic T1 primary -> T2 fallback",
  },
  judge: {
    label: "Judge Gate",
    icon: "⚖",
    bg: "#06b6d4",
    cat: "agent",
    ports: { in: 1, out: 2 },
    desc: "System 1 decision evaluator assessing output quality & criteria",
  },
  sub_agent: {
    label: "Sub-Agent",
    icon: "S",
    bg: "#bc8cff",
    cat: "agent",
    ports: { in: 1, out: 1 },
    desc: "Specialized delegate agent executing scoped subtasks",
  },
  ralph: {
    label: "RALPH Loop",
    icon: "R",
    bg: "#d97706",
    cat: "agent",
    ports: { in: 1, out: 1 },
    desc: "Iterative Reason-Act-Learn-Plan-Handoff convergence loop",
  },
  doc_loader: {
    label: "Doc Loader",
    icon: "D",
    bg: "#6366f1",
    cat: "rag",
    ports: { in: 0, out: 1 },
    desc: "Ingests documents, text files, and unstructured knowledge",
  },
  embedder: {
    label: "Embedder",
    icon: "E",
    bg: "#14b8a6",
    cat: "rag",
    ports: { in: 1, out: 1 },
    desc: "Transforms text chunks into high-dimensional vector embeddings",
  },
  vector_store: {
    label: "Vector Store",
    icon: "V",
    bg: "#ec4899",
    cat: "rag",
    ports: { in: 1, out: 1 },
    desc: "Indexed vector database supporting semantic similarity queries",
  },
  retriever: {
    label: "Retriever",
    icon: "R",
    bg: "#f59e0b",
    cat: "rag",
    ports: { in: 1, out: 1 },
    desc: "Fetches top-k relevant knowledge chunks based on similarity",
  },
  generator: {
    label: "Generator",
    icon: "G",
    bg: "#1f6feb",
    cat: "rag",
    ports: { in: 1, out: 1 },
    desc: "Synthesizes grounded final answer from retrieved context",
  },
  memory: {
    label: "Memory",
    icon: "M",
    bg: "#8b5cf6",
    cat: "rag",
    ports: { in: 1, out: 1 },
    desc: "Short-term and long-term state persistence across pipeline steps",
  },
  llm_provider: {
    label: "LLM Provider",
    icon: "L",
    bg: "#10a37f",
    cat: "tool",
    ports: { in: 1, out: 1 },
    desc: "Direct provider model invocation gateway",
  },
  tool: {
    label: "Tool",
    icon: "T",
    bg: "#8b949e",
    cat: "tool",
    ports: { in: 1, out: 1 },
    desc: "Executes external CLI tools, functions, or shell commands",
  },
  http: {
    label: "HTTP Request",
    icon: "H",
    bg: "#0ea5e9",
    cat: "tool",
    ports: { in: 1, out: 1 },
    desc: "Performs outbound HTTP REST / GraphQL requests",
  },
  code: {
    label: "Code",
    icon: "</>",
    bg: "#64748b",
    cat: "tool",
    ports: { in: 1, out: 1 },
    desc: "Sandboxed code execution environment",
  },
};

var WF_TEMPLATES = {
  laya_multi_agent: {
    name: "Laya Encapsulation (Agent + Sub-Agents)",
    nodes: [
      { id: "n1", type: "start", x: 60, y: 220, name: "Task Input" },
      {
        id: "n2",
        type: "classifier",
        x: 280,
        y: 220,
        name: "Laya Task Classifier",
        provider: "laya",
        system:
          "Encapsulate and decompose task with System 1 fast classification",
      },
      {
        id: "n3",
        type: "agent",
        x: 540,
        y: 130,
        name: "Primary Coordinator",
        system: "Coordinate overall execution plan",
      },
      {
        id: "n4",
        type: "sub_agent",
        x: 540,
        y: 310,
        name: "Specialist Sub-Agent",
        system: "Execute scoped subtasks delegated from Laya",
      },
      { id: "n5", type: "merge", x: 780, y: 220, name: "Merge Deliverables" },
      {
        id: "n6",
        type: "judge",
        x: 1000,
        y: 220,
        name: "Laya Decision Gate",
        provider: "laya",
        system: "System 1 quality gate evaluation",
      },
      { id: "n7", type: "end", x: 1220, y: 220, name: "Final Solution" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n4", fromPort: 1, toPort: 0 },
      { from: "n3", to: "n5", fromPort: 0, toPort: 0 },
      { from: "n4", to: "n5", fromPort: 0, toPort: 1 },
      { from: "n5", to: "n6", fromPort: 0, toPort: 0 },
      { from: "n6", to: "n7", fromPort: 0, toPort: 0 },
    ],
  },
  tiered_routing: {
    name: "Tiered Routing (T1: Gemini → T2: DeepSeek)",
    nodes: [
      { id: "n1", type: "start", x: 60, y: 220, name: "Task Input" },
      {
        id: "n2",
        type: "tiered_node",
        x: 280,
        y: 140,
        name: "T1: Gemini Primary",
        provider: "gemini",
        tier: "t1",
        fallback: "deepseek",
        system: "Primary generation using Gemini Tier-1",
      },
      {
        id: "n3",
        type: "judge",
        x: 520,
        y: 220,
        name: "Jev Decision / Gate",
        provider: "jev",
        tier: "judge",
        system:
          "TypeSafe AI Jev decision evaluator assessing output quality & criteria",
      },
      {
        id: "n4",
        type: "tiered_node",
        x: 760,
        y: 300,
        name: "T2: DeepSeek Fallback",
        provider: "deepseek",
        tier: "t2",
        system:
          "Fallback Tier-2 generation via DeepSeek on T1 failure or rejection",
      },
      { id: "n5", type: "merge", x: 1000, y: 220, name: "Merge & Format" },
      { id: "n6", type: "end", x: 1220, y: 220, name: "Final Output" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n5", fromPort: 1, toPort: 0 },
      { from: "n4", to: "n5", fromPort: 0, toPort: 1 },
      { from: "n5", to: "n6", fromPort: 0, toPort: 0 },
    ],
  },
  simple_agent: {
    name: "Simple Agent",
    nodes: [
      { id: "n1", type: "start", x: 80, y: 200, name: "Start" },
      { id: "n2", type: "agent", x: 340, y: 200, name: "Agent" },
      { id: "n3", type: "end", x: 600, y: 200, name: "End" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
    ],
  },
  multi_agent: {
    name: "Multi-Agent Pipeline",
    nodes: [
      { id: "n1", type: "start", x: 60, y: 200, name: "Start" },
      { id: "n2", type: "agent", x: 280, y: 200, name: "Planner" },
      { id: "n3", type: "sub_agent", x: 500, y: 120, name: "Worker A" },
      { id: "n4", type: "sub_agent", x: 500, y: 280, name: "Worker B" },
      { id: "n5", type: "merge", x: 720, y: 200, name: "Merge" },
      { id: "n6", type: "agent", x: 940, y: 200, name: "Reviewer" },
      { id: "n7", type: "end", x: 1160, y: 200, name: "End" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n5", fromPort: 0, toPort: 0 },
      { from: "n4", to: "n5", fromPort: 0, toPort: 1 },
      { from: "n5", to: "n6", fromPort: 0, toPort: 0 },
      { from: "n6", to: "n7", fromPort: 0, toPort: 0 },
    ],
  },
  rag_basic: {
    name: "RAG: Basic",
    nodes: [
      { id: "n1", type: "doc_loader", x: 60, y: 200, name: "Load Docs" },
      { id: "n2", type: "embedder", x: 280, y: 200, name: "Embed" },
      { id: "n3", type: "vector_store", x: 500, y: 200, name: "Store" },
      { id: "n4", type: "retriever", x: 720, y: 200, name: "Retrieve" },
      { id: "n5", type: "generator", x: 940, y: 200, name: "Generate" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n4", to: "n5", fromPort: 0, toPort: 0 },
    ],
  },
  rag_conversational: {
    name: "RAG: Conversational",
    nodes: [
      { id: "n1", type: "doc_loader", x: 60, y: 160, name: "Load Docs" },
      { id: "n2", type: "embedder", x: 280, y: 160, name: "Embed" },
      { id: "n3", type: "vector_store", x: 500, y: 160, name: "Store" },
      { id: "n4", type: "retriever", x: 720, y: 160, name: "Retrieve" },
      { id: "n5", type: "memory", x: 720, y: 310, name: "Conv Memory" },
      { id: "n6", type: "generator", x: 940, y: 220, name: "Generate" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n4", to: "n6", fromPort: 0, toPort: 0 },
      { from: "n5", to: "n6", fromPort: 0, toPort: 0 },
    ],
  },
  rag_multi_source: {
    name: "RAG: Multi-Source",
    nodes: [
      { id: "n1", type: "doc_loader", x: 60, y: 100, name: "PDF Loader" },
      { id: "n2", type: "doc_loader", x: 60, y: 240, name: "Web Scraper" },
      { id: "n3", type: "doc_loader", x: 60, y: 380, name: "DB Connector" },
      { id: "n4", type: "merge", x: 300, y: 240, name: "Merge Sources" },
      { id: "n5", type: "embedder", x: 520, y: 240, name: "Embed" },
      { id: "n6", type: "vector_store", x: 740, y: 240, name: "Store" },
      { id: "n7", type: "retriever", x: 960, y: 240, name: "Retrieve" },
      { id: "n8", type: "generator", x: 1180, y: 240, name: "Generate" },
    ],
    edges: [
      { from: "n1", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n4", to: "n5", fromPort: 0, toPort: 0 },
      { from: "n5", to: "n6", fromPort: 0, toPort: 0 },
      { from: "n6", to: "n7", fromPort: 0, toPort: 0 },
      { from: "n7", to: "n8", fromPort: 0, toPort: 0 },
    ],
  },
  rag_agentic: {
    name: "RAG: Agentic",
    nodes: [
      { id: "n1", type: "start", x: 60, y: 220, name: "Query" },
      { id: "n2", type: "ralph", x: 280, y: 220, name: "RALPH Agent" },
      { id: "n3", type: "branch", x: 500, y: 220, name: "Needs RAG?" },
      { id: "n4", type: "retriever", x: 720, y: 120, name: "Retrieve" },
      { id: "n5", type: "generator", x: 720, y: 320, name: "Direct Gen" },
      { id: "n6", type: "merge", x: 940, y: 220, name: "Combine" },
      { id: "n7", type: "end", x: 1160, y: 220, name: "Response" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n5", fromPort: 1, toPort: 0 },
      { from: "n4", to: "n6", fromPort: 0, toPort: 0 },
      { from: "n5", to: "n6", fromPort: 0, toPort: 1 },
      { from: "n6", to: "n7", fromPort: 0, toPort: 0 },
    ],
  },
  ralph_loop: {
    name: "RALPH Loop",
    nodes: [
      { id: "n1", type: "start", x: 60, y: 200, name: "Input" },
      { id: "n2", type: "ralph", x: 300, y: 200, name: "Reason" },
      { id: "n3", type: "agent", x: 520, y: 200, name: "Act" },
      { id: "n4", type: "sub_agent", x: 740, y: 200, name: "Learn" },
      { id: "n5", type: "agent", x: 960, y: 200, name: "Plan" },
      { id: "n6", type: "end", x: 1180, y: 200, name: "Handoff" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n4", to: "n5", fromPort: 0, toPort: 0 },
      { from: "n5", to: "n6", fromPort: 0, toPort: 0 },
    ],
  },
  map_reduce: {
    name: "Map-Reduce",
    nodes: [
      { id: "n1", type: "start", x: 60, y: 220, name: "Input" },
      { id: "n2", type: "code", x: 280, y: 220, name: "Chunker" },
      { id: "n3", type: "sub_agent", x: 500, y: 100, name: "Map 1" },
      { id: "n4", type: "sub_agent", x: 500, y: 220, name: "Map 2" },
      { id: "n5", type: "sub_agent", x: 500, y: 340, name: "Map 3" },
      { id: "n6", type: "merge", x: 720, y: 220, name: "Reduce" },
      { id: "n7", type: "agent", x: 940, y: 220, name: "Summarize" },
      { id: "n8", type: "end", x: 1160, y: 220, name: "Output" },
    ],
    edges: [
      { from: "n1", to: "n2", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n3", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n4", fromPort: 0, toPort: 0 },
      { from: "n2", to: "n5", fromPort: 0, toPort: 0 },
      { from: "n3", to: "n6", fromPort: 0, toPort: 0 },
      { from: "n4", to: "n6", fromPort: 0, toPort: 0 },
      { from: "n5", to: "n6", fromPort: 0, toPort: 0 },
      { from: "n6", to: "n7", fromPort: 0, toPort: 0 },
      { from: "n7", to: "n8", fromPort: 0, toPort: 0 },
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

var SVG_NS = "http://www.w3.org/2000/svg";

function wfInit() {
  if (wfInitDone) return;
  wfInitDone = true;
  var wrap = document.getElementById("wf-canvas-wrap");
  var svg = document.getElementById("wf-svg");

  document.querySelectorAll(".wf-palette-node").forEach(function (el) {
    el.addEventListener("dragstart", function (e) {
      e.dataTransfer.setData("text/plain", el.dataset.nodeType);
      e.dataTransfer.effectAllowed = "copy";
    });
  });
  wrap.addEventListener("dragover", function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  wrap.addEventListener("drop", function (e) {
    e.preventDefault();
    var nodeType = e.dataTransfer.getData("text/plain");
    if (!nodeType || !NODE_DEFS[nodeType]) return;
    var rect = wrap.getBoundingClientRect();
    var x = (e.clientX - rect.left - wfPan.x) / wfZoom;
    var y = (e.clientY - rect.top - wfPan.y) / wfZoom;
    wfAddNode(nodeType, x - NODE_W / 2, y - NODE_H / 2);
  });

  svg.addEventListener("pointerdown", function (e) {
    if (e.target === svg || e.target.id === "wf-canvas-g") {
      wfPanning = true;
      wfPanStart = { x: e.clientX - wfPan.x, y: e.clientY - wfPan.y };
      wfDeselectAll();
      svg.style.cursor = "grabbing";
      svg.setPointerCapture(e.pointerId);
    }
  });
  svg.addEventListener("pointermove", function (e) {
    if (wfPanning) {
      wfPan.x = e.clientX - wfPanStart.x;
      wfPan.y = e.clientY - wfPanStart.y;
      wfApplyTransform();
    }
    if (wfDragging) {
      var rect = wrap.getBoundingClientRect();
      wfDragging.node.x =
        (e.clientX - rect.left - wfPan.x) / wfZoom - wfDragging.ox;
      wfDragging.node.y =
        (e.clientY - rect.top - wfPan.y) / wfZoom - wfDragging.oy;
      wfRender();
    }
    if (wfConnecting) {
      var rect = wrap.getBoundingClientRect();
      var mx = (e.clientX - rect.left - wfPan.x) / wfZoom;
      var my = (e.clientY - rect.top - wfPan.y) / wfZoom;
      wfRenderTempEdge(mx, my);
    }
  });
  svg.addEventListener("pointerup", function (e) {
    if (wfPanning) {
      wfPanning = false;
      svg.style.cursor = "";
    }
    if (wfDragging) wfDragging = null;
    if (wfConnecting) {
      var target = document.elementFromPoint(e.clientX, e.clientY);
      if (
        target &&
        target.classList.contains("wf-port") &&
        target.dataset.portType === "in"
      ) {
        var toId = target.dataset.nodeId;
        var toPort = parseInt(target.dataset.portIdx);
        if (toId !== wfConnecting.nodeId) {
          wfEdges.push({
            from: wfConnecting.nodeId,
            to: toId,
            fromPort: wfConnecting.portIdx,
            toPort: toPort,
          });
        }
      }
      wfConnecting = null;
      wfRender();
    }
  });

  wrap.addEventListener(
    "wheel",
    function (e) {
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
      document.getElementById("wf-zoom-label").textContent =
        Math.round(wfZoom * 100) + "%";
    },
    { passive: false },
  );

  document.addEventListener("keydown", function (e) {
    if (document.getElementById("view-workflows").hidden) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (
        document.activeElement.tagName === "INPUT" ||
        document.activeElement.tagName === "TEXTAREA"
      )
        return;
      wfDeleteSelected();
    }
  });

  if (!wfNodes.length) loadTemplate("simple_agent");
  else {
    wfRender();
    wfFitView();
  }
}

function wfApplyTransform() {
  var g = document.getElementById("wf-canvas-g");
  g.setAttribute(
    "transform",
    "translate(" + wfPan.x + "," + wfPan.y + ") scale(" + wfZoom + ")",
  );
  wfUpdateMinimap();
}

function wfAddNode(type, x, y, name, id) {
  var def = NODE_DEFS[type];
  if (!def) return;
  var node = {
    id: id || "n" + wfNextId++,
    type: type,
    x: x || 100,
    y: y || 100,
    name: name || def.label,
    provider: "",
    tier: "",
    fallback: "",
    system: "",
    config: "",
  };
  wfNodes.push(node);
  wfRender();
  return node;
}

let graphSaveTimer;
function wfRender() {
  if (currentProject && !wfRunning && !projectBusy) {
    clearTimeout(graphSaveTimer);
    graphSaveTimer = setTimeout(() => projectSave().catch(projectError), 250);
  }
  var g = document.getElementById("wf-canvas-g");
  g.innerHTML = "";

  wfEdges.forEach(function (edge, idx) {
    var fromNode = wfNodes.find(function (n) {
      return n.id === edge.from;
    });
    var toNode = wfNodes.find(function (n) {
      return n.id === edge.to;
    });
    if (!fromNode || !toNode) return;
    var fromDef = NODE_DEFS[fromNode.type];
    var toDef = NODE_DEFS[toNode.type];
    var fp = wfPortPos(fromNode, "out", edge.fromPort ?? 0, fromDef.ports.out);
    var tp = wfPortPos(toNode, "in", edge.toPort ?? 0, toDef.ports.in);
    var path = wfBezier(fp.x, fp.y, tp.x, tp.y);
    var el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("d", path);
    el.setAttribute("class", "wf-edge");
    el.setAttribute("stroke", "var(--fg2)");
    el.setAttribute("marker-end", "url(#wf-arrow)");
    el.dataset.tooltipTitle =
      "Edge: " + fromNode.name + " \u2192 " + toNode.name;
    el.dataset.tooltip = "Click edge to disconnect and remove link";
    el.addEventListener("click", function () {
      wfEdges.splice(idx, 1);
      wfRender();
    });
    g.appendChild(el);
  });

  wfNodes.forEach(function (node) {
    var def = NODE_DEFS[node.type];
    var ng = document.createElementNS(SVG_NS, "g");
    ng.setAttribute(
      "class",
      "wf-svg-node" + (wfSelectedNode === node.id ? " selected" : ""),
    );
    ng.setAttribute("transform", "translate(" + node.x + "," + node.y + ")");
    ng.dataset.tooltipTitle = node.name + " (" + def.label + ")";
    ng.dataset.tooltip = def.desc || "Workflow node (" + def.cat + ")";

    var rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("class", "node-body");
    rect.setAttribute("width", NODE_W);
    rect.setAttribute("height", NODE_H);
    rect.setAttribute("fill", "var(--card)");
    rect.setAttribute("stroke", "var(--border)");
    ng.appendChild(rect);

    var ic = document.createElementNS(SVG_NS, "circle");
    ic.setAttribute("cx", 26);
    ic.setAttribute("cy", NODE_H / 2);
    ic.setAttribute("r", 14);
    ic.setAttribute("fill", def.bg);
    ng.appendChild(ic);

    var it = document.createElementNS(SVG_NS, "text");
    it.setAttribute("x", 26);
    it.setAttribute("y", NODE_H / 2 + 4);
    it.setAttribute("text-anchor", "middle");
    it.setAttribute("class", "node-icon-text");
    it.textContent = def.icon;
    ng.appendChild(it);

    var tt = document.createElementNS(SVG_NS, "text");
    tt.setAttribute("x", 50);
    tt.setAttribute("y", NODE_H / 2 - 4);
    tt.setAttribute("class", "node-title");
    tt.setAttribute("fill", "var(--fg)");
    tt.textContent =
      node.name.length > 16 ? node.name.slice(0, 15) + "…" : node.name;
    ng.appendChild(tt);

    var st = document.createElementNS(SVG_NS, "text");
    st.setAttribute("x", 50);
    st.setAttribute("y", NODE_H / 2 + 12);
    st.setAttribute("class", "node-subtitle");
    const state = wfNodeStates[node.id] || { status: "idle" };
    st.textContent =
      def.label + " · " + (WF_STATE_LABELS[state.status] || state.status);
    st.style.fill = WF_STATE_COLORS[state.status] || "var(--fg2)";
    rect.style.stroke = WF_STATE_COLORS[state.status] || "var(--border)";
    rect.style.strokeWidth = state.status === "running" ? "3" : "1.5";
    ng.setAttribute("data-state", state.status);
    ng.dataset.tooltip =
      (def.desc || "") +
      "\nState: " +
      (WF_STATE_LABELS[state.status] || state.status) +
      (state.output ? "\n" + state.output : "") +
      (state.error ? "\n" + state.error : "");
    ng.appendChild(st);

    for (var i = 0; i < def.ports.in; i++) {
      var pp = wfLocalPortPos("in", i, def.ports.in);
      var port = document.createElementNS(SVG_NS, "circle");
      port.setAttribute("cx", pp.x);
      port.setAttribute("cy", pp.y);
      port.setAttribute("r", 5);
      port.setAttribute("fill", "var(--bg)");
      port.setAttribute("stroke", "var(--accent)");
      port.setAttribute("stroke-width", "2");
      port.setAttribute("class", "wf-port");
      port.dataset.nodeId = node.id;
      port.dataset.portType = "in";
      port.dataset.portIdx = i;
      port.dataset.tooltipTitle = node.name + ": Input Port " + (i + 1);
      port.dataset.tooltip = "Drop a connection here from another node";
      ng.appendChild(port);
    }

    for (var i = 0; i < def.ports.out; i++) {
      var pp = wfLocalPortPos("out", i, def.ports.out);
      var port = document.createElementNS(SVG_NS, "circle");
      port.setAttribute("cx", pp.x);
      port.setAttribute("cy", pp.y);
      port.setAttribute("r", 5);
      port.setAttribute("fill", "var(--accent)");
      port.setAttribute("stroke", "var(--accent)");
      port.setAttribute("stroke-width", "2");
      port.setAttribute("class", "wf-port");
      port.dataset.nodeId = node.id;
      port.dataset.portType = "out";
      port.dataset.portIdx = i;
      port.dataset.tooltipTitle = node.name + ": Output Port " + (i + 1);
      port.dataset.tooltip = "Click and drag to link to an input port";
      (function (nodeRef, portIdx) {
        port.addEventListener("pointerdown", function (e) {
          e.stopPropagation();
          wfConnecting = { nodeId: nodeRef.id, portIdx: portIdx };
        });
      })(node, i);
      ng.appendChild(port);
    }

    (function (nodeRef) {
      ng.addEventListener("pointerdown", function (e) {
        if (e.target.classList.contains("wf-port")) return;
        e.stopPropagation();
        wfSelectNode(nodeRef.id);
        var rect2 = document
          .getElementById("wf-canvas-wrap")
          .getBoundingClientRect();
        var mx = (e.clientX - rect2.left - wfPan.x) / wfZoom;
        var my = (e.clientY - rect2.top - wfPan.y) / wfZoom;
        wfDragging = { node: nodeRef, ox: mx - nodeRef.x, oy: my - nodeRef.y };
      });
    })(node);

    g.appendChild(ng);
  });

  document.getElementById("wf-node-count").textContent =
    wfNodes.length + " node" + (wfNodes.length !== 1 ? "s" : "");
  wfUpdateMinimap();
}

function wfLocalPortPos(type, idx, total) {
  var spacing = NODE_H / (total + 1);
  var y = spacing * (idx + 1);
  return { x: type === "in" ? 0 : NODE_W, y: y };
}

function wfPortPos(node, type, idx, total) {
  var local = wfLocalPortPos(type, idx, total);
  return { x: node.x + local.x, y: node.y + local.y };
}

function wfBezier(x1, y1, x2, y2) {
  var dx = Math.abs(x2 - x1) * 0.5;
  return (
    "M" +
    x1 +
    "," +
    y1 +
    " C" +
    (x1 + dx) +
    "," +
    y1 +
    " " +
    (x2 - dx) +
    "," +
    y2 +
    " " +
    x2 +
    "," +
    y2
  );
}

function wfRenderTempEdge(mx, my) {
  var g = document.getElementById("wf-canvas-g");
  var tempEl = g.querySelector(".wf-edge-temp");
  if (!wfConnecting) {
    if (tempEl) tempEl.remove();
    return;
  }
  var fromNode = wfNodes.find(function (n) {
    return n.id === wfConnecting.nodeId;
  });
  if (!fromNode) return;
  var fromDef = NODE_DEFS[fromNode.type];
  var fp = wfPortPos(fromNode, "out", wfConnecting.portIdx, fromDef.ports.out);
  var path = wfBezier(fp.x, fp.y, mx, my);
  if (!tempEl) {
    tempEl = document.createElementNS(SVG_NS, "path");
    tempEl.setAttribute("class", "wf-edge-temp");
    tempEl.setAttribute("stroke", "var(--accent)");
    g.appendChild(tempEl);
  }
  tempEl.setAttribute("d", path);
}

function wfSelectNode(id) {
  wfSelectedNode = id;
  wfRender();
  var node = wfNodes.find(function (n) {
    return n.id === id;
  });
  if (node) {
    var panel = document.getElementById("wf-detail");
    panel.classList.add("open");
    document.getElementById("wf-detail-title").textContent = node.name;
    document.getElementById("wf-d-name").value = node.name;
    document.getElementById("wf-d-type").value = NODE_DEFS[node.type]
      ? NODE_DEFS[node.type].label
      : node.type;
    document.getElementById("wf-d-provider").value = node.provider || "";
    document.getElementById("wf-d-tier").value = node.tier || "";
    document.getElementById("wf-d-fallback").value = node.fallback || "";
    document.getElementById("wf-d-system").value = node.system || "";
    document.getElementById("wf-d-config").value = node.config || "";
  }
}

function wfDeselectAll() {
  wfSelectedNode = null;
  document.getElementById("wf-detail").classList.remove("open");
  wfRender();
}

function wfUpdateNodeProp(prop, value) {
  if (wfRunning) return;
  if (!wfSelectedNode) return;
  var node = wfNodes.find(function (n) {
    return n.id === wfSelectedNode;
  });
  if (!node) return;
  node[prop] = value;
  if (prop === "name") {
    document.getElementById("wf-detail-title").textContent = value;
    wfRender();
  }
}

function wfDeleteSelected() {
  if (wfRunning) return;
  if (!wfSelectedNode) return;
  wfNodeStates = {};
  wfSetRunStatus("idle");
  wfNodes = wfNodes.filter(function (n) {
    return n.id !== wfSelectedNode;
  });
  wfEdges = wfEdges.filter(function (e) {
    return e.from !== wfSelectedNode && e.to !== wfSelectedNode;
  });
  wfSelectedNode = null;
  document.getElementById("wf-detail").classList.remove("open");
  wfRender();
}

function wfClearCanvas() {
  if (wfRunning) return;
  wfNodeStates = {};
  wfSetRunStatus("idle");
  wfNodes = [];
  wfEdges = [];
  wfSelectedNode = null;
  wfNextId = 1;
  document.getElementById("wf-detail").classList.remove("open");
  wfRender();
}

function loadTemplate(key) {
  if (wfRunning) return;
  var tpl = WF_TEMPLATES[key];
  if (!tpl) return;
  wfClearCanvas();
  tpl.nodes.forEach(function (n) {
    var node = wfAddNode(n.type, n.x, n.y, n.name, n.id);
    if (node) {
      if (n.provider) node.provider = n.provider;
      if (n.tier) node.tier = n.tier;
      if (n.fallback) node.fallback = n.fallback;
      if (n.system) node.system = n.system;
      if (n.config) node.config = n.config;
    }
  });
  var maxId = Math.max.apply(
    null,
    wfNodes.map(function (n) {
      return parseInt(n.id.replace("n", "")) || 0;
    }),
  );
  wfNextId = maxId + 1;
  wfEdges = tpl.edges.map(function (e) {
    return { from: e.from, to: e.to, fromPort: e.fromPort, toPort: e.toPort };
  });
  wfRender();
  wfFitView();
  document.getElementById("wf-template-select").value = key;
  addLog("Loaded template: " + tpl.name);
}

function wfZoomIn() {
  wfZoom = Math.min(3, wfZoom + 0.15);
  wfApplyTransform();
  document.getElementById("wf-zoom-label").textContent =
    Math.round(wfZoom * 100) + "%";
}

function wfZoomOut() {
  wfZoom = Math.max(0.15, wfZoom - 0.15);
  wfApplyTransform();
  document.getElementById("wf-zoom-label").textContent =
    Math.round(wfZoom * 100) + "%";
}

function wfFitView() {
  if (wfNodes.length === 0) {
    wfPan = { x: 40, y: 40 };
    wfZoom = 1;
    wfApplyTransform();
    return;
  }
  var wrap = document.getElementById("wf-canvas-wrap");
  var ww = wrap.clientWidth;
  var wh = wrap.clientHeight;
  if (!ww || !wh) return;
  var minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  wfNodes.forEach(function (n) {
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
  document.getElementById("wf-zoom-label").textContent =
    Math.round(wfZoom * 100) + "%";
}

function wfUpdateMinimap() {
  var mmSvg = document.getElementById("wf-minimap-svg");
  if (!mmSvg || wfNodes.length === 0) {
    if (mmSvg) mmSvg.innerHTML = "";
    return;
  }
  var minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  wfNodes.forEach(function (n) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NODE_W);
    maxY = Math.max(maxY, n.y + NODE_H);
  });
  var pad = 20;
  var vw = maxX - minX + pad * 2;
  var vh = maxY - minY + pad * 2;
  mmSvg.setAttribute(
    "viewBox",
    minX - pad + " " + (minY - pad) + " " + vw + " " + vh,
  );
  var html = "";
  wfEdges.forEach(function (edge) {
    var fn = wfNodes.find(function (n) {
      return n.id === edge.from;
    });
    var tn = wfNodes.find(function (n) {
      return n.id === edge.to;
    });
    if (!fn || !tn) return;
    var fx = fn.x + NODE_W,
      fy = fn.y + NODE_H / 2;
    var tx = tn.x,
      ty = tn.y + NODE_H / 2;
    html +=
      '<line x1="' +
      fx +
      '" y1="' +
      fy +
      '" x2="' +
      tx +
      '" y2="' +
      ty +
      '" stroke="var(--fg2)" stroke-width="2" opacity="0.4"/>';
  });
  wfNodes.forEach(function (node) {
    var def = NODE_DEFS[node.type];
    var sel = wfSelectedNode === node.id;
    html +=
      '<rect x="' +
      node.x +
      '" y="' +
      node.y +
      '" width="' +
      NODE_W +
      '" height="' +
      NODE_H +
      '" rx="6" fill="' +
      def.bg +
      '" opacity="' +
      (sel ? 0.9 : 0.5) +
      '"/>';
  });
  mmSvg.innerHTML = html;
}

async function wfSaveWorkflow() {
  try {
    await projectSave();
  } catch (error) {
    addLog(error.message, "error");
    return;
  }
  var payload = {
    name: "Workflow " + new Date().toLocaleTimeString(),
    nodes: wfNodes.map(function (n) {
      return {
        id: n.id,
        type: n.type,
        x: n.x,
        y: n.y,
        name: n.name,
        provider: n.provider,
        tier: n.tier,
        fallback: n.fallback,
        system: n.system,
        config: n.config,
      };
    }),
    edges: wfEdges,
  };
  try {
    var r = await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    var data = await r.json();
    if (data.ok) addLog("Workflow saved: " + (data.id || ""), "success");
    else addLog("Save failed: " + (data.error || ""), "error");
  } catch (e) {
    addLog("Save error: " + e.message, "error");
  }
}

let currentProject = null;
let projectBusy = false;
function projectError(error) {
  document.getElementById("project-status").textContent = error.message;
}
const browserProjects = new BrowserProjects();
let projectWrites = Promise.resolve();
function projectWrite(id, update) {
  const operation = projectWrites
    .catch(() => {})
    .then(async () => {
      const project = await browserProjects.get(id);
      update(project);
      const saved = await browserProjects.save(project);
      if (currentProject?.id === id) currentProject = saved;
      return saved;
    });
  projectWrites = operation;
  return operation;
}
async function projectRequest(path, body) {
  if (path === "/api/projects")
    return { projects: await browserProjects.list() };
  if (path.startsWith("/api/projects?id="))
    return {
      project: await browserProjects.get(
        new URL(path, location.origin).searchParams.get("id"),
      ),
    };
  if (path === "/api/projects/update")
    return {
      project: await projectWrite(body.project_id, (p) => {
        for (const key of ["input", "workflow", "tiers", "draft"])
          if (key in body) p[key] = body[key];
      }),
    };
  if (path === "/api/projects/command") {
    const command = body.command;
    if (command.startsWith("/project new ")) {
      const p = createProject(command.slice(13));
      const output = "Created project " + p.name;
      appendMessage(p, "user", command, { kind: "command" });
      appendMessage(p, "assistant", output, { kind: "command" });
      return { project: await browserProjects.save(p), output };
    }
    if (!body.project_id) throw new Error("Select a project first");
    if (!command.startsWith("/")) return browserChat(body.project_id, command);
    const classifier = new LayaClassifier();
    let output = "";
    const project = await projectWrite(body.project_id, (p) => {
      output =
        command === "/projects"
          ? "Projects are listed in the project selector."
          : applyCommand(p, command, (text, context) =>
              classifier.encapsulate(text, context || "").toDict(),
            );
      appendMessage(p, "user", command, { kind: "command", status: "sent" });
      appendMessage(p, "assistant", output, {
        kind: "command",
        status: "sent",
      });
    });
    return { project, output };
  }
  const response = await fetch(
    path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await response.json();
  if (!response.ok || data.error)
    throw new Error(data.error || "Request failed");
  return data;
}
async function browserChat(id, content, retryId) {
  let request, userId, assistantId;
  const initial = await projectWrite(id, (p) => {
    let user = retryId ? p.messages.find((m) => m.id === retryId) : null;
    if (user && user.delivery) {
      request = user.delivery;
      if (user.status === "failed")
        request = { ...request, request_id: newId() };
      user.request_id = request.request_id;
      user.status = "sending";
      user.error = undefined;
    } else {
      user = appendMessage(p, "user", content, {
        kind: "chat",
        status: "sending",
        request_id: newId(),
      });
      request = {
        project_id: id,
        request_id: user.request_id,
        messages: conversationMessages(p),
        tiers: p.tiers,
        conversations: p.conversations || {},
      };
      user.delivery = request;
    }
    userId = user.id;
    p.draft = "";
    const assistant = appendMessage(p, "assistant", "", {
      kind: "chat",
      status: "queued",
      request_id: request.request_id,
    });
    assistantId = assistant.id;
  });
  projectRender(initial);
  document.getElementById("project-command").value = "";
  let completed = false,
    attemptFailed = false;
  const consume = async (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error")
      throw new Error(event.error || "Message delivery failed");
    const saved = await projectWrite(id, (p) => {
      const assistant = p.messages.find((m) => m.id === assistantId),
        user = p.messages.find((m) => m.id === userId);
      if (event.type === "sending") {
        assistant.status = "sending";
        assistant.provider = event.provider;
        assistant.content = "";
        attemptFailed = false;
      }
      if (event.type === "conversation") {
        p.conversations ||= {};
        p.conversations[event.provider] = event.id;
      }
      if (event.type === "delta") {
        assistant.status = "streaming";
        assistant.content += event.text;
      }
      if (event.type === "attempt_failed") {
        assistant.error = event.error;
        attemptFailed = true;
      }
      if (event.type === "complete") {
        completed = true;
        const usage = event.claude_usage || { calls: 0, tokens: 0 };
        document.getElementById("claude-usage").textContent =
          "Claude: " + usage.calls + " calls / " + usage.tokens + " tokens";
        assistant.status = event.status;
        assistant.content = event.output;
        assistant.provider = event.provider;
        assistant.error = event.error;
        user.status = event.status;
        user.error = event.error;
        p.conversations = event.conversations;
        assistant.usage = event.claude_usage;
      }
    });
    projectRender(saved);
    document.getElementById("project-status").textContent =
      event.type === "complete"
        ? event.status === "sent"
          ? "Saved in browser"
          : event.error
        : "Sending via " + (event.provider || "provider") + "…";
  };
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      attemptFailed = true;
      const data = await response.json();
      throw new Error(data.error || "Chat HTTP " + response.status);
    }
    if (!response.body) throw new Error("Missing chat stream");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += chunk.done
          ? decoder.decode()
          : decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) await consume(line);
        if (chunk.done) {
          if (buffer) await consume(buffer);
          break;
        }
      }
    } finally {
      await reader.cancel();
    }
    if (!completed)
      throw new Error("Connection ended before message delivery was confirmed");
  } catch (error) {
    const saved = await projectWrite(id, (p) => {
      for (const mid of [userId, assistantId]) {
        const message = p.messages.find((m) => m.id === mid);
        message.status = attemptFailed ? "failed" : "interrupted";
        message.error = error.message;
      }
    });
    projectRender(saved);
    throw error;
  }
  const project = await browserProjects.get(id),
    reply = project.messages.find((m) => m.id === assistantId);
  return { project, output: reply.content, error: reply.error };
}
async function projectRetry(id) {
  if (projectBusy || wfRunning) return;
  projectBusy = true;
  document.getElementById("project-send").disabled = true;
  try {
    await browserChat(currentProject.id, "", id);
  } catch (error) {
    projectError(error);
  } finally {
    projectBusy = false;
    document.getElementById("project-send").disabled = false;
  }
}
async function projectExport() {
  try {
    const blob = new Blob([await browserProjects.export()], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "oma-projects.json";
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    projectError(error);
  }
}
async function projectImport(event) {
  try {
    await browserProjects.import(await event.target.files[0].text());
    await projectRefreshList();
    document.getElementById("project-status").textContent =
      "Imported into browser cache";
  } catch (error) {
    projectError(error);
  }
  event.target.value = "";
}
async function connectCodex() {
  const status = document.getElementById("status-codex");
  status.textContent = "Verifying Codex message delivery…";
  try {
    const response = await fetch("/api/auth/codex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verify: true }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error);
    status.textContent = data.detail;
    await fetchStatus();
  } catch (error) {
    status.textContent = error.message;
  }
}
async function connectClaudeCLI() {
  const status = document.getElementById("status-claude-cli");
  status.textContent = "Verifying Claude Code message delivery…";
  try {
    const response = await fetch("/api/auth/claude-cli", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verify: true }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error);
    status.textContent = data.detail;
    await fetchStatus();
  } catch (error) {
    status.textContent = error.message;
  }
}
// Inline handlers remain available after Bun bundles the TypeScript module.
Object.assign(window, {
  projectRetry,
  projectExport,
  projectImport,
  connectCodex,
  connectClaudeCLI,
});
function projectRender(project) {
  currentProject = project;
  if (!projectBusy)
    document.getElementById("project-command").value = project.draft || "";
  localStorage.setItem("oma-project", project.id);
  document.getElementById("wf-input").value = project.input || "";
  const tiers = project.tiers || {
    primary: "codex",
    fallback: "claude",
    claude_max_calls: 2,
    claude_max_tokens: 8000,
  };
  document.getElementById("tier-primary").value = tiers.primary;
  document.getElementById("tier-fallback").value = tiers.fallback;
  document.getElementById("claude-call-cap").value = tiers.claude_max_calls;
  document.getElementById("claude-token-cap").value = tiers.claude_max_tokens;
  const history = document.getElementById("project-history");
  history.replaceChildren();
  (project.messages || []).forEach((message) => {
    const item = document.createElement("div");
    item.style.cssText = "padding:8px 0;border-bottom:1px solid var(--border)";
    item.textContent =
      message.role +
      (message.status ? " [" + message.status + "]" : "") +
      ": " +
      message.content;
    if (message.error) {
      const error = document.createElement("div");
      error.style.color = "var(--red)";
      error.textContent = message.error;
      item.appendChild(error);
    }
    if (
      message.role === "user" &&
      message.delivery &&
      ["failed", "interrupted"].includes(message.status)
    ) {
      const retry = document.createElement("button");
      retry.className = "btn btn-ghost";
      retry.textContent = "Retry message";
      retry.onclick = () => projectRetry(message.id);
      item.appendChild(retry);
    }
    history.appendChild(item);
  });
  history.scrollTop = history.scrollHeight;
  const tasks = document.getElementById("project-tasks");
  tasks.replaceChildren();
  (project.tasks || []).forEach((task) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;margin:8px 0;align-items:center";
    const label = document.createElement("span");
    label.textContent = task.title;
    label.style.flex = "1";
    const status = document.createElement("select");
    status.setAttribute("aria-label", "Status for " + task.title);
    ["todo", "working", "done", "blocked"].forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      status.appendChild(option);
    });
    status.value = task.status;
    status.onchange = () =>
      projectCommand("/task status " + task.id + " " + status.value);
    row.append(label, status);
    tasks.appendChild(row);
  });
  const cleanup = project.cleanup;
  document.getElementById("project-cleanup").textContent = cleanup
    ? "Laya cleanup\n" +
      (cleanup.flags || []).join("\n") +
      "\n" +
      cleanup.summary
    : "";
  const run = (project.runs || []).at(-1);
  document.getElementById("wf-output").textContent =
    "Run a workflow to see outputs.";
  if (run)
    document.getElementById("wf-output").textContent = Object.entries(
      run.node_results || {},
    )
      .map(
        ([id, r]) => id + " [" + r.status + "]\n" + (r.output || r.error || ""),
      )
      .join("\n\n");
}
async function projectRefreshList() {
  const data = await projectRequest("/api/projects");
  const select = document.getElementById("project-select");
  select.replaceChildren();
  data.projects.forEach((p) => {
    const option = document.createElement("option");
    option.value = p.id;
    option.textContent = p.name;
    select.appendChild(option);
  });
  if (currentProject) select.value = currentProject.id;
  return data.projects;
}
async function projectSelect(id) {
  if (wfRunning || projectBusy) {
    document.getElementById("project-select").value = currentProject.id;
    return;
  }
  try {
    const data = await projectRequest(
      "/api/projects?id=" + encodeURIComponent(id),
    );
    projectRender(data.project);
    if (data.project.workflow) {
      wfNodes = data.project.workflow.nodes;
      wfEdges = data.project.workflow.edges;
      wfNextId =
        Math.max(
          0,
          ...wfNodes.map((n) => parseInt(n.id.replace("n", "")) || 0),
        ) + 1;
    } else {
      wfNodes = [];
      wfEdges = [];
      wfNextId = 1;
    }
    const run = (data.project.runs || []).at(-1);
    wfNodeStates = Object.fromEntries(
      Object.entries(run?.node_results || {}).map(([id, result]) => [
        id,
        {
          ...result,
          status: result.status === "pass-through" ? "done" : result.status,
        },
      ]),
    );
    wfSetRunStatus(run?.status || "idle");
    const usage = run?.claude_usage || { calls: 0, tokens: 0 };
    document.getElementById("claude-usage").textContent =
      "Claude: " + usage.calls + " calls / " + usage.tokens + " tokens";
    if (!document.getElementById("view-workflows").hidden) {
      wfInit();
      wfRender();
      wfFitView();
    }
  } catch (error) {
    document.getElementById("project-status").textContent = error.message;
  }
}
async function projectSave() {
  if (!currentProject) throw new Error("Select a project first");
  const data = await projectRequest("/api/projects/update", {
    project_id: currentProject.id,
    input: document.getElementById("wf-input").value,
    workflow: { nodes: wfNodes, edges: wfEdges },
    tiers: {
      primary: document.getElementById("tier-primary").value.trim(),
      fallback: document.getElementById("tier-fallback").value.trim(),
      claude_max_calls: Number(
        document.getElementById("claude-call-cap").value,
      ),
      claude_max_tokens: Number(
        document.getElementById("claude-token-cap").value,
      ),
    },
  });
  currentProject = data.project;
}
async function projectCreate() {
  if (wfRunning || projectBusy) return;
  const name = document.getElementById("project-name").value.trim();
  if (!name) {
    document.getElementById("project-status").textContent =
      "Enter a project name.";
    return;
  }
  await projectCommand("/project new " + name);
  document.getElementById("project-name").value = "";
}
async function projectAddTask() {
  if (wfRunning || projectBusy) return;
  const input = document.getElementById("project-task-title");
  if (input.value.trim()) {
    await projectCommand("/task add " + input.value.trim());
    input.value = "";
  }
}
async function projectCommand(command) {
  command = command || document.getElementById("project-command").value.trim();
  if (!command || projectBusy || wfRunning) return;
  if (command === "/run") {
    await wfRunWorkflow();
    return;
  }
  if (command === "/export") {
    await projectExport();
    return;
  }
  projectBusy = true;
  document.getElementById("project-send").disabled = true;
  document.getElementById("project-status").textContent =
    command === "/cleanup" ? "Laya is organizing the project…" : "Working…";
  try {
    if (currentProject) await projectSave();
    const data = await projectRequest("/api/projects/command", {
      project_id: currentProject?.id,
      command,
    });
    if (data.project) {
      projectRender(data.project);
      await projectRefreshList();
    }
    if (command.startsWith("/project new ")) {
      wfNodes = [];
      wfEdges = [];
      wfNodeStates = {};
      wfRender();
    }
    document.getElementById("project-command").value = "";
    document.getElementById("project-status").textContent =
      data.error || "Saved in browser";
    if (data.output) addLog(data.output, data.error ? "warn" : "success");
  } catch (error) {
    document.getElementById("project-status").textContent = error.message;
    if (currentProject) {
      try {
        projectRender(
          (await projectRequest("/api/projects?id=" + currentProject.id))
            .project,
        );
      } catch {}
    }
  } finally {
    projectBusy = false;
    document.getElementById("project-send").disabled = false;
  }
}
async function projectInit() {
  try {
    // Import legacy server snapshots once per ID. Local records always take precedence.
    try {
      const response = await fetch("/api/projects");
      if (response.ok) {
        const remote = await response.json(),
          known = new Set((await browserProjects.list()).map((p) => p.id));
        for (const item of remote.projects) {
          if (!known.has(item.id)) {
            const loaded = await fetch("/api/projects?id=" + item.id);
            if (loaded.ok)
              await browserProjects.save(
                migrateProject((await loaded.json()).project),
                true,
              );
          }
        }
      }
    } catch {
      /* Cached projects work offline. */
    }
    let list = await projectRefreshList();
    if (!list.length) {
      const project = await browserProjects.save(createProject("Workspace"));
      projectRender(project);
      list = await projectRefreshList();
    }
    const id =
      list.find((p) => p.id === localStorage.getItem("oma-project"))?.id ||
      list[0].id;
    await browserProjects.recover(id);
    await projectSelect(id);
    document.getElementById("project-status").textContent =
      "Browser cache ready";
    const persistDraft = () => {
      if (currentProject) {
        const draft = document.getElementById("project-command").value;
        projectWrite(currentProject.id, (p) => {
          p.draft = draft;
        }).catch(projectError);
      }
    };
    document
      .getElementById("project-command")
      .addEventListener("input", persistDraft);
    document
      .getElementById("wf-input")
      .addEventListener("input", () => projectSave().catch(projectError));
    browserProjects.changed.onmessage = async (event) => {
      if (!projectBusy && !wfRunning && currentProject?.id === event.data.id) {
        projectRender(await browserProjects.get(event.data.id));
      }
    };
    navigator.storage?.persist?.().catch(() => {});
  } catch (error) {
    projectError(error);
  }
}
window.addEventListener("DOMContentLoaded", projectInit);

const WF_STATE_LABELS = {
  idle: "Idle",
  queued: "Queued",
  running: "Working",
  done: "Done",
  parked: "Parked",
  failed: "Failed",
  blocked: "Blocked",
  skipped: "Skipped",
};
const WF_STATE_COLORS = {
  idle: "var(--border)",
  queued: "var(--fg2)",
  running: "var(--accent)",
  done: "var(--green)",
  parked: "var(--yellow)",
  failed: "var(--red)",
  blocked: "var(--orange)",
  skipped: "var(--fg2)",
};
let wfNodeStates = {};
let wfRunning = false;
function wfSetRunStatus(status) {
  const label = document.getElementById("wf-run-status");
  label.textContent = WF_STATE_LABELS[status] || status;
  label.style.color = WF_STATE_COLORS[status] || "var(--fg2)";
}
function wfApplyEvent(event) {
  if (event.type === "node") {
    wfNodeStates[event.node_id] = event;
    wfRender();
    document.getElementById("wf-output").textContent = Object.entries(
      wfNodeStates,
    )
      .map(
        ([id, r]) => id + " [" + r.status + "]\n" + (r.output || r.error || ""),
      )
      .join("\n\n");
  } else if (event.type === "complete") {
    wfSetRunStatus(event.status);
    const usage = event.claude_usage || { calls: 0, tokens: 0 };
    document.getElementById("claude-usage").textContent =
      "Claude: " + usage.calls + " calls / " + usage.tokens + " tokens";
    addLog(
      "Workflow " + event.status,
      event.status === "done" ? "success" : "warn",
    );
  } else if (event.type === "error") {
    throw new Error(event.error || "Workflow failed");
  }
}
async function wfRunWorkflow() {
  if (wfRunning || projectBusy) return;
  if (wfNodes.length === 0) {
    addLog("No nodes in workflow", "warn");
    return;
  }
  const payload = {
    nodes: wfNodes.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      provider: n.provider,
      tier: n.tier,
      fallback: n.fallback,
      system: n.system,
      config: n.config,
    })),
    edges: wfEdges,
    stream: true,
    tiers: currentProject?.tiers,
    input: document.getElementById("wf-input").value,
  };
  wfRunning = true;
  wfNodeStates = Object.fromEntries(
    wfNodes.map((n) => [n.id, { status: "queued" }]),
  );
  wfRender();
  wfSetRunStatus("running");
  document.getElementById("wf-run-btn").disabled = true;
  addLog("Running workflow (" + wfNodes.length + " nodes)...");
  let receivedCompletion = false;
  const runId = newId();
  const projectId = currentProject?.id;
  try {
    await projectSave();
    if (projectId)
      await projectWrite(projectId, (p) => {
        appendMessage(p, "user", "/run " + p.input, {
          kind: "workflow",
          status: "sent",
        });
        p.runs.push({
          id: runId,
          status: "running",
          created_at: Date.now() / 1000,
          node_results: { ...wfNodeStates },
        });
      });
    const response = await fetch("/api/workflows/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (
      !response.ok ||
      !(response.headers.get("Content-Type") || "").includes(
        "application/x-ndjson",
      )
    ) {
      const data = await response.json();
      throw new Error(data.error || "Workflow stream unavailable");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = async (line) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      wfApplyEvent(event);
      if (event.type === "complete") receivedCompletion = true;
      if (projectId)
        await projectWrite(projectId, (p) => {
          const run = p.runs.find((r) => r.id === runId);
          if (event.type === "node")
            run.node_results[event.node_id] = { ...event };
          if (event.type === "complete") {
            Object.assign(run, event);
            appendMessage(p, "assistant", "Workflow " + event.status, {
              kind: "workflow",
              status: "sent",
              run_id: runId,
            });
          }
        });
    };
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += chunk.done
          ? decoder.decode()
          : decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) await consume(line);
        if (chunk.done) {
          if (buffer) await consume(buffer);
          break;
        }
      }
    } finally {
      await reader.cancel();
    }
    if (!receivedCompletion)
      throw new Error("Workflow connection ended before completion");
  } catch (error) {
    Object.values(wfNodeStates).forEach((state) => {
      if (state.status === "running") state.status = "failed";
      else if (state.status === "queued") state.status = "blocked";
    });
    wfSetRunStatus("failed");
    wfRender();
    addLog("Workflow error: " + error.message, "error");
    if (projectId)
      await projectWrite(projectId, (p) => {
        const run = p.runs.find((r) => r.id === runId);
        if (run) {
          run.status = "failed";
          run.node_results = { ...wfNodeStates };
          run.error = error.message;
        }
      }).catch(projectError);
  } finally {
    wfRunning = false;
    document.getElementById("wf-run-btn").disabled = false;
    if (currentProject) {
      try {
        projectRender(
          (await projectRequest("/api/projects?id=" + currentProject.id))
            .project,
        );
      } catch {}
    }
  }
}

// ---- routing dashboard ----
const BREAKER_COLORS = {
  closed: "#22c55e",
  degraded: "#f59e0b",
  open: "#ef4444",
  half_open: "#3b82f6",
};

function refreshRouting() {
  fetch("/api/status")
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      const router = data.router || {};
      const providers = router.providers || {};
      const lkgp = router.lkgp || {};
      const omniroute = router.omniroute || null;

      // strategy badge
      const badge = document.getElementById("routing-mode-badge");
      if (omniroute && omniroute.available) {
        badge.textContent = "OmniRoute";
        badge.className = "badge badge-green";
      } else {
        badge.textContent = router.strategy || "embedded";
        badge.className = "badge badge-blue";
      }

      // strategy selector
      const sel = document.getElementById("routing-strategy");
      if (router.strategy && sel.value !== router.strategy) {
        sel.value = router.strategy;
      }

      // OmniRoute status
      const dot = document.getElementById("omniroute-status-dot");
      const txt = document.getElementById("omniroute-status-text");
      if (omniroute) {
        if (omniroute.available) {
          dot.style.background = "#22c55e";
          const mc = omniroute.model_count || 0;
          txt.textContent = "Connected (" + mc + " models)";
          txt.style.color = "var(--fg)";
        } else {
          dot.style.background = "#ef4444";
          txt.textContent = "Unreachable";
          txt.style.color = "var(--fg2)";
        }
      } else {
        dot.style.background = "#666";
        txt.textContent = "Not configured";
        txt.style.color = "var(--fg2)";
      }

      // circuit breakers
      const grid = document.getElementById("breaker-grid");
      const pids = Object.keys(providers);
      if (pids.length === 0) {
        grid.innerHTML =
          '<div style="color:var(--fg2); font-size:13px; padding:16px; text-align:center">No providers active yet</div>';
      } else {
        grid.innerHTML = pids
          .map(function (pid) {
            const p = providers[pid];
            const b = p.breaker || {};
            const state = b.state || "closed";
            const color = BREAKER_COLORS[state] || "#666";
            const failPct = b.failure_threshold
              ? Math.round(((b.failure_count || 0) / b.failure_threshold) * 100)
              : 0;
            return (
              '<div style="border:1px solid var(--border); border-radius:8px; padding:12px; background:var(--bg2)" data-tooltip-title="Breaker: ' +
              escHtml(pid) +
              '" data-tooltip="State: ' +
              state +
              " | Failures: " +
              (b.failure_count || 0) +
              "/" +
              (b.failure_threshold || 8) +
              " | Quota: " +
              (p.quota_available ? "OK" : "Exhausted") +
              " (" +
              Math.round((p.quota_remaining_pct || 1) * 100) +
              '%)">' +
              '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">' +
              '<span style="font-weight:500; font-size:13px">' +
              escHtml(pid) +
              "</span>" +
              '<span style="background:' +
              color +
              '; color:#fff; font-size:11px; padding:2px 8px; border-radius:10px">' +
              state +
              "</span>" +
              "</div>" +
              '<div style="font-size:11px; color:var(--fg2); line-height:1.8">' +
              "<div>Failures: " +
              (b.failure_count || 0) +
              " / " +
              (b.failure_threshold || 8) +
              "</div>" +
              '<div style="background:var(--border); border-radius:3px; height:4px; margin:4px 0">' +
              '<div style="background:' +
              color +
              "; height:100%; border-radius:3px; width:" +
              Math.min(failPct, 100) +
              '%; transition:width 0.3s"></div>' +
              "</div>" +
              "<div>Successes: " +
              (b.success_count || 0) +
              "</div>" +
              "<div>Quota: " +
              (p.quota_available ? "OK" : "Exhausted") +
              " (" +
              Math.round((p.quota_remaining_pct || 1) * 100) +
              "%)</div>" +
              "</div></div>"
            );
          })
          .join("");
      }

      // cost table
      const tbody = document.getElementById("cost-table-body");
      if (pids.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="4" style="padding:12px; text-align:center; color:var(--fg2)">No data</td></tr>';
      } else {
        tbody.innerHTML = pids
          .map(function (pid) {
            const p = providers[pid];
            return (
              '<tr style="border-bottom:1px solid var(--border)" data-tooltip-title="Cost Usage: ' +
              escHtml(pid) +
              '" data-tooltip="' +
              (p.requests || 0) +
              " requests, " +
              (p.total_tokens || 0).toLocaleString() +
              " tokens, $" +
              (p.total_cost || 0).toFixed(4) +
              '">' +
              '<td style="padding:6px 8px">' +
              escHtml(pid) +
              "</td>" +
              '<td style="padding:6px 8px">' +
              (p.requests || 0) +
              "</td>" +
              '<td style="padding:6px 8px">' +
              (p.total_tokens || 0).toLocaleString() +
              "</td>" +
              '<td style="padding:6px 8px">$' +
              (p.total_cost || 0).toFixed(4) +
              "</td>" +
              "</tr>"
            );
          })
          .join("");
      }

      // LKGP state
      const lkgpEl = document.getElementById("lkgp-list");
      const lkgpEntries = Object.entries(lkgp);
      if (lkgpEntries.length === 0) {
        lkgpEl.innerHTML = "No routing history yet";
      } else {
        lkgpEl.innerHTML = lkgpEntries
          .map(function (entry) {
            return (
              '<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border)" data-tooltip-title="LKGP: ' +
              escHtml(entry[0]) +
              '" data-tooltip="Last known good provider for ' +
              escHtml(entry[0]) +
              '">' +
              '<span style="color:var(--fg)">' +
              escHtml(entry[0]) +
              "</span>" +
              '<span style="color:var(--accent)">' +
              escHtml(String(entry[1])) +
              "</span>" +
              "</div>"
            );
          })
          .join("");
      }
    })
    .catch(function () {});
}

// auto-refresh routing when visible
setInterval(function () {
  if (!document.getElementById("view-routing").hidden) refreshRouting();
}, 2000);

// ---- tooltip engine ----
var tooltipEl = null;
var currentTooltipTarget = null;

function findTooltipTarget(el) {
  while (el && el !== document.body) {
    if (el.dataset && (el.dataset.tooltip || el.dataset.tooltipTitle))
      return el;
    if (
      el.hasAttribute &&
      (el.hasAttribute("data-tooltip") || el.hasAttribute("data-tooltip-title"))
    )
      return el;
    el = el.parentElement;
  }
  return null;
}

function initTooltipEngine() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.id = "oma-global-tooltip";
    tooltipEl.className = "oma-tooltip";
    document.body.appendChild(tooltipEl);
  }

  document.addEventListener(
    "mouseover",
    function (e) {
      var target = findTooltipTarget(e.target);
      if (!target) {
        hideTooltip();
        return;
      }
      if (target === currentTooltipTarget) return;
      currentTooltipTarget = target;

      if (target.hasAttribute("title") && target.getAttribute("title")) {
        target.setAttribute(
          "data-original-title",
          target.getAttribute("title"),
        );
        target.removeAttribute("title");
      }

      var title = target.getAttribute("data-tooltip-title") || "";
      var desc =
        target.getAttribute("data-tooltip") ||
        target.getAttribute("data-original-title") ||
        "";
      if (!title && !desc) {
        hideTooltip();
        return;
      }

      showTooltip(target, title, desc);
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    function (e) {
      if (!currentTooltipTarget) return;
      if (!e.relatedTarget || !currentTooltipTarget.contains(e.relatedTarget)) {
        hideTooltip();
      }
    },
    true,
  );

  window.addEventListener(
    "scroll",
    function () {
      if (currentTooltipTarget) positionTooltip(currentTooltipTarget);
    },
    true,
  );
  window.addEventListener("resize", function () {
    if (currentTooltipTarget) positionTooltip(currentTooltipTarget);
  });
}

function hideTooltip() {
  if (tooltipEl) {
    tooltipEl.classList.remove("visible");
  }
  if (
    currentTooltipTarget &&
    currentTooltipTarget.hasAttribute("data-original-title")
  ) {
    currentTooltipTarget.setAttribute(
      "title",
      currentTooltipTarget.getAttribute("data-original-title"),
    );
    currentTooltipTarget.removeAttribute("data-original-title");
  }
  currentTooltipTarget = null;
}

function showTooltip(target, title, desc) {
  if (!tooltipEl) return;
  var content = "";
  if (title) content += '<div class="tt-title">' + escHtml(title) + "</div>";
  if (desc) content += '<div class="tt-desc">' + escHtml(desc) + "</div>";
  tooltipEl.innerHTML = content;
  tooltipEl.classList.add("visible");
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

  tooltipEl.style.left = Math.round(left) + "px";
  tooltipEl.style.top = Math.round(top) + "px";
}

// ---- Onboarding & Demo Engine ----
var currentOnboardStep = 0;
var TOTAL_ONBOARD_STEPS = 5;

function checkOnboarding() {
  try {
    if (!localStorage.getItem("oma_onboarding_completed")) {
      setTimeout(function () {
        openOnboarding(0);
      }, 450);
    }
  } catch (e) {}
}

function openOnboarding(step) {
  if (typeof step !== "number") step = 0;
  currentOnboardStep = Math.max(0, Math.min(TOTAL_ONBOARD_STEPS - 1, step));
  renderOnboardingStep();
  var modal = document.getElementById("onboarding-modal");
  if (modal) modal.classList.add("open");
}

function closeOnboarding(savePreference) {
  var modal = document.getElementById("onboarding-modal");
  if (modal) modal.classList.remove("open");
  if (savePreference) {
    try {
      var chk = document.getElementById("onboard-dont-show");
      if (!chk || chk.checked) {
        localStorage.setItem("oma_onboarding_completed", "1");
      }
    } catch (e) {}
  }
}

function onboardingBackdropClick(e) {
  if (e.target && e.target.id === "onboarding-modal") {
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
    "Welcome to OMA",
    "Provider Connections",
    "Visual Workflow Studio",
    "Smart Routing & Fault Tolerance",
    "Autonomous RALPH Task Runner",
  ];

  var badgeEl = document.getElementById("onboard-step-badge");
  var titleEl = document.getElementById("onboard-header-title");
  if (badgeEl)
    badgeEl.textContent =
      "Step " + (currentOnboardStep + 1) + " of " + TOTAL_ONBOARD_STEPS;
  if (titleEl)
    titleEl.textContent = titles[currentOnboardStep] || "Welcome to OMA";

  for (var i = 0; i < TOTAL_ONBOARD_STEPS; i++) {
    var s = document.getElementById("onboard-slide-" + i);
    if (s) {
      if (i === currentOnboardStep) s.classList.add("active");
      else s.classList.remove("active");
    }
  }

  var dotsContainer = document.getElementById("onboard-dots");
  if (dotsContainer) {
    var dots = dotsContainer.querySelectorAll(".onboarding-dot");
    dots.forEach(function (dot, idx) {
      if (idx === currentOnboardStep) dot.classList.add("active");
      else dot.classList.remove("active");
    });
  }

  var prevBtn = document.getElementById("onboard-btn-prev");
  var nextBtn = document.getElementById("onboard-btn-next");
  if (prevBtn) prevBtn.disabled = currentOnboardStep === 0;
  if (nextBtn) {
    if (currentOnboardStep === TOTAL_ONBOARD_STEPS - 1) {
      nextBtn.innerHTML = "&#9654; Run Interactive Demo";
      nextBtn.className = "btn btn-sm btn-primary";
      nextBtn.style.background = "var(--green)";
      nextBtn.style.borderColor = "var(--green)";
    } else {
      nextBtn.textContent = "Next";
      nextBtn.className = "btn btn-sm btn-primary";
      nextBtn.style.background = "";
      nextBtn.style.borderColor = "";
    }
  }
}

function startOnboardingDemo() {
  closeOnboarding(true);
  showView("task");

  var objEl = document.getElementById("task-objective");
  var critEl = document.getElementById("task-criteria");
  if (objEl) {
    objEl.value =
      "Analyze API architecture for high-throughput multi-provider LLM routing with automated circuit breaker failover and credential safety";
  }
  if (critEl) {
    critEl.value = JSON.stringify(
      {
        throughput: "high",
        resilience: true,
        cost_optimized: true,
        safety: "owner-only",
      },
      null,
      2,
    );
  }

  runInteractiveDemoSimulation();
}

function runInteractiveDemoSimulation() {
  if (taskRunning) return;
  taskRunning = true;

  clearLog();
  var resEl = document.getElementById("result-text");
  if (resEl) resEl.textContent = "";
  var btn = document.getElementById("btn-run");
  var stopBtn = document.getElementById("btn-stop");
  if (btn) btn.disabled = true;
  if (stopBtn) stopBtn.disabled = false;

  addLog("=== Starting OMA Interactive Onboarding Demo ===", "info");
  addLog(
    "Task: High-throughput multi-provider routing with circuit breaker resilience",
    "info",
  );

  var progressFill = document.getElementById("progress-fill");
  var progressText = document.getElementById("progress-text");

  updateRalphPhase(
    "reason",
    1,
    "Analyzing objective, decomposing requirements, selecting primary provider",
  );
  if (progressFill) progressFill.style.width = "15%";
  if (progressText) progressText.textContent = "15% -- Reasoning approach";
  addLog(
    "[REASON] Iteration 1: Decomposed objective into 4 criteria gates: throughput, resilience, cost_optimized, safety.",
    "info",
  );

  setTimeout(function () {
    updateRalphPhase(
      "act",
      1,
      "Executing solve attempt via Claude (claude-sonnet-4)",
    );
    if (progressFill) progressFill.style.width = "35%";
    if (progressText) progressText.textContent = "35% -- Act: generating draft";
    addLog(
      "[ACT] Querying primary provider Claude (claude-sonnet-4) with optimized context...",
      "info",
    );

    setTimeout(function () {
      updateRalphPhase(
        "learn",
        1,
        "Evaluating candidate solution against criteria gates",
      );
      if (progressFill) progressFill.style.width = "55%";
      if (progressText)
        progressText.textContent = "55% -- Learn: scoring criteria";
      addLog(
        '[LEARN] Solution evaluated: confidence 0.70 < threshold 0.85. Criteria "cost_optimized" requires more detail.',
        "warn",
      );

      setTimeout(function () {
        updateRalphPhase(
          "plan",
          1,
          "Adapting strategy: rotating provider preference to Gemini for secondary validation",
        );
        if (progressFill) progressFill.style.width = "70%";
        if (progressText)
          progressText.textContent = "70% -- Plan: adaptive fallback";
        addLog(
          "[PLAN] Strategy adjusted: Rotating provider chain [claude -> gemini] to prioritize cost optimization.",
          "info",
        );

        setTimeout(function () {
          updateRalphPhase(
            "reason",
            2,
            "Refining prompt with attempt 1 lessons",
          );
          addLog(
            "[REASON] Iteration 2: Focusing on cost accounting algorithms and circuit breaker backoff.",
            "info",
          );

          setTimeout(function () {
            updateRalphPhase(
              "act",
              2,
              "Executing refined attempt via Gemini (gemini-2.0-flash)",
            );
            if (progressFill) progressFill.style.width = "85%";
            if (progressText)
              progressText.textContent = "85% -- Act: refined solution";
            addLog(
              "[ACT] Querying Gemini (gemini-2.0-flash) with lesson-enriched context...",
              "info",
            );

            setTimeout(function () {
              updateRalphPhase(
                "learn",
                2,
                "Confidence 0.94 >= threshold 0.85 -- all criteria satisfied!",
              );
              if (progressFill) progressFill.style.width = "95%";
              if (progressText)
                progressText.textContent = "95% -- Learn: criteria met";
              addLog(
                "[LEARN] Evaluated attempt 2: confidence 0.94 >= threshold 0.85! All 4 criteria gates PASSED.",
                "info",
              );

              setTimeout(function () {
                updateRalphPhase(
                  "handoff",
                  2,
                  "Final verified artifact produced",
                );
                if (progressFill) progressFill.style.width = "100%";
                if (progressText) progressText.textContent = "100% -- Complete";
                addLog(
                  "[HANDOFF] Task completed successfully in 2 iterations (tokens used: 642, confidence: 94%).",
                  "info",
                );

                var sampleResult = [
                  "# Multi-Provider Routing & Circuit Breaker Architecture",
                  "",
                  "## 1. Dynamic Routing Engine",
                  "- Core Strategy: Power-of-Two-Choices (P2C) weighted by quality EMA and cost.",
                  "- Fallback Chain: Claude -> Gemini -> DeepSeek.",
                  "- LKGP (Last Known Good Provider) cached per task modality.",
                  "",
                  "## 2. Self-Healing Circuit Breaker",
                  "- State Transitions: Closed (healthy) -> Degraded (warning) -> Open (tripped) -> Half-Open (probe).",
                  "- Failure Threshold: 5 consecutive failures triggers exponential backoff.",
                  "",
                  "## 3. Credential Safety & Privacy",
                  "- Storage: ~/.oma/credentials.json with POSIX 0600 owner-only permissions.",
                  "- Encryption: PBKDF2 key derivation with AES/XOR cipher.",
                  "- Zero telemetry / zero external proxying.",
                ].join("\n");

                if (resEl) resEl.textContent = sampleResult;

                taskRunning = false;
                if (btn) btn.disabled = false;
                if (stopBtn) stopBtn.disabled = true;

                addLog(
                  "=== Demo Finished! You are ready to connect providers and run your own tasks. ===",
                  "info",
                );
              }, 600);
            }, 700);
          }, 600);
        }, 600);
      }, 700);
    }, 700);
  }, 700);
}

document.addEventListener("keydown", function (e) {
  var modal = document.getElementById("onboarding-modal");
  if (!modal || !modal.classList.contains("open")) return;
  if (e.key === "Escape") {
    closeOnboarding(true);
  } else if (e.key === "ArrowRight") {
    nextOnboardingStep();
  } else if (e.key === "ArrowLeft") {
    prevOnboardingStep();
  }
});

// ---- init ----
(function init() {
  try {
    if (localStorage.getItem("oma-theme") === "light")
      document.body.classList.add("light");
  } catch (e) {}
  initTooltipEngine();
  checkOnboarding();
  fetchStatus().then(function () {
    if (connectedCount === 0) showView("connect");
  });
  setInterval(fetchStatus, 1500);
  addLog("OMA Dashboard ready (RALPH loop enabled)");
})();

Object.assign(window, {
  showView,
  addLog,
  clearLog,
  escHtml,
  updateRalphPhase,
  resetRalphStepper,
  toggleConnect,
  connectProvider,
  connectApiKey,
  disconnect,
  flushAllCredentials,
  renderProviders,
  runTask,
  stopTask,
  copyCmd,
  copyResult,
  fetchStatus,
  toggleTheme,
  wfInit,
  wfApplyTransform,
  wfAddNode,
  wfRender,
  wfLocalPortPos,
  wfPortPos,
  wfBezier,
  wfRenderTempEdge,
  wfSelectNode,
  wfDeselectAll,
  wfUpdateNodeProp,
  wfDeleteSelected,
  wfClearCanvas,
  loadTemplate,
  wfZoomIn,
  wfZoomOut,
  wfFitView,
  wfUpdateMinimap,
  wfSaveWorkflow,
  projectError,
  projectWrite,
  projectRequest,
  browserChat,
  projectRetry,
  projectExport,
  projectImport,
  connectCodex,
  projectRender,
  projectRefreshList,
  projectSelect,
  projectSave,
  projectCreate,
  projectAddTask,
  projectCommand,
  projectInit,
  wfSetRunStatus,
  wfApplyEvent,
  wfRunWorkflow,
  refreshRouting,
  findTooltipTarget,
  initTooltipEngine,
  hideTooltip,
  showTooltip,
  positionTooltip,
  checkOnboarding,
  openOnboarding,
  closeOnboarding,
  onboardingBackdropClick,
  goToOnboardingStep,
  prevOnboardingStep,
  nextOnboardingStep,
  renderOnboardingStep,
  startOnboardingDemo,
  runInteractiveDemoSimulation,
});
