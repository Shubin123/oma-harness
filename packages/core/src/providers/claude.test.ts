import { test } from "bun:test";
import assert from "node:assert/strict";
import { ClaudeSubscriptionProvider } from "./subscription.js";
const frame = (e: unknown) => "data: " + JSON.stringify(e) + "\n\n";
const reply =
  frame({ type: "message_start", message: { usage: { input_tokens: 7 } } }) +
  frame({
    type: "content_block_delta",
    delta: { type: "text_delta", text: "kiwi 🥝" },
  }) +
  frame({
    type: "message_delta",
    usage: { output_tokens: 3 },
    delta: { stop_reason: "end_turn" },
  }) +
  frame({ type: "message_stop" });
function fragmented(raw: string) {
  const bytes = new TextEncoder().encode(raw);
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (i >= bytes.length) c.close();
        else c.enqueue(bytes.slice(i, (i += 2)));
      },
    }),
  );
}
async function fixture(
  run: (
    p: ClaudeSubscriptionProvider,
    calls: Array<{ url: string; body: any }>,
  ) => Promise<void>,
  completion: () => Response = () => fragmented(reply),
) {
  const original = globalThis.fetch,
    calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      body: options?.body ? JSON.parse(String(options.body)) : null,
    });
    if (u.endsWith("/organizations")) return Response.json([{ uuid: "org" }]);
    if (u.endsWith("/chat_conversations"))
      return Response.json({ uuid: crypto.randomUUID() });
    return completion();
  }) as unknown as typeof fetch;
  try {
    await run(new ClaudeSubscriptionProvider("private-cookie"), calls);
  } finally {
    globalThis.fetch = original;
  }
}
test("Claude delivers modern fragmented text, retains assistant context and reuses one thread per project", async () =>
  fixture(async (p, calls) => {
    const messages = [
      { role: "user", content: "Remember kiwi" },
      { role: "assistant", content: "I remember kiwi" },
      { role: "user", content: "What was it?" },
    ];
    const deltas: string[] = [];
    let conversation = "";
    const r = await p.complete(messages, "System context", 77, 0.2, {
      conversationKey: "project-a",
      onDelta: (s: string) => deltas.push(s),
      onConversation: (id: string) => (conversation = id),
    });
    assert.equal(r.error, undefined);
    assert.equal(r.text, "kiwi 🥝");
    assert.equal(r.tokens_in + r.tokens_out, 10);
    assert.deepEqual(deltas, ["kiwi 🥝"]);
    assert.ok(conversation);
    const sent = calls.at(-1)!.body;
    assert.ok(sent.prompt.includes("assistant: I remember kiwi"));
    assert.ok(sent.prompt.includes("System context"));
    assert.equal(sent.max_tokens, 77);
    await p.complete(
      [
        ...messages,
        { role: "assistant", content: r.text },
        { role: "user", content: "Again please" },
      ],
      undefined,
      77,
      0.3,
      { conversationKey: "project-a" },
    );
    assert.equal(
      calls.filter((c) => c.url.endsWith("/chat_conversations")).length,
      1,
    );
    assert.equal(calls.at(-1)!.body.prompt, "Again please");
    await p.complete(messages, undefined, 77, 0.3, {
      conversationKey: "project-b",
    });
    assert.equal(
      calls.filter((c) => c.url.endsWith("/chat_conversations")).length,
      2,
    );
  }));
test("Claude can resume a saved browser conversation after server restart", async () =>
  fixture(async (p, calls) => {
    const id = crypto.randomUUID();
    const r = await p.complete(
      [{ role: "user", content: "continue" }],
      undefined,
      40,
      0.3,
      { conversationKey: "project", conversationId: id },
    );
    assert.equal(r.error, undefined);
    assert.equal(
      calls.filter((c) => c.url.endsWith("/chat_conversations")).length,
      0,
    );
    assert.ok(calls.at(-1)!.url.includes(id));
  }));
for (const status of [401, 403, 429, 503])
  test("Claude rejects completion HTTP " + status, async () =>
    fixture(
      async (p) => {
        const r = await p.complete([{ role: "user", content: "hi" }]);
        assert.equal(r.error, "Claude completion HTTP " + status);
        assert.equal(
          r.error_class,
          status === 401 || status === 403
            ? "fatal"
            : status === 503
              ? "capacity"
              : "retryable",
        );
      },
      () => new Response("secret", { status }),
    ),
  );
for (const [name, raw] of Object.entries({
  empty: frame({ type: "message_stop" }),
  truncated: frame({
    type: "content_block_delta",
    delta: { type: "text_delta", text: "partial" },
  }),
  error: frame({
    type: "error",
    error: { type: "overloaded_error", message: "secret" },
  }),
  malformed: "data: {bad}\n\n",
}))
  test("Claude rejects " + name + " replies", async () =>
    fixture(
      async (p) => {
        const r = await p.complete([{ role: "user", content: "hi" }]);
        assert.ok(r.error);
        assert.ok(!r.error!.includes("secret"));
      },
      () => fragmented(raw),
    ),
  );
test("Claude legacy completion events still deliver and require stop marker", async () =>
  fixture(
    async (p) => {
      assert.equal(
        (await p.complete([{ role: "user", content: "hi" }])).text,
        "legacy",
      );
    },
    () =>
      fragmented(frame({ completion: "legacy", stop_reason: "stop_sequence" })),
  ));
test("Claude authentication failures and empty prompts never spawn conversations", async () =>
  fixture(async (p, calls) => {
    assert.ok((await p.complete([])).error);
    assert.equal(calls.length, 0);
    globalThis.fetch = (async () =>
      new Response("secret", { status: 401 })) as unknown as typeof fetch;
    assert.equal(
      (await p.complete([{ role: "user", content: "hi" }])).error,
      "Claude organizations HTTP 401",
    );
    assert.equal(calls.length, 0);
  }));
test("Claude failed completion retries reuse the created conversation", async () => {
  let attempt = 0;
  await fixture(
    async (p, calls) => {
      assert.ok((await p.complete([{ role: "user", content: "hi" }])).error);
      assert.equal(
        (await p.complete([{ role: "user", content: "hi" }])).error,
        undefined,
      );
      assert.equal(
        calls.filter((c) => c.url.endsWith("/chat_conversations")).length,
        1,
      );
    },
    () =>
      ++attempt === 1 ? new Response("", { status: 503 }) : fragmented(reply),
  );
});
