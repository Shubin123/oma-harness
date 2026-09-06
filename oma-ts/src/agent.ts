/**
 * OMA - Open Multi Agent harness.
 *
 * Wires together:
 *   - Core loop (invariant retry with time/token awareness)
 *   - Provider registry (Claude, Gemini, ChatGPT, DeepSeek, GLM, Kimi)
 *   - Criteria engine (define what "done" means)
 *   - Sanitizer (strip provider fingerprints)
 *   - Automation layers (pixel, page, memory)
 *   - Edge handlers (near-outage summarize, outage recovery)
 *
 * Usage:
 *   import { OMA } from './agent.js';
 *
 *   const agent = OMA.fromEnv();
 *   const result = await agent.run("build a web scraper for HN front page");
 *   console.log(result.artifacts.final);
 */

import { ContextOptimizer, PersistentMemory, WorkingMemory } from './automation/memory.js';
import { ensureCriteria } from './core/criteria.js';
import { nearOutageHandler } from './core/edge.js';
import { CoreLoop, type LoopConfig, DEFAULT_LOOP_CONFIG, TaskState } from './core/loop.js';
import { Sanitizer } from './core/sanitize.js';
import { ProviderRegistry } from './providers/registry.js';
import { providerResponseOk, providerResponseTokensTotal } from './providers/base.js';
import type { AuthManager } from './providers/auth.js';

export class OMA {
  registry: ProviderRegistry;
  config: LoopConfig;
  sanitizer: Sanitizer;
  working: WorkingMemory;
  persistent: PersistentMemory;
  optimizer: ContextOptimizer;

  constructor(opts: {
    registry: ProviderRegistry;
    config?: Partial<LoopConfig>;
    sanitizer?: Sanitizer;
    memoryDir?: string;
  }) {
    this.registry = opts.registry;
    this.config = {
      ...DEFAULT_LOOP_CONFIG,
      provider_chain: opts.registry.fallbackChain(),
      ...opts.config,
    };
    this.sanitizer = opts.sanitizer ?? new Sanitizer();
    this.working = new WorkingMemory();
    this.persistent = new PersistentMemory(opts.memoryDir ?? '.oma_memory');
    this.optimizer = new ContextOptimizer(this.config.token_budget);
  }

  /** Create OMA from environment variables. */
  static fromEnv(opts?: Partial<LoopConfig>): OMA {
    const registry = ProviderRegistry.fromEnv();
    return new OMA({ registry, config: opts });
  }

  /**
   * Create OMA from stored credentials (subscription or API key).
   * Used by the graphical UI - providers are registered from
   * browser-based login sessions rather than env vars.
   */
  static fromCredentials(authManager: AuthManager, opts?: Partial<LoopConfig>): OMA {
    let registry = ProviderRegistry.fromCredentials(authManager);
    if (registry.available().length === 0) {
      // fallback to env vars if no credentials stored
      registry = ProviderRegistry.fromEnv();
    }
    return new OMA({ registry, config: opts });
  }

  /**
   * Run the full agent loop.
   *
   * @param objective - what to accomplish
   * @param criteria - optional pre-defined success criteria
   * @param system - system prompt override
   * @param resumeFrom - task_id to resume from (loads persistent memory)
   */
  async run(opts: {
    objective: string;
    criteria?: Record<string, unknown>;
    system?: string;
    resumeFrom?: string;
  }): Promise<TaskState> {
    const { objective, criteria, system, resumeFrom } = opts;

    // load previous state if resuming
    let prevContext: Record<string, unknown> | null = null;
    if (resumeFrom) {
      const prev = this.persistent.load(resumeFrom);
      prevContext = prev;
      const handoffs = prev.handoffs as Array<Record<string, string>> | undefined;
      if (handoffs?.length) {
        const last = handoffs[handoffs.length - 1];
        this.working.put('handoff_context', last.summary, {
          tags: ['handoff', 'context'],
        });
      }
    }

    const solveFn = async (state: TaskState, providerName: string): Promise<[string, number, number]> => {
      const provider = this.registry.get(providerName);
      if (!provider) throw new Error(`provider ${providerName} not registered`);

      // build optimized context
      const [sysPrompt, messages] = this.optimizer.buildContext({
        system: system ?? 'You are an agent completing a task. Be direct and efficient.',
        task_state: state.snapshot() as unknown as Record<string, unknown>,
        working: this.working,
        persistent: prevContext,
        history: [],
      });

      // add the task as user message
      messages.push({
        role: 'user',
        content: `Complete this task: ${state.objective}\n\n` +
          `Criteria: ${JSON.stringify(state.criteria)}\n\n` +
          `Attempt ${state.attempts}. ` +
          `Previous confidence: ${state.confidence.toFixed(2)}`,
      });

      const response = await provider.complete(
        messages.map(m => ({ role: m.role, content: m.content })),
        sysPrompt,
        undefined,
        0.3,
      );

      if (!providerResponseOk(response)) {
        this.registry.recordFailure(
          providerName,
          response.error ?? 'unknown error',
          response.error_class!,
        );
        throw new Error(`${providerName}: ${response.error}`);
      }

      const tokensTotal = providerResponseTokensTotal(response);
      this.registry.recordSuccess(providerName, tokensTotal, response.latency_ms);

      // store in working memory
      this.working.put(`attempt_${state.attempts}`, response.text.slice(0, 500), {
        tags: ['attempt', 'result'],
        source: providerName,
      });

      // estimate confidence from response
      const confidence = this._estimateConfidence(response.text, state.criteria);

      return [response.text, tokensTotal, confidence];
    };

    const handoffFn = async (state: TaskState): Promise<void> => {
      const note = nearOutageHandler(
        state,
        this.working,
        Object.keys(state.criteria),
      );
      this.persistent.appendHandoff(state.task_id, note.toPrompt());
      this.persistent.mergeWorking(state.task_id, this.working);
    };

    const loop = new CoreLoop({
      config: this.config,
      solve_fn: solveFn,
      sanitize_fn: (text: string) => this.sanitizer.run(text),
      handoff_fn: handoffFn,
    });

    // always ensure criteria are present - defaults apply if none given
    const validatedCriteria = ensureCriteria(criteria ?? null);

    return loop.run(objective, validatedCriteria);
  }

  /** Heuristic confidence estimation. */
  private _estimateConfidence(output: string, criteria: Record<string, unknown>): number {
    if (!output) return 0;

    let score = 0.3; // baseline for non-empty output

    // length heuristic: very short answers are usually incomplete
    if (output.length > 200) score += 0.1;
    if (output.length > 1000) score += 0.1;

    // check if output addresses criteria keywords
    if (criteria && Object.keys(criteria).length > 0) {
      const outputLower = output.toLowerCase();
      const keys = Object.keys(criteria);
      const matched = keys.filter(key => outputLower.includes(key.toLowerCase())).length;
      score += 0.3 * (matched / keys.length);
    }

    // cap at 0.95 (never auto-confirm at 1.0 without eval)
    return Math.min(score, 0.95);
  }

  /** Current state of the agent. */
  status(): Record<string, unknown> {
    return {
      providers: this.registry.statusReport(),
      working_memory_entries: this.working._store.size,
      config: {
        token_budget: this.config.token_budget,
        wall_limit_s: this.config.wall_limit_s,
        confidence_threshold: this.config.confidence_threshold,
        provider_chain: this.config.provider_chain,
      },
    };
  }
}
