/**
 * OMA HTTP Providers - raw HTTP connectors for each subscription.
 *
 * No SDK dependencies. Each provider is defined as:
 *   - endpoint URL
 *   - default model
 *   - headers builder
 *   - request body builder
 *   - response parser
 *
 * This is the side-channel: we talk to every provider the same way,
 * using their public HTTP APIs directly.
 */

import { Provider, type ProviderResponse, type Message, type RateLimiter, ErrorClass } from './base.js';

interface ParsedResponse {
  text: string;
  tokens_in: number;
  tokens_out: number;
  model?: string;
}

type HeadersFn = (apiKey: string) => Record<string, string>;
type BodyFn = (opts: { messages: Message[]; system?: string; model: string; max_tokens: number; temperature: number }) => unknown;
type ParseFn = (raw: Record<string, unknown>) => ParsedResponse;

export interface ProviderConfig {
  endpoint: string;
  default_model: string;
  headers_fn: HeadersFn;
  body_fn: BodyFn;
  parse_fn: ParseFn;
}

async function httpPost(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await resp.json() as Record<string, unknown>;
    if (!resp.ok) {
      throw Object.assign(new Error(`HTTP ${resp.status}: ${JSON.stringify(raw).slice(0, 500)}`), { status: resp.status });
    }
    return raw;
  } finally {
    clearTimeout(timer);
  }
}

export class HTTPProvider extends Provider {
  endpoint: string;
  model: string;
  private headersFn: HeadersFn;
  private bodyFn: BodyFn;
  private parseFn: ParseFn;

  constructor(opts: {
    name: string;
    api_key: string;
    endpoint: string;
    model: string;
    headers_fn: HeadersFn;
    body_fn: BodyFn;
    parse_fn: ParseFn;
  }) {
    super(opts.api_key);
    this.name = opts.name;
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.headersFn = opts.headers_fn;
    this.bodyFn = opts.body_fn;
    this.parseFn = opts.parse_fn;
  }

  async complete(
    messages: Message[],
    system?: string,
    maxTokens = 4096,
    temperature = 0.3,
    opts?: Record<string, unknown>,
  ): Promise<ProviderResponse> {
    await this.rateLimiter.waitIfNeeded(maxTokens);

    const headers = this.headersFn(this.apiKey!);
    const model = (opts?.model as string) || this.model;
    const body = this.bodyFn({ messages, system, model, max_tokens: maxTokens, temperature });

    let endpoint = this.endpoint;
    // gemini needs model in URL and API key as query param
    if (this.name === 'gemini' && endpoint.includes('{model}')) {
      endpoint = endpoint.replace('{model}', model) + `?key=${this.apiKey}`;
    }

    const t0 = performance.now();
    try {
      const raw = await httpPost(endpoint, headers, body, this.timeout);
      const latency = performance.now() - t0;
      const result = this.parseFn(raw);
      this.rateLimiter.recordTokens(result.tokens_in + result.tokens_out);
      this.onSuccess();

      return {
        text: result.text,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        model: result.model || this.model,
        provider: this.name,
        latency_ms: latency,
        raw,
      };
    } catch (e) {
      const latency = performance.now() - t0;
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        text: '',
        tokens_in: 0,
        tokens_out: 0,
        model: this.model,
        provider: this.name,
        latency_ms: latency,
        error: errMsg.slice(0, 500),
        error_class: this.classifyError(e),
      };
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ---- provider configs ----

function claudeHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

function claudeBody({ messages, system, model, max_tokens, temperature }: { messages: Message[]; system?: string; model: string; max_tokens: number; temperature: number }): unknown {
  const body: Record<string, unknown> = { model, max_tokens, temperature, messages };
  if (system) body.system = system;
  return body;
}

function claudeParse(raw: Record<string, unknown>): ParsedResponse {
  const content = raw.content as Array<Record<string, string>> | undefined;
  const text = content?.[0]?.text ?? '';
  const usage = raw.usage as Record<string, number> | undefined;
  return {
    text,
    tokens_in: usage?.input_tokens ?? 0,
    tokens_out: usage?.output_tokens ?? 0,
    model: raw.model as string | undefined,
  };
}

function openaiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
}

function openaiBody({ messages, system, model, max_tokens, temperature }: { messages: Message[]; system?: string; model: string; max_tokens: number; temperature: number }): unknown {
  const msgs = [...messages];
  if (system) msgs.unshift({ role: 'system', content: system });
  return { model, max_tokens, temperature, messages: msgs };
}

function openaiParse(raw: Record<string, unknown>): ParsedResponse {
  const choices = raw.choices as Array<Record<string, unknown>> | undefined;
  const msg = choices?.[0]?.message as Record<string, string> | undefined;
  const text = msg?.content ?? '';
  const usage = raw.usage as Record<string, number> | undefined;
  return {
    text,
    tokens_in: usage?.prompt_tokens ?? 0,
    tokens_out: usage?.completion_tokens ?? 0,
    model: raw.model as string | undefined,
  };
}

function openaiResponsesBody({ messages, system, model, max_tokens }: { messages: Message[]; system?: string; model: string; max_tokens: number; temperature: number }): unknown {
  // GPT reasoning models reject temperature unless reasoning is disabled.
  // OMA manages context itself, so do not persist requests at the provider.
  const body: Record<string, unknown> = {
    model,
    input: [...messages],
    max_output_tokens: max_tokens,
    store: false,
  };
  if (system) body.instructions = system;
  return body;
}

function openaiResponsesParse(raw: Record<string, unknown>): ParsedResponse {
  const output = raw.output as Array<Record<string, unknown>> | undefined;
  const text = (output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => (item.content as Array<Record<string, unknown>> | undefined) ?? [])
    .filter(content => content.type === 'output_text')
    .map(content => content.text as string | undefined)
    .filter((part): part is string => typeof part === 'string')
    .join('');
  const usage = raw.usage as Record<string, number> | undefined;
  return {
    text,
    tokens_in: usage?.input_tokens ?? 0,
    tokens_out: usage?.output_tokens ?? 0,
    model: raw.model as string | undefined,
  };
}

function geminiHeaders(_apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

function geminiBody({ messages, system, model, max_tokens, temperature }: { messages: Message[]; system?: string; model: string; max_tokens: number; temperature: number }): unknown {
  const contents = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: max_tokens, temperature },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  return body;
}

function geminiParse(raw: Record<string, unknown>): ParsedResponse {
  const candidates = raw.candidates as Array<Record<string, unknown>> | undefined;
  const parts = (candidates?.[0]?.content as Record<string, unknown>)?.parts as Array<Record<string, string>> | undefined;
  const text = parts?.[0]?.text ?? '';
  const usage = raw.usageMetadata as Record<string, number> | undefined;
  return {
    text,
    tokens_in: usage?.promptTokenCount ?? 0,
    tokens_out: usage?.candidatesTokenCount ?? 0,
  };
}

function optionalBearerHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  return h;
}

export const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  claude: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    default_model: 'claude-sonnet-4-20250514',
    headers_fn: claudeHeaders,
    body_fn: claudeBody,
    parse_fn: claudeParse,
  },
  chatgpt: {
    // OpenAI Responses is the native protocol; the configs below retain the
    // Chat Completions protocol for third-party OpenAI-compatible APIs.
    endpoint: 'https://api.openai.com/v1/responses',
    default_model: 'gpt-5.4',
    headers_fn: openaiHeaders,
    body_fn: openaiResponsesBody,
    parse_fn: openaiResponsesParse,
  },
  gemini: {
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    default_model: 'gemini-2.0-flash',
    headers_fn: geminiHeaders,
    body_fn: geminiBody,
    parse_fn: geminiParse,
  },
  deepseek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    default_model: 'deepseek-chat',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  jev: {
    endpoint: 'https://api.typesafe.ai/v1/chat/completions',
    default_model: 'typesafe/jev',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  laya: {
    endpoint: 'http://127.0.0.1:8385/v1/chat/completions',
    default_model: 'convaiinnovations/laya',
    headers_fn: optionalBearerHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    default_model: 'llama-3.3-70b-versatile',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  mistral: {
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    default_model: 'mistral-small-latest',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    default_model: 'typesafe/jev',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  ollama: {
    endpoint: 'http://localhost:11434/v1/chat/completions',
    default_model: 'llama3',
    headers_fn: optionalBearerHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  together: {
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    default_model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  qwen: {
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    default_model: 'qwen-plus',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  glm: {
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    default_model: 'glm-4-flash',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
  kimi: {
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    default_model: 'moonshot-v1-8k',
    headers_fn: openaiHeaders,
    body_fn: openaiBody,
    parse_fn: openaiParse,
  },
};
