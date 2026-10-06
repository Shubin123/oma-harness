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

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { OMA } from "@oma/core/agent";
import { AuthManager } from "@oma/core/providers/auth";
import { LimitedProvider, limitedAgent } from "@oma/core/providers/limited";
import { ProviderRegistry } from "@oma/core/providers/registry";
import { ProjectStore } from "./projects.js";
let projectStore: ProjectStore | undefined;
function projects(): ProjectStore {
  return (projectStore ??= new ProjectStore());
}

// ---- inline SPA ----

import { DASHBOARD_HTML } from "./page.js";
import { BROWSER_SCRIPT } from "./generated/browser.js";
import { ChatService, type ChatRequest } from "./chat.js";
import {
  CodexSubscriptionProvider,
  readCodexLogin,
} from "@oma/core/providers/codex";
import os from "node:os";
import {
  ClaudeCLIProvider,
  claudeLoginStatus,
} from "@oma/core/providers/claude-cli";
import { validateTiers } from "@oma/shared";

// ---- HTTP server ----

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let dashboardAgent: OMA | null = null;
let dashboardAuth: AuthManager | null = null;
let taskRunning = false;
let chatService: ChatService;
const savedWorkflows: Record<string, Record<string, unknown>> = {};

function sendJson(
  res: http.ServerResponse,
  data: Record<string, unknown>,
  status = 200,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("Expected an object");
        resolve(body);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function verifyToken(
  provider: string,
  token: string,
): Promise<[boolean, string]> {
  if (!token || !token.trim()) {
    return [false, "Empty token"];
  }
  if (provider === "laya") {
    return [true, "Laya local System 1 classifier active"];
  }
  try {
    if (provider === "claude") {
      const resp = await fetch("https://claude.ai/api/organizations", {
        headers: {
          Cookie: `sessionKey=${token}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          Origin: "https://claude.ai",
          Referer: "https://claude.ai/",
        },
      });
      if (!resp.ok) {
        return [
          false,
          `Authentication failed (HTTP ${resp.status}) - token is invalid or expired`,
        ];
      }
      const data = (await resp.json()) as Array<Record<string, string>>;
      if (data && data.length > 0) {
        const orgName = data[0].name ?? "";
        return [true, orgName ? `Organization: ${orgName}` : "Session valid"];
      }
      return [false, "No organizations found - token may be invalid"];
    }

    if (provider === "chatgpt") {
      const resp = await fetch("https://chatgpt.com/api/auth/session", {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });
      if (!resp.ok) {
        return [
          false,
          `Authentication failed (HTTP ${resp.status}) - token is invalid or expired`,
        ];
      }
      const data = (await resp.json()) as Record<
        string,
        Record<string, string>
      >;
      const email = data.user?.email ?? "";
      return [true, email ? `Account: ${email}` : "Session valid"];
    }

    if (provider === "gemini") {
      const resp = await fetch("https://gemini.google.com/", {
        headers: {
          Cookie: `__Secure-1PSID=${token}`,
          "User-Agent": USER_AGENT,
        },
      });
      if (!resp.ok) {
        return [false, `HTTP error ${resp.status} - check token and try again`];
      }
      const html = await resp.text();
      if (/"SNlM0e"/.test(html)) {
        return [true, "Google session valid"];
      }
      return [true, "Cookie accepted (could not fully verify)"];
    }

    if (provider === "deepseek") {
      const resp = await fetch("https://api.deepseek.com/models", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
      if (resp.status === 200) {
        return [true, "DeepSeek API valid"];
      }
      return [false, `DeepSeek returned status ${resp.status}`];
    }

    // for other providers, just accept
    return [true, "Token stored"];
  } catch (err: unknown) {
    return [false, "Verification failed; check the credential and network"];
  }
}

function rebuildAgent(): void {
  try {
    if (dashboardAuth) {
      dashboardAgent = OMA.fromCredentials(dashboardAuth);
      chatService = new ChatService(dashboardAgent.registry);
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
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // ---- GET ----
  if (req.method === "GET") {
    if (pathname === "/" || pathname === "/index.html") {
      const html = Buffer.from(DASHBOARD_HTML, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": html.length,
      });
      res.end(html);
      return;
    }

    if (pathname === "/dashboard.js") {
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(BROWSER_SCRIPT);
      return;
    }
    if (pathname === "/api/status") {
      const status: Record<string, unknown> = {};
      if (dashboardAuth) {
        status.auth = dashboardAuth.status();
      }
      if (dashboardAgent) {
        const health = dashboardAgent.registry.statusReport();
        const auth = (status.auth ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        for (const [name, h] of Object.entries(health)) {
          if (auth[name]) {
            auth[name].health = h;
          }
        }
        // include ralph status
        status.ralph = dashboardAgent.ralphStatus();
        // include router + OmniRoute status
        if (typeof dashboardAgent.routerStatus === "function") {
          status.router = dashboardAgent.routerStatus();
        } else {
          status.router = { strategy: "auto", providers: {}, lkgp: {} };
        }
      }
      try {
        const testing = JSON.parse(
          fs.readFileSync(
            path.resolve(process.cwd(), ".build_cache/test-status.json"),
            "utf8",
          ),
        );
        let alive = false;
        try {
          process.kill(testing.pid, 0);
          alive = true;
        } catch {}
        status.testing = { ...testing, alive };
      } catch {
        status.testing = { status: "not running", alive: false };
      }
      const auth = (status.auth ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      for (const [name, info] of Object.entries(auth)) {
        if (info.status === "logged_in" && !info.health) {
          info.health = {
            success_rate: "100.0%",
            avg_latency_ms: "0",
            total_tokens: 0,
            in_cooldown: false,
            last_error: null,
          };
        }
      }
      sendJson(res, status);
      return;
    }

    if (pathname === "/api/storage/info") {
      if (!dashboardAuth) {
        sendJson(res, { error: "auth not initialized" }, 500);
        return;
      }
      sendJson(res, dashboardAuth.storageInfo());
      return;
    }

    if (pathname === "/api/projects") {
      try {
        const id = new URL(req.url!, "http://localhost").searchParams.get("id");
        sendJson(
          res,
          id
            ? { project: projects().get(id) }
            : { projects: projects().list() },
        );
      } catch (exc) {
        sendJson(res, { error: String(exc) }, 404);
      }
      return;
    }

    if (pathname === "/api/workflows") {
      sendJson(res, { workflows: Object.values(savedWorkflows) });
      return;
    }

    if (pathname === "/api/workflows/templates") {
      const tplList = [
        {
          key: "tiered_routing",
          name: "Tiered Routing (T1: Gemini → T2: DeepSeek)",
        },
        { key: "simple_agent", name: "Simple Agent" },
        { key: "multi_agent", name: "Multi-Agent Pipeline" },
        { key: "rag_basic", name: "RAG: Basic" },
        { key: "rag_conversational", name: "RAG: Conversational" },
        { key: "rag_multi_source", name: "RAG: Multi-Source" },
        { key: "rag_agentic", name: "RAG: Agentic" },
        { key: "ralph_loop", name: "RALPH Loop" },
        { key: "map_reduce", name: "Map-Reduce" },
      ];
      sendJson(res, { templates: tplList });
      return;
    }

    if (pathname === "/api/test/history") {
      const candidates = [
        path.resolve(process.cwd(), ".build_cache/test-history.json"),
      ];
      let historyPath = "";
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          historyPath = p;
          break;
        }
      }
      if (historyPath) {
        try {
          const runs = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
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
    res.end("Not Found");
    return;
  }

  // ---- POST ----
  if (req.method === "POST") {
    const body = await readBody(req);

    if (pathname === "/api/auth/claude-cli") {
      try {
        const command = Bun.which("claude");
        if (!command) throw new Error("Claude Code is not installed");
        const login = await claudeLoginStatus(command);
        if (!login.loggedIn) throw new Error("Run claude auth login first");
        const model = String(body.model || "sonnet");
        let verified = false;
        if (body.verify === true) {
          const result = await new ClaudeCLIProvider(command, model).complete(
            [{ role: "user", content: "Reply with exactly: linked" }],
            undefined,
            128,
          );
          if (result.error || !result.text.trim())
            throw new Error(result.error || "No Claude reply");
          verified = true;
        }
        dashboardAuth!.storeCredential(
          "claude",
          JSON.stringify({ command, model }),
          {
            authType: "claude_cli",
            plan: login.subscriptionType || "Subscription",
          },
        );
        rebuildAgent();
        sendJson(res, {
          ok: true,
          verified,
          detail: verified
            ? "Claude Code linked and message delivery verified"
            : "Claude Code subscription linked",
        });
      } catch (error) {
        sendJson(
          res,
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not link Claude Code",
          },
          400,
        );
      }
      return;
    }
    if (pathname === "/api/auth/codex") {
      try {
        const authFile = path.join(
          process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
          "auth.json",
        );
        readCodexLogin(authFile);
        const model = String(body.model || "gpt-6.1-sol");
        let verified = false;
        if (body.verify === true) {
          const result = await new CodexSubscriptionProvider(
            authFile,
            model,
          ).complete([{ role: "user", content: "Reply with exactly: linked" }]);
          if (result.error || !result.text.trim())
            throw new Error(result.error || "No Codex reply");
          verified = true;
        }
        dashboardAuth!.storeCredential(
          "codex",
          JSON.stringify({ auth_file: authFile, model }),
          { authType: "codex_file", plan: "Subscription" },
        );
        rebuildAgent();
        chatService = new ChatService(dashboardAgent!.registry);
        sendJson(res, {
          ok: true,
          verified,
          detail: verified
            ? "Codex linked and message delivery verified"
            : "Codex login file linked; message delivery not yet verified",
        });
      } catch {
        sendJson(
          res,
          {
            ok: false,
            error: "Could not link Codex. Run codex login and retry.",
          },
          400,
        );
      }
      return;
    }
    if (pathname === "/api/chat") {
      try {
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        let streaming = false;
        const result = await chatService.send(
          body as unknown as ChatRequest,
          (event) => {
            if (!streaming) {
              res.writeHead(200, {
                "Content-Type": "application/x-ndjson",
                "Cache-Control": "no-cache",
              });
              res.flushHeaders();
              streaming = true;
            }
            if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
          },
          controller.signal,
        );
        if (!streaming)
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-cache",
          });
        res.end(JSON.stringify({ type: "complete", ...result }) + "\n");
      } catch (exc) {
        if (!res.headersSent)
          sendJson(
            res,
            { error: exc instanceof Error ? exc.message : "Chat failed" },
            400,
          );
        else
          res.end(
            JSON.stringify({ type: "error", error: "Chat delivery failed" }) +
              "\n",
          );
      }
      return;
    }
    if (pathname === "/api/auth/connect") {
      const provider = (body.provider ?? "") as string;
      const token = (body.token ?? "") as string;
      if (!provider || !token) {
        sendJson(res, { error: "missing provider or token" }, 400);
        return;
      }

      const [ok, detail] = await verifyToken(provider, token);
      if (ok) {
        dashboardAuth?.storeSessionToken(provider, token);
        rebuildAgent();
        sendJson(res, { ok: true, detail });
      } else {
        sendJson(res, {
          ok: false,
          error: detail || "Token verification failed",
        });
      }
      return;
    }

    if (pathname === "/api/auth/apikey") {
      const provider = (body.provider ?? "") as string;
      const apiKey = (body.api_key ?? "") as string;
      if (dashboardAuth && provider && apiKey) {
        dashboardAuth.storeApiKey(provider, apiKey);
        rebuildAgent();
        sendJson(res, { ok: true });
      } else {
        sendJson(res, { error: "missing provider or api_key" }, 400);
      }
      return;
    }

    if (pathname === "/api/auth/logout") {
      const provider = (body.provider ?? "") as string;
      if (dashboardAuth && provider) {
        dashboardAuth.logout(provider);
        rebuildAgent();
        sendJson(res, { ok: true });
      } else {
        sendJson(res, { error: "missing provider" }, 400);
      }
      return;
    }

    if (pathname === "/api/auth/flush") {
      const includeMemory = Boolean(body.include_memory);
      if (dashboardAuth) {
        const details = dashboardAuth.flush(includeMemory);
        rebuildAgent();
        sendJson(res, { ok: true, details });
      } else {
        sendJson(res, { error: "auth not initialized" }, 500);
      }
      return;
    }

    if (pathname === "/api/run") {
      const objective = (body.objective ?? "") as string;
      const criteria = body.criteria as Record<string, unknown> | undefined;

      if (!objective) {
        sendJson(res, { error: "no objective" }, 400);
        return;
      }

      if (!dashboardAgent) {
        rebuildAgent();
      }
      if (!dashboardAgent) {
        sendJson(res, { error: "no providers configured" }, 400);
        return;
      }

      try {
        taskRunning = true;
        const bounded = await limitedAgent(
          dashboardAgent,
          validateTiers(
            body.tiers || {
              primary: "codex",
              fallback: "claude",
              claude_max_calls: 2,
              claude_max_tokens: 8000,
            },
          ),
        );
        const result = await bounded.run({ objective, criteria });
        taskRunning = false;

        sendJson(res, {
          status: result.status,
          confidence: result.confidence,
          attempts: result.attempts,
          tokens_used: result.tokens_used,
          result: result.artifacts.final ?? result.strategy.best_result ?? "",
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

    if (pathname === "/api/projects/command") {
      try {
        sendJson(
          res,
          await projects().command(
            body.project_id as string | undefined,
            String(body.command || ""),
            dashboardAgent,
          ),
        );
      } catch (exc) {
        if (body.project_id) {
          try {
            projects().message(
              String(body.project_id),
              "assistant",
              String(exc),
              { status: "failed" },
            );
          } catch {
            /* invalid project */
          }
        }
        sendJson(res, { error: String(exc) }, 400);
      }
      return;
    }
    if (pathname === "/api/projects/update") {
      try {
        const project = projects().get(String(body.project_id));
        if ("input" in body) project.input = String(body.input);
        if ("workflow" in body) project.workflow = body.workflow;
        if ("tiers" in body)
          project.tiers = body.tiers as NonNullable<typeof project.tiers>;
        sendJson(res, { project: projects().save(project) });
      } catch (exc) {
        sendJson(res, { error: String(exc) }, 400);
      }
      return;
    }

    if (pathname === "/api/workflows") {
      const wfName = (body.name ?? "Untitled") as string;
      const nodes = (body.nodes ?? []) as Array<Record<string, unknown>>;
      const edges = (body.edges ?? []) as Array<Record<string, unknown>>;
      const { createHash } = await import("node:crypto");
      const wfId = createHash("md5")
        .update(`${wfName}${Date.now()}`)
        .digest("hex")
        .slice(0, 12);
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

    if (pathname === "/api/workflows/run") {
      const nodes = (body.nodes ?? []) as Array<Record<string, unknown>>;
      const edges = (body.edges ?? []) as Array<Record<string, unknown>>;
      if (nodes.length === 0) {
        sendJson(res, { error: "no nodes in workflow" }, 400);
        return;
      }
      if (!dashboardAgent) rebuildAgent();
      if (!dashboardAgent) {
        try {
          dashboardAgent = OMA.load();
        } catch {
          /* ignore */
        }
      }
      if (!dashboardAgent) {
        sendJson(res, { error: "no providers configured" }, 400);
        return;
      }
      let streaming = false;
      const states: Record<string, string> = Object.fromEntries(
        nodes.map((n) => [String(n.id), "queued"]),
      );
      let activeNode: string | undefined;
      let results: Record<string, Record<string, unknown>> = {};
      const emit = (event: Record<string, unknown>) => {
        if (streaming) res.write(JSON.stringify(event) + "\n");
      };
      const nodeState = (
        nid: string,
        status: string,
        result: Record<string, unknown> = {},
      ) => {
        states[nid] = status;
        emit({ type: "node", node_id: nid, ...result, status });
      };
      try {
        const tiers = validateTiers(
          body.tiers ||
            (body.project_id
              ? projects().get(String(body.project_id)).tiers
              : undefined) || {
              primary: "codex",
              fallback: "claude",
              claude_max_calls: 2,
              claude_max_tokens: 8000,
            },
        );
        if (body.project_id) {
          projects().get(String(body.project_id));
          projects().message(
            String(body.project_id),
            "user",
            "/run " + String(body.input || ""),
            { kind: "workflow" },
          );
        }
        if (Object.keys(states).length !== nodes.length)
          throw new Error("Workflow node IDs must be unique");
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
          if (!adj[from] || !adj[to])
            throw new Error("Workflow edge references an unknown node");
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
          for (const child of adj[nid] ?? []) {
            inDeg[child]--;
            if (inDeg[child] === 0) queue.push(child);
          }
        }
        if (order.length !== nodes.length)
          throw new Error("Workflow contains a cycle");
        if (body.stream) {
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-cache",
          });
          res.flushHeaders();
          streaming = true;
          for (const nid of Object.keys(states)) nodeState(nid, "queued");
        }
        const registry = new ProviderRegistry();
        let limitedClaude: LimitedProvider | undefined;
        for (const name of dashboardAgent.registry.providerNames()) {
          let provider = dashboardAgent.registry.get(name)!;
          if (name === "claude") {
            limitedClaude = new LimitedProvider(
              provider,
              Math.max(0, tiers.claude_max_calls),
              Math.max(0, tiers.claude_max_tokens),
            );
            provider = limitedClaude;
          }
          registry.register(name, provider);
        }
        const executionAgent = new OMA({
          registry,
          config: { ...dashboardAgent.config },
          fallback_enabled: false,
        });
        executionAgent.classifier = dashboardAgent.classifier;
        const runNode = async (
          objective: string,
          primary: string,
          fallback: string,
        ) => {
          const chain = [
            ...new Set([primary, fallback].filter((p) => registry.get(p))),
          ];
          const nodeRegistry = new ProviderRegistry();
          for (const name of chain)
            nodeRegistry.register(name, registry.get(name)!);
          const agent = new OMA({
            registry: nodeRegistry,
            config: { ...executionAgent.config, provider_chain: chain },
            routingStrategy: "priority",
            fallback_enabled: false,
          });
          agent.classifier = executionAgent.classifier;
          const result = await agent.run({ objective });
          if (
            !result.artifacts.final &&
            typeof result.strategy.best_result === "string"
          )
            result.artifacts.partial = result.strategy.best_result;
          return result;
        };
        const nodeMap: Record<string, Record<string, unknown>> = {};
        for (const n of nodes) nodeMap[n.id as string] = n;
        results = new Proxy({} as Record<string, Record<string, unknown>>, {
          set(target, nid: string, result: Record<string, unknown>) {
            target[nid] = result;
            nodeState(
              nid,
              result.status === "pass-through" ? "done" : String(result.status),
              result,
            );
            return true;
          },
        });
        for (const nid of order) {
          const incoming = edges.filter((e) => e.to === nid);
          const activeIncoming = incoming.filter(
            (e) =>
              results[e.from as string].reason !== "branch_not_selected" &&
              (!("active_port" in results[e.from as string]) ||
                (e.fromPort ?? 0) === results[e.from as string].active_port),
          );
          if (incoming.length && !activeIncoming.length) {
            results[nid] = {
              status: "skipped",
              reason: "branch_not_selected",
              output: "",
            };
            continue;
          }
          if (
            activeIncoming.some((e) =>
              ["failed", "parked", "blocked", "skipped"].includes(
                states[e.from as string],
              ),
            )
          ) {
            results[nid] = {
              status: "blocked",
              output: "",
              error: "A dependency did not complete",
            };
            continue;
          }
          activeNode = nid;
          nodeState(nid, "running");
          const node = nodeMap[nid];
          const ntype = (node.type ?? "") as string;
          if (["start", "end", "merge"].includes(ntype)) {
            if (ntype === "merge") {
              const combined = activeIncoming
                .map(
                  (e) =>
                    `[${e.from}]: ${(results[e.from as string] as Record<string, unknown>).output ?? ""}`,
                )
                .join("\n\n");
              results[nid] = { status: "pass-through", output: combined };
            } else if (ntype === "end") {
              let lastOutput = "";
              for (const e of activeIncoming) {
                if (e.to === nid && results[e.from as string]) {
                  lastOutput = String(
                    (results[e.from as string] as Record<string, unknown>)
                      .output ?? "",
                  );
                  break;
                }
              }
              results[nid] = { status: "pass-through", output: lastOutput };
            } else {
              results[nid] = {
                status: "pass-through",
                output: (body.input as string) ?? "",
              };
            }
            continue;
          }
          const parentOutputs: Record<string, unknown>[] = [];
          for (const e of activeIncoming) {
            if (e.to === nid && results[e.from as string]) {
              parentOutputs.push(
                results[e.from as string] as Record<string, unknown>,
              );
            }
          }
          const ctx = parentOutputs
            .filter((p) => p.output)
            .map((p) => String(p.output))
            .join("; ");
          const basePrompt =
            (node.system as string) || (node.name as string) || "task";
          let objective = ctx ? `${basePrompt} -- context: ${ctx}` : basePrompt;

          if (ntype === "branch") {
            const config = (
              typeof node.config === "string"
                ? JSON.parse(node.config)
                : node.config || {}
            ) as Record<string, unknown>;
            const condition = config.condition || "not_empty";
            const value = String(config.value || "");
            if (
              !["not_empty", "contains", "equals"].includes(String(condition))
            )
              throw new Error(
                "Branch condition must be not_empty, contains, or equals",
              );
            const matched =
              condition === "not_empty"
                ? Boolean(ctx.trim())
                : condition === "contains"
                  ? ctx.includes(value)
                  : ctx === value;
            results[nid] = {
              status: "done",
              output: ctx,
              active_port: matched ? 0 : 1,
              condition_matched: matched,
            };
            continue;
          }

          // Laya Task Classifier & Encapsulation Node
          if (
            ntype === "classifier" ||
            ntype === "laya_classifier" ||
            (node.provider === "laya" &&
              ntype !== "judge" &&
              ntype !== "tiered_node")
          ) {
            const encap = dashboardAgent.classifier.encapsulate(
              (body.input as string) || objective,
              ctx,
              (node.criteria as Record<string, unknown>) || {},
              nid,
            );
            results[nid] = {
              status: "done",
              classifier: "laya (Convai System 1)",
              category: encap.category,
              complexity: encap.complexity,
              assigned_agent: encap.assignedAgent,
              routing_decision: encap.routingDecision,
              confidence: encap.confidence,
              recommended_provider: encap.recommendedProvider,
              sub_agents: encap.subAgents,
              task_encapsulation: encap.toDict(),
              output: `[Laya Encapsulation: ${encap.category.toUpperCase()}] Complexity: ${encap.complexity} | Assigned: ${encap.assignedAgent} | Sub-Agents: ${encap.subAgents.length} | Confidence: ${encap.confidence.toFixed(2)}\nObjective: ${encap.objective}`,
            };
            continue;
          }

          // Jev / Laya Decision / Judge Gate
          if (
            ntype === "judge" ||
            node.provider === "jev" ||
            node.provider === "laya" ||
            node.tier === "judge"
          ) {
            const isLaya = node.provider === "laya";
            const evaluatorName = isLaya
              ? "laya (Convai System 1)"
              : "jev (TypeSafe AI)";
            const prefixLabel = isLaya ? "Laya" : "Jev";
            const gate = dashboardAgent.classifier.evaluateQuality(
              ctx,
              (node.criteria as Record<string, unknown>) || {},
            );

            results[nid] = {
              status: "done",
              evaluator: evaluatorName,
              decision: gate.passed ? "PASSED" : "FAILOVER_TRIGGERED",
              confidence: gate.confidence,
              output: `[${prefixLabel} Decision: ${gate.passed ? "PASSED" : "FAILOVER"}] Score: ${gate.score.toFixed(2)} — ${gate.notes}\n${ctx.slice(0, 300)}`,
            };
            continue;
          }

          // If incoming from a classifier node, extract delegated subtask for sub_agent
          if (ntype === "sub_agent") {
            for (const p of parentOutputs) {
              if (Array.isArray(p.sub_agents) && p.sub_agents.length > 0) {
                const subtask = p.sub_agents[0] as {
                  role: string;
                  objective: string;
                };
                objective = `[Sub-Agent: ${subtask.role}] ${subtask.objective} -- Context: ${ctx}`;
                break;
              }
            }
          }

          // Tiered Routing Node (e.g. T1: Gemini -> T2: DeepSeek)
          const tier = node.tier as string | undefined;
          const providerReq = node.provider as string | undefined;
          const fallbackReq =
            (node.fallback as string | undefined) || "deepseek";

          if (tier || ntype === "tiered_node" || providerReq) {
            const t1Cand = providerReq || "gemini";
            const t2Cand = fallbackReq;
            const avail =
              typeof executionAgent.registry.providerNames === "function"
                ? executionAgent.registry.providerNames()
                : executionAgent.registry.available();
            const [selProv, selTier, isFailover] =
              executionAgent.router.selectTiered(t1Cand, t2Cand, avail);
            let runProv = selProv;
            let tierUsed = selTier;
            let failedOver = isFailover;
            if (!avail.includes(t1Cand) && avail.includes(t2Cand)) {
              runProv = t2Cand;
              tierUsed = "t2";
              failedOver = true;
            }

            const result = await runNode(objective, runProv, fallbackReq);
            results[nid] = {
              status: result.status,
              provider_used: runProv,
              tier_used: tierUsed,
              failover_triggered: failedOver,
              confidence: result.confidence,
              output: result.artifacts.final || result.artifacts.partial || "",
            };
          } else if (["agent", "sub_agent", "ralph"].includes(ntype)) {
            const result = await runNode(
              objective,
              tiers.primary,
              tiers.fallback,
            );
            results[nid] = {
              status: result.status,
              confidence: result.confidence,
              output: result.artifacts.final || result.artifacts.partial || "",
            };
          } else {
            results[nid] = { status: "skipped", type: ntype };
          }
        }
        const statuses = Object.values(states);
        const status = statuses.includes("failed")
          ? "failed"
          : statuses.includes("parked")
            ? "parked"
            : statuses.includes("blocked") ||
                Object.values(results).some(
                  (r) =>
                    r.status === "skipped" &&
                    r.reason !== "branch_not_selected",
                )
              ? "blocked"
              : "done";
        const summary = {
          status,
          node_results: results,
          execution_order: order,
          claude_usage: {
            calls: limitedClaude?.calls || 0,
            tokens: limitedClaude?.tokens || 0,
          },
        };
        projects().recordRun(body.project_id as string | undefined, {
          ...summary,
          input: body.input || "",
          nodes,
          edges,
        });
        if (streaming) {
          emit({ type: "complete", ...summary });
          res.end();
        } else sendJson(res, summary);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (activeNode && states[activeNode] === "running")
          results[activeNode] = { status: "failed", error: msg, output: "" };
        for (const [nid, state] of Object.entries(states))
          if (state === "queued")
            results[nid] = { status: "blocked", output: "" };
        if (body.project_id) {
          try {
            projects().recordRun(String(body.project_id), {
              status: "failed",
              error: msg,
              node_results: results,
            });
          } catch {
            /* invalid project */
          }
        }
        if (streaming) {
          emit({ type: "error", error: msg });
          res.end();
        } else sendJson(res, { error: msg }, 400);
      }
      return;
    }

    if (pathname === "/api/stop") {
      taskRunning = false;
      sendJson(res, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
}

/** Open a URL in the default browser (cross-platform). */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${url}"`, { timeout: 5000 });
    } else if (platform === "linux") {
      execSync(`xdg-open "${url}"`, { timeout: 5000 });
    } else if (platform === "win32") {
      execSync(`start "${url}"`, { timeout: 5000 });
    }
  } catch {
    /* ignore */
  }
}

/** Create the dashboard HTTP server instance. */
export function createDashboardServer(
  options: {
    auth?: AuthManager;
    agent?: OMA;
    projectStore?: ProjectStore;
  } = {},
): http.Server {
  dashboardAuth = options.auth || new AuthManager();
  projectStore = options.projectStore;
  if (options.agent) dashboardAgent = options.agent;
  else rebuildAgent();
  chatService = new ChatService(dashboardAgent!.registry);

  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Request error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  });
}

/** Start the graphical dashboard. */
export function runWeb(
  host = "127.0.0.1",
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
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
}
