import {
  ErrorClass,
  type Message,
  type ProviderResponse,
} from "@oma/core/providers/base";
import { ProviderRegistry } from "@oma/core/providers/registry";
import { LimitedProvider } from "@oma/core/providers/limited";
import { validateTiers, DEFAULT_TIERS, type Tiers } from "@oma/shared";
export interface ChatRequest {
  project_id: string;
  request_id: string;
  messages: Message[];
  tiers?: Tiers;
  conversations?: Record<string, string>;
  system?: string;
}
export interface ChatResult {
  status: "sent" | "failed";
  output: string;
  provider: string;
  error?: string;
  conversations: Record<string, string>;
  claude_usage: { calls: number; tokens: number };
}
export class ChatService {
  private requests = new Map<
    string,
    { fingerprint: string; promise: Promise<ChatResult> }
  >();
  private active = new Set<string>();
  constructor(readonly registry: ProviderRegistry) {}
  async send(
    request: ChatRequest,
    emit: (event: Record<string, unknown>) => void = () => {},
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    if (
      !/^[a-f0-9]{32}$/.test(request.project_id) ||
      !/^[a-f0-9]{32}$/.test(request.request_id)
    )
      throw new Error("Invalid project or request ID");
    if (
      !Array.isArray(request.messages) ||
      !request.messages.length ||
      request.messages.some(
        (m) =>
          !m ||
          !["user", "assistant"].includes(m.role) ||
          typeof m.content !== "string" ||
          !m.content.trim(),
      ) ||
      request.messages.at(-1)?.role !== "user"
    )
      throw new Error(
        "Chat requires a nonempty user message and valid history",
      );
    const tiers = validateTiers(request.tiers || DEFAULT_TIERS);
    const key = request.project_id + ":" + request.request_id;
    const fingerprint = JSON.stringify({
      messages: request.messages,
      tiers,
      system: request.system,
    });
    const existing = this.requests.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("Request ID already used for different messages");
      return existing.promise;
    }
    if (this.active.has(request.project_id))
      throw new Error("A message is already sending for this project");
    this.active.add(request.project_id);
    const promise = this.deliver(request, tiers, emit, signal).finally(() =>
      this.active.delete(request.project_id),
    );
    this.requests.set(key, { fingerprint, promise });
    // Retain in-flight requests and bounded completed delivery receipts.
    if (this.requests.size > 1000) {
      for (const k of this.requests.keys()) {
        if (!this.active.has(k.split(":")[0])) {
          this.requests.delete(k);
          break;
        }
      }
    }
    return promise;
  }
  private async deliver(
    request: ChatRequest,
    tiers: Tiers,
    emit: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const conversations = { ...request.conversations };
    let last: ProviderResponse | undefined;
    let limited: LimitedProvider | undefined;
    for (const name of new Set([tiers.primary, tiers.fallback])) {
      let provider = this.registry.get(name);
      if (!provider) continue;
      if (signal?.aborted) break;
      if (name === "claude") {
        limited = new LimitedProvider(
          provider,
          tiers.claude_max_calls,
          tiers.claude_max_tokens,
        );
        provider = limited;
      }
      emit({ type: "sending", provider: name });
      last = await provider.complete(
        request.messages,
        request.system ||
          "Continue this project conversation. Answer the latest user message.",
        2048,
        0.3,
        {
          signal,
          conversationKey: request.project_id,
          conversationId: conversations[name],
          onConversation: (id: string) => {
            conversations[name] = id;
            emit({ type: "conversation", provider: name, id });
          },
          onDelta: (text: string) =>
            emit({ type: "delta", provider: name, text }),
        },
      );
      if (!last.error && last.text.trim()) {
        this.registry.recordSuccess(
          name,
          last.tokens_in + last.tokens_out,
          last.latency_ms,
        );
        return {
          status: "sent",
          output: last.text,
          provider: name,
          conversations,
          claude_usage: {
            calls: limited?.calls || 0,
            tokens: limited?.tokens || 0,
          },
        };
      }
      this.registry.recordFailure(
        name,
        last.error || "Empty reply",
        last.error_class || ErrorClass.RETRYABLE,
      );
      emit({
        type: "attempt_failed",
        provider: name,
        error: last.error || "Provider returned an empty reply",
        partial: last.text,
      });
    }
    return {
      status: "failed",
      output: last?.text || "",
      provider: last?.provider || tiers.primary,
      error: last?.error || "No connected provider returned a reply",
      conversations,
      claude_usage: {
        calls: limited?.calls || 0,
        tokens: limited?.tokens || 0,
      },
    };
  }
}
