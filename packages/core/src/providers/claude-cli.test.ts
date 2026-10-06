import { test } from "bun:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { ClaudeCLIProvider, type CliRunner } from "./claude-cli.js";
import { AuthManager, CredentialStore } from "./auth.js";
import { ProviderRegistry } from "./registry.js";
const delta = {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    delta: { type: "text_delta", text: "mango 🥭" },
  },
};
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "mango 🥭",
  usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 },
};
function fixture(events: any[], code = 0): CliRunner {
  return () => {
    const bytes = new TextEncoder().encode(
      events
        .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
        .join("\n"),
    );
    let i = 0;
    return {
      stdout: new ReadableStream({
        pull(c) {
          if (i === bytes.length) c.close();
          else c.enqueue(bytes.slice(i, (i += 1)));
        },
      }),
      exited: Promise.resolve(code),
      kill: () => {},
    };
  };
}
test("Claude CLI sends all roles on stdin, streams Unicode, counts cache usage, bounds turns/output/retries and disables persistence", async () => {
  const deltas: string[] = [];
  const runner: CliRunner = (command, args, input, env, signal) => {
    assert.equal(command, "/fixture/claude");
    assert.deepEqual(
      JSON.parse(input.split("\n")[1]).map((m: any) => m.role),
      ["user", "assistant", "user"],
    );
    assert.ok(input.includes("remembered"));
    assert.ok(args.includes("--no-session-persistence"));
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.equal(args[args.indexOf("--max-turns") + 1], "1");
    assert.equal(env.CLAUDE_CODE_MAX_RETRIES, "0");
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "40");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    return fixture([
      delta,
      {
        type: "assistant",
        message: {
          model: "resolved-model",
          content: [{ type: "text", text: "mango 🥭" }],
        },
      },
      success,
    ])(command, args, input, env, signal);
  };
  const provider = new ClaudeCLIProvider("/fixture/claude", "sonnet", runner);
  const r = await provider.complete(
    [
      { role: "user", content: "mango" },
      { role: "assistant", content: "remembered" },
      { role: "user", content: "what?" },
    ],
    undefined,
    40,
    0.3,
    { onDelta: (s: string) => deltas.push(s) },
  );
  assert.equal(r.error, undefined);
  assert.equal(r.text, "mango 🥭");
  assert.equal(r.tokens_in + r.tokens_out, 12);
  assert.equal(r.model, "resolved-model");
  assert.deepEqual(deltas, ["mango 🥭"]);
});
for (const [name, events, code] of [
  ["empty", [{ ...success, result: "" }], 0],
  ["interrupted", [delta], 0],
  [
    "failed",
    [
      {
        type: "result",
        is_error: true,
        subtype: "error_during_execution",
        errors: ["secret"],
      },
    ],
    0,
  ],
  ["nonzero", [delta, success], 1],
  ["malformed", ["{bad}"], 0],
] as const)
  test("Claude CLI rejects " + name + " completion", async () => {
    const r = await new ClaudeCLIProvider(
      "/fixture/claude",
      "sonnet",
      fixture([...events], code),
    ).complete([{ role: "user", content: "hi" }]);
    assert.ok(r.error);
    assert.ok(!r.error!.includes("secret"));
  });
test("Claude CLI links are registered without copying OAuth tokens or imposing an arbitrary link expiry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cli-link-"));
  try {
    const auth = new AuthManager(
      new CredentialStore(path.join(dir, "credentials.json")),
    );
    const command = path.resolve(dir, "claude");
    const c = auth.storeCredential(
      "claude",
      JSON.stringify({ command, model: "sonnet" }),
      { authType: "claude_cli" },
    );
    assert.equal(c.auth_type, "claude_cli");
    assert.equal(c.expires_at, undefined);
    assert.ok(
      ProviderRegistry.fromCredentials(auth).get("claude") instanceof
        ClaudeCLIProvider,
    );
    assert.equal(auth.status().claude.auth_type, "claude_cli");
    assert.throws(() =>
      auth.storeCredential("claude", "{}", { authType: "claude_cli" }),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
