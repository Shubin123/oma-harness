/**
 * OMA Router - Advanced multi-strategy routing engine.
 *
 * Provides OmniRoute-class capabilities on top of the existing ProviderRegistry:
 *   - 10 routing strategies (priority, weighted, round-robin, p2c, etc.)
 *   - 4-state circuit breaker (CLOSED / DEGRADED / OPEN / HALF_OPEN)
 *   - Multi-factor auto-scoring (10 weighted factors)
 *   - Cost & budget tracking with daily/monthly limits
 *   - Quota management with TTL-based refresh
 *   - Modality bridging (vision/audio -> text fallback)
 *   - Graceful degradation (feature-level failover)
 *   - Pipeline orchestration (multi-stage LLM chaining)
 *
 * Zero external dependencies. Works with any ProviderRegistry instance.
 */

// ---------------------------------------------------------------------------
// Enums & Types
// ---------------------------------------------------------------------------

export type RoutingStrategy =
  | 'priority'
  | 'weighted'
  | 'round_robin'
  | 'p2c'
  | 'least_used'
  | 'cost_optimized'
  | 'lkgp'
  | 'auto'
  | 'fusion'
  | 'pipeline';

export type BreakerState = 'closed' | 'degraded' | 'open' | 'half_open';

export type ModalityType = 'text' | 'vision' | 'audio';

export type DegradationLevel = 'full' | 'reduced' | 'minimal' | 'default';

export const ROUTING_STRATEGIES: RoutingStrategy[] = [
  'priority', 'weighted', 'round_robin', 'p2c', 'least_used',
  'cost_optimized', 'lkgp', 'auto', 'fusion', 'pipeline',
];

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  failure_threshold: number;
  degradation_pct: number;
  recovery_timeout_s: number;
  backoff_multiplier: number;
  max_backoff_multiplier: number;
}

const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failure_threshold: 8,
  degradation_pct: 0.6,
  recovery_timeout_s: 30,
  backoff_multiplier: 2,
  max_backoff_multiplier: 16,
};

export class CircuitBreaker {
  config: CircuitBreakerConfig;
  state: BreakerState = 'closed';
  failureCount = 0;
  successCount = 0;
  lastFailureTime = 0;
  lastStateChange = 0;
  consecutiveRecoveryFailures = 0;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_BREAKER_CONFIG, ...config };
  }

  get degradationThreshold(): number {
    return Math.max(1, Math.floor(this.config.failure_threshold * this.config.degradation_pct));
  }

  recordSuccess(): void {
    this.successCount++;
    if (this.state === 'half_open') {
      this._transition('closed');
      this.failureCount = 0;
      this.consecutiveRecoveryFailures = 0;
    } else if (this.state === 'closed' || this.state === 'degraded') {
      this.failureCount = Math.max(0, this.failureCount - 1);
      if (this.failureCount < this.degradationThreshold && this.state !== 'closed') {
        this._transition('closed');
      }
    }
  }

  recordFailure(immediateOpen = false): void {
    this.failureCount++;
    this.lastFailureTime = Date.now() / 1000;

    if (immediateOpen || this.failureCount >= this.config.failure_threshold) {
      if (this.state === 'half_open') {
        this.consecutiveRecoveryFailures++;
      }
      this._transition('open');
    } else if (this.failureCount >= this.degradationThreshold) {
      if (this.state === 'closed') {
        this._transition('degraded');
      }
    }
  }

  allowRequest(): boolean {
    if (this.state === 'closed' || this.state === 'degraded') {
      return true;
    }
    if (this.state === 'open') {
      const effectiveTimeout = this.config.recovery_timeout_s * Math.min(
        Math.pow(this.config.backoff_multiplier, this.consecutiveRecoveryFailures),
        this.config.max_backoff_multiplier,
      );
      const now = Date.now() / 1000;
      if (now - this.lastStateChange >= effectiveTimeout) {
        this._transition('half_open');
        return true;
      }
      return false;
    }
    // half_open: allow single probe
    return true;
  }

  private _transition(newState: BreakerState): void {
    this.state = newState;
    this.lastStateChange = Date.now() / 1000;
  }

  toDict(): Record<string, unknown> {
    return {
      state: this.state,
      failure_count: this.failureCount,
      success_count: this.successCount,
      consecutive_recovery_failures: this.consecutiveRecoveryFailures,
    };
  }
}

// ---------------------------------------------------------------------------
// Quota Manager
// ---------------------------------------------------------------------------

interface QuotaEntry {
  remaining: number;
  total: number;
  resetAt: number;
  lastChecked: number;
  exhausted: boolean;
  ttlS: number;
}

function defaultQuotaEntry(): QuotaEntry {
  return { remaining: -1, total: -1, resetAt: 0, lastChecked: 0, exhausted: false, ttlS: 300 };
}

export class QuotaManager {
  entries: Map<string, QuotaEntry> = new Map();

  markExhausted(providerId: string, retryAfterS = 300): void {
    const entry = this._getOrCreate(providerId);
    entry.exhausted = true;
    entry.resetAt = Date.now() / 1000 + retryAfterS;
    entry.lastChecked = Date.now() / 1000;
  }

  markAvailable(providerId: string, remaining = -1, total = -1): void {
    const entry = this._getOrCreate(providerId);
    entry.exhausted = false;
    entry.remaining = remaining;
    entry.total = total;
    entry.lastChecked = Date.now() / 1000;
  }

  isAvailable(providerId: string): boolean {
    const entry = this.entries.get(providerId);
    if (!entry) return true;
    if (entry.exhausted) {
      if (Date.now() / 1000 >= entry.resetAt) {
        entry.exhausted = false;
        return true;
      }
      return false;
    }
    return true;
  }

  remainingPct(providerId: string): number {
    const entry = this.entries.get(providerId);
    if (!entry || entry.total <= 0) return 1.0;
    if (entry.exhausted) return 0.0;
    return Math.max(0, entry.remaining / entry.total);
  }

  private _getOrCreate(id: string): QuotaEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = defaultQuotaEntry();
      this.entries.set(id, e);
    }
    return e;
  }
}

// ---------------------------------------------------------------------------
// Cost / Budget Tracker
// ---------------------------------------------------------------------------

const DEFAULT_PRICING: Record<string, [number, number]> = {
  claude:   [3.00, 15.00],
  chatgpt:  [2.50, 10.00],
  gemini:   [0.075, 0.30],
  deepseek: [0.14, 0.28],
  glm:      [0.01, 0.01],
  kimi:     [0.01, 0.01],
};

interface CostEntry {
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  dailyTokens: number;
  dailyCost: number;
  monthlyTokens: number;
  monthlyCost: number;
  dayStart: number;
  monthStart: number;
  requestCount: number;
}

function defaultCostEntry(): CostEntry {
  return {
    totalTokensIn: 0, totalTokensOut: 0, totalCost: 0,
    dailyTokens: 0, dailyCost: 0,
    monthlyTokens: 0, monthlyCost: 0,
    dayStart: 0, monthStart: 0,
    requestCount: 0,
  };
}

export interface BudgetRule {
  daily_token_limit: number;
  daily_cost_limit: number;
  monthly_token_limit: number;
  monthly_cost_limit: number;
  warning_pct: number;
}

export class CostTracker {
  pricing: Record<string, [number, number]>;
  budgets: Record<string, BudgetRule>;
  entries: Map<string, CostEntry> = new Map();

  constructor(
    pricing?: Record<string, [number, number]>,
    budgets?: Record<string, BudgetRule>,
  ) {
    this.pricing = pricing ? { ...pricing } : { ...DEFAULT_PRICING };
    this.budgets = budgets ? { ...budgets } : {};
  }

  record(providerId: string, tokensIn: number, tokensOut: number): void {
    const now = Date.now() / 1000;
    let entry = this.entries.get(providerId);
    if (!entry) {
      entry = defaultCostEntry();
      this.entries.set(providerId, entry);
    }

    if (now - entry.dayStart > 86400) {
      entry.dailyTokens = 0;
      entry.dailyCost = 0;
      entry.dayStart = now;
    }
    if (now - entry.monthStart > 2592000) {
      entry.monthlyTokens = 0;
      entry.monthlyCost = 0;
      entry.monthStart = now;
    }

    const p = this.pricing[providerId] ?? [0, 0];
    const cost = (tokensIn * p[0] + tokensOut * p[1]) / 1_000_000;
    const totalTok = tokensIn + tokensOut;

    entry.totalTokensIn += tokensIn;
    entry.totalTokensOut += tokensOut;
    entry.totalCost += cost;
    entry.dailyTokens += totalTok;
    entry.dailyCost += cost;
    entry.monthlyTokens += totalTok;
    entry.monthlyCost += cost;
    entry.requestCount++;
  }

  checkBudget(providerId: string): [boolean, number, boolean] {
    const rule = this.budgets[providerId];
    if (!rule) return [true, 1.0, false];

    let entry = this.entries.get(providerId);
    if (!entry) entry = defaultCostEntry();

    if (rule.daily_token_limit > 0) {
      const ratio = entry.dailyTokens / rule.daily_token_limit;
      if (ratio >= 1.0) return [false, 0, true];
      if (ratio >= rule.warning_pct) return [true, 1 - ratio, true];
    }
    if (rule.daily_cost_limit > 0) {
      const ratio = entry.dailyCost / rule.daily_cost_limit;
      if (ratio >= 1.0) return [false, 0, true];
      if (ratio >= rule.warning_pct) return [true, 1 - ratio, true];
    }
    if (rule.monthly_token_limit > 0) {
      const ratio = entry.monthlyTokens / rule.monthly_token_limit;
      if (ratio >= 1.0) return [false, 0, true];
      if (ratio >= rule.warning_pct) return [true, 1 - ratio, true];
    }
    if (rule.monthly_cost_limit > 0) {
      const ratio = entry.monthlyCost / rule.monthly_cost_limit;
      if (ratio >= 1.0) return [false, 0, true];
      if (ratio >= rule.warning_pct) return [true, 1 - ratio, true];
    }
    return [true, 1.0, false];
  }
}

// ---------------------------------------------------------------------------
// Auto Scorer
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  health: number;
  quota: number;
  cost_inv: number;
  latency_inv: number;
  task_fit: number;
  stability: number;
  tier: number;
  quality: number;
  budget_headroom: number;
  success_rate: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  health: 0.18, quota: 0.14, cost_inv: 0.14, latency_inv: 0.12,
  task_fit: 0.10, stability: 0.06, tier: 0.06, quality: 0.06,
  budget_headroom: 0.07, success_rate: 0.07,
};

const TASK_FITNESS: Record<string, Record<string, number>> = {
  claude:   { coding: 0.95, reasoning: 0.95, creative: 0.90, general: 0.90, rag: 0.90 },
  chatgpt:  { coding: 0.90, reasoning: 0.90, creative: 0.92, general: 0.90, rag: 0.88 },
  gemini:   { coding: 0.80, reasoning: 0.85, creative: 0.85, general: 0.85, rag: 0.85 },
  deepseek: { coding: 0.88, reasoning: 0.82, creative: 0.75, general: 0.80, rag: 0.78 },
  glm:      { coding: 0.65, reasoning: 0.65, creative: 0.70, general: 0.70, rag: 0.70 },
  kimi:     { coding: 0.65, reasoning: 0.65, creative: 0.75, general: 0.70, rag: 0.72 },
};

const TIER_SCORES: Record<string, number> = {
  claude: 1.0, chatgpt: 0.90, gemini: 0.80,
  deepseek: 0.70, glm: 0.40, kimi: 0.40,
};

export class AutoScorer {
  weights: ScoringWeights;
  qualitySignals: Map<string, number> = new Map();

  constructor(weights?: Partial<ScoringWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  score(
    providerId: string,
    breaker: CircuitBreaker,
    quotaMgr: QuotaManager,
    costTracker: CostTracker,
    healthStats: Record<string, number>,
    taskType = 'general',
  ): [number, Record<string, number>] {
    const w = this.weights;
    const f: Record<string, number> = {};

    const stateMap: Record<BreakerState, number> = {
      closed: 1.0, degraded: 0.65, half_open: 0.30, open: 0.0,
    };
    f.health = stateMap[breaker.state] ?? 0;
    f.quota = quotaMgr.remainingPct(providerId);

    const p = costTracker.pricing[providerId] ?? [1, 1];
    const avgPrice = (p[0] + p[1]) / 2;
    let poolMax = 0.001;
    for (const pp of Object.values(costTracker.pricing)) {
      const avg = (pp[0] + pp[1]) / 2;
      if (avg > poolMax) poolMax = avg;
    }
    f.cost_inv = 1 - (avgPrice / poolMax);

    const avgLat = healthStats.avg_latency ?? 1.0;
    const maxLat = healthStats.max_pool_latency ?? 10.0;
    f.latency_inv = 1 - Math.min(avgLat / Math.max(maxLat, 0.001), 1.0);

    const fitMap = TASK_FITNESS[providerId] ?? {};
    f.task_fit = fitMap[taskType] ?? 0.5;

    f.stability = 1 - Math.min(healthStats.error_rate ?? 0, 1.0);
    f.tier = TIER_SCORES[providerId] ?? 0.5;
    f.quality = this.qualitySignals.get(providerId) ?? 0.5;

    const [allowed, remaining] = costTracker.checkBudget(providerId);
    f.budget_headroom = allowed ? remaining : 0;
    f.success_rate = healthStats.success_rate ?? 0.5;

    const total =
      w.health * f.health + w.quota * f.quota + w.cost_inv * f.cost_inv +
      w.latency_inv * f.latency_inv + w.task_fit * f.task_fit +
      w.stability * f.stability + w.tier * f.tier + w.quality * f.quality +
      w.budget_headroom * f.budget_headroom + w.success_rate * f.success_rate;

    return [Math.max(0, Math.min(1, total)), f];
  }

  recordQuality(providerId: string, rating: number): void {
    const alpha = 0.3;
    const cur = this.qualitySignals.get(providerId) ?? 0.5;
    this.qualitySignals.set(providerId, cur * (1 - alpha) + rating * alpha);
  }
}

// ---------------------------------------------------------------------------
// Modality Bridge
// ---------------------------------------------------------------------------

export class ModalityBridge {
  static readonly VISION_CAPABLE = new Set(['claude', 'chatgpt', 'gemini']);
  static readonly AUDIO_CAPABLE = new Set(['chatgpt', 'gemini']);

  static needsBridge(providerId: string, modality: ModalityType): boolean {
    if (modality === 'vision') return !ModalityBridge.VISION_CAPABLE.has(providerId);
    if (modality === 'audio') return !ModalityBridge.AUDIO_CAPABLE.has(providerId);
    return false;
  }

  static describeImage(description: string): string {
    return `[Image content: ${description}]`;
  }

  static findCapableProvider(available: string[], modality: ModalityType): string | null {
    const capSet = modality === 'vision'
      ? ModalityBridge.VISION_CAPABLE
      : ModalityBridge.AUDIO_CAPABLE;
    for (const p of available) {
      if (capSet.has(p)) return p;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Graceful Degradation
// ---------------------------------------------------------------------------

export class DegradationManager {
  features: Map<string, DegradationLevel> = new Map();

  withDegradation<T>(
    feature: string,
    primaryFn: () => T,
    fallbackFn?: () => T,
    defaultValue?: T,
  ): T | undefined {
    try {
      const result = primaryFn();
      this.features.set(feature, 'full');
      return result;
    } catch {
      if (fallbackFn) {
        try {
          const result = fallbackFn();
          this.features.set(feature, 'reduced');
          return result;
        } catch {
          // fall through
        }
      }
      this.features.set(feature, 'minimal');
      return defaultValue;
    }
  }

  level(feature: string): DegradationLevel {
    return this.features.get(feature) ?? 'default';
  }

  status(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.features) out[k] = v;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Pipeline Engine
// ---------------------------------------------------------------------------

interface PipelineStage {
  name: string;
  providerTier: 'best' | 'moderate' | 'cheapest';
  promptTemplate: string;
}

interface StageLog {
  stage: string;
  provider: string;
  output_len?: number;
  elapsed_s: number;
  error?: string;
}

const PIPELINE_TEMPLATES: Record<string, PipelineStage[]> = {
  code: [
    { name: 'plan',    providerTier: 'best',     promptTemplate: 'Create a detailed implementation plan for:\n{input}' },
    { name: 'execute', providerTier: 'cheapest',  promptTemplate: 'Implement the following plan:\n{prev}\n\nOriginal task: {input}' },
    { name: 'reflect', providerTier: 'moderate',  promptTemplate: 'Review this implementation for correctness:\n{prev}\n\nOriginal task: {input}\n\nRespond with JSON: {"pass": bool, "feedback": str, "corrected": str_or_null}' },
    { name: 'fix',     providerTier: 'cheapest',  promptTemplate: 'Fix the following based on review:\n{prev}\n\nFeedback: {feedback}' },
  ],
  reasoning: [
    { name: 'execute', providerTier: 'best',     promptTemplate: 'Solve step by step:\n{input}' },
    { name: 'reflect', providerTier: 'moderate',  promptTemplate: 'Verify this solution:\n{prev}\n\nProblem: {input}\n\nRespond with JSON: {"pass": bool, "feedback": str, "corrected": str_or_null}' },
  ],
  creative: [
    { name: 'execute', providerTier: 'moderate', promptTemplate: '{input}' },
    { name: 'reflect', providerTier: 'best',     promptTemplate: 'Improve this creative work:\n{prev}\n\nOriginal brief: {input}' },
  ],
  rag: [
    { name: 'retrieve', providerTier: 'cheapest', promptTemplate: 'Extract the key search queries needed to answer:\n{input}' },
    { name: 'generate', providerTier: 'best',     promptTemplate: 'Using the retrieved context:\n{context}\n\nAnswer: {input}' },
  ],
  general: [
    { name: 'execute', providerTier: 'best',     promptTemplate: '{input}' },
    { name: 'reflect', providerTier: 'moderate',  promptTemplate: 'Check this answer for accuracy:\n{prev}\n\nQuestion: {input}' },
  ],
};

export class PipelineEngine {
  templates: Record<string, PipelineStage[]>;

  constructor() {
    this.templates = { ...PIPELINE_TEMPLATES };
  }

  async run(
    taskType: string,
    inputText: string,
    callFn: (providerId: string, prompt: string) => Promise<string>,
    available: string[],
    context = '',
  ): Promise<[string, StageLog[]]> {
    const stages = this.templates[taskType] ?? this.templates.general;
    const tierIdx: Record<string, number> = {
      best: 0,
      moderate: Math.floor(available.length / 2),
      cheapest: available.length - 1,
    };

    let prev = '';
    let feedback = '';
    let bestOutput = '';
    const log: StageLog[] = [];

    for (const stage of stages) {
      const idx = Math.min(tierIdx[stage.providerTier] ?? 0, available.length - 1);
      const provider = available[idx];

      const prompt = stage.promptTemplate
        .replace(/\{input\}/g, inputText)
        .replace(/\{prev\}/g, prev)
        .replace(/\{feedback\}/g, feedback)
        .replace(/\{context\}/g, context || prev);

      const t0 = Date.now();
      let result: string;
      try {
        result = await callFn(provider, prompt);
      } catch (err) {
        log.push({
          stage: stage.name,
          provider,
          elapsed_s: Math.round((Date.now() - t0) / 1000 * 1000) / 1000,
          error: String(err),
        });
        continue;
      }
      const elapsed = Math.round((Date.now() - t0) / 1000 * 1000) / 1000;

      log.push({ stage: stage.name, provider, output_len: result.length, elapsed_s: elapsed });

      if (stage.name === 'reflect') {
        try {
          const parsed = JSON.parse(result);
          if (parsed.pass) {
            bestOutput = prev;
            break;
          }
          feedback = parsed.feedback ?? '';
          if (parsed.corrected) {
            prev = parsed.corrected;
            bestOutput = parsed.corrected;
          }
        } catch {
          bestOutput = prev;
        }
      } else {
        prev = result;
        bestOutput = result;
      }
    }

    return [bestOutput, log];
  }
}

// ---------------------------------------------------------------------------
// Main Router
// ---------------------------------------------------------------------------

export class Router {
  strategy: RoutingStrategy;
  breakers: Map<string, CircuitBreaker> = new Map();
  quotaMgr: QuotaManager;
  costTracker: CostTracker;
  scorer: AutoScorer;
  degradation: DegradationManager;
  modalityBridge = ModalityBridge;
  pipeline: PipelineEngine;

  private _rrCounter = 0;
  private _lkgp: Map<string, string> = new Map();
  private _usageCounts: Map<string, number> = new Map();
  private _providerWeights: Map<string, number> = new Map();

  constructor(opts?: {
    strategy?: RoutingStrategy;
    weights?: Partial<ScoringWeights>;
    pricing?: Record<string, [number, number]>;
    budgets?: Record<string, BudgetRule>;
  }) {
    this.strategy = opts?.strategy ?? 'auto';
    this.quotaMgr = new QuotaManager();
    this.costTracker = new CostTracker(opts?.pricing, opts?.budgets);
    this.scorer = new AutoScorer(opts?.weights);
    this.degradation = new DegradationManager();
    this.pipeline = new PipelineEngine();
  }

  getBreaker(providerId: string): CircuitBreaker {
    let b = this.breakers.get(providerId);
    if (!b) {
      b = new CircuitBreaker();
      this.breakers.set(providerId, b);
    }
    return b;
  }

  setWeights(providerId: string, weight: number): void {
    this._providerWeights.set(providerId, Math.max(0, weight));
  }

  select(
    available: string[],
    healthStats?: Record<string, Record<string, number>>,
    taskType = 'general',
    modality: ModalityType = 'text',
  ): string | string[] | null {
    if (!available.length) return null;
    const hs = healthStats ?? {};

    // filter by breaker + quota + budget
    let candidates: string[] = [];
    for (const pid of available) {
      const breaker = this.getBreaker(pid);
      if (!breaker.allowRequest()) continue;
      if (!this.quotaMgr.isAvailable(pid)) continue;
      const [allowed] = this.costTracker.checkBudget(pid);
      if (!allowed) continue;
      candidates.push(pid);
    }

    // degraded fallback
    if (!candidates.length) {
      for (const pid of available) {
        if (this.getBreaker(pid).state !== 'open') candidates.push(pid);
      }
    }
    if (!candidates.length) candidates = [...available];

    // modality filtering
    if (modality !== 'text') {
      const cap = candidates.filter(p => !ModalityBridge.needsBridge(p, modality));
      if (cap.length) candidates = cap;
    }

    const strat = this.strategy;

    if (strat === 'priority') return candidates[0];

    if (strat === 'weighted') return this._weighted(candidates);

    if (strat === 'round_robin') {
      this._rrCounter++;
      return candidates[this._rrCounter % candidates.length];
    }

    if (strat === 'p2c') return this._p2c(candidates, hs, taskType);

    if (strat === 'least_used') {
      let minCount = Infinity;
      let pick = candidates[0];
      for (const p of candidates) {
        const c = this._usageCounts.get(p) ?? 0;
        if (c < minCount) { minCount = c; pick = p; }
      }
      return pick;
    }

    if (strat === 'cost_optimized') {
      let minCost = Infinity;
      let pick = candidates[0];
      for (const p of candidates) {
        const pr = this.costTracker.pricing[p] ?? [999, 999];
        const avg = (pr[0] + pr[1]) / 2;
        if (avg < minCost) { minCost = avg; pick = p; }
      }
      return pick;
    }

    if (strat === 'lkgp') return this._lkgpSelect(candidates, taskType);

    if (strat === 'auto') return this._autoSelect(candidates, hs, taskType);

    if (strat === 'fusion') return candidates;

    if (strat === 'pipeline') return candidates[0];

    return candidates[0];
  }

  // -- strategy helpers --

  private _weighted(candidates: string[]): string {
    const weights = candidates.map(p => this._providerWeights.get(p) ?? 1.0);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return candidates[Math.floor(Math.random() * candidates.length)];
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  private _p2c(
    candidates: string[],
    hs: Record<string, Record<string, number>>,
    taskType: string,
  ): string {
    let pair: string[];
    if (candidates.length <= 2) {
      pair = candidates;
    } else {
      const a = Math.floor(Math.random() * candidates.length);
      let b = Math.floor(Math.random() * (candidates.length - 1));
      if (b >= a) b++;
      pair = [candidates[a], candidates[b]];
    }
    let bestScore = -1;
    let bestPid = pair[0];
    for (const pid of pair) {
      const [s] = this.scorer.score(
        pid, this.getBreaker(pid),
        this.quotaMgr, this.costTracker,
        hs[pid] ?? {}, taskType,
      );
      if (s > bestScore) { bestScore = s; bestPid = pid; }
    }
    return bestPid;
  }

  private _lkgpSelect(candidates: string[], taskType: string): string {
    const last = this._lkgp.get(taskType);
    if (last && candidates.includes(last)) return last;
    return candidates[0];
  }

  private _autoSelect(
    candidates: string[],
    hs: Record<string, Record<string, number>>,
    taskType: string,
  ): string {
    let bestScore = -1;
    let bestPid = candidates[0];
    for (const pid of candidates) {
      const [s] = this.scorer.score(
        pid, this.getBreaker(pid),
        this.quotaMgr, this.costTracker,
        hs[pid] ?? {}, taskType,
      );
      if (s > bestScore) { bestScore = s; bestPid = pid; }
    }
    return bestPid;
  }

  // -- recording --

  recordSuccess(opts: {
    providerId: string;
    tokensIn?: number;
    tokensOut?: number;
    latencyS?: number;
    taskType?: string;
  }): void {
    const { providerId, tokensIn = 0, tokensOut = 0, taskType = 'general' } = opts;
    this.getBreaker(providerId).recordSuccess();
    this._usageCounts.set(providerId, (this._usageCounts.get(providerId) ?? 0) + 1);
    this._lkgp.set(taskType, providerId);
    if (tokensIn || tokensOut) {
      this.costTracker.record(providerId, tokensIn, tokensOut);
    }
  }

  recordFailure(opts: {
    providerId: string;
    errorCode?: number;
    retryAfterS?: number;
  }): void {
    const { providerId, errorCode, retryAfterS } = opts;
    const immediate = errorCode === 401 || errorCode === 403;
    this.getBreaker(providerId).recordFailure(immediate);
    if (errorCode === 429) {
      this.quotaMgr.markExhausted(providerId, retryAfterS ?? 300);
    }
  }

  // -- pipeline execution --

  async runPipeline(
    taskType: string,
    inputText: string,
    callFn: (providerId: string, prompt: string) => Promise<string>,
    available: string[],
    context = '',
  ): Promise<[string, StageLog[]]> {
    return this.pipeline.run(taskType, inputText, callFn, available, context);
  }

  // -- status --

  status(): Record<string, unknown> {
    const providers: Record<string, unknown> = {};
    const allIds = new Set([
      ...this.breakers.keys(),
      ...this.costTracker.entries.keys(),
    ]);

    for (const pid of [...allIds].sort()) {
      const breaker = this.getBreaker(pid);
      const entry = this.costTracker.entries.get(pid);
      const e = entry ?? defaultCostEntry();
      providers[pid] = {
        breaker: breaker.toDict(),
        quota_available: this.quotaMgr.isAvailable(pid),
        quota_remaining_pct: Math.round(this.quotaMgr.remainingPct(pid) * 1000) / 1000,
        total_tokens: e.totalTokensIn + e.totalTokensOut,
        total_cost: Math.round(e.totalCost * 1_000_000) / 1_000_000,
        daily_tokens: e.dailyTokens,
        daily_cost: Math.round(e.dailyCost * 1_000_000) / 1_000_000,
        requests: e.requestCount,
        usage_count: this._usageCounts.get(pid) ?? 0,
      };
    }

    const lkgp: Record<string, string> = {};
    for (const [k, v] of this._lkgp) lkgp[k] = v;

    return {
      strategy: this.strategy,
      providers,
      lkgp,
      degradation: this.degradation.status(),
    };
  }

  toDict(): Record<string, unknown> {
    const breakers: Record<string, unknown> = {};
    for (const [pid, b] of this.breakers) breakers[pid] = b.toDict();

    const quota: Record<string, unknown> = {};
    for (const [pid, e] of this.quotaMgr.entries) {
      quota[pid] = {
        remaining: e.remaining, total: e.total, exhausted: e.exhausted,
        remaining_pct: Math.round(this.quotaMgr.remainingPct(pid) * 1000) / 1000,
      };
    }

    const costs: Record<string, unknown> = {};
    for (const [pid, e] of this.costTracker.entries) {
      costs[pid] = {
        total_tokens: e.totalTokensIn + e.totalTokensOut,
        total_cost: Math.round(e.totalCost * 1_000_000) / 1_000_000,
        daily_tokens: e.dailyTokens,
        daily_cost: Math.round(e.dailyCost * 1_000_000) / 1_000_000,
        monthly_tokens: e.monthlyTokens,
        monthly_cost: Math.round(e.monthlyCost * 1_000_000) / 1_000_000,
        requests: e.requestCount,
      };
    }

    const lkgp: Record<string, string> = {};
    for (const [k, v] of this._lkgp) lkgp[k] = v;

    const usageCounts: Record<string, number> = {};
    for (const [k, v] of this._usageCounts) usageCounts[k] = v;

    return {
      strategy: this.strategy,
      breakers,
      quota,
      costs,
      scoring_weights: { ...this.scorer.weights },
      lkgp,
      usage_counts: usageCounts,
      degradation: this.degradation.status(),
    };
  }
}
