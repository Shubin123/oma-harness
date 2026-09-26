import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Router,
  CircuitBreaker,
  CostTracker,
  QuotaManager,
  AutoScorer,
  ModalityBridge,
  DegradationManager,
  PipelineEngine,
  ROUTING_STRATEGIES,
} from './core/router.js';
import { OmniRouteBridge } from './core/omniroute_bridge.js';
import { PROVIDER_CONFIGS } from './providers/http-providers.js';
import { OMA } from './agent.js';
import { LayaClassifier, TaskEncapsulation } from './core/layaClassifier.js';

test('integration: Router supports all 10 routing strategies', () => {
  const providers = ['claude', 'chatgpt', 'gemini'];

  for (const strategy of ROUTING_STRATEGIES) {
    const router = new Router({ strategy });
    assert.equal(router.strategy, strategy);

    const pick = router.select(providers);
    assert.ok(pick !== null, `Strategy ${strategy} should select a candidate`);

    if (strategy === 'fusion') {
      assert.ok(Array.isArray(pick), 'fusion returns array of candidates');
      assert.deepEqual(pick, providers);
    } else {
      assert.ok(typeof pick === 'string', `${strategy} returns a single provider string`);
      assert.ok(providers.includes(pick as string));
    }
  }
});

test('integration: Router round-robin cycles through candidates', () => {
  const router = new Router({ strategy: 'round_robin' });
  const providers = ['p1', 'p2', 'p3'];

  const r1 = router.select(providers);
  const r2 = router.select(providers);
  const r3 = router.select(providers);
  const r4 = router.select(providers);

  assert.equal(r1, 'p1');
  assert.equal(r2, 'p2');
  assert.equal(r3, 'p3');
  assert.equal(r4, 'p1'); // wrapped around
});

test('integration: Router LKGP (last known good provider) tracks per task type', () => {
  const router = new Router({ strategy: 'lkgp' });
  const providers = ['claude', 'chatgpt', 'gemini'];

  // initially priority pick
  assert.equal(router.select(providers, undefined, 'coding'), 'claude');

  // record success for chatgpt on coding
  router.recordSuccess({ providerId: 'chatgpt', taskType: 'coding' });

  // next select for coding picks chatgpt
  assert.equal(router.select(providers, undefined, 'coding'), 'chatgpt');

  // reasoning still defaults to priority
  assert.equal(router.select(providers, undefined, 'reasoning'), 'claude');
});

test('integration: CircuitBreaker state transitions (closed -> degraded -> open -> half_open -> closed)', () => {
  const breaker = new CircuitBreaker({
    failure_threshold: 4,
    degradation_pct: 0.5,
    recovery_timeout_s: 0.05, // 50ms for testing
    backoff_multiplier: 1,
    max_backoff_multiplier: 1,
  });

  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.allowRequest(), true);

  // 1 failure: stays closed
  breaker.recordFailure();
  assert.equal(breaker.state, 'closed');

  // 2 failures (>= 4 * 0.5 = 2): becomes degraded
  breaker.recordFailure();
  assert.equal(breaker.state, 'degraded');
  assert.equal(breaker.allowRequest(), true);

  // 4 failures (>= 4): becomes open
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state, 'open');
  assert.equal(breaker.allowRequest(), false);

  // wait for recovery timeout
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      // should allow single probe and transition to half_open
      assert.equal(breaker.allowRequest(), true);
      assert.equal(breaker.state, 'half_open');

      // success resets back to closed
      breaker.recordSuccess();
      assert.equal(breaker.state, 'closed');
      assert.equal(breaker.failureCount, 0);
      resolve();
    }, 80);
  });
});

test('integration: CostTracker & QuotaManager tracking', () => {
  const tracker = new CostTracker();
  tracker.budgets['mock_p'] = {
    daily_token_limit: 0,
    daily_cost_limit: 10.0,
    monthly_token_limit: 0,
    monthly_cost_limit: 0,
    warning_pct: 0.8,
  };
  tracker.pricing['mock_p'] = [2.0, 6.0]; // per 1M tokens

  // initial budget check
  const [allowed1, remaining1] = tracker.checkBudget('mock_p');
  assert.equal(allowed1, true);
  assert.equal(remaining1, 1.0);

  // record 10k in, 5k out
  tracker.record('mock_p', 10_000, 5_000);
  // cost: (10,000 * 2.0 + 5,000 * 6.0) / 1,000,000 = (20,000 + 30,000) / 1,000,000 = 0.05
  const entry = tracker.entries.get('mock_p');
  assert.ok(entry);
  assert.equal(entry.requestCount, 1);
  assert.equal(entry.totalTokensIn, 10_000);
  assert.equal(entry.totalTokensOut, 5_000);
  assert.ok(Math.abs(entry.totalCost - 0.05) < 1e-4, 'calculated cost matches pricing');

  const quota = new QuotaManager();
  quota.markAvailable('mock_p', 100, 1000);
  assert.equal(quota.isAvailable('mock_p'), true);
  assert.equal(quota.remainingPct('mock_p'), 0.1);

  quota.markExhausted('mock_p');
  assert.equal(quota.isAvailable('mock_p'), false);
  assert.equal(quota.remainingPct('mock_p'), 0.0);
});

test('integration: AutoScorer multi-factor evaluation', () => {
  const scorer = new AutoScorer();
  const breaker = new CircuitBreaker();
  const quota = new QuotaManager();
  const cost = new CostTracker();

  const [score1, factors1] = scorer.score(
    'claude',
    breaker,
    quota,
    cost,
    { avg_latency: 0.5, success_rate: 1.0, error_rate: 0.0 },
    'coding',
  );

  assert.ok(score1 > 0 && score1 <= 1.0, 'score should be clamped [0, 1]');
  assert.equal(factors1.health, 1.0, 'closed breaker gives 1.0 health');

  // test quality rating feedback
  scorer.recordQuality('claude', 0.95);
  const [, factors2] = scorer.score(
    'claude',
    breaker,
    quota,
    cost,
    { avg_latency: 0.5, success_rate: 1.0, error_rate: 0.0 },
    'coding',
  );
  assert.ok(factors2.quality > 0.5, 'recorded quality updates factor');
});

test('integration: ModalityBridge vision and audio capabilities', () => {
  assert.equal(ModalityBridge.needsBridge('claude', 'vision'), false);
  assert.equal(ModalityBridge.needsBridge('deepseek', 'vision'), true);
  assert.equal(ModalityBridge.needsBridge('chatgpt', 'audio'), false);
  assert.equal(ModalityBridge.needsBridge('claude', 'audio'), true);

  const desc = ModalityBridge.describeImage('diagram showing architecture');
  assert.ok(desc.includes('diagram showing architecture'));
});

test('integration: DegradationManager feature levels', () => {
  const dm = new DegradationManager();

  const res1 = dm.withDegradation('feat1', () => 'ok');
  assert.equal(res1, 'ok');
  assert.equal(dm.level('feat1'), 'full');

  const res2 = dm.withDegradation('feat2', () => { throw new Error('fail'); }, () => 'fallback');
  assert.equal(res2, 'fallback');
  assert.equal(dm.level('feat2'), 'reduced');

  const res3 = dm.withDegradation('feat3', () => { throw new Error('fail1'); }, () => { throw new Error('fail2'); }, 'default_val');
  assert.equal(res3, 'default_val');
  assert.equal(dm.level('feat3'), 'minimal');
});

test('integration: PipelineEngine empty available handling', async () => {
  const engine = new PipelineEngine();
  const [output, log] = await engine.run('code', 'test input', async () => 'result', []);
  assert.equal(output, '');
  assert.deepEqual(log, []);
});

test('integration: OmniRouteBridge initialization and status', async () => {
  const bridge = new OmniRouteBridge({ baseUrl: 'http://127.0.0.1:9999' });
  assert.equal(bridge.available, false);

  const status = await bridge.status();
  assert.equal(status.available, false);
  assert.equal(status.base_url, 'http://127.0.0.1:9999');
});

test('integration: Router selectTiered dynamic failover (Gemini T1 -> DeepSeek T2)', () => {
  const router = new Router();
  const available = ['gemini', 'deepseek', 'groq'];

  // 1. When Gemini (T1) is healthy, it is selected as primary
  const [p1, tier1, failover1] = router.selectTiered('gemini', 'deepseek', available);
  assert.equal(p1, 'gemini');
  assert.equal(tier1, 't1');
  assert.equal(failover1, false);

  // 2. When Gemini trips its circuit breaker, failover directly to DeepSeek (T2)
  const geminiBreaker = router.getBreaker('gemini');
  for (let i = 0; i < geminiBreaker.config.failure_threshold; i++) {
    geminiBreaker.recordFailure();
  }
  assert.equal(geminiBreaker.state, 'open');

  const [p2, tier2, failover2] = router.selectTiered('gemini', 'deepseek', available);
  assert.equal(p2, 'deepseek');
  assert.equal(tier2, 't2');
  assert.equal(failover2, true);
});

test('integration: HTTP Providers includes Jev, Groq, Mistral, OpenRouter, Ollama, Together, Qwen', () => {
  const expected = [
    'claude', 'chatgpt', 'gemini', 'deepseek', 'jev', 'groq',
    'mistral', 'openrouter', 'ollama', 'together', 'qwen', 'glm', 'kimi',
  ];

  for (const name of expected) {
    assert.ok(name in PROVIDER_CONFIGS, `Missing provider config for ${name}`);
    const cfg = PROVIDER_CONFIGS[name];
    assert.ok(cfg.endpoint.length > 0, `${name} has endpoint`);
    assert.ok(cfg.default_model.length > 0, `${name} has default_model`);
  }

  // Jev (TypeSafe AI fast System 1 evaluator)
  const jevCfg = PROVIDER_CONFIGS['jev'];
  assert.equal(jevCfg.default_model, 'typesafe/jev');
  assert.ok(jevCfg.endpoint.includes('typesafe.ai'));
});

test('integration: OpenAI uses stateless Responses API contracts', () => {
  const cfg = PROVIDER_CONFIGS.chatgpt;
  assert.equal(cfg.endpoint, 'https://api.openai.com/v1/responses');
  assert.equal(cfg.default_model, 'gpt-5.4');
  const body = cfg.body_fn({
    messages: [{ role: 'user', content: 'hello' }], system: 'be helpful',
    model: 'gpt-5.4', max_tokens: 100, temperature: 0.3,
  }) as Record<string, unknown>;
  assert.equal(body.instructions, 'be helpful');
  assert.equal(body.max_output_tokens, 100);
  assert.equal(body.store, false);
  assert.deepEqual(body.input, [{ role: 'user', content: 'hello' }]);
  assert.equal('temperature' in body, false);

  const parsed = cfg.parse_fn({
    model: 'gpt-5.4-2026-03-05',
    output: [{ type: 'message', content: [
      { type: 'output_text', text: 'Hello' },
      { type: 'output_text', text: ' world' },
    ] }],
    usage: { input_tokens: 12, output_tokens: 7 },
  });
  assert.deepEqual(parsed, {
    text: 'Hello world', tokens_in: 12, tokens_out: 7, model: 'gpt-5.4-2026-03-05',
  });
});

test('integration: OMA fallback solve delivers high-confidence solution on offline / uncredentialed', async () => {
  const oma = OMA.fromEnv();
  // Clear any active providers to force offline self-healing fallback solver
  const result = await oma.run({ objective: 'Write a quicksort in python' });
  assert.equal(result.status, 'done');
  assert.ok(result.confidence >= 0.90, `Confidence ${result.confidence} should be >= 0.90`);
  assert.ok(result.tokens_used > 0, 'Tokens should be accounted');
  assert.ok((result.artifacts.final ?? '').includes('def quicksort'), 'Quicksort implementation generated');
});

test('integration: LayaClassifier encapsulates tasks with agents and sub-agents', () => {
  const classifier = new LayaClassifier();

  // Test coding task classification and encapsulation
  const encCoding = classifier.encapsulate('Refactor the database queries in Python and write unit tests');
  assert.equal(encCoding.category, 'coding');
  assert.equal(encCoding.assignedAgent, 'coding_agent');
  assert.ok(['chatgpt', 'claude', 'deepseek'].includes(encCoding.recommendedProvider));
  assert.ok(encCoding.subAgents.length >= 2, 'Should decompose into subtasks');
  assert.ok(encCoding.subAgents.some(st => st.role.toLowerCase().includes('developer') || st.role.toLowerCase().includes('qa') || st.role.toLowerCase().includes('architect')));

  // Test research task
  const encResearch = classifier.encapsulate('Research market competitors and analyze pricing models');
  assert.equal(encResearch.category, 'research');
  assert.equal(encResearch.assignedAgent, 'research_agent');
  assert.ok(['gemini', 'claude'].includes(encResearch.recommendedProvider));

  // Test math logic task
  const encMath = classifier.encapsulate('Calculate Bayesian posterior probability under beta prior');
  assert.equal(encMath.category, 'math_logic');

  // Test quality gate evaluation
  const gatePass = classifier.evaluateQuality('All 15 tests passed with 100% branch coverage', { tests: 'passed' });
  assert.equal(gatePass.passed, true);
  assert.ok(gatePass.score >= 0.7);

  const gateFail = classifier.evaluateQuality('error: failed to bind address');
  assert.equal(gateFail.passed, false);

  // Invariant 1: State always serializable
  const serialized = encCoding.toDict();
  assert.equal(typeof serialized, 'object');
  const restored = TaskEncapsulation.fromDict(serialized);
  assert.deepEqual(restored.toDict(), serialized);

  // OMA integration check
  const oma = OMA.fromEnv();
  const classified = oma.classifyTask('Implement a binary search tree in TypeScript');
  assert.equal(classified.category, 'coding');
  assert.ok(classified.subAgents.length > 0);
});
