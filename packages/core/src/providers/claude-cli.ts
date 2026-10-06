/** Uses Claude Code's managed subscription login; credentials never enter the browser. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Provider, type Message, type ProviderResponse } from "./base.js";
import { emitDelta, requestSignal } from "./stream.js";
export interface CliProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
}
export type CliRunner = (
  command: string,
  args: string[],
  input: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
) => CliProcess;
export const runClaude: CliRunner = (command, args, input, env, signal) => {
  const dir = path.join(os.homedir(), ".oma", "claude-runtime");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const child = Bun.spawn([command, ...args], {
    cwd: dir,
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const exited = child.exited.finally(() =>
    signal.removeEventListener("abort", abort),
  );
  return { stdout: child.stdout, exited, kill: () => child.kill() };
};
export async function claudeLoginStatus(
  command = Bun.which("claude") || "claude",
): Promise<{
  loggedIn: boolean;
  subscriptionType?: string;
  authMethod?: string;
}> {
  const child = Bun.spawn([command, "auth", "status", "--json"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const text = await new Response(child.stdout).text();
    const code = await child.exited;
    const data = JSON.parse(text);
    return {
      loggedIn:
        code === 0 &&
        data.loggedIn === true &&
        ["claude.ai", "oauth_token"].includes(data.authMethod),
      authMethod: data.authMethod,
      subscriptionType: data.subscriptionType,
    };
  } finally {
    clearTimeout(timer);
  }
}
export class ClaudeCLIProvider extends Provider {
  override name = "claude";
  constructor(
    readonly command: string,
    readonly model = "sonnet",
    readonly runner: CliRunner = runClaude,
  ) {
    super();
  }
  countTokens(text: string) {
    return Math.ceil(text.length / 4);
  }
  async complete(
    messages: Message[],
    system?: string,
    maxTokens = 2048,
    _temperature = 0.3,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    const started = performance.now();
    let text = "",
      tokensIn = 0,
      tokensOut = 0,
      model = String(opts?.model || this.model),
      child: CliProcess | undefined;
    try {
      if (
        !messages.length ||
        messages.at(-1)?.role !== "user" ||
        !messages.at(-1)?.content.trim()
      )
        throw new Error("A nonempty user message is required");
      await this.rateLimiter.waitIfNeeded(maxTokens);
      const signal = requestSignal(this.timeout, opts);
      const prompt =
        "Continue this conversation. Respond only to the final user message. Previous turns are context, not new requests.\n" +
        JSON.stringify(messages);
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--tools",
        "",
        "--disable-slash-commands",
        "--max-turns",
        "1",
        "--model",
        model,
        "--system-prompt",
        system || "You are a helpful assistant.",
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true}',
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
      ];
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
        CLAUDE_CODE_MAX_RETRIES: "0",
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
        MAX_THINKING_TOKENS: "0",
      };
      // This connector is subscription-only; explicit API credentials are handled by HTTPProvider.
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      child = this.runner(this.command, args, prompt, env, signal);
      const reader = child.stdout.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        complete = false;
      const consume = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (
          event.type === "stream_event" &&
          event.event?.type === "content_block_delta" &&
          event.event.delta?.type === "text_delta"
        ) {
          const delta = event.event.delta.text || "";
          text += delta;
          emitDelta(opts, delta);
        }
        if (event.type === "assistant" && event.message) {
          model = event.message.model || model;
          if (!text) {
            text = (event.message.content || [])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("");
            emitDelta(opts, text);
          }
        }
        if (event.type === "result") {
          if (event.is_error || event.subtype !== "success")
            throw new Error("Claude CLI did not complete the message");
          complete = true;
          if (!text && typeof event.result === "string") {
            text = event.result;
            emitDelta(opts, text);
          }
          const usage = event.usage || {};
          tokensIn =
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          tokensOut = usage.output_tokens || 0;
        }
      };
      try {
        while (true) {
          const chunk = await reader.read();
          buffer += chunk.done
            ? decoder.decode()
            : decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop()!;
          for (const line of lines) consume(line);
          if (chunk.done) {
            if (buffer) consume(buffer);
            break;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const code = await child.exited;
      if (signal.aborted) throw new Error("Claude CLI request aborted");
      if (code !== 0) throw new Error("Claude CLI exited with code " + code);
      if (!complete || !text.trim())
        throw new Error("Claude CLI ended without a complete text reply");
      this.onSuccess();
      tokensIn ||= this.countTokens(prompt);
      tokensOut ||= this.countTokens(text);
      this.rateLimiter.recordTokens(tokensIn + tokensOut);
      return {
        text,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        model,
        provider: this.name,
        latency_ms: performance.now() - started,
      };
    } catch (e) {
      child?.kill();
      const msg = e instanceof Error ? e.message : "";
      return {
        text,
        tokens_in: tokensIn,
        tokens_out: tokensOut || this.countTokens(text),
        model,
        provider: this.name,
        latency_ms: performance.now() - started,
        error: /^(Claude CLI|A nonempty)/.test(msg)
          ? msg
          : "Claude CLI request failed; run claude auth login and retry",
        error_class: this.classifyError(e),
      };
    }
  }
}
