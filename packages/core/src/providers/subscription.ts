/**
 * OMA Subscription Providers - use paid subscriptions instead of API keys.
 *
 * These providers connect to the web interfaces that paid subscribers
 * use (Claude Pro, ChatGPT Plus, Gemini Advanced), using session
 * cookies/tokens captured via browser login.
 *
 * This is the "side-channel" - same models, no separate API billing.
 *
 * Supported:
 *   - Claude: claude.ai web API (session cookie)
 *   - ChatGPT: chatgpt.com backend API (access token)
 *   - Gemini: gemini.google.com API (Google session cookie)
 *
 * SESSION KEY FIX: conversations are named with a truncated objective
 * so they don't appear as "Untitled" in claude.ai. Conversations are
 * reused within a session to avoid polluting the sidebar.
 */

import {
  Provider,
  type ProviderResponse,
  type Message,
  RateLimiter,
  ErrorClass,
} from "./base.js";
import { cleanToken } from "./auth.js";
import crypto from "node:crypto";
import { ClaudeCLIProvider } from "./claude-cli.js";
import { readEvents, requestSignal, emitDelta } from "./stream.js";
import { CodexSubscriptionProvider } from "./codex.js";

class SubscriptionProvider extends Provider {
  protected _credential: string;
  protected _authType: string;

  constructor(opts: { name: string; credential: string; authType?: string }) {
    super();
    this.name = opts.name;
    this._credential = opts.credential;
    this._authType = opts.authType ?? "cookie";
    this.rateLimiter = new RateLimiter(20, 50_000); // conservative for web APIs
  }

  async complete(
    _messages: Message[],
    _system?: string,
    _maxTokens?: number,
    _temperature?: number,
  ): Promise<ProviderResponse> {
    throw new Error("not implemented");
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export class ClaudeSubscriptionProvider extends SubscriptionProvider {
  static ENDPOINT =
    "https://claude.ai/api/organizations/{org_id}/chat_conversations/{conv_id}/completion";
  static ORGS_ENDPOINT = "https://claude.ai/api/organizations";
  private orgId: string | null = null;
  private conversations = new Map<string, string>();
  constructor(sessionCookie: string) {
    super({
      name: "claude",
      credential: cleanToken("claude", sessionCookie),
      authType: "cookie",
    });
  }
  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: "sessionKey=" + this._credential,
      "User-Agent": BROWSER_UA,
      Accept: "text/event-stream",
      Origin: "https://claude.ai",
      Referer: "https://claude.ai/",
    };
  }
  async complete(
    messages: Message[],
    system?: string,
    maxTokens = 4096,
    temperature = 0.3,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    const started = performance.now();
    const model = String(opts?.model || "claude-sonnet-4-20250514");
    let text = "",
      tokensIn = 0,
      tokensOut = 0;
    try {
      const latest = messages.at(-1);
      if (!latest || latest.role !== "user" || !latest.content.trim())
        throw new Error("A nonempty user message is required");
      await this.rateLimiter.waitIfNeeded(maxTokens);
      const signal = requestSignal(this.timeout, opts);
      if (!this.orgId) {
        const response = await fetch(ClaudeSubscriptionProvider.ORGS_ENDPOINT, {
          headers: this.headers(),
          signal,
        });
        if (!response.ok)
          throw new Error("Claude organizations HTTP " + response.status);
        const orgs = (await response.json()) as Array<Record<string, string>>;
        if (!Array.isArray(orgs) || (!orgs[0]?.uuid && !orgs[0]?.id))
          throw new Error("401 No Claude organization; check session");
        this.orgId = orgs[0].uuid || orgs[0].id;
      }
      const scope = String(
        opts?.conversationKey ||
          messages.find((m) => m.role === "user")!.content,
      );
      let id = this.conversations.get(scope);
      const supplied = opts?.conversationId;
      if (
        !id &&
        typeof supplied === "string" &&
        /^[a-f0-9-]{36}$/i.test(supplied)
      ) {
        id = supplied;
        this.conversations.set(scope, id);
      }
      const continuing = !!id;
      if (!id) {
        const response = await fetch(
          "https://claude.ai/api/organizations/" +
            this.orgId +
            "/chat_conversations",
          {
            method: "POST",
            headers: this.headers(),
            signal,
            body: JSON.stringify({
              name:
                "[OMA] " +
                messages.find((m) => m.role === "user")!.content.slice(0, 80),
              uuid: crypto.randomUUID(),
            }),
          },
        );
        if (!response.ok)
          throw new Error("Claude conversation HTTP " + response.status);
        const data = (await response.json()) as Record<string, string>;
        id = data.uuid || data.id;
        if (!id) throw new Error("Claude did not return a conversation ID");
        this.conversations.set(scope, id);
      }
      if (typeof opts?.onConversation === "function")
        (opts.onConversation as (id: string) => void)(id);
      // Existing web threads carry earlier turns. A newly created thread receives all roles.
      const prompt = continuing
        ? latest.content
        : [
            system ? "System: " + system : "",
            ...messages.map((m) => m.role + ": " + m.content),
          ]
            .filter(Boolean)
            .join("\n\n");
      const url = ClaudeSubscriptionProvider.ENDPOINT.replace(
        "{org_id}",
        this.orgId,
      ).replace("{conv_id}", id);
      const response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        signal,
        body: JSON.stringify({
          prompt,
          timezone: "UTC",
          model,
          max_tokens: maxTokens,
          temperature,
          attachments: [],
          files: [],
          rendering_mode: "messages",
        }),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          this.orgId = null;
        throw new Error("Claude completion HTTP " + response.status);
      }
      let completed = false;
      for await (const event of readEvents(response)) {
        if (event.type === "error")
          throw new Error(
            "Claude stream " + String(event.error?.type || "error"),
          );
        let delta = "";
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta"
        )
          delta = event.delta.text || "";
        else if (
          event.type === "content_block_start" &&
          event.content_block?.type === "text"
        )
          delta = event.content_block.text || "";
        else if (typeof event.completion === "string") delta = event.completion;
        if (delta) {
          text += delta;
          emitDelta(opts, delta);
        }
        if (event.type === "message_start")
          tokensIn = event.message?.usage?.input_tokens || 0;
        if (event.usage?.output_tokens) tokensOut = event.usage.output_tokens;
        if (event.type === "message_stop" || event.stop_reason)
          completed = true;
      }
      if (!completed || !text.trim())
        throw new Error("Claude stream ended without a complete text reply");
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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Claude request failed";
      // Never reflect response bodies, cookies, or arbitrary transport error strings.
      const safe = /^(Claude |HTTP |401 No Claude|A nonempty)/.test(message)
        ? message
        : "Claude request failed; check session or network";
      return {
        text,
        tokens_in: tokensIn,
        tokens_out: tokensOut || this.countTokens(text),
        model,
        provider: this.name,
        latency_ms: performance.now() - started,
        error: safe,
        error_class: this.classifyError(error),
      };
    }
  }
}

export class ChatGPTSubscriptionProvider extends SubscriptionProvider {
  static ENDPOINT = "https://chatgpt.com/backend-api/conversation";

  constructor(accessToken: string) {
    const cleaned = cleanToken("chatgpt", accessToken);
    super({ name: "chatgpt", credential: cleaned, authType: "token" });
  }

  private _getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this._credential}`,
      "User-Agent": BROWSER_UA,
      Accept: "text/event-stream",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
    };
  }

  async complete(
    messages: Message[],
    system?: string,
    maxTokens = 4096,
    temperature = 0.3,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    await this.rateLimiter.waitIfNeeded(maxTokens);

    const promptParts: string[] = [];
    if (system) promptParts.push(system);
    for (const msg of messages) {
      promptParts.push(msg.content);
    }

    const body = {
      action: "next",
      messages: [
        {
          id: crypto.randomUUID(),
          author: { role: "user" },
          content: {
            content_type: "text",
            parts: [promptParts.join("\n\n")],
          },
        },
      ],
      parent_message_id: crypto.randomUUID(),
      model: (opts?.model as string) || "gpt-4o",
      timezone_offset_min: 0,
    };

    const t0 = performance.now();
    try {
      const resp = await fetch(ChatGPTSubscriptionProvider.ENDPOINT, {
        method: "POST",
        headers: this._getHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
      const raw = await resp.text();

      let fullText = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            const msg = event.message as Record<string, unknown> | undefined;
            const parts = (msg?.content as Record<string, unknown>)?.parts as
              | string[]
              | undefined;
            if (parts?.length) {
              fullText = parts[0]; // last message wins (accumulative)
            }
          } catch {
            continue;
          }
        }
      }

      const latency = performance.now() - t0;
      const prompt = promptParts.join("\n\n");
      this.onSuccess();

      return {
        text: fullText,
        tokens_in: Math.ceil(prompt.length / 4),
        tokens_out: Math.ceil(fullText.length / 4),
        model: "gpt-4o",
        provider: this.name,
        latency_ms: latency,
      };
    } catch (e) {
      const latency = performance.now() - t0;
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        text: "",
        tokens_in: 0,
        tokens_out: 0,
        model: "gpt-4o",
        provider: this.name,
        latency_ms: latency,
        error: errMsg.slice(0, 500),
        error_class: this.classifyError(e),
      };
    }
  }
}

export class GeminiSubscriptionProvider extends SubscriptionProvider {
  private _snlm0e: string | null = null;

  constructor(sessionCookie: string) {
    const cleaned = cleanToken("gemini", sessionCookie);
    super({ name: "gemini", credential: cleaned, authType: "cookie" });
  }

  private _getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: `__Secure-1PSID=${this._credential}`,
      "User-Agent": BROWSER_UA,
      Origin: "https://gemini.google.com",
      Referer: "https://gemini.google.com/",
    };
  }

  private async _getSnlm0e(): Promise<void> {
    if (this._snlm0e) return;
    try {
      const resp = await fetch("https://gemini.google.com/", {
        headers: this._getHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      const html = await resp.text();
      const match = html.match(/"SNlM0e":"([^"]+)"/);
      if (match) this._snlm0e = match[1];
    } catch {
      /* ignore */
    }
  }

  async complete(
    messages: Message[],
    system?: string,
    maxTokens = 4096,
    temperature = 0.3,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    await this.rateLimiter.waitIfNeeded(maxTokens);
    await this._getSnlm0e();

    const promptParts: string[] = [];
    if (system) promptParts.push(system);
    for (const msg of messages) {
      if (msg.role !== "assistant") {
        promptParts.push(msg.content);
      }
    }
    const prompt = promptParts.join("\n\n");

    const model = (opts?.model as string) || "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    };

    const t0 = performance.now();
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this._getHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
      const raw = (await resp.json()) as Record<string, unknown>;

      const candidates = raw.candidates as
        | Array<Record<string, unknown>>
        | undefined;
      const parts = (candidates?.[0]?.content as Record<string, unknown>)
        ?.parts as Array<Record<string, string>> | undefined;
      const text = parts?.[0]?.text ?? "";
      const usage = raw.usageMetadata as Record<string, number> | undefined;

      const latency = performance.now() - t0;
      this.onSuccess();

      return {
        text,
        tokens_in: usage?.promptTokenCount ?? Math.ceil(prompt.length / 4),
        tokens_out: usage?.candidatesTokenCount ?? Math.ceil(text.length / 4),
        model,
        provider: this.name,
        latency_ms: latency,
      };
    } catch (e) {
      const latency = performance.now() - t0;
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        text: "",
        tokens_in: 0,
        tokens_out: 0,
        model: "gemini-2.0-flash",
        provider: this.name,
        latency_ms: latency,
        error: errMsg.slice(0, 500),
        error_class: this.classifyError(e),
      };
    }
  }
}

// ---- factory ----

const SUBSCRIPTION_PROVIDERS: Record<
  string,
  new (cred: string) => SubscriptionProvider
> = {
  claude: ClaudeSubscriptionProvider,
  chatgpt: ChatGPTSubscriptionProvider,
  gemini: GeminiSubscriptionProvider,
};

export function makeSubscriptionProvider(
  name: string,
  credentialValue: string,
  _authType = "cookie",
): Provider | null {
  if (name === "codex" && _authType === "codex_file") {
    const config = JSON.parse(credentialValue);
    return new CodexSubscriptionProvider(config.auth_file, config.model);
  }
  if (name === "claude" && _authType === "claude_cli") {
    const c = JSON.parse(credentialValue);
    return new ClaudeCLIProvider(c.command, c.model);
  }
  const Cls = SUBSCRIPTION_PROVIDERS[name];
  if (!Cls) return null;
  return new Cls(credentialValue);
}
