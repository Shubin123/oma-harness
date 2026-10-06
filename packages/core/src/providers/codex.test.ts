import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexSubscriptionProvider } from "./codex.js";
import { ProviderRegistry } from "./registry.js";
import { AuthManager, CredentialStore } from "./auth.js";
const frame = (event: unknown) => "data: " + JSON.stringify(event) + "\r\n\r\n";
const done = {
  type: "response.completed",
  response: {
    status: "completed",
    usage: { input_tokens: 10, output_tokens: 2 },
  },
};
function bytes(text: string): Response {
  const data = new TextEncoder().encode(text);
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (index === data.length) c.close();
        else c.enqueue(data.slice(index, (index += 1)));
      },
    }),
  );
}
async function fixture(
  run: (provider: CodexSubscriptionProvider, file: string) => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-codex-"));
  const file = path.join(dir, "auth.json");
  const original = globalThis.fetch;
  fs.writeFileSync(
    file,
    JSON.stringify({
      tokens: { access_token: "first", account_id: "account" },
    }),
  );
  try {
    await run(new CodexSubscriptionProvider(file, "test-model"), file);
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("Codex links through registry, rereads refreshed login, and sends full structured conversation", async () =>
  fixture(async (provider, file) => {
    const manager = new AuthManager(
      new CredentialStore(path.join(path.dirname(file), "credentials.json")),
    );
    manager.storeCredential(
      "codex",
      JSON.stringify({ auth_file: file, model: "test-model" }),
      { authType: "codex_file" },
    );
    provider = ProviderRegistry.fromCredentials(manager).get(
      "codex",
    ) as CodexSubscriptionProvider;
    assert.equal(manager.store.get("codex")?.auth_type, "codex_file");
    for (const token of ["first", "refreshed"]) {
      fs.writeFileSync(
        file,
        JSON.stringify({
          tokens: { access_token: token, account_id: "account" },
        }),
      );
      globalThis.fetch = (async (
        url: RequestInfo | URL,
        options?: RequestInit,
      ) => {
        assert.equal(url, CodexSubscriptionProvider.ENDPOINT);
        assert.equal(
          (options!.headers as any).Authorization,
          "Bearer " + token,
        );
        assert.equal(
          (options!.headers as any)["ChatGPT-Account-ID"],
          "account",
        );
        const body = JSON.parse(String(options!.body));
        assert.equal(body.instructions, "System context");
        assert.equal(body.store, false);
        assert.equal(body.stream, true);
        assert.deepEqual(
          body.input.map((m: any) => [
            m.role,
            m.content[0].type,
            m.content[0].text,
          ]),
          [
            ["user", "input_text", "Remember kiwi"],
            ["assistant", "output_text", "I remember kiwi"],
            ["user", "input_text", "What was it?"],
          ],
        );
        return bytes(
          ": ping\r\n" +
            frame({ type: "response.output_text.delta", delta: "kiwi 🥝" }) +
            frame(done),
        );
      }) as unknown as typeof fetch;
      const deltas: string[] = [];
      const result = await provider.complete(
        [
          { role: "user", content: "Remember kiwi" },
          { role: "assistant", content: "I remember kiwi" },
          { role: "user", content: "What was it?" },
        ],
        "System context",
        100,
        0.3,
        { onDelta: (s: string) => deltas.push(s) },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.text, "kiwi 🥝");
      assert.deepEqual(deltas, ["kiwi 🥝"]);
      assert.equal(result.tokens_in + result.tokens_out, 12);
    }
    assert.ok(!JSON.stringify(manager.status()).includes("refreshed"));
    assert.ok(
      !fs
        .readFileSync(path.join(path.dirname(file), "credentials.json"), "utf8")
        .includes("refreshed"),
    );
  }));
for (const status of [401, 403, 429, 503])
  test(
    "Codex rejects HTTP " + status + " without leaking response body",
    async () =>
      fixture(async (provider) => {
        globalThis.fetch = (async () =>
          new Response("private credential echoed here", {
            status,
          })) as unknown as typeof fetch;
        const result = await provider.complete([
          { role: "user", content: "hi" },
        ]);
        assert.equal(result.error, "Codex HTTP " + status);
        assert.equal(
          result.error_class,
          status === 401 || status === 403
            ? "fatal"
            : status === 503
              ? "capacity"
              : "retryable",
        );
      }),
  );
for (const [name, stream] of Object.entries({
  empty: frame(done),
  truncated: frame({ type: "response.output_text.delta", delta: "partial" }),
  failed: frame({ type: "response.failed" }),
  incomplete: frame({ type: "response.incomplete" }),
  malformed: "data: {bad}\n\n",
}))
  test(
    "Codex does not accept " + name + " stream as successful delivery",
    async () =>
      fixture(async (provider) => {
        globalThis.fetch = (async () =>
          bytes(stream)) as unknown as typeof fetch;
        const result = await provider.complete([
          { role: "user", content: "hi" },
        ]);
        assert.ok(result.error);
        if (name === "truncated") assert.equal(result.text, "partial");
      }),
  );
test("Codex missing login and empty prompts fail before any network request", async () =>
  fixture(async (provider, file) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("must not call");
    }) as unknown as typeof fetch;
    assert.ok((await provider.complete([])).error);
    fs.unlinkSync(file);
    assert.ok(
      (await provider.complete([{ role: "user", content: "hi" }])).error,
    );
    assert.equal(calls, 0);
  }));
