/**
 * OMA Core Loop -- RALPH (Reason, Act, Learn, Plan, Handoff).
 *
 * Five-phase agent loop with invariant retry, time-horizon awareness,
 * success tracking, and adaptive strategy.
 *
 * The loop runs until:
 *   - task is marked DONE with confidence >= threshold, OR
 *   - token budget is exhausted (triggers edge handoff), OR
 *   - max wall-clock time exceeded (triggers edge handoff)
 *
 * Invariants maintained every iteration:
 *   1. task_state is always serializable (can be handed to next worker)
 *   2. cumulative_cost never exceeds budget without triggering summarize_and_park
 *   3. every provider call is wrapped in fallback chain
 *   4. output is sanitized before storage
 *
 * RALPH phases per iteration:
 *   R - Reason:  analyze state, decompose problem, identify approach
 *   A - Act:     execute solve attempt with provider fallback
 *   L - Learn:   evaluate result against criteria, extract lessons
 *   P - Plan:    adjust strategy based on lessons (reorder providers, refine approach)
 *   H - Handoff: if done or at edge, create handoff; else loop to Reason
 */

import crypto from 'node:crypto';

export enum Status {
  PENDING = 'pending',
  RUNNING = 'running',
  BLOCKED = 'blocked',
  NEAR_OUTAGE = 'near_outage',
  DONE = 'done',
  PARKED = 'parked',
}

export enum RalphPhase {
  IDLE = 'idle',
  REASON = 'reason',
  ACT = 'act',
  LEARN = 'learn',
  PLAN = 'plan',
  HANDOFF = 'handoff',
}

export interface PhaseEvent {
  phase: RalphPhase;
  iteration: number;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface Reasoning {
  analysis: string;
  approach: string;
  focus_areas: string[];
  provider_preference: string;
}

export interface Lesson {
  iteration: number;
  succeeded: boolean;
  confidence_delta: number;
  what_worked: string;
  what_failed: string;
  provider_used: string;
  tokens_spent: number;
}

export interface PlanDecision {
  action: 'continue' | 'done' | 'park';
  reason: string;
  reorder_providers: string[];
  adjust_temperature: number | null;
  refine_prompt: string;
  escalate: boolean;
}

export interface Strategy {
  provider_order: string[];
  temperature: number;
  approach_notes: string[];
  lessons_summary: string;
  consecutive_failures: number;
  best_confidence: number;
  best_result: string;
  total_lessons: number;
}

function strategyToDict(s: Strategy): Record<string, unknown> {
  return {
    provider_order: s.provider_order,
    temperature: s.temperature,
    approach_notes: s.approach_notes.slice(-3),
    lessons_summary: s.lessons_summary,
    consecutive_failures: s.consecutive_failures,
    best_confidence: s.best_confidence,
    total_lessons: s.total_lessons,
  };
}

function createStrategy(providerOrder: string[]): Strategy {
  return {
    provider_order: [...providerOrder],
    temperature: 0.3,
    approach_notes: [],
    lessons_summary: '',
    consecutive_failures: 0,
    best_confidence: 0,
    best_result: '',
    total_lessons: 0,
  };
}

function createReasoning(): Reasoning {
  return { analysis: '', approach: '', focus_areas: [], provider_preference: '' };
}

function createLesson(): Lesson {
  return {
    iteration: 0,
    succeeded: false,
    confidence_delta: 0,
    what_worked: '',
    what_failed: '',
    provider_used: '',
    tokens_spent: 0,
  };
}

function createPlanDecision(): PlanDecision {
  return {
    action: 'continue',
    reason: '',
    reorder_providers: [],
    adjust_temperature: null,
    refine_prompt: '',
    escalate: false,
  };
}

export interface TaskStateData {
  task_id: string;
  objective: string;
  status: string;
  criteria: Record<string, unknown>;
  progress: Array<[number, string, number]>;
  context_for_next: string;
  tokens_used: number;
  tokens_budget: number;
  wall_start: number;
  wall_limit_s: number;
  attempts: number;
  max_attempts: number;
  confidence: number;
  confidence_threshold: number;
  provider_chain: string[];
  artifacts: Record<string, string>;
  checksum: string;
  // ralph-specific
  current_phase: string;
  phase_history: Array<Record<string, unknown>>;
  strategy: Record<string, unknown>;
  lessons: Array<Record<string, unknown>>;
}

export class TaskState {
  task_id!: string;
  objective!: string;
  status: Status = Status.PENDING;
  criteria: Record<string, unknown> = {};
  progress: Array<[number, string, number]> = [];
  context_for_next = '';
  tokens_used = 0;
  tokens_budget = 0;
  wall_start = 0;
  wall_limit_s = 0;
  attempts = 0;
  max_attempts = 20;
  confidence = 0;
  confidence_threshold = 0.85;
  provider_chain: string[] = [];
  artifacts: Record<string, string> = {};
  checksum = '';
  // ralph-specific state
  current_phase = 'idle';
  phase_history: Array<Record<string, unknown>> = [];
  strategy: Record<string, unknown> = {};
  lessons: Array<Record<string, unknown>> = [];

  constructor(init: Partial<TaskState> & { task_id: string; objective: string }) {
    Object.assign(this, init);
  }

  snapshot(): TaskStateData {
    const d: TaskStateData = {
      task_id: this.task_id,
      objective: this.objective,
      status: this.status,
      criteria: this.criteria,
      progress: this.progress,
      context_for_next: this.context_for_next,
      tokens_used: this.tokens_used,
      tokens_budget: this.tokens_budget,
      wall_start: this.wall_start,
      wall_limit_s: this.wall_limit_s,
      attempts: this.attempts,
      max_attempts: this.max_attempts,
      confidence: this.confidence,
      confidence_threshold: this.confidence_threshold,
      provider_chain: this.provider_chain,
      artifacts: this.artifacts,
      checksum: '',
      current_phase: this.current_phase,
      phase_history: this.phase_history,
      strategy: this.strategy,
      lessons: this.lessons,
    };
    const raw = JSON.stringify(d, Object.keys(d).sort());
    d.checksum = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return d;
  }

  remainingTokens(): number {
    return Math.max(0, this.tokens_budget - this.tokens_used);
  }

  remainingTime(): number {
    if (this.wall_limit_s <= 0) return Infinity;
    return Math.max(0, this.wall_limit_s - (Date.now() / 1000 - this.wall_start));
  }

  isNearOutage(tokenReserve = 2000): boolean {
    return this.remainingTokens() < tokenReserve;
  }

  isTimedOut(): boolean {
    return this.remainingTime() <= 0;
  }
}

export interface LoopConfig {
  token_budget: number;
  wall_limit_s: number;
  max_attempts: number;
  confidence_threshold: number;
  token_reserve_for_handoff: number;
  backoff_base_s: number;
  backoff_max_s: number;
  provider_chain: string[];
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  token_budget: 100_000,
  wall_limit_s: 600,
  max_attempts: 20,
  confidence_threshold: 0.85,
  token_reserve_for_handoff: 3000,
  backoff_base_s: 2.0,
  backoff_max_s: 30.0,
  provider_chain: ['claude', 'gemini', 'chatgpt'],
};

// ---- callback types ----
export type SolveFn = (state: TaskState, provider: string) => Promise<[string, number, number]>;
export type SanitizeFn = (text: string) => string;
export type HandoffFn = (state: TaskState) => Promise<void>;
export type CriteriaFn = (state: TaskState) => Record<string, unknown>;
export type ReasonFn = (state: TaskState, strategy: Strategy) => Reasoning;
export type PlanFn = (state: TaskState, strategy: Strategy, lesson: Lesson) => PlanDecision;
export type OnPhaseFn = (event: PhaseEvent) => void;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * The RALPH loop. Five-phase agent loop with adaptive strategy.
 *
 * Plug in:
 *   - solve_fn(state, provider) -> [result, tokens_used, confidence]
 *   - sanitize_fn(text) -> text
 *   - handoff_fn(state) -> void
 *   - reason_fn(state, strategy) -> Reasoning (optional)
 *   - plan_fn(state, strategy, lesson) -> PlanDecision (optional)
 *   - on_phase(event) -> void (optional, for GUI updates)
 *   - criteria_fn(state) -> dict (optional)
 */
export class RalphLoop {
  private config: LoopConfig;
  private solve: SolveFn;
  private sanitize: SanitizeFn;
  private handoff: HandoffFn;
  private reasonFn?: ReasonFn;
  private planFn?: PlanFn;
  private onPhase?: OnPhaseFn;
  private criteriaFn?: CriteriaFn;

  constructor(opts: {
    config: LoopConfig;
    solve_fn: SolveFn;
    sanitize_fn: SanitizeFn;
    handoff_fn: HandoffFn;
    reason_fn?: ReasonFn;
    plan_fn?: PlanFn;
    on_phase?: OnPhaseFn;
    criteria_fn?: CriteriaFn;
  }) {
    this.config = opts.config;
    this.solve = opts.solve_fn;
    this.sanitize = opts.sanitize_fn;
    this.handoff = opts.handoff_fn;
    this.reasonFn = opts.reason_fn;
    this.planFn = opts.plan_fn;
    this.onPhase = opts.on_phase;
    this.criteriaFn = opts.criteria_fn;
  }

  /** Emit a phase event and update state tracking. */
  private emit(state: TaskState, phase: RalphPhase, data: Record<string, unknown> = {}): void {
    const event: PhaseEvent = {
      phase,
      iteration: state.attempts,
      data,
      timestamp: Date.now() / 1000,
    };
    state.current_phase = phase;
    state.phase_history.push({
      phase: phase,
      iteration: state.attempts,
      timestamp: event.timestamp,
      data: event.data,
    });
    if (this.onPhase) {
      try {
        this.onPhase(event);
      } catch {
        // observer failures must not break the loop
      }
    }
  }

  async run(objective: string, initialCriteria?: Record<string, unknown>): Promise<TaskState> {
    const now = Date.now() / 1000;
    const hash = crypto.createHash('sha256').update(`${objective}${now}`).digest('hex').slice(0, 12);

    const state = new TaskState({
      task_id: hash,
      objective,
      status: Status.RUNNING,
      tokens_budget: this.config.token_budget,
      wall_start: now,
      wall_limit_s: this.config.wall_limit_s,
      max_attempts: this.config.max_attempts,
      confidence_threshold: this.config.confidence_threshold,
      provider_chain: [...this.config.provider_chain],
      criteria: initialCriteria ?? {},
    });

    // initialize strategy
    const strategy = createStrategy(this.config.provider_chain);
    state.strategy = strategyToDict(strategy);

    // phase 0: solve for criteria if not provided
    if (Object.keys(state.criteria).length === 0 && this.criteriaFn) {
      state.criteria = this.criteriaFn(state);
    }

    // ---- RALPH loop ----
    while (state.attempts < state.max_attempts) {
      state.attempts++;

      // ---- invariant checks (before any phase) ----
      if (state.isTimedOut()) {
        this.emit(state, RalphPhase.HANDOFF, { trigger: 'wall_timeout' });
        state.status = Status.PARKED;
        state.context_for_next = this.summarizeForHandoff(state, 'wall_timeout');
        await this.handoff(state);
        break;
      }

      if (state.isNearOutage(this.config.token_reserve_for_handoff)) {
        this.emit(state, RalphPhase.HANDOFF, { trigger: 'token_near_outage' });
        state.status = Status.NEAR_OUTAGE;
        state.context_for_next = this.summarizeForHandoff(state, 'token_near_outage');
        await this.handoff(state);
        state.status = Status.PARKED;
        break;
      }

      // ---- R: REASON ----
      const reasoning = this.phaseReason(state, strategy);

      // ---- A: ACT ----
      const [result, tokens, confidence, providerUsed] = await this.phaseAct(
        state, strategy, reasoning,
      );
      state.tokens_used += tokens;

      // ---- L: LEARN ----
      const lesson = this.phaseLearn(state, strategy, result, tokens, confidence, providerUsed);

      // ---- P: PLAN ----
      const decision = this.phasePlan(state, strategy, lesson);

      // ---- H: HANDOFF ----
      if (decision.action === 'done') {
        this.emit(state, RalphPhase.HANDOFF, { trigger: 'done' });
        state.status = Status.DONE;
        if (strategy.best_result) {
          state.artifacts['final'] = strategy.best_result;
        }
        break;
      } else if (decision.action === 'park') {
        this.emit(state, RalphPhase.HANDOFF, { trigger: decision.reason });
        state.status = Status.PARKED;
        state.context_for_next = this.summarizeForHandoff(state, decision.reason);
        await this.handoff(state);
        break;
      } else {
        // "continue" - apply strategy adjustments
        if (decision.reorder_providers.length > 0) {
          state.provider_chain = decision.reorder_providers;
          strategy.provider_order = [...decision.reorder_providers];
        }
        state.strategy = strategyToDict(strategy);
        this.emit(state, RalphPhase.HANDOFF, { trigger: 'continue' });
      }
    }

    // if we exhausted attempts without a decision
    if (state.status === Status.RUNNING) {
      this.emit(state, RalphPhase.HANDOFF, { trigger: 'max_attempts' });
      state.status = Status.PARKED;
      state.context_for_next = this.summarizeForHandoff(state, 'max_attempts');
      await this.handoff(state);
    }

    state.current_phase = RalphPhase.IDLE;
    return state;
  }

  // ---- RALPH phase implementations ----

  /** R: Analyze state, identify approach for this iteration. */
  private phaseReason(state: TaskState, strategy: Strategy): Reasoning {
    this.emit(state, RalphPhase.REASON, {
      iteration: state.attempts,
      confidence_so_far: state.confidence,
      consecutive_failures: strategy.consecutive_failures,
    });

    if (this.reasonFn) {
      try {
        return this.reasonFn(state, strategy);
      } catch {
        // fall through to default
      }
    }

    // default reasoning: heuristic analysis
    const reasoning = createReasoning();

    if (state.attempts === 1) {
      reasoning.analysis = `First attempt at: ${state.objective}`;
      reasoning.approach = 'direct';
    } else if (strategy.consecutive_failures > 2) {
      reasoning.analysis =
        `Multiple failures (${strategy.consecutive_failures}). Changing approach.`;
      reasoning.approach = 'alternative';
      if (strategy.provider_order.length > 1) {
        reasoning.provider_preference =
          strategy.provider_order[strategy.provider_order.length - 1];
      }
    } else {
      reasoning.analysis =
        `Attempt ${state.attempts}, best confidence so far: ${strategy.best_confidence.toFixed(2)}`;
      reasoning.approach = 'iterative';
    }

    if (Object.keys(state.criteria).length > 0) {
      reasoning.focus_areas = Object.keys(state.criteria).slice(0, 5);
    }

    return reasoning;
  }

  /** A: Execute solve attempt with provider fallback. */
  private async phaseAct(
    state: TaskState,
    strategy: Strategy,
    reasoning: Reasoning,
  ): Promise<[string | null, number, number, string]> {
    this.emit(state, RalphPhase.ACT, {
      approach: reasoning.approach,
      provider_preference: reasoning.provider_preference,
    });

    // determine provider order for this attempt
    const providers = [...strategy.provider_order];
    if (reasoning.provider_preference && providers.includes(reasoning.provider_preference)) {
      const idx = providers.indexOf(reasoning.provider_preference);
      providers.splice(idx, 1);
      providers.unshift(reasoning.provider_preference);
    }

    for (const providerName of providers) {
      try {
        const [result, tokens, confidence] = await this.solve(state, providerName);
        return [result, tokens, confidence, providerName];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        state.progress.push([state.attempts, `[${providerName}] error: ${msg}`, 0]);
        continue;
      }
    }

    // all providers failed - backoff
    const wait = Math.min(
      this.config.backoff_base_s * (2 ** (state.attempts - 1)),
      this.config.backoff_max_s,
    );
    await sleep(wait * 1000);
    return [null, 0, 0, ''];
  }

  /** L: Evaluate result, extract lessons, update memory. */
  private phaseLearn(
    state: TaskState,
    strategy: Strategy,
    result: string | null,
    tokens: number,
    confidence: number,
    providerUsed: string,
  ): Lesson {
    this.emit(state, RalphPhase.LEARN, {
      has_result: result !== null,
      confidence,
      provider: providerUsed,
    });

    const lesson = createLesson();
    lesson.iteration = state.attempts;
    lesson.provider_used = providerUsed;
    lesson.tokens_spent = tokens;

    if (result !== null) {
      const clean = this.sanitize(result);
      state.progress.push([state.attempts, clean, confidence]);
      state.confidence = confidence;

      lesson.succeeded = true;
      lesson.confidence_delta = confidence - strategy.best_confidence;

      if (confidence > strategy.best_confidence) {
        strategy.best_confidence = confidence;
        strategy.best_result = clean;
        lesson.what_worked =
          `Provider ${providerUsed} achieved new best confidence ${confidence.toFixed(2)}`;
      } else {
        lesson.what_worked =
          `Got result but below best (${confidence.toFixed(2)} < ${strategy.best_confidence.toFixed(2)})`;
      }

      // track in artifacts if this meets threshold
      if (confidence >= state.confidence_threshold) {
        state.artifacts['final'] = clean;
      }
    } else {
      lesson.succeeded = false;
      lesson.what_failed = 'All providers failed this round';
    }

    strategy.total_lessons++;
    state.lessons.push({
      iteration: lesson.iteration,
      succeeded: lesson.succeeded,
      confidence_delta: lesson.confidence_delta,
      provider: lesson.provider_used,
    });

    return lesson;
  }

  /** P: Adjust strategy based on lessons, decide next action. */
  private phasePlan(
    state: TaskState,
    strategy: Strategy,
    lesson: Lesson,
  ): PlanDecision {
    this.emit(state, RalphPhase.PLAN, {
      lesson_succeeded: lesson.succeeded,
      best_confidence: strategy.best_confidence,
      threshold: state.confidence_threshold,
    });

    if (this.planFn) {
      try {
        const decision = this.planFn(state, strategy, lesson);
        this.applyPlanEffects(strategy, lesson, decision);
        return decision;
      } catch {
        // fall through to default
      }
    }

    // default planning logic
    const decision = createPlanDecision();

    // check: did we hit the confidence threshold?
    if (strategy.best_confidence >= state.confidence_threshold) {
      decision.action = 'done';
      decision.reason =
        `Confidence ${strategy.best_confidence.toFixed(2)} >= threshold ${state.confidence_threshold.toFixed(2)}`;
      return decision;
    }

    // track consecutive failures
    if (lesson.succeeded) {
      strategy.consecutive_failures = 0;
    } else {
      strategy.consecutive_failures++;
    }

    // too many consecutive failures - park
    if (strategy.consecutive_failures >= 3) {
      decision.action = 'park';
      decision.reason = `consecutive_failures (${strategy.consecutive_failures})`;
      return decision;
    }

    // approaching budget limits - park
    const remainingPct = state.remainingTokens() / Math.max(state.tokens_budget, 1);
    if (remainingPct < 0.15) {
      decision.action = 'park';
      decision.reason = 'low_budget';
      return decision;
    }

    // adaptive provider reordering
    if (lesson.succeeded && lesson.provider_used) {
      // promote successful provider
      const newOrder = [...strategy.provider_order];
      const idx = newOrder.indexOf(lesson.provider_used);
      if (idx >= 0) {
        newOrder.splice(idx, 1);
        newOrder.unshift(lesson.provider_used);
        decision.reorder_providers = newOrder;
      }
    } else if (!lesson.succeeded && strategy.provider_order.length > 1) {
      // rotate: move first provider to end
      const newOrder = [...strategy.provider_order];
      newOrder.push(newOrder.shift()!);
      decision.reorder_providers = newOrder;
    }

    // add approach note
    if (lesson.what_worked) {
      strategy.approach_notes.push(lesson.what_worked);
    } else if (lesson.what_failed) {
      strategy.approach_notes.push(lesson.what_failed);
    }

    decision.action = 'continue';
    decision.reason = 'iterating';

    return decision;
  }

  /** Apply side effects from a plan decision onto strategy. */
  private applyPlanEffects(strategy: Strategy, lesson: Lesson, _decision: PlanDecision): void {
    if (lesson.succeeded) {
      strategy.consecutive_failures = 0;
    } else {
      strategy.consecutive_failures++;
    }

    if (lesson.what_worked) {
      strategy.approach_notes.push(lesson.what_worked);
    } else if (lesson.what_failed) {
      strategy.approach_notes.push(lesson.what_failed);
    }
  }

  // ---- handoff support ----

  /** Compress what the next worker needs to know. */
  private summarizeForHandoff(state: TaskState, reason: string): string {
    const progressSummary = state.progress.slice(-5).map(([step, result, conf]) => {
      const preview = String(result).slice(0, 200);
      return `  step ${step} (conf=${conf.toFixed(2)}): ${preview}`;
    });

    const strategyInfo = state.strategy || {};

    return [
      `=== OMA HANDOFF (${reason}) ===`,
      `objective: ${state.objective}`,
      `criteria: ${JSON.stringify(state.criteria)}`,
      `attempts: ${state.attempts}/${state.max_attempts}`,
      `tokens: ${state.tokens_used}/${state.tokens_budget}`,
      `best confidence: ${state.confidence.toFixed(2)} (threshold: ${state.confidence_threshold})`,
      `strategy: ${JSON.stringify(strategyInfo)}`,
      `lessons learned: ${state.lessons.length}`,
      `recent progress:`,
      ...progressSummary,
      `artifacts keys: ${JSON.stringify(Object.keys(state.artifacts))}`,
      `=== NEXT WORKER: pick up from here ===`,
    ].join('\n');
  }
}

// ---- backwards compatibility ----
// CoreLoop is now an alias for RalphLoop with no reason/plan overrides
// (the default heuristic reason/plan kicks in)
export { RalphLoop as CoreLoop };
