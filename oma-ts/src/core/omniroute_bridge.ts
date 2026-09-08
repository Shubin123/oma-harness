/**
 * OmniRoute Bridge - Connects OMA harness to a running OmniRoute gateway.
 *
 * When OmniRoute is running locally (default: http://localhost:20128), this
 * bridge routes all OMA provider calls through it, inheriting OmniRoute's
 * full feature set:
 *
 *   - 19+ routing strategies with auto-combo scoring
 *   - Three-layer circuit breaker with adaptive backoff
 *   - RTK + Caveman compression (15-95% token savings)
 *   - Quota-aware scheduling and budget enforcement
 *   - Vision/audio/video modality bridging
 *   - 352+ provider support with free-tier pooling
 *   - MCP server and A2A protocol support
 *
 * Zero external dependencies beyond Node.js built-ins.
 */

import * as http from 'node:http';
import * as https from 'node:https';

const DEFAULT_BASE_URL = 'http://localhost:20128';

/** OmniRoute auto-routing model aliases */
export const AUTO_MODELS: Record<string, string> = {
  auto:           'auto',
  'auto/coding':  'auto/coding',
  'auto/fast':    'auto/fast',
  'auto/cheap':   'auto/cheap',
  'auto/offline': 'auto/offline',
  'auto/smart':   'auto/smart',
};

/** Maps OMA provider names to OmniRoute-compatible model prefixes */
export const PROVIDER_MODEL_MAP: Record<string, string> = {
  claude:   'anthropic/claude-sonnet-4-20250514',
  chatgpt:  'openai/gpt-4o',
  gemini:   'google/gemini-2.0-flash',
  deepseek: 'deepseek/deepseek-chat',
  glm:      'zhipu/glm-4-flash',
  kimi:     'moonshot/moonshot-v1-auto',
};

export interface OmniRouteConfig {
  baseUrl: string;
  timeoutMs: number;
  autoModel: string;
  stream: boolean;
  temperature: number;
  maxTokens: number;
  extraHeaders: Record<string, string>;
}

const DEFAULT_CONFIG: OmniRouteConfig = {
  baseUrl: '',
  timeoutMs: 120_000,
  autoModel: 'auto',
  stream: false,
  temperature: 0.7,
  maxTokens: 4096,
  extraHeaders: {},
};

export interface BridgeResponse {
  ok: boolean;
  text: string;
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  latencyMs: number;
  cost: number;
  error: string;
  errorCode: number;
  raw: Record<string, unknown>;
}

function emptyResponse(): BridgeResponse {
  return {
    ok: false, text: '', model: '', provider: '',
    tokensIn: 0, tokensOut: 0, tokensTotal: 0,
    latencyMs: 0, cost: 0, error: '', errorCode: 0, raw: {},
  };
}

/**
 * Thin HTTP bridge to a running OmniRoute instance.
 *
 * OmniRoute serves an OpenAI-compatible API at /v1/chat/completions.
 * This bridge translates OMA's internal message format into that API
 * and extracts routing metadata from the response headers.
 */
export class OmniRouteBridge {
  config: OmniRouteConfig;
  private _available: boolean | null = null;
  private _modelsCache: string[] | null = null;
  private _modelsCacheTime = 0;

  constructor(config?: Partial<OmniRouteConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!this.config.baseUrl) {
      this.config.baseUrl = process.env.OMNIROUTE_URL ?? DEFAULT_BASE_URL;
    }
  }

  get available(): boolean {
    return this._available ?? false;
  }

  /** Check if OmniRoute is running and reachable. */
  async checkAvailability(): Promise<boolean> {
    try {
      const data = await this._get('/v1/models', 5000);
      this._available = !!data;
      return this._available;
    } catch {
      this._available = false;
      return false;
    }
  }

  /** Fetch available models from OmniRoute's catalog. */
  async listModels(forceRefresh = false): Promise<string[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this._modelsCache &&
      now - this._modelsCacheTime < 300_000
    ) {
      return this._modelsCache;
    }

    try {
      const data = await this._get('/v1/models', 10_000);
      const parsed = JSON.parse(data);
      const models = (parsed.data ?? []).map((m: Record<string, unknown>) => m.id as string);
      this._modelsCache = models;
      this._modelsCacheTime = now;
      return models;
    } catch {
      return [];
    }
  }

  /**
   * Send a chat completion request through OmniRoute.
   *
   * OmniRoute handles routing, fallback, compression, and all
   * provider-specific translation internally.
   */
  async chatCompletion(opts: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    system?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<BridgeResponse> {
    const fullMessages: Array<{ role: string; content: string }> = [];
    if (opts.system) {
      fullMessages.push({ role: 'system', content: opts.system });
    }
    fullMessages.push(...opts.messages);

    const payload = {
      model: opts.model ?? this.config.autoModel,
      messages: fullMessages,
      temperature: opts.temperature ?? this.config.temperature,
      max_tokens: opts.maxTokens ?? this.config.maxTokens,
      stream: this.config.stream,
    };

    const t0 = Date.now();
    try {
      const rawStr = await this._post(
        '/v1/chat/completions',
        JSON.stringify(payload),
        this.config.timeoutMs,
      );
      const rawData = JSON.parse(rawStr);
      const latency = Date.now() - t0;

      const choices = rawData.choices ?? [];
      let text = '';
      if (choices.length > 0) {
        text = choices[0]?.message?.content ?? '';
      }

      const usage = rawData.usage ?? {};
      const tokensIn = usage.prompt_tokens ?? 0;
      const tokensOut = usage.completion_tokens ?? 0;

      return {
        ok: true,
        text,
        model: rawData.model ?? opts.model ?? '',
        provider: rawData._omniroute_provider ?? '',
        tokensIn,
        tokensOut,
        tokensTotal: tokensIn + tokensOut,
        latencyMs: latency,
        cost: rawData._omniroute_cost ?? 0,
        error: '',
        errorCode: 0,
        raw: rawData,
      };
    } catch (err) {
      const resp = emptyResponse();
      resp.latencyMs = Date.now() - t0;
      resp.error = String(err);
      if (err && typeof err === 'object' && 'statusCode' in err) {
        resp.errorCode = (err as { statusCode: number }).statusCode;
      }
      return resp;
    }
  }

  /**
   * Map an OMA provider name to an OmniRoute model identifier.
   * If preferAuto is true and OmniRoute is available, returns the
   * auto-routing model (lets OmniRoute pick the best provider).
   */
  resolveModel(omaProvider: string, preferAuto = true): string {
    if (preferAuto && this.available) {
      return this.config.autoModel;
    }
    return PROVIDER_MODEL_MAP[omaProvider] ?? `${omaProvider}/default`;
  }

  /** Get OmniRoute gateway status. */
  async status(): Promise<Record<string, unknown>> {
    await this.checkAvailability();
    const result: Record<string, unknown> = {
      available: this.available,
      base_url: this.config.baseUrl,
      auto_model: this.config.autoModel,
    };

    if (this.available) {
      const models = await this.listModels();
      result.model_count = models.length;
      result.auto_variants = models.filter(m => m.startsWith('auto'));
    }

    return result;
  }

  /** Fetch analytics/telemetry from OmniRoute's dashboard API. */
  async getAnalytics(): Promise<Record<string, unknown>> {
    if (!this.available) return { error: 'OmniRoute not available' };
    try {
      const data = await this._get('/api/analytics', 10_000);
      return JSON.parse(data);
    } catch (err) {
      return { error: String(err) };
    }
  }

  // -- HTTP helpers (stdlib only) --

  private _get(path: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.config.baseUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.get(url.toString(), { timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            resolve(Buffer.concat(chunks).toString('utf-8'));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  private _post(path: string, body: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.config.baseUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        ...this.config.extraHeaders,
      };
      const opts = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers,
        timeout: timeoutMs,
      };
      const req = mod.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode && res.statusCode >= 400) {
            const err = Object.assign(new Error(`HTTP ${res.statusCode}: ${text}`), {
              statusCode: res.statusCode,
            });
            reject(err);
          } else {
            resolve(text);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }
}
