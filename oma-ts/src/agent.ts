/**
 * OMA - Open Multi Agent harness.
 *
 * Wires together:
 *   - RALPH loop (Reason, Act, Learn, Plan, Handoff)
 *   - Provider registry (Claude, Gemini, ChatGPT, DeepSeek, GLM, Kimi)
 *   - Advanced routing engine (10 strategies, circuit breaker, cost/quota)
 *   - OmniRoute bridge (352+ providers when gateway is running)
 *   - Criteria engine (define what "done" means)
 *   - Sanitizer (strip provider fingerprints)
 *   - Automation layers (pixel, page, memory)
 *   - Edge handlers (near-outage summarize, outage recovery)
 *
 * Usage:
 *   import { OMA } from './agent.js';
 *
 *   // standalone mode (embedded router)
 *   const agent = OMA.fromEnv();
 *   const result = await agent.run({ objective: "build a web scraper" });
 *
 *   // with OmniRoute gateway (352+ providers)
 *   const agent = OMA.fromEnv({ omniroute: true });
 *   const result = await agent.run({ objective: "build a web scraper" });
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
import {
  Router,
  type RoutingStrategy,
  type ModalityType,
  type BudgetRule,
  type ScoringWeights,
} from './core/router.js';
import {
  OmniRouteBridge,
  type OmniRouteConfig,
} from './core/omniroute_bridge.js';
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
  router: Router;
  omniRouteBridge: OmniRouteBridge | null = null;

  private _omniRouteEnabled = false;
  private _currentPhase = 'idle';
  private _phaseEvents: Array<Record<string, unknown>> = [];

  constructor(opts: {
    registry: ProviderRegistry;
    config?: Partial<LoopConfig>;
    sanitizer?: Sanitizer;
    memoryDir?: string;
    routingStrategy?: RoutingStrategy;
    scoringWeights?: Partial<ScoringWeights>;
    budgets?: Record<string, BudgetRule>;
    omniroute?: boolean;
    omniRouteConfig?: Partial<OmniRouteConfig>;
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

    // embedded router
    this.router = new Router({
      strategy: opts.routingStrategy ?? 'auto',
      weights: opts.scoringWeights,
      budgets: opts.budgets,
    });

    // OmniRoute bridge (optional)
    this._omniRouteEnabled = opts.omniroute ?? false;
    if (this._omniRouteEnabled) {
      this.omniRouteBridge = new OmniRouteBridge(opts.omniRouteConfig);
    }
  }

  /** Create OMA from environment variables. */
  static fromEnv(opts?: {
    config?: Partial<LoopConfig>;
    omniroute?: boolean;
    routingStrategy?: RoutingStrategy;
    checkGeneric?: boolean;
  }): OMA {
    const registry = ProviderRegistry.fromEnv(opts?.checkGeneric ?? false);
    return new OMA({
      registry,
      config: opts?.config,
      omniroute: opts?.omniroute,
      routingStrategy: opts?.routingStrategy,
    });
  }

  /**
   * Create OMA by loading securely stored credentials first,
   * falling back to environment variables.
   */
  static load(opts?: {
    config?: Partial<LoopConfig>;
    memoryDir?: string;
    omniroute?: boolean;
  }): OMA {
    const auth = new AuthManager();
    let registry = ProviderRegistry.fromCredentials(auth);
    if (registry.available().length === 0) {
      registry = ProviderRegistry.fromEnv(true);
    }
    return new OMA({
      registry,
      config: opts?.config,
      memoryDir: opts?.memoryDir,
      omniroute: opts?.omniroute,
    });
  }

  /**
   * Create OMA from stored credentials (subscription or API key).
   * Used by the graphical UI - providers are registered from
   * browser-based login sessions rather than env vars.
   */
  static fromCredentials(
    authManager: AuthManager,
    opts?: {
      config?: Partial<LoopConfig>;
      omniroute?: boolean;
    },
  ): OMA {
    let registry = ProviderRegistry.fromCredentials(authManager);
    if (registry.available().length === 0) {
      registry = ProviderRegistry.fromEnv(true);
    }
    return new OMA({
      registry,
      config: opts?.config,
      omniroute: opts?.omniroute,
    });
  }

  /**
   * Run the full RALPH agent loop.
   */
  async run(opts: {
    objective: string;
    criteria?: Record<string, unknown>;
    system?: string;
    resumeFrom?: string;
    onPhase?: (event: PhaseEvent) => void;
    taskType?: string;
    modality?: ModalityType;
  }): Promise<TaskState> {
    const {
      objective,
      criteria,
      system,
      resumeFrom,
      onPhase,
      taskType = 'general',
      modality = 'text',
    } = opts;

    this._currentPhase = 'idle';
    this._phaseEvents = [];

    // probe OmniRoute availability if enabled
    if (this.omniRouteBridge) {
      await this.omniRouteBridge.checkAvailability();
    }

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

    const solveFn = async (
      state: TaskState,
      providerName: string,
    ): Promise<[string, number, number]> => {
      // dual-mode dispatch: OmniRoute gateway vs embedded
      if (this.omniRouteBridge && this.omniRouteBridge.available) {
        return this._solveViaOmniRoute(state, providerName, system);
      }
      return this._solveDirect(state, providerName, system, prevContext, taskType);
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

      // use router to pick best provider
      const available = this.registry.available();
      if (available.length > 0) {
        const selected = this.router.select(available, health, taskType, modality);
        if (Array.isArray(selected)) {
          reasoning.provider_preference = selected[0] ?? '';
        } else if (selected) {
          reasoning.provider_preference = selected;
        }
      }

      if (state.attempts === 1) {
        reasoning.analysis = `First attempt: ${state.objective}`;
        reasoning.approach = 'direct';
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

    const validatedCriteria = ensureCriteria(criteria ?? null);
    return loop.run(objective, validatedCriteria);
  }

  /** Execute via embedded provider registry with router tracking. */
  private async _solveDirect(
    state: TaskState,
    providerName: string,
    system: string | undefined,
    prevContext: Record<string, unknown> | null,
    taskType: string,
  ): Promise<[string, number, number]> {
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
      // record in router too
      this.router.recordFailure({
        providerId: providerName,
        errorCode: response.error_code ?? 0,
      });
      throw new Error(`${providerName}: ${response.error}`);
    }

    const tokensTotal = providerResponseTokensTotal(response);
    this.registry.recordSuccess(providerName, tokensTotal, response.latency_ms);

    // track in router
    this.router.recordSuccess({
      providerId: providerName,
      tokensIn: response.tokens_in ?? 0,
      tokensOut: response.tokens_out ?? 0,
      latencyS: (response.latency_ms ?? 0) / 1000,
      taskType,
    });

    // store in working memory
    this.working.put(`attempt_${state.attempts}`, response.text.slice(0, 500), {
      tags: ['attempt', 'result'],
      source: providerName,
    });

    const confidence = this._estimateConfidence(response.text, state.criteria);
    return [response.text, tokensTotal, confidence];
  }

  /** Execute via OmniRoute gateway for full 352+ provider routing. */
  private async _solveViaOmniRoute(
    state: TaskState,
    providerName: string,
    system: string | undefined,
  ): Promise<[string, number, number]> {
    const bridge = this.omniRouteBridge!;

    const msgs: Array<{ role: string; content: string }> = [];
    if (system) {
      msgs.push({ role: 'system', content: system });
    }

    let strategyCtx = '';
    if (state.strategy) {
      const notes = (state.strategy as Record<string, unknown>).approach_notes as string[] | undefined;
      if (notes?.length) {
        strategyCtx = '\n\nLessons from previous attempts:\n' +
          notes.slice(-3).map(n => `- ${n}`).join('\n');
      }
    }

    msgs.push({
      role: 'user',
      content: `Complete this task: ${state.objective}\n\n` +
        `Criteria: ${JSON.stringify(state.criteria)}\n\n` +
        `Attempt ${state.attempts}. ` +
        `Previous confidence: ${state.confidence.toFixed(2)}` +
        strategyCtx,
    });

    // resolve model: prefer auto-routing
    const model = bridge.resolveModel(providerName, true);

    const resp = await bridge.chatCompletion({
      messages: msgs,
      model,
      temperature: 0.3,
    });

    if (!resp.ok) {
      this.router.recordFailure({
        providerId: providerName,
        errorCode: resp.errorCode || 0,
      });
      // fallback to direct if OmniRoute fails
      const directProvider = this.registry.get(providerName);
      if (directProvider) {
        return this._solveDirect(state, providerName, system, null, 'general');
      }
      throw new Error(`OmniRoute: ${resp.error}`);
    }

    // record in router
    this.router.recordSuccess({
      providerId: resp.provider || providerName,
      tokensIn: resp.tokensIn,
      tokensOut: resp.tokensOut,
      latencyS: resp.latencyMs / 1000,
    });

    // store in working memory
    this.working.put(`attempt_${state.attempts}`, resp.text.slice(0, 500), {
      tags: ['attempt', 'result', 'omniroute'],
      source: resp.provider || providerName,
    });

    const confidence = this._estimateConfidence(resp.text, state.criteria);
    return [resp.text, resp.tokensTotal, confidence];
  }

  /** Heuristic confidence estimation. */
  private _estimateConfidence(output: string, criteria: Record<string, unknown>): number {
    if (!output) return 0;

    let score = 0.2;
    if (output.length > 50) score += 0.1;
    if (output.length > 200) score += 0.1;
    if (output.length > 500) score += 0.1;

    if (criteria && Object.keys(criteria).length > 0) {
      const outputLower = output.toLowerCase();
      const keys = Object.keys(criteria);
      const matched = keys.filter(key => outputLower.includes(key.toLowerCase())).length;
      score += 0.45 * (matched / keys.length);
    }

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

  /** Router, circuit breaker, and cost status for GUI dashboard. */
  routerStatus(): Record<string, unknown> {
    const result = this.router.status();
    if (this.omniRouteBridge) {
      (result as Record<string, unknown>).omniroute = this.omniRouteBridge.status();
    }
    return result;
  }

  /** Current state of the agent. */
  status(): Record<string, unknown> {
    const st: Record<string, unknown> = {
      providers: this.registry.statusReport(),
      working_memory_entries: this.working._store.size,
      ralph: this.ralphStatus(),
      router: this.routerStatus(),
      config: {
        token_budget: this.config.token_budget,
        wall_limit_s: this.config.wall_limit_s,
        confidence_threshold: this.config.confidence_threshold,
        provider_chain: this.config.provider_chain,
        routing_strategy: this.router.strategy,
        omniroute_enabled: this._omniRouteEnabled,
      },
    };
    if (this.omniRouteBridge) {
      st.omniroute_available = this.omniRouteBridge.available;
    }
    return st;
  }
}
