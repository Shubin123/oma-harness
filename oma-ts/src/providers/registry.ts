/**
 * OMA Provider Registry - plug-and-play multi-subscription connector.
 *
 * Register providers by name, look them up, chain them for fallback.
 * The registry also tracks health (success/fail rates) per provider
 * and reorders the chain dynamically.
 *
 * Side-channel approach: no single provider's SDK is a hard dependency.
 * Each provider impl uses raw HTTP or optional SDK, imported lazily.
 */

import { Provider, ErrorClass } from './base.js';
import { PROVIDER_CONFIGS, HTTPProvider } from './http-providers.js';
import { detectAuthType, cleanToken } from './auth.js';

export class ProviderHealth {
  name: string;
  successes = 0;
  failures = 0;
  totalTokens = 0;
  totalLatencyMs = 0;
  lastError: string | null = null;
  lastErrorClass: ErrorClass | null = null;
  lastSuccessAt = 0;
  cooldownUntil = 0;

  constructor(name: string) {
    this.name = name;
  }

  get successRate(): number {
    const total = this.successes + this.failures;
    return total > 0 ? this.successes / total : 0.5; // prior
  }

  get avgLatencyMs(): number {
    return this.successes > 0 ? this.totalLatencyMs / this.successes : Infinity;
  }

  get isCooledDown(): boolean {
    return Date.now() >= this.cooldownUntil;
  }

  recordSuccess(tokens: number, latencyMs: number): void {
    this.successes++;
    this.totalTokens += tokens;
    this.totalLatencyMs += latencyMs;
    this.lastSuccessAt = Date.now();
    this.lastError = null;
  }

  recordFailure(error: string, errorClass: ErrorClass): void {
    this.failures++;
    this.lastError = error;
    this.lastErrorClass = errorClass;
    const now = Date.now();
    // timeouts are retryable - short cooldown, don't give up
    const isTimeout = ['timeout', 'timed out', 'urlopen'].some(k => error.toLowerCase().includes(k));
    if (isTimeout) {
      this.cooldownUntil = now + 5_000;
    } else if (errorClass === ErrorClass.RETRYABLE) {
      this.cooldownUntil = now + 10_000;
    } else if (errorClass === ErrorClass.CAPACITY) {
      this.cooldownUntil = now + 30_000;
    } else if (errorClass === ErrorClass.BUDGET) {
      this.cooldownUntil = now + 300_000;
    } else if (errorClass === ErrorClass.FATAL) {
      this.cooldownUntil = now + 600_000;
    }
  }
}

export class ProviderRegistry {
  private _providers = new Map<string, Provider>();
  private _health = new Map<string, ProviderHealth>();

  register(name: string, provider: Provider): this {
    this._providers.set(name, provider);
    this._health.set(name, new ProviderHealth(name));
    return this;
  }

  get(name: string): Provider | undefined {
    return this._providers.get(name);
  }

  health(name: string): ProviderHealth | undefined {
    return this._health.get(name);
  }

  /** Providers not in cooldown. */
  available(): string[] {
    return [...this._health.entries()]
      .filter(([, h]) => h.isCooledDown)
      .map(([name]) => name);
  }

  /** Pick the provider with best success rate * inverse latency, among available. */
  bestAvailable(): string | null {
    const avail = this.available();
    if (avail.length === 0) return null;

    const score = (name: string): number => {
      const h = this._health.get(name)!;
      const rate = h.successRate;
      const speed = 1.0 / (h.avgLatencyMs + 1.0);
      return rate * 0.7 + speed * 0.3;
    };

    return avail.reduce((best, name) =>
      score(name) > score(best) ? name : best
    );
  }

  /** All available providers, ordered by score descending. */
  fallbackChain(): string[] {
    const avail = this.available();

    const score = (name: string): number => {
      const h = this._health.get(name)!;
      return h.successRate * 0.7 + (1.0 / (h.avgLatencyMs + 1.0)) * 0.3;
    };

    return avail.sort((a, b) => score(b) - score(a));
  }

  recordSuccess(name: string, tokens: number, latencyMs: number): void {
    this._health.get(name)?.recordSuccess(tokens, latencyMs);
  }

  recordFailure(name: string, error: string, errorClass: ErrorClass): void {
    this._health.get(name)?.recordFailure(error, errorClass);
  }

  statusReport(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, h] of this._health) {
      result[name] = {
        success_rate: `${(h.successRate * 100).toFixed(1)}%`,
        avg_latency_ms: `${h.avgLatencyMs.toFixed(0)}`,
        total_tokens: h.totalTokens,
        in_cooldown: !h.isCooledDown,
        last_error: h.lastError,
      };
    }
    return result;
  }

  /** Auto-discover providers from environment variables. */
  static fromEnv(checkGeneric = false): ProviderRegistry {
    const reg = new ProviderRegistry();
    const envMap: Record<string, string[]> = {
      claude: ['OMA_CLAUDE_KEY'],
      gemini: ['OMA_GEMINI_KEY'],
      chatgpt: ['OMA_OPENAI_KEY'],
      deepseek: ['OMA_DEEPSEEK_KEY'],
      glm: ['OMA_GLM_KEY'],
      kimi: ['OMA_KIMI_KEY'],
    };

    if (checkGeneric) {
      envMap.claude.push('ANTHROPIC_API_KEY', 'CLAUDE_SESSION_KEY', 'CLAUDE_COOKIE');
      envMap.chatgpt.push('OPENAI_API_KEY', 'CHATGPT_ACCESS_TOKEN');
      envMap.gemini.push('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_COOKIE');
      envMap.deepseek.push('DEEPSEEK_API_KEY');
    }

    for (const [name, envVars] of Object.entries(envMap)) {
      for (const ev of envVars) {
        const rawKey = process.env[ev];
        if (rawKey) {
          const authType = detectAuthType(name, rawKey);
          const cleaned = cleanToken(name, rawKey);
          let provider: Provider | null = null;
          if (authType === 'cookie' || authType === 'token') {
            provider = makeSubscriptionProvider(name, cleaned, authType);
          } else {
            provider = makeHTTPProvider(name, cleaned);
          }
          if (provider) {
            reg.register(name, provider);
          }
          break;
        }
      }
    }

    return reg;
  }

  /** Build registry from stored credentials (subscription login or API key). */
  static fromCredentials(authManager: { store: { allProviders(): Record<string, { auth_type: string; value: string }> } }): ProviderRegistry {
    const reg = new ProviderRegistry();
    const creds = authManager.store.allProviders();

    for (const [name, cred] of Object.entries(creds)) {
      let provider: Provider | null = null;
      if (cred.auth_type === 'api_key') {
        provider = makeHTTPProvider(name, cred.value);
      } else {
        // lazy import subscription provider
        provider = makeSubscriptionProvider(name, cred.value, cred.auth_type);
      }
      if (provider) reg.register(name, provider);
    }

    return reg;
  }
}

function makeHTTPProvider(name: string, apiKey: string): Provider | null {
  const config = PROVIDER_CONFIGS[name];
  if (!config) return null;

  return new HTTPProvider({
    name,
    api_key: apiKey,
    endpoint: config.endpoint,
    model: config.default_model,
    headers_fn: config.headers_fn,
    body_fn: config.body_fn,
    parse_fn: config.parse_fn,
  });
}

function makeSubscriptionProvider(name: string, credentialValue: string, authType: string): Provider | null {
  // lazy import to avoid circular deps
  const { makeSubscriptionProvider: factory } = require('./subscription.js');
  return factory(name, credentialValue, authType);
}
