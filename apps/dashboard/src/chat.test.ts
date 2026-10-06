import { test } from "bun:test";
import assert from "node:assert/strict";
import { ChatService } from "./chat.js";
import {
  Provider,
  type Message,
  type ProviderResponse,
} from "@oma/core/providers/base";
import { ProviderRegistry } from "@oma/core/providers/registry";
import { newId, DEFAULT_TIERS } from "@oma/shared";
import { verifyToken } from "./web.js";
class Recorder extends Provider {
  calls = 0;
  messages: Message[] = [];
  fail = false;
  defer?: () => Promise<void>;
  constructor(name: string) {
    super();
    this.name = name;
  }
  countTokens() {
    return 10;
  }
  async complete(
    messages: Message[],
    _system?: string,
    _max?: number,
    _temp?: number,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    this.calls++;
    this.messages = messages;
    if (this.defer) await this.defer();
    if (typeof opts?.onDelta === "function") opts.onDelta("reply");
    return {
      text: this.fail ? "" : "reply",
      error: this.fail ? "HTTP 401" : undefined,
      tokens_in: 10,
      tokens_out: 10,
      provider: this.name,
      model: "fixture",
      latency_ms: 1,
    };
  }
}
const request = () => ({
  project_id: newId(),
  request_id: newId(),
  messages: [
    { role: "user", content: "Remember mango" },
    { role: "assistant", content: "Mango saved" },
    { role: "user", content: "What fruit?" },
  ],
  tiers: { ...DEFAULT_TIERS },
});
for (const name of ["codex", "claude"])
  test(
    name +
      " chat sends conversational roles once and replays duplicate delivery receipts",
    async () => {
      const registry = new ProviderRegistry(),
        provider = new Recorder(name);
      registry.register(name, provider);
      const service = new ChatService(registry),
        r = request();
      r.tiers.primary = name;
      r.tiers.fallback = name;
      const events: any[] = [];
      const a = await service.send(r, (e) => events.push(e));
      assert.equal(a.status, "sent");
      assert.deepEqual(provider.messages, r.messages);
      assert.equal(events.find((e) => e.type === "delta").text, "reply");
      assert.deepEqual(await service.send(r), a);
      assert.equal(provider.calls, 1);
      await assert.rejects(
        () =>
          service.send({
            ...r,
            messages: [{ role: "user", content: "changed" }],
          }),
        /different messages/,
      );
    },
  );
test("Chat concurrent duplicate requests share delivery; other messages in same thread wait for user retry", async () => {
  const registry = new ProviderRegistry(),
    p = new Recorder("codex");
  registry.register("codex", p);
  let release!: () => void;
  p.defer = () => new Promise((resolve) => (release = resolve));
  const service = new ChatService(registry),
    r = request(),
    first = service.send(r),
    second = service.send(r);
  await assert.rejects(
    () => service.send({ ...r, request_id: newId() }),
    /already sending/,
  );
  release();
  assert.deepEqual(await first, await second);
  assert.equal(p.calls, 1);
});
test("Claude disabled budget blocks actual calls; provider errors are visible with no canned success", async () => {
  const registry = new ProviderRegistry(),
    p = new Recorder("claude");
  registry.register("claude", p);
  const service = new ChatService(registry),
    r = request();
  r.tiers = {
    primary: "claude",
    fallback: "claude",
    claude_max_calls: 0,
    claude_max_tokens: 50,
  };
  const result = await service.send(r);
  assert.equal(result.status, "failed");
  assert.equal(p.calls, 0);
  assert.match(result.error!, /limit/);
  p.fail = true;
  r.request_id = newId();
  r.tiers.claude_max_calls = 1;
  assert.equal((await service.send(r)).status, "failed");
  assert.equal(p.calls, 1);
});
test("A primary failure reaches only the configured fallback and respects its cap", async () => {
  const registry = new ProviderRegistry(),
    codex = new Recorder("codex"),
    claude = new Recorder("claude");
  codex.fail = true;
  registry.register("codex", codex);
  registry.register("claude", claude);
  const result = await new ChatService(registry).send(request());
  assert.equal(result.provider, "claude");
  assert.equal(result.status, "sent");
  assert.equal(result.claude_usage.calls, 1);
  assert.equal(codex.calls, 1);
  assert.equal(claude.calls, 1);
});
test("Tokens containing test still go through real verification", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("", { status: 401 });
  }) as unknown as typeof fetch;
  try {
    assert.equal(
      (await verifyToken("claude", "sk-ant-sid-test-expired"))[0],
      false,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
