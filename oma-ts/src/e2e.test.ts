import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoreLoop, Status, RalphPhase, PhaseEvent, DEFAULT_LOOP_CONFIG } from './core/loop.js';
import { OMA } from './agent.js';
import { Provider, Message, ProviderResponse } from './providers/base.js';

test('e2e: CoreLoop multi-attempt convergence when confidence meets threshold', async () => {
  let attemptCount = 0;
  const phaseEvents: PhaseEvent[] = [];

  const loop = new CoreLoop({
    config: {
      ...DEFAULT_LOOP_CONFIG,
      max_attempts: 5,
      confidence_threshold: 0.85,
      provider_chain: ['mock_p'],
    },
    solve_fn: async (state, _provider) => {
      attemptCount++;
      // Attempt 1: 0.4 confidence, Attempt 2: 0.9 confidence (reaches threshold)
      const conf = attemptCount === 1 ? 0.4 : 0.9;
      return [`Output for attempt ${attemptCount}`, 100, conf];
    },
    sanitize_fn: (output) => output.trim(),
    handoff_fn: async (state) => {
      state.context_for_next = 'handoff completed';
    },
    on_phase: (ev) => {
      phaseEvents.push(ev);
    },
  });

  const finalState = await loop.run('Test objective for convergence', { accuracy: true });

  assert.equal(finalState.status, Status.DONE);
  assert.equal(finalState.attempts, 2);
  assert.ok(finalState.confidence >= 0.85);
  assert.ok(finalState.artifacts['final']);

  // verify all RALPH phases were emitted
  const phasesEmitted = phaseEvents.map(e => e.phase);
  assert.ok(phasesEmitted.includes(RalphPhase.REASON));
  assert.ok(phasesEmitted.includes(RalphPhase.ACT));
  assert.ok(phasesEmitted.includes(RalphPhase.LEARN));
  assert.ok(phasesEmitted.includes(RalphPhase.PLAN));
  assert.ok(phasesEmitted.includes(RalphPhase.HANDOFF));
});

test('e2e: CoreLoop budget exhaustion parks task with handoff', async () => {
  let handoffCalled = false;

  const loop = new CoreLoop({
    config: {
      ...DEFAULT_LOOP_CONFIG,
      token_budget: 250,
      token_reserve_for_handoff: 100,
      max_attempts: 10,
      confidence_threshold: 0.99,
      provider_chain: ['mock_p'],
    },
    solve_fn: async () => {
      // each attempt spends 100 tokens
      return ['Attempt output', 100, 0.5];
    },
    sanitize_fn: (output) => output,
    handoff_fn: async (_state) => {
      handoffCalled = true;
    },
  });

  const finalState = await loop.run('Test budget exhaustion');

  assert.equal(finalState.status, Status.PARKED);
  assert.ok(handoffCalled, 'handoff_fn should be invoked when parked');
  assert.ok(finalState.tokens_used >= 150);
  assert.ok(finalState.context_for_next.length > 0);
});

test('e2e: CoreLoop max attempts limit parks task', async () => {
  let attemptsMade = 0;

  const loop = new CoreLoop({
    config: {
      ...DEFAULT_LOOP_CONFIG,
      max_attempts: 3,
      confidence_threshold: 0.99, // unreachable
      provider_chain: ['mock_p'],
    },
    solve_fn: async () => {
      attemptsMade++;
      return ['Unsatisfactory result', 10, 0.3];
    },
    sanitize_fn: (output) => output,
    handoff_fn: async () => {},
  });

  const finalState = await loop.run('Test max attempts limit');

  assert.equal(attemptsMade, 3);
  assert.equal(finalState.status, Status.PARKED);
  assert.equal(finalState.attempts, 3);
});

class MockE2EProvider extends Provider {
  name = 'e2e_provider';
  callCount = 0;

  async complete(_messages: Message[]): Promise<ProviderResponse> {
    this.callCount++;
    return {
      text: 'Final validated answer for objective accuracy and quality.',
      tokens_in: 25,
      tokens_out: 40,
      model: 'e2e-model',
      provider: 'e2e_provider',
      latency_ms: 15,
    };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

test('e2e: OMA full run() with Provider and event listener', async () => {
  const oma = OMA.fromEnv({
    config: {
      token_budget: 10_000,
      confidence_threshold: 0.6,
      max_attempts: 3,
      provider_chain: ['e2e_provider'],
    },
  });

  const mock = new MockE2EProvider();
  oma.registry.register('e2e_provider', mock);

  const phaseSequence: string[] = [];
  const state = await oma.run({
    objective: 'Generate final verified report with accuracy and quality',
    criteria: { accuracy: true, quality: true },
    onPhase: (ev) => {
      phaseSequence.push(ev.phase);
    },
  });

  assert.equal(state.status, Status.DONE);
  assert.ok(mock.callCount >= 1, 'Provider was invoked during Act phase');
  assert.ok(phaseSequence.includes('reason'));
  assert.ok(phaseSequence.includes('act'));
  assert.ok(phaseSequence.includes('learn'));
  assert.ok(phaseSequence.includes('plan'));
  assert.ok(phaseSequence.includes('handoff'));

  // verify working memory has stored the attempt
  assert.ok(oma.working._store.size > 0);
  assert.ok(oma.working.get('attempt_1') !== null);
});
