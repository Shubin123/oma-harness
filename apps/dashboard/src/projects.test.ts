import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "./projects.js";
import { createDashboardServer } from "./web.js";
import { LimitedProvider } from "@oma/core/providers/limited";
import {
  Provider,
  type Message,
  type ProviderResponse,
} from "@oma/core/providers/base";

class FakeClaude extends Provider {
  override name = "claude";
  calls = 0;
  allowed = 0;
  countTokens(_text: string): number {
    return 10;
  }
  async complete(
    _messages: Message[],
    _system?: string,
    maxTokens = 4096,
  ): Promise<ProviderResponse> {
    this.calls++;
    this.allowed = maxTokens;
    return {
      text: "ok",
      tokens_in: 10,
      tokens_out: 20,
      model: "test",
      provider: this.name,
      latency_ms: 1,
    };
  }
}
test("Claude request and retry caps are enforced at the provider boundary", async () => {
  const source = new FakeClaude();
  const limited = new LimitedProvider(source, 1, 40);
  await limited.complete([{ role: "user", content: "input" }], undefined, 100);
  assert.equal(source.allowed, 30);
  assert.equal(limited.tokens, 30);
  assert.equal((await limited.complete([])).error_class, "budget");
  assert.equal(source.calls, 1);
});
test("Projects persist tasks, conversations, outputs, and Laya cleanup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-project-"));
  try {
    const store = new ProjectStore(dir);
    const p = store.create("Parser");
    await store.command(p.id, "/task add Build a CSV parser", null);
    await store.command(p.id, "/input CSV input", null);
    store.recordRun(p.id, {
      status: "parked",
      node_results: { n1: { status: "parked", output: "partial" } },
    });
    await store.command(p.id, "/cleanup", null);
    const restored = new ProjectStore(dir).get(p.id);
    assert.equal(restored.input, "CSV input");
    assert.ok(restored.cleanup);
    assert.deepEqual(restored.cleanup!.flags, ["n1: parked"]);
    assert.equal(
      (await store.command(p.id, "/output n1", null)).output,
      "partial",
    );
    assert.throws(() => store.get("../credentials"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Workflow streams queued, working and done states over HTTP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-dashboard-"));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  const server = createDashboardServer();
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const url = "http://127.0.0.1:" + address.port;
    const response = await fetch(url + "/api/workflows/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: true,
        input: "flow input",
        nodes: [
          { id: "a", type: "start" },
          { id: "b", type: "end" },
        ],
        edges: [{ from: "a", to: "b" }],
      }),
    });
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.filter((e) => e.node_id === "a").map((e) => e.status),
      ["queued", "running", "done"],
    );
    assert.equal(events.at(-1).status, "done");
    assert.equal(events.at(-1).node_results.b.output, "flow input");
    const cyclic = await fetch(url + "/api/workflows/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: [{ id: "a", type: "start" }],
        edges: [{ from: "a", to: "a" }],
      }),
    });
    assert.equal(cyclic.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Provider workflow emits working state before reply and shares Claude caps across all nodes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-flow-cap-"));
  const { OMA } = await import("@oma/core/agent");
  const { ProviderRegistry } = await import("@oma/core/providers/registry");
  const { AuthManager, CredentialStore } = await import(
    "@oma/core/providers/auth"
  );
  class SlowClaude extends FakeClaude {
    finished = 0;
    async complete(...args: Parameters<FakeClaude["complete"]>) {
      await new Promise((r) => setTimeout(r, 150));
      const result = await super.complete(...args);
      this.finished++;
      return result;
    }
  }
  const source = new SlowClaude(),
    registry = new ProviderRegistry();
  registry.register("claude", source);
  const agent = new OMA({
    registry,
    config: { max_attempts: 1, confidence_threshold: 0.1 },
    fallback_enabled: false,
  });
  const server = createDashboardServer({
    agent,
    auth: new AuthManager(
      new CredentialStore(path.join(dir, "credentials.json")),
    ),
    projectStore: new ProjectStore(path.join(dir, "projects")),
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url =
      "http://127.0.0.1:" + (server.address() as { port: number }).port;
    const graph = {
      stream: true,
      input: "input",
      tiers: {
        primary: "claude",
        fallback: "claude",
        claude_max_calls: 1,
        claude_max_tokens: 100,
      },
      nodes: [
        { id: "a", type: "start" },
        { id: "b", type: "agent", provider: "claude" },
        { id: "c", type: "agent", provider: "claude" },
        { id: "d", type: "end" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
      ],
    };
    const response = await fetch(url + "/api/workflows/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(graph),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(),
      decoder = new TextDecoder();
    let raw = "",
      sawWorking = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
      if (
        !sawWorking &&
        raw
          .split("\n")
          .slice(0, -1)
          .some((line) => {
            const e = JSON.parse(line);
            return e.node_id === "b" && e.status === "running";
          })
      ) {
        sawWorking = true;
        assert.equal(source.finished, 0);
      }
    }
    const events = raw
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s)),
      final = events.at(-1);
    assert.ok(sawWorking);
    assert.equal(source.calls, 1);
    assert.equal(final.claude_usage.calls, 1);
    assert.equal(final.node_results.b.status, "done");
    assert.notEqual(final.node_results.c.status, "done");
    assert.equal(final.node_results.d.status, "blocked");
    const invalid = await fetch(url + "/api/workflows/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...graph,
        tiers: { ...graph.tiers, claude_max_calls: -1 },
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(source.calls, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Workflow branch ports skip inactive nodes and still complete a merge", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-branch-"));
  const { OMA } = await import("@oma/core/agent");
  const { ProviderRegistry } = await import("@oma/core/providers/registry");
  const { AuthManager, CredentialStore } = await import(
    "@oma/core/providers/auth"
  );
  const server = createDashboardServer({
    agent: new OMA({ registry: new ProviderRegistry() }),
    auth: new AuthManager(
      new CredentialStore(path.join(dir, "credentials.json")),
    ),
    projectStore: new ProjectStore(path.join(dir, "projects")),
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const response = await fetch(
      "http://127.0.0.1:" +
        (server.address() as { port: number }).port +
        "/api/workflows/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: "selected",
          nodes: [
            { id: "a", type: "start" },
            {
              id: "b",
              type: "branch",
              config: { condition: "contains", value: "selected" },
            },
            { id: "c", type: "merge" },
            { id: "d", type: "merge" },
            { id: "e", type: "merge" },
          ],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "c", fromPort: 0 },
            { from: "b", to: "d", fromPort: 1 },
            { from: "c", to: "e" },
            { from: "d", to: "e" },
          ],
        }),
      },
    );
    const result = (await response.json()) as any;
    assert.equal(result.status, "done");
    assert.equal(result.node_results.b.active_port, 0);
    assert.equal(result.node_results.d.reason, "branch_not_selected");
    assert.equal(result.node_results.e.output, "[c]: [b]: selected");
    assert.ok(!result.node_results.e.output.includes("[d]"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
