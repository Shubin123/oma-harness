/**
 * OMA Core Loop - invariant retry with time-horizon awareness and success tracking.
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

export type SolveFn = (state: TaskState, provider: string) => Promise<[string, number, number]>;
export type SanitizeFn = (text: string) => string;
export type HandoffFn = (state: TaskState) => Promise<void>;
export type CriteriaFn = (state: TaskState) => Record<string, unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class CoreLoop {
  private config: LoopConfig;
  private solve: SolveFn;
  private sanitize: SanitizeFn;
  private handoff: HandoffFn;
  private criteriaFn?: CriteriaFn;

  constructor(opts: {
    config: LoopConfig;
    solve_fn: SolveFn;
    sanitize_fn: SanitizeFn;
    handoff_fn: HandoffFn;
    criteria_fn?: CriteriaFn;
  }) {
    this.config = opts.config;
    this.solve = opts.solve_fn;
    this.sanitize = opts.sanitize_fn;
    this.handoff = opts.handoff_fn;
    this.criteriaFn = opts.criteria_fn;
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
      criteria: initialCriteria || {},
    });

    // phase 0: solve for criteria if not provided
    if (Object.keys(state.criteria).length === 0 && this.criteriaFn) {
      state.criteria = this.criteriaFn(state);
    }

    // core loop - invariant: state is always consistent and serializable
    while (state.attempts < state.max_attempts) {
      state.attempts++;

      // invariant checks
      if (state.isTimedOut()) {
        state.status = Status.PARKED;
        state.context_for_next = this.summarizeForHandoff(state, 'wall_timeout');
        await this.handoff(state);
        break;
      }

      if (state.isNearOutage(this.config.token_reserve_for_handoff)) {
        state.status = Status.NEAR_OUTAGE;
        state.context_for_next = this.summarizeForHandoff(state, 'token_near_outage');
        await this.handoff(state);
        state.status = Status.PARKED;
        break;
      }

      // attempt solve with provider fallback
      const [result, tokens, confidence] = await this.tryProviders(state);
      state.tokens_used += tokens;

      if (result !== null) {
        const clean = this.sanitize(result);
        state.progress.push([state.attempts, clean, confidence]);
        state.confidence = confidence;

        if (confidence >= state.confidence_threshold) {
          state.status = Status.DONE;
          state.artifacts['final'] = clean;
          break;
        }
      } else {
        // all providers failed this round - backoff
        const wait = Math.min(
          this.config.backoff_base_s * (2 ** (state.attempts - 1)),
          this.config.backoff_max_s,
        );
        await sleep(wait * 1000);
      }
    }

    if (state.status === Status.RUNNING) {
      state.status = Status.PARKED;
      state.context_for_next = this.summarizeForHandoff(state, 'max_attempts');
      await this.handoff(state);
    }

    return state;
  }

  private async tryProviders(state: TaskState): Promise<[string | null, number, number]> {
    for (const providerName of state.provider_chain) {
      try {
        const [result, tokens, confidence] = await this.solve(state, providerName);
        return [result, tokens, confidence];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        state.progress.push([state.attempts, `[${providerName}] error: ${msg}`, 0]);
        continue;
      }
    }
    return [null, 0, 0];
  }

  private summarizeForHandoff(state: TaskState, reason: string): string {
    const progressSummary = state.progress.slice(-5).map(([step, result, conf]) => {
      const preview = String(result).slice(0, 200);
      return `  step ${step} (conf=${conf.toFixed(2)}): ${preview}`;
    });

    return [
      `=== OMA HANDOFF (${reason}) ===`,
      `objective: ${state.objective}`,
      `criteria: ${JSON.stringify(state.criteria)}`,
      `attempts: ${state.attempts}/${state.max_attempts}`,
      `tokens: ${state.tokens_used}/${state.tokens_budget}`,
      `best confidence: ${state.confidence.toFixed(2)} (threshold: ${state.confidence_threshold})`,
      `recent progress:`,
      ...progressSummary,
      `artifacts keys: ${JSON.stringify(Object.keys(state.artifacts))}`,
      `=== NEXT WORKER: pick up from here ===`,
    ].join('\n');
  }
}
