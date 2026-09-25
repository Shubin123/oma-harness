/**
 * Regression tests verifying fixes for latent bugs discovered across OMA TypeScript.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OMA } from './agent.js';
import { Status } from './core/loop.js';
import { ProviderRegistry } from './providers/registry.js';
import { Provider, ProviderResponse } from './providers/base.js';
import { HTTPProvider, PROVIDER_CONFIGS } from './providers/http-providers.js';
import { Router, CircuitBreaker, QuotaManager, PipelineEngine } from './core/router.js';
import { Criterion, CriterionType } from './core/criteria.js';
import { Sanitizer } from './core/sanitize.js';
import { createDashboardServer } from './gui/web.js';

test('regression: double plan effects - consecutive failures increment exactly once per failure', async () => {
  const reg = new ProviderRegistry();
  class FailingDummyProvider extends Provider {
    name = 'failing_p';
    async complete(): Promise<ProviderResponse> {
      return {
        text: '',
        tokens_in: 0,
        tokens_out: 0,
        model: 'm',
        provider: 'failing_p',
        latency_ms: 0,
        error: 'simulated error',
      };
    }
    countTokens(): number { return 0; }
  }

  reg.register('failing_p', new FailingDummyProvider());

  const agent = new OMA({
    registry: reg,
    config: {
      provider_chain: ['failing_p'],
      max_attempts: 5,
      confidence_threshold: 0.8,
      backoff_base_s: 0.001,
      backoff_max_s: 0.005,
    },
  });

  const state = await agent.run({ objective: 'Failing task' });
  // With max_attempts=5 and threshold 3, consecutive_failures reaching 3 causes park at attempt 3
  assert.equal(state.attempts, 3);
  assert.equal(state.status, Status.PARKED);
});

test('regression: gemini endpoint formatting replaces {model} and adds API key', async () => {
  const cfg = PROVIDER_CONFIGS['gemini'];
  const provider = new HTTPProvider({
    name: 'gemini',
    api_key: 'test_api_key_123',
    endpoint: cfg.endpoint,
    model: cfg.default_model,
    headers_fn: cfg.headers_fn,
    body_fn: cfg.body_fn,
    parse_fn: cfg.parse_fn,
  });

  const origFetch = globalThis.fetch;
  let capturedUrl = '';

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Gemini response' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    const resp = await provider.complete(
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
      0.3,
      { model: 'gemini-2.0-flash' },
    );
    assert.equal(resp.text, 'Gemini response');
    assert.ok(capturedUrl.includes('models/gemini-2.0-flash:generateContent?key=test_api_key_123'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('regression: web test history endpoint returns runs array without hanging', async () => {
  const server = createDashboardServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };

  try {
    const resp = await fetch(`http://127.0.0.1:${addr.port}/api/test/history`);
    assert.equal(resp.status, 200);
    const data = await resp.json() as { runs: unknown[] };
    assert.ok(Array.isArray(data.runs));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('regression: criteria extraction in confidence estimation recognizes nested criteria list', () => {
  const reg = new ProviderRegistry();
  const agent = new OMA({ registry: reg });

  const criteriaDict = {
    criteria: [
      { name: 'latency_check', type: 'threshold', target: 100 },
      { name: 'correctness', type: 'binary', target: true },
    ],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const confWithMatches = (agent as any)._estimateConfidence(
    'The latency_check is good and correctness is verified.',
    criteriaDict,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const confWithoutMatches = (agent as any)._estimateConfidence(
    'Unrelated output here with nothing relevant.',
    criteriaDict,
  );

  assert.ok(confWithMatches > confWithoutMatches);
  assert.ok(confWithMatches >= 0.65);
});

test('regression: round-robin selects index 0 on first call and wraps correctly', () => {
  const router = new Router({ strategy: 'round_robin' });
  const candidates = ['alpha', 'beta', 'gamma'];

  const c1 = router.select(candidates);
  const c2 = router.select(candidates);
  const c3 = router.select(candidates);
  const c4 = router.select(candidates);

  assert.equal(c1, 'alpha');
  assert.equal(c2, 'beta');
  assert.equal(c3, 'gamma');
  assert.equal(c4, 'alpha');
});

test('regression: pipeline engine handles empty available list without crashing', async () => {
  const engine = new PipelineEngine();
  const [res, stages] = await engine.run(
    'general',
    'Do something',
    async () => 'output',
    [],
  );
  assert.equal(res, '');
  assert.deepEqual(stages, []);
});

test('regression: threshold criterion clamped [0, 1] and zero target handling', () => {
  const cZero = new Criterion({
    name: 'zero_target',
    description: 'zero target',
    ctype: CriterionType.THRESHOLD,
    target: 0.0,
  });
  assert.equal(cZero.evaluate(0), 1.0);
  assert.equal(cZero.evaluate(-10), 0.0);

  const cNorm = new Criterion({
    name: 'norm',
    description: 'norm 100',
    ctype: CriterionType.THRESHOLD,
    target: 100.0,
  });
  assert.equal(cNorm.evaluate(-50.0), 0.0);
  assert.equal(cNorm.evaluate(200.0), 1.0);
});

test('regression: circuit breaker in half-open immediately transitions to open on failure', () => {
  const cb = new CircuitBreaker({
    failure_threshold: 5,
    degradation_pct: 0.5,
    recovery_timeout_s: 0.01,
    backoff_multiplier: 1.5,
    max_backoff_multiplier: 10,
  });
  cb.state = 'half_open';
  cb.failureCount = 0;

  // Probe failed in half-open
  cb.recordFailure();

  // Must immediately transition back to open
  assert.equal(cb.state, 'open');
});

test('regression: quota manager returns 0.0 for exhausted provider even with total <= 0', () => {
  const qm = new QuotaManager();
  qm.markExhausted('test_prov');

  const pct = qm.remainingPct('test_prov');
  assert.equal(pct, 0.0);
});

test('regression: sanitizer strips curly quotes and attributions', () => {
  const s = new Sanitizer();
  const text1 = "Anthropic's Claude generated this solution.\nHere is your solution.";
  const text2 = "Anthropic’s Claude generated this solution.\nHere is your solution.";
  const text3 = "I'm Claude, here to assist.\nHere is your solution.";
  const text4 = "I’m Claude, here to assist.\nHere is your solution.";

  const clean1 = s.run(text1);
  const clean2 = s.run(text2);
  const clean3 = s.run(text3);
  const clean4 = s.run(text4);

  assert.ok(!clean1.includes('Claude'));
  assert.ok(!clean2.includes('Claude'));
  assert.ok(!clean3.includes('Claude'));
  assert.ok(!clean4.includes('Claude'));
  assert.ok(clean1.includes('Here is your solution.'));
  assert.ok(clean2.includes('Here is your solution.'));
  assert.ok(clean3.includes('Here is your solution.'));
  assert.ok(clean4.includes('Here is your solution.'));
});
