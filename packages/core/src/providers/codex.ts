/** Subscription inference using the fresh token file maintained by Codex. */
import fs from "node:fs";
import {
  Provider,
  ErrorClass,
  type Message,
  type ProviderResponse,
} from "./base.js";
import { readEvents, requestSignal, emitDelta } from "./stream.js";
export interface CodexLink {
  auth_file: string;
  model: string;
}
export function readCodexLogin(authFile: string): {
  access_token: string;
  account_id: string;
} {
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const tokens = auth.tokens;
  if (
    typeof tokens?.access_token !== "string" ||
    !tokens.access_token ||
    typeof tokens?.account_id !== "string" ||
    !tokens.account_id
  )
    throw new Error("401 missing Codex login");
  return tokens;
}
export class CodexSubscriptionProvider extends Provider {
  override name = "codex";
  static ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
  constructor(
    readonly authFile: string,
    readonly model: string,
  ) {
    super();
  }
  countTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }
  async complete(
    messages: Message[],
    system?: string,
    maxTokens = 4096,
    _temperature = 0.3,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    const started = performance.now(),
      model = String(opts?.model || this.model);
    let text = "";
    let usage: { input_tokens?: number; output_tokens?: number } = {};
    let error: string | undefined, errorClass: ErrorClass | undefined;
    try {
      if (
        !messages.length ||
        messages.at(-1)?.role !== "user" ||
        !messages.at(-1)?.content.trim()
      )
        throw new Error("A nonempty user message is required");
      await this.rateLimiter.waitIfNeeded(maxTokens);
      const tokens = readCodexLogin(this.authFile);
      const response = await fetch(CodexSubscriptionProvider.ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokens.access_token,
          "ChatGPT-Account-ID": tokens.account_id,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          instructions: system || "You are a helpful assistant.",
          input: messages.map((m) => ({
            role: m.role,
            content: [
              {
                type: m.role === "assistant" ? "output_text" : "input_text",
                text: m.content,
              },
            ],
          })),
          store: false,
          stream: true,
        }),
        signal: requestSignal(this.timeout, opts),
      });
      if (!response.ok) throw new Error("Codex HTTP " + response.status);
      let completed = false;
      for await (const event of readEvents(response)) {
        if (event.type === "response.output_text.delta") {
          const delta = event.delta || "";
          text += delta;
          emitDelta(opts, delta);
        } else if (event.type === "response.completed") {
          completed = event.response?.status === "completed";
          usage = event.response?.usage || {};
        } else if (
          ["response.failed", "response.incomplete", "error"].includes(
            event.type,
          )
        )
          throw new Error("Codex inference failed or was incomplete");
      }
      if (!completed || !text.trim())
        throw new Error("Incomplete Codex text response");
      this.onSuccess();
    } catch (exc) {
      errorClass = this.classifyError(exc);
      error = "Codex request failed; check codex login and auth file";
      if (
        exc instanceof Error &&
        /^(Codex HTTP \d+|Incomplete Codex text response|Codex inference failed or was incomplete|A nonempty user message is required)$/.test(
          exc.message,
        )
      )
        error = exc.message;
    }
    const tokensIn =
      usage.input_tokens ?? this.countTokens(JSON.stringify(messages));
    const tokensOut =
      usage.output_tokens ?? (text ? this.countTokens(text) : 0);
    this.rateLimiter.recordTokens(tokensIn + tokensOut);
    return {
      text,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      model,
      provider: this.name,
      latency_ms: performance.now() - started,
      error,
      error_class: errorClass,
    };
  }
}
