/**
 * OMA - Open Multi Agent harness.
 *
 * Wires together:
 *   - RALPH loop (Reason, Act, Learn, Plan, Handoff)
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
import {
  RalphLoop,
  type LoopConfig,
  DEFAULT_LOOP_CONFIG,
  TaskState,
  type Strategy,
  type Reasoning,
  type Lesson,
  type PlanDecision,
  type PhaseEvent,
} from './core/loop.js';
import { Sanitizer } from './core/sanitize.js';
import { ProviderRegistry } from './providers/registry.js';
import { providerResponseOk, providerResponseTokensTotal } from './providers/base.js';
import { AuthManager } from './providers/auth.js';

export class OMA {
  registry: ProviderRegistry;
  config: LoopConfig;
  sanitizer: Sanitizer;
  working: WorkingMemory;
  persistent: PersistentMemory;
  optimizer: ContextOptimizer;
  // ralph phase tracking for GUI
  private _currentPhase = 'idle';
  private _phaseEvents: Array<Record<string, unknown>> = [];

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
  static fromEnv(opts?: Partial<LoopConfig>, checkGeneric = false): OMA {
    const registry = ProviderRegistry.fromEnv(checkGeneric);
    return new OMA({ registry, config: opts });
  }

  /**
   * Create OMA by loading securely stored credentials first,
   * falling back to environment variables.
   */
  static load(opts?: { config?: Partial<LoopConfig>; memoryDir?: string }): OMA {
    const auth = new AuthManager();
    let registry = ProviderRegistry.fromCredentials(auth);
    if (registry.available().length === 0) {
      registry = ProviderRegistry.fromEnv(true);
    }
    return new OMA({ registry, config: opts?.config, memoryDir: opts?.memoryDir });
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
      registry = ProviderRegistry.fromEnv(true);
    }
    return new OMA({ registry, config: opts });
  }

  /**
   * Run the full RALPH agent loop.
   *
   * @param objective - what to accomplish
   * @param criteria - optional pre-defined success criteria
   * @param system - system prompt override
   * @param resumeFrom - task_id to resume from (loads persistent memory)
   * @param onPhase - optional callback for phase transitions (GUI use)
   */
  async run(opts: {
    objective: string;
    criteria?: Record<string, unknown>;
    system?: string;
    resumeFrom?: string;
    onPhase?: (event: PhaseEvent) => void;
  }): Promise<TaskState> {
    const { objective, criteria, system, resumeFrom, onPhase } = opts;

    this._currentPhase = 'idle';
    this._phaseEvents = [];

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

      // add the task as user message, enriched with strategy context
      let strategyCtx = '';
      if (state.strategy) {
        const notes = (state.strategy as Record<string, unknown>).approach_notes as string[] | undefined;
        if (notes?.length) {
          strategyCtx = '\n\nLessons from previous attempts:\n' +
            notes.slice(-3).map(n => `- ${n}`).join('\n');
        }
      }

      messages.push({
        role: 'user',
        content: `Complete this task: ${state.objective}\n\n` +
          `Criteria: ${JSON.stringify(state.criteria)}\n\n` +
          `Attempt ${state.attempts}. ` +
          `Previous confidence: ${state.confidence.toFixed(2)}` +
          strategyCtx,
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

    const reasonFn = (state: TaskState, strategy: Strategy): Reasoning => {
      // gather provider health info
      const health = this.registry.statusReport();
      const healthyProviders = Object.entries(health)
        .filter(([, h]) => !(h as Record<string, unknown>).in_cooldown)
        .map(([name]) => name);

      const reasoning: Reasoning = {
        analysis: '',
        approach: '',
        focus_areas: [],
        provider_preference: '',
      };

      if (state.attempts === 1) {
        reasoning.analysis = `First attempt: ${state.objective}`;
        reasoning.approach = 'direct';
        const best = this.registry.bestAvailable();
        if (best) reasoning.provider_preference = best;
      } else if (strategy.consecutive_failures > 2) {
        reasoning.analysis =
          `Consecutive failures: ${strategy.consecutive_failures}. Switching strategy.`;
        reasoning.approach = 'alternative';
        if (healthyProviders.length > 0) {
          reasoning.provider_preference = healthyProviders[healthyProviders.length - 1];
        }
      } else if (strategy.best_confidence > 0.5) {
        reasoning.analysis =
          `Making progress (best: ${strategy.best_confidence.toFixed(2)}). Refining approach.`;
        reasoning.approach = 'refinement';
      } else {
        reasoning.analysis = `Attempt ${state.attempts}, exploring.`;
        reasoning.approach = 'iterative';
      }

      if (Object.keys(state.criteria).length > 0) {
        reasoning.focus_areas = Object.keys(state.criteria).slice(0, 5);
      }

      return reasoning;
    };

    const planFn = (state: TaskState, strategy: Strategy, lesson: Lesson): PlanDecision => {
      const decision: PlanDecision = {
        action: 'continue',
        reason: '',
        reorder_providers: [],
        adjust_temperature: null,
        refine_prompt: '',
        escalate: false,
      };

      // check: threshold met?
      if (strategy.best_confidence >= state.confidence_threshold) {
        decision.action = 'done';
        decision.reason =
          `Confidence ${strategy.best_confidence.toFixed(2)} >= threshold ${state.confidence_threshold}`;
        return decision;
      }

      // track failures
      if (lesson.succeeded) {
        strategy.consecutive_failures = 0;
      } else {
        strategy.consecutive_failures++;
      }

      // too many failures
      if (strategy.consecutive_failures >= 3) {
        decision.action = 'park';
        decision.reason = 'consecutive_failures';
        return decision;
      }

      // budget check
      const remainingPct = state.remainingTokens() / Math.max(state.tokens_budget, 1);
      if (remainingPct < 0.15) {
        decision.action = 'park';
        decision.reason = 'low_budget';
        return decision;
      }

      // adaptive reordering using registry health
      const newChain = this.registry.fallbackChain();
      if (
        newChain.length > 0 &&
        JSON.stringify(newChain) !== JSON.stringify(strategy.provider_order)
      ) {
        decision.reorder_providers = newChain;
      }

      // approach notes
      if (lesson.what_worked) {
        strategy.approach_notes.push(lesson.what_worked);
      } else if (lesson.what_failed) {
        strategy.approach_notes.push(lesson.what_failed);
      }

      decision.action = 'continue';
      decision.reason = 'iterating';
      return decision;
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

    const phaseHandler = (event: PhaseEvent): void => {
      this._currentPhase = event.phase;
      this._phaseEvents.push({
        phase: event.phase,
        iteration: event.iteration,
        timestamp: event.timestamp,
        data: event.data,
      });
      if (onPhase) {
        try {
          onPhase(event);
        } catch {
          // ignore
        }
      }
    };

    const loop = new RalphLoop({
      config: this.config,
      solve_fn: solveFn,
      sanitize_fn: (text: string) => this.sanitizer.run(text),
      handoff_fn: handoffFn,
      reason_fn: reasonFn,
      plan_fn: planFn,
      on_phase: phaseHandler,
    });

    // always ensure criteria are present - defaults apply if none given
    const validatedCriteria = ensureCriteria(criteria ?? null);

    return loop.run(objective, validatedCriteria);
  }

  /** Heuristic confidence estimation. */
  private _estimateConfidence(output: string, criteria: Record<string, unknown>): number {
    if (!output) return 0;

    let score = 0.2;
    if (output.length > 50) score += 0.1;
    if (output.length > 200) score += 0.1;
    if (output.length > 500) score += 0.1;

    // check if output addresses criteria keywords
    if (criteria && Object.keys(criteria).length > 0) {
      const outputLower = output.toLowerCase();
      const keys = Object.keys(criteria);
      const matched = keys.filter(key => outputLower.includes(key.toLowerCase())).length;
      score += 0.45 * (matched / keys.length);
    }

    // cap at 0.95 (never auto-confirm at 1.0 without eval)
    return Math.min(score, 0.95);
  }

  /** Current RALPH phase and recent events (for GUI polling). */
  ralphStatus(): Record<string, unknown> {
    return {
      current_phase: this._currentPhase,
      phase_events: this._phaseEvents.slice(-20),
      total_events: this._phaseEvents.length,
    };
  }

  /** Current state of the agent. */
  status(): Record<string, unknown> {
    return {
      providers: this.registry.statusReport(),
      working_memory_entries: this.working._store.size,
      ralph: this.ralphStatus(),
      config: {
        token_budget: this.config.token_budget,
        wall_limit_s: this.config.wall_limit_s,
        confidence_threshold: this.config.confidence_threshold,
        provider_chain: this.config.provider_chain,
      },
    };
  }
}
