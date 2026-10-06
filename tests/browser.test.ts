import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { createDashboardServer } from "@oma/dashboard";
import { ProjectStore } from "../apps/dashboard/src/projects.js";
import { AuthManager, CredentialStore } from "@oma/core/providers/auth";
import { OMA } from "@oma/core/agent";
import { ProviderRegistry } from "@oma/core/providers/registry";
import { ClaudeSubscriptionProvider } from "@oma/core/providers/subscription";
import { CodexSubscriptionProvider } from "@oma/core/providers/codex";
const frame = (e: unknown) => "data: " + JSON.stringify(e) + "\n\n";
async function send(page: Page, text: string) {
  await page.locator("#project-command").fill(text);
  await page.locator("#project-send").click();
  await page.waitForFunction(
    () =>
      !(document.querySelector("#project-send") as HTMLButtonElement).disabled,
  );
}
for (const provider of ["codex", "claude"])
  test(
    provider +
      " browser linking, message delivery, thread context, cache reload, offline commands and failures",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-browser-")),
        file = path.join(dir, "auth.json");
      fs.writeFileSync(
        file,
        JSON.stringify({
          tokens: {
            access_token: "browser-fixture-token",
            account_id: "fixture-account",
          },
        }),
      );
      const originalFetch = globalThis.fetch,
        oldCodexHome = process.env.CODEX_HOME;
      process.env.CODEX_HOME = dir;
      const calls: Array<{ url: string; body: any }> = [];
      let fail = false,
        convCount = 0;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        options?: RequestInit,
      ) => {
        const url = String(input);
        if (
          !url.startsWith("https://claude.ai/") &&
          !url.startsWith("https://chatgpt.com/")
        )
          return originalFetch(input, options);
        const body = options?.body ? JSON.parse(String(options.body)) : null;
        calls.push({ url, body });
        if (url.endsWith("/organizations"))
          return Response.json([{ uuid: "fixture-org", name: "Fixture" }]);
        if (url.endsWith("/chat_conversations")) {
          convCount++;
          return Response.json({ uuid: crypto.randomUUID() });
        }
        if (fail)
          return new Response("never expose private response", { status: 401 });
        const codex = url === CodexSubscriptionProvider.ENDPOINT;
        const prompt = codex ? body.input.at(-1).content[0].text : body.prompt;
        const text = prompt.includes("linked")
          ? "linked"
          : prompt.includes("What fruit")
            ? "mango"
            : "Remembered mango";
        const delta = codex
          ? { type: "response.output_text.delta", delta: text }
          : {
              type: "content_block_delta",
              delta: { type: "text_delta", text },
            };
        const done = codex
          ? {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 8, output_tokens: 4 },
              },
            }
          : { type: "message_stop" };
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(frame(delta)));
              await Bun.sleep(120);
              controller.enqueue(new TextEncoder().encode(frame(done)));
              controller.close();
            },
          }),
        );
      }) as typeof fetch;
      const auth = new AuthManager(
          new CredentialStore(path.join(dir, "credentials.json")),
        ),
        registry = new ProviderRegistry();
      if (provider === "claude") {
        auth.storeSessionToken("claude", "browser-private-cookie", {
          authType: "cookie",
        });
        registry.register(
          "claude",
          new ClaudeSubscriptionProvider("browser-private-cookie"),
        );
      } else
        registry.register(
          "codex",
          new CodexSubscriptionProvider(file, "fixture-model"),
        );
      const store = new ProjectStore(path.join(dir, "projects")),
        legacy = store.create("Imported project");
      store.message(legacy.id, "user", "Imported history", {
        kind: "imported_chat",
      });
      const server = createDashboardServer({
        auth,
        agent: new OMA({ registry, fallback_enabled: false }),
        projectStore: store,
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      const browser = await chromium.launch({ headless: true }),
        context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() =>
        localStorage.setItem("oma_onboarding_completed", "true"),
      );
      try {
        await page.goto("http://127.0.0.1:" + port);
        await page.waitForFunction(
          () =>
            document.querySelector("#project-status")?.textContent ===
            "Browser cache ready",
        );
        await page.evaluate(() => (window as any).showView("workflows"));
        assert.ok(
          (await page.locator("#project-history").innerText()).includes(
            "Imported history",
          ),
        );
        if (provider === "codex") {
          await page.evaluate(() => (window as any).showView("connect"));
          await page
            .getByRole("button", { name: "Link Codex and test a message" })
            .click();
          await page.waitForFunction(() =>
            document
              .querySelector("#status-codex")
              ?.textContent?.includes("verified"),
          );
          assert.equal(auth.store.get("codex")?.auth_type, "codex_file");
          assert.ok(
            !JSON.stringify(auth.status()).includes("browser-fixture-token"),
          );
          await page.evaluate(() => (window as any).showView("workflows"));
        }
        await page.locator("#tier-primary").fill(provider);
        await page.locator("#tier-fallback").fill(provider);
        await page.locator("#tier-fallback").dispatchEvent("change");
        await page.locator("#project-command").fill("Remember mango");
        await page.locator("#project-send").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#project-history")
            ?.textContent?.includes("[streaming]"),
        );
        await page.waitForFunction(
          () =>
            !(document.querySelector("#project-send") as HTMLButtonElement)
              .disabled,
        );
        assert.ok(
          (await page.locator("#project-history").innerText()).includes(
            "assistant [sent]: Remembered mango",
          ),
        );
        await page.reload();
        await page.waitForFunction(
          () =>
            document.querySelector("#project-status")?.textContent ===
            "Browser cache ready",
        );
        await page.evaluate(() => (window as any).showView("workflows"));
        await send(page, "What fruit did I name?");
        assert.ok(
          (await page.locator("#project-history").innerText()).includes(
            "assistant [sent]: mango",
          ),
        );
        if (provider === "codex") {
          const sent = calls
            .filter((c) => c.url === CodexSubscriptionProvider.ENDPOINT)
            .at(-1)!.body;
          assert.ok(
            sent.input.some(
              (m: any) =>
                m.role === "assistant" &&
                m.content[0].text === "Remembered mango",
            ),
          );
        } else {
          assert.equal(convCount, 1);
          assert.equal(
            calls.filter((c) => c.url.endsWith("/completion")).at(-1)!.body
              .prompt,
            "What fruit did I name?",
          );
        }
        // Failed messages and partial replies remain visible and reloadable.
        fail = true;
        await send(page, "fail this message");
        assert.ok(
          (await page.locator("#project-history").innerText()).includes(
            "[failed]",
          ),
        );
        assert.ok(
          await page.getByRole("button", { name: "Retry message" }).count(),
        );
        fail = false;
        await page.getByRole("button", { name: "Retry message" }).click();
        await page.waitForFunction(
          () =>
            !(document.querySelector("#project-send") as HTMLButtonElement)
              .disabled,
        );
        assert.equal(
          await page.getByRole("button", { name: "Retry message" }).count(),
          0,
        );
        const requestCount = calls.length;
        await page.route("**/api/**", (route) => route.abort());
        await send(page, "/task add Offline parser");
        await send(page, "/cleanup");
        await page.locator("#wf-input").fill("cached workflow input");
        await page.locator("#project-command").fill("unsent draft");
        await page.waitForTimeout(100);
        await page.reload();
        await page.waitForFunction(
          () =>
            document.querySelector("#project-status")?.textContent ===
            "Browser cache ready",
        );
        await page.evaluate(() => (window as any).showView("workflows"));
        assert.equal(
          await page.locator("#project-command").inputValue(),
          "unsent draft",
        );
        assert.equal(
          await page.locator("#wf-input").inputValue(),
          "cached workflow input",
        );
        assert.ok(
          (await page.locator("#project-tasks").innerText()).includes(
            "Offline parser",
          ),
        );
        assert.ok(
          (await page.locator("#project-cleanup").innerText()).includes(
            "Laya cleanup",
          ),
        );
        assert.equal(calls.length, requestCount);
        const exported = await page.evaluate(() =>
          (window as any).browserProjects?.export?.(),
        );
        // Inspect the actual database record; credentials must never enter project cache.
        const cached = await page.evaluate(
          () =>
            new Promise<string>((resolve, reject) => {
              const req = indexedDB.open("oma-harness", 1);
              req.onsuccess = () => {
                const read = req.result
                  .transaction("projects")
                  .objectStore("projects")
                  .getAll();
                read.onsuccess = () => {
                  resolve(JSON.stringify(read.result));
                  req.result.close();
                };
                read.onerror = () => reject(read.error);
              };
            }),
        );
        assert.ok(cached.includes("Remembered mango"));
        assert.ok(!cached.includes("browser-private-cookie"));
        assert.ok(!cached.includes("browser-fixture-token"));
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        await new Promise<void>((r) => server.close(() => r()));
        globalThis.fetch = originalFetch;
        if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = oldCodexHome;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    30000,
  );

test("IndexedDB preserves rich data, rejects stale writes and quota failures, exports/imports and recovers interrupted states", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cache-"));
  const auth = new AuthManager(
    new CredentialStore(path.join(dir, "credentials.json")),
  );
  const server = createDashboardServer({
    auth,
    agent: new OMA({
      registry: new ProviderRegistry(),
      fallback_enabled: false,
    }),
    projectStore: new ProjectStore(path.join(dir, "projects")),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const bundle = await Bun.build({
    entrypoints: ["tests/fixtures/storage.ts"],
    target: "browser",
  });
  assert.ok(bundle.success);
  const browser = await chromium.launch({ headless: true }),
    page = await browser.newPage();
  try {
    await page.goto("http://127.0.0.1:" + port);
    await page.addScriptTag({ content: await bundle.outputs[0].text() });
    const result = await page.evaluate(async () => {
      const {
        BrowserProjects,
        createProject,
        appendMessage,
        serialize,
        deserialize,
      } = (window as any).storageTest;
      const store = new BrowserProjects("cache-regression-a"),
        p = createProject("Rich cache");
      p.cleanup = {
        map: new Map([["a", new Set([1, 2])]]),
        date: new Date("2026-10-06"),
        big: 5n,
      };
      appendMessage(p, "user", "pending", { kind: "chat", status: "sending" });
      appendMessage(p, "assistant", "partial reply", {
        kind: "chat",
        status: "streaming",
      });
      p.runs = [
        {
          id: "run",
          status: "running",
          node_results: { a: { status: "running" }, b: { status: "queued" } },
        },
      ];
      const saved = await store.save(p),
        restored = await store.get(p.id);
      const rich =
        restored.cleanup.map instanceof Map &&
        restored.cleanup.map.get("a") instanceof Set &&
        restored.cleanup.date instanceof Date &&
        restored.cleanup.big === 5n;
      const a = deserialize(serialize(saved)),
        b = deserialize(serialize(saved));
      a.name = "First edit";
      b.name = "Second edit";
      const writes = await Promise.allSettled([store.save(a), store.save(b)]);
      const staleRejected =
        writes.filter((r) => r.status === "rejected").length === 1;
      const before = await store.get(p.id);
      const put = IDBObjectStore.prototype.put;
      let quotaRejected = false;
      IDBObjectStore.prototype.put = function () {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      };
      try {
        await store.save({ ...before, name: "Lost edit" });
      } catch {
        quotaRejected = true;
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      const quotaPreserved = (await store.get(p.id)).name === before.name;
      const recovered = await store.recover(p.id);
      const interrupted =
        recovered.messages.every((m: any) => m.status === "interrupted") &&
        recovered.messages[1].content === "partial reply" &&
        recovered.runs[0].status === "interrupted" &&
        recovered.runs[0].node_results.a.status === "failed" &&
        recovered.runs[0].node_results.b.status === "blocked";
      const exported = await store.export(),
        other = new BrowserProjects("cache-regression-b");
      await other.import(exported);
      const imported =
        (await other.get(p.id)).messages[1].content === "partial reply";
      const existing = await other.get(p.id);
      existing.name = "Local wins";
      await other.save(existing);
      await other.import(exported);
      const localWins = (await other.get(p.id)).name === "Local wins";
      let invalidRejected = false;
      try {
        await other.import('{"id":"bad"}');
      } catch {
        invalidRejected = true;
      }
      await store.close();
      await other.close();
      return {
        rich,
        staleRejected,
        quotaRejected,
        quotaPreserved,
        interrupted,
        imported,
        localWins,
        invalidRejected,
      };
    });
    assert.deepEqual(result, {
      rich: true,
      staleRejected: true,
      quotaRejected: true,
      quotaPreserved: true,
      interrupted: true,
      imported: true,
      localWins: true,
      invalidRejected: true,
    });
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
