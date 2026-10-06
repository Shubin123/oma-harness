/** Enforce workflow caps before invoking the provider, including retry calls. */
import {
  Provider,
  ErrorClass,
  type Message,
  type ProviderResponse,
} from "./base.js";
export class LimitedProvider extends Provider {
  calls = 0;
  tokens = 0;
  constructor(
    readonly provider: Provider,
    readonly maxCalls = 2,
    readonly maxTokens = 8000,
  ) {
    super();
    this.name = provider.name;
  }
  countTokens(text: string): number {
    return this.provider.countTokens(text);
  }
  async complete(
    messages: Message[],
    system?: string,
    maxTokens = 4096,
    temperature = 0.3,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    const input = this.countTokens(
      (system || "") + messages.map((m) => m.content).join("\n"),
    );
    const remaining = this.maxTokens - this.tokens - input;
    if (this.calls >= this.maxCalls || remaining <= 0)
      return {
        text: "",
        tokens_in: 0,
        tokens_out: 0,
        model: "",
        provider: this.name,
        latency_ms: 0,
        error: "Claude workflow usage limit reached",
        error_class: ErrorClass.BUDGET,
      };
    const allowed = Math.min(maxTokens, remaining);
    const reservation = input + allowed;
    this.calls++;
    this.tokens += reservation;
    let response: ProviderResponse | undefined;
    try {
      response = await this.provider.complete(
        messages,
        system,
        allowed,
        temperature,
        opts,
      );
      return response;
    } finally {
      this.tokens +=
        (response ? response.tokens_in + response.tokens_out : reservation) -
        reservation;
    }
  }
}

export async function limitedAgent(
  agent: import("../agent.js").OMA,
  tiers: {
    primary: string;
    fallback: string;
    claude_max_calls: number;
    claude_max_tokens: number;
  },
): Promise<import("../agent.js").OMA> {
  const { OMA } = await import("../agent.js");
  const { ProviderRegistry } = await import("./registry.js");
  const registry = new ProviderRegistry();
  const chain = [
    ...new Set(
      [tiers.primary, tiers.fallback].filter((name) =>
        agent.registry.get(name),
      ),
    ),
  ];
  for (const name of chain) {
    let provider = agent.registry.get(name)!;
    if (name === "claude")
      provider = new LimitedProvider(
        provider,
        tiers.claude_max_calls,
        tiers.claude_max_tokens,
      );
    registry.register(name, provider);
  }
  const result = new OMA({
    registry,
    config: { ...agent.config, provider_chain: chain, max_attempts: 1 },
    routingStrategy: "priority",
    fallback_enabled: false,
  });
  result.classifier = agent.classifier;
  return result;
}
