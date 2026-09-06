/**
 * OMA Provider Layer - unified interface for multiple LLM subscriptions.
 *
 * Each provider wraps a subscription (Claude, Gemini, ChatGPT, DeepSeek, GLM, Kimi)
 * behind a common interface. The connector layer handles:
 *   - auth (api key or session cookie)
 *   - rate limiting per provider
 *   - token counting (provider-native or estimated)
 *   - response normalization
 *   - error classification (retryable vs fatal)
 *
 * No provider gets special treatment. The loop picks them by availability and cost.
 */

export enum ErrorClass {
  RETRYABLE = 'retryable',
  FATAL = 'fatal',
  CAPACITY = 'capacity',
  BUDGET = 'budget',
}

export interface ProviderResponse {
  text: string;
  tokens_in: number;
  tokens_out: number;
  model: string;
  provider: string;
  latency_ms: number;
  raw?: unknown;
  error?: string;
  error_class?: ErrorClass;
}

export function providerResponseOk(r: ProviderResponse): boolean {
  return r.error === undefined;
}

export function providerResponseTokensTotal(r: ProviderResponse): number {
  return r.tokens_in + r.tokens_out;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class RateLimiter {
  requestsPerMinute: number;
  tokensPerMinute: number;
  private requestTimes: number[] = [];
  private tokenCounts: [number, number][] = [];

  constructor(rpm = 60, tpm = 100_000) {
    this.requestsPerMinute = rpm;
    this.tokensPerMinute = tpm;
  }

  async waitIfNeeded(estimatedTokens = 0): Promise<void> {
    const now = Date.now();
    const cutoff = now - 60_000;

    this.requestTimes = this.requestTimes.filter(t => t > cutoff);
    this.tokenCounts = this.tokenCounts.filter(([t]) => t > cutoff);

    if (this.requestTimes.length >= this.requestsPerMinute) {
      const wait = this.requestTimes[0] - cutoff;
      if (wait > 0) await sleep(wait);
    }

    const tokenSum = this.tokenCounts.reduce((s, [, c]) => s + c, 0);
    if (tokenSum + estimatedTokens > this.tokensPerMinute) {
      const wait = this.tokenCounts.length > 0 ? this.tokenCounts[0][0] - cutoff : 1000;
      if (wait > 0) await sleep(Math.max(wait, 500));
    }

    this.requestTimes.push(Date.now());
  }

  recordTokens(count: number): void {
    this.tokenCounts.push([Date.now(), count]);
  }
}

export interface Message {
  role: string;
  content: string;
}

export abstract class Provider {
  name = 'base';
  rateLimiter: RateLimiter;
  apiKey?: string;
  config: Record<string, unknown>;

  // adaptive timeout
  static TIMEOUT_BASE = 180_000;  // 3 min default
  static TIMEOUT_MAX = 600_000;   // 10 min ceiling
  static TIMEOUT_BACKOFF = 1.5;

  private currentTimeout: number;

  constructor(apiKey?: string, config?: Record<string, unknown>) {
    this.apiKey = apiKey;
    this.rateLimiter = new RateLimiter();
    this.config = config ?? {};
    this.currentTimeout = Provider.TIMEOUT_BASE;
  }

  get timeout(): number {
    return this.currentTimeout;
  }

  onTimeout(): void {
    this.currentTimeout = Math.min(
      this.currentTimeout * Provider.TIMEOUT_BACKOFF,
      Provider.TIMEOUT_MAX,
    );
  }

  onSuccess(): void {
    this.currentTimeout = Provider.TIMEOUT_BASE;
  }

  abstract complete(
    messages: Message[],
    system?: string,
    maxTokens?: number,
    temperature?: number,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse>;

  abstract countTokens(text: string): number;

  classifyError(error: unknown): ErrorClass {
    const msg = String(error).toLowerCase();
    if (['timed out', 'timeout', 'deadline', 'urlopen', 'abort'].some(k => msg.includes(k))) {
      this.onTimeout();
      return ErrorClass.RETRYABLE;
    }
    if (['rate limit', '429', 'too many'].some(k => msg.includes(k))) return ErrorClass.RETRYABLE;
    if (['overloaded', '503', 'capacity'].some(k => msg.includes(k))) return ErrorClass.CAPACITY;
    if (['billing', 'quota', 'insufficient'].some(k => msg.includes(k))) return ErrorClass.BUDGET;
    if (['401', '403', 'invalid key', 'unauthorized'].some(k => msg.includes(k))) return ErrorClass.FATAL;
    return ErrorClass.RETRYABLE; // default optimistic
  }
}
