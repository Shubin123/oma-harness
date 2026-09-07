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

import { Provider, type ProviderResponse, type Message, RateLimiter, ErrorClass } from './base.js';
import { cleanToken } from './auth.js';
import crypto from 'node:crypto';

class SubscriptionProvider extends Provider {
  protected _credential: string;
  protected _authType: string;

  constructor(opts: { name: string; credential: string; authType?: string }) {
    super();
    this.name = opts.name;
    this._credential = opts.credential;
    this._authType = opts.authType ?? 'cookie';
    this.rateLimiter = new RateLimiter(20, 50_000); // conservative for web APIs
  }

  async complete(
    _messages: Message[],
    _system?: string,
    _maxTokens?: number,
    _temperature?: number,
  ): Promise<ProviderResponse> {
    throw new Error('not implemented');
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class ClaudeSubscriptionProvider extends SubscriptionProvider {
  static ENDPOINT = 'https://claude.ai/api/organizations/{org_id}/chat_conversations/{conv_id}/completion';
  static ORGS_ENDPOINT = 'https://claude.ai/api/organizations';

  private _orgId: string | null = null;
  private _convId: string | null = null;
  private _convObjective: string | null = null;

  constructor(sessionCookie: string) {
    const cleaned = cleanToken('claude', sessionCookie);
    super({ name: 'claude', credential: cleaned, authType: 'cookie' });
  }

  private _getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Cookie': `sessionKey=${this._credential}`,
      'User-Agent': BROWSER_UA,
      'Accept': 'text/event-stream',
      'Origin': 'https://claude.ai',
      'Referer': 'https://claude.ai/',
    };
  }

  private async _ensureOrg(): Promise<void> {
    if (this._orgId) return;
    try {
      const resp = await fetch(ClaudeSubscriptionProvider.ORGS_ENDPOINT, {
        headers: this._getHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      const orgs = await resp.json() as Array<Record<string, string>>;
      if (orgs?.length) {
        this._orgId = orgs[0].uuid ?? orgs[0].id ?? null;
      }
    } catch {
      this._orgId = null;
    }
  }

  /**
   * SESSION KEY FIX: create conversation with a meaningful name
   * derived from the objective so it doesn't show as "Untitled" in claude.ai.
   * Also reuse conversations within a session for the same objective.
   */
  private async _ensureConversation(objective: string): Promise<string | null> {
    // reuse existing conversation if same objective
    if (this._convId && this._convObjective === objective) {
      return this._convId;
    }

    if (!this._orgId) return null;

    try {
      const url = `https://claude.ai/api/organizations/${this._orgId}/chat_conversations`;
      // name the conversation with a truncated objective (max 80 chars)
      const convName = objective.length > 80
        ? objective.slice(0, 77) + '...'
        : objective;

      const resp = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify({
          name: `[OMA] ${convName}`,
          uuid: crypto.randomUUID(),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await resp.json() as Record<string, string>;
      this._convId = data.uuid ?? data.id ?? null;
      this._convObjective = objective;
      return this._convId;
    } catch {
      return null;
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
    await this._ensureOrg();

    if (!this._orgId) {
      return {
        text: '', tokens_in: 0, tokens_out: 0,
        model: 'claude-sonnet-4-20250514', provider: this.name,
        latency_ms: 0, error: 'No organization found - session may be expired',
        error_class: ErrorClass.FATAL,
      };
    }

    // derive a conversation name from the messages
    const objective = messages.find(m => m.role === 'user')?.content?.slice(0, 120) ?? 'OMA task';
    const convId = await this._ensureConversation(objective);
    if (!convId) {
      return {
        text: '', tokens_in: 0, tokens_out: 0,
        model: 'claude-sonnet-4-20250514', provider: this.name,
        latency_ms: 0, error: 'Failed to create conversation',
        error_class: ErrorClass.RETRYABLE,
      };
    }

    // build prompt from messages
    let promptText = '';
    if (system) promptText += `[System: ${system}]\n\n`;
    for (const msg of messages) {
      if (msg.role !== 'assistant') {
        promptText += msg.content + '\n';
      }
    }

    const url = ClaudeSubscriptionProvider.ENDPOINT
      .replace('{org_id}', this._orgId)
      .replace('{conv_id}', convId);

    const model = (opts?.model as string) || 'claude-sonnet-4-20250514';
    const body = { prompt: promptText, timezone: 'UTC', model };

    const t0 = performance.now();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
      const raw = await resp.text();

      // SSE stream - collect all text events
      let fullText = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (event.type === 'completion' || event.completion) {
              fullText += (event.completion as string) ?? '';
            }
          } catch { continue; }
        }
      }

      const latency = performance.now() - t0;
      this.onSuccess();

      return {
        text: fullText,
        tokens_in: Math.ceil(promptText.length / 4),
        tokens_out: Math.ceil(fullText.length / 4),
        model,
        provider: this.name,
        latency_ms: latency,
      };
    } catch (e) {
      const latency = performance.now() - t0;
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        text: '', tokens_in: 0, tokens_out: 0,
        model, provider: this.name,
        latency_ms: latency,
        error: errMsg.slice(0, 500),
        error_class: this.classifyError(e),
      };
    }
  }
}

export class ChatGPTSubscriptionProvider extends SubscriptionProvider {
  static ENDPOINT = 'https://chatgpt.com/backend-api/conversation';

  constructor(accessToken: string) {
    const cleaned = cleanToken('chatgpt', accessToken);
    super({ name: 'chatgpt', credential: cleaned, authType: 'token' });
  }

  private _getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._credential}`,
      'User-Agent': BROWSER_UA,
      'Accept': 'text/event-stream',
      'Origin': 'https://chatgpt.com',
      'Referer': 'https://chatgpt.com/',
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
      action: 'next',
      messages: [{
        id: crypto.randomUUID(),
        author: { role: 'user' },
        content: {
          content_type: 'text',
          parts: [promptParts.join('\n\n')],
        },
      }],
      parent_message_id: crypto.randomUUID(),
      model: (opts?.model as string) || 'gpt-4o',
      timezone_offset_min: 0,
    };

    const t0 = performance.now();
    try {
      const resp = await fetch(ChatGPTSubscriptionProvider.ENDPOINT, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
      const raw = await resp.text();

      let fullText = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            const msg = event.message as Record<string, unknown> | undefined;
            const parts = (msg?.content as Record<string, unknown>)?.parts as string[] | undefined;
            if (parts?.length) {
              fullText = parts[0]; // last message wins (accumulative)
            }
          } catch { continue; }
        }
      }

      const latency = performance.now() - t0;
      const prompt = promptParts.join('\n\n');
      this.onSuccess();

      return {
        text: fullText,
        tokens_in: Math.ceil(prompt.length / 4),
        tokens_out: Math.ceil(fullText.length / 4),
        model: 'gpt-4o',
        provider: this.name,
        latency_ms: latency,
      };
    } catch (e) {
      const latency = performance.now() - t0;
      const errMsg = e instanceof Error ? e.message : String(e);
      return {
        text: '', tokens_in: 0, tokens_out: 0,
        model: 'gpt-4o', provider: this.name,
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
    const cleaned = cleanToken('gemini', sessionCookie);
    super({ name: 'gemini', credential: cleaned, authType: 'cookie' });
  }

  private _getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Cookie': `__Secure-1PSID=${this._credential}`,
      'User-Agent': BROWSER_UA,
      'Origin': 'https://gemini.google.com',
      'Referer': 'https://gemini.google.com/',
    };
  }

  private async _getSnlm0e(): Promise<void> {
    if (this._snlm0e) return;
    try {
      const resp = await fetch('https://gemini.google.com/', {
        headers: this._getHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      const html = await resp.text();
      const match = html.match(/"SNlM0e":"([^"]+)"/);
      if (match) this._snlm0e = match[1];
    } catch { /* ignore */ }
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
      if (msg.role !== 'assistant') {
        promptParts.push(msg.content);
      }
    }
    const prompt = promptParts.join('\n\n');

    const model = (opts?.model as string) || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    };

    const t0 = performance.now();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
      const raw = await resp.json() as Record<string, unknown>;

      const candidates = raw.candidates as Array<Record<string, unknown>> | undefined;
      const parts = (candidates?.[0]?.content as Record<string, unknown>)?.parts as Array<Record<string, string>> | undefined;
      const text = parts?.[0]?.text ?? '';
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
        text: '', tokens_in: 0, tokens_out: 0,
        model: 'gemini-2.0-flash', provider: this.name,
        latency_ms: latency,
        error: errMsg.slice(0, 500),
        error_class: this.classifyError(e),
      };
    }
  }
}

// ---- factory ----

const SUBSCRIPTION_PROVIDERS: Record<string, new (cred: string) => SubscriptionProvider> = {
  claude: ClaudeSubscriptionProvider,
  chatgpt: ChatGPTSubscriptionProvider,
  gemini: GeminiSubscriptionProvider,
};

export function makeSubscriptionProvider(
  name: string,
  credentialValue: string,
  _authType = 'cookie',
): Provider | null {
  const Cls = SUBSCRIPTION_PROVIDERS[name];
  if (!Cls) return null;
  return new Cls(credentialValue);
}
