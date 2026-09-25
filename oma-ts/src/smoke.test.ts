import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OMA } from './agent.js';
import { Sanitizer, sanitize } from './core/sanitize.js';
import { CriteriaSet, Criterion, CriterionType } from './core/criteria.js';
import { WorkingMemory } from './automation/memory.js';
import { ProviderRegistry } from './providers/registry.js';
import { Provider, Message, ProviderResponse } from './providers/base.js';
import { IS_WINDOWS, currentUser, machineId, expectedPermissions } from './platformCompat.js';

test('smoke: OMA initialization and status()', () => {
  const oma = OMA.fromEnv();
  const status = oma.status() as {
    providers: Record<string, unknown>;
    working_memory_entries: number;
    ralph: { current_phase: string; total_events: number };
    config: { token_budget: number };
  };

  assert.ok(status, 'status object exists');
  assert.equal(typeof status.working_memory_entries, 'number');
  assert.equal(status.ralph.current_phase, 'idle');
  assert.equal(typeof status.config.token_budget, 'number');
});

test('smoke: Sanitizer removes fingerprints and normalizes punctuation', () => {
  const s = new Sanitizer();
  const raw = "Certainly! I'd be happy to help. Powered by Claude — here is your answer: “quoted text”";
  const cleaned = s.run(raw);

  assert.ok(!cleaned.includes('Powered by Claude'), 'attributions stripped');
  assert.ok(!cleaned.includes('Certainly!'), 'filler stripped');
  assert.ok(!cleaned.includes('“') && !cleaned.includes('”'), 'curly quotes straightened');
  assert.equal(sanitize.run(raw), cleaned, 'singleton behaves identically to new instance');
});

test('smoke: Criterion and CriteriaSet evaluation', () => {
  const cBool = new Criterion({
    name: 'bool_test',
    description: 'test boolean',
    ctype: CriterionType.BOOLEAN,
  });
  assert.equal(cBool.evaluate(true), 1.0);
  assert.equal(cBool.evaluate(false), 0.0);

  const cNum = new Criterion({
    name: 'num_test',
    description: 'test numeric',
    ctype: CriterionType.NUMERIC,
  });
  assert.equal(cNum.evaluate(0.75), 0.75);

  const cContains = new Criterion({
    name: 'cont_test',
    description: 'test contains',
    ctype: CriterionType.CONTAINS,
    weight: 1.0,
    target: 'hello',
  });
  assert.equal(cContains.evaluate('say hello world'), 1.0);

  const cRegex = new Criterion({
    name: 're_test',
    description: 'test regex',
    ctype: CriterionType.REGEX,
    weight: 1.0,
    target: '\\d{3}',
  });
  assert.equal(cRegex.evaluate('code 456 ok'), 1.0);

  const cCustom = new Criterion({
    name: 'cust_test',
    description: 'test custom',
    ctype: CriterionType.CUSTOM,
    weight: 1.0,
    eval_fn: (val: unknown) => (val === 'special' ? 0.9 : 0.1),
  });
  assert.equal(cCustom.evaluate('special'), 0.9);

  const set = new CriteriaSet();
  set.add(cBool).add(cContains);
  const [overall, scores] = set.evaluate({ bool_test: true, cont_test: 'hello there' });
  assert.equal(overall, 1.0);
  assert.equal(scores.bool_test.status, 'pass');
  assert.equal(scores.cont_test.status, 'pass');
});

test('smoke: WorkingMemory LRU and tagging', () => {
  const mem = new WorkingMemory(10);
  mem.put('key1', 'content with apple and banana', { tags: ['fruit'], source: 'src1' });
  mem.put('key2', 'content with carrot and celery', { tags: ['vegetable'], source: 'src2' });

  assert.equal(mem.get('key1'), 'content with apple and banana');
  assert.equal(mem.get('key2'), 'content with carrot and celery');

  const foundByTag = mem.search('fruit');
  assert.equal(foundByTag.length, 1);
  assert.equal(foundByTag[0].key, 'key1');

  const summary = mem.summarize();
  assert.ok(summary.includes('key1'));
  assert.ok(summary.includes('key2'));
});

class MockProvider extends Provider {
  name = 'test_p';
  async complete(_messages: Message[]): Promise<ProviderResponse> {
    return {
      text: 'mock response text',
      tokens_in: 5,
      tokens_out: 10,
      model: 'mock-model',
      provider: 'test_p',
      latency_ms: 12,
    };
  }
  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

test('smoke: ProviderRegistry registration and statusReport', () => {
  const reg = new ProviderRegistry();
  const mockProvider = new MockProvider();
  reg.register('test_p', mockProvider);

  assert.ok(reg.get('test_p') !== undefined);
  assert.equal(reg.get('test_p'), mockProvider);
  assert.ok(reg.available().includes('test_p'));

  const report = reg.statusReport();
  assert.ok(report.test_p);
});

test('smoke: PlatformCompat machineId and permissions', () => {
  const user = currentUser();
  assert.ok(user.length > 0, 'currentUser is non-empty');

  const mid = machineId();
  assert.ok(mid.length > 0, 'machineId is non-empty');

  const expectedFilePerm = expectedPermissions(false);
  assert.ok(expectedFilePerm.length > 0, 'expectedPermissions returns non-empty string');
  if (!IS_WINDOWS) {
    assert.equal(expectedFilePerm, '0o600');
  }
});
