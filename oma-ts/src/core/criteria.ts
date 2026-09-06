/**
 * OMA Criteria Engine - define, search, and evaluate solution characteristics.
 *
 * Criteria are the "what good looks like" spec for a task.
 * The engine:
 *   1. Decomposes an objective into measurable criteria
 *   2. Weights them by importance
 *   3. Evaluates a candidate solution against them
 *   4. Returns a confidence score
 *
 * This replaces vague "is it done?" checks with explicit pass/fail gates.
 */

export enum CriterionType {
  BOOLEAN = 'boolean',
  NUMERIC = 'numeric',
  THRESHOLD = 'threshold',
  CONTAINS = 'contains',
  REGEX = 'regex',
  CUSTOM = 'custom',
}

export interface CriterionInit {
  name: string;
  description: string;
  ctype: CriterionType;
  weight?: number;
  target?: unknown;
  eval_fn?: (output: unknown) => number;
  required?: boolean;
}

export class Criterion {
  name: string;
  description: string;
  ctype: CriterionType;
  weight: number;
  target: unknown;
  eval_fn?: (output: unknown) => number;
  required: boolean;

  constructor(init: CriterionInit) {
    this.name = init.name;
    this.description = init.description;
    this.ctype = init.ctype;
    this.weight = init.weight ?? 1.0;
    this.target = init.target ?? null;
    this.eval_fn = init.eval_fn;
    this.required = init.required ?? false;
  }

  evaluate(output: unknown): number {
    try {
      switch (this.ctype) {
        case CriterionType.BOOLEAN:
          return output ? 1.0 : 0.0;

        case CriterionType.NUMERIC:
          return Math.max(0, Math.min(1, Number(output)));

        case CriterionType.THRESHOLD: {
          const val = Number(output);
          const tgt = Number(this.target);
          return val >= tgt ? 1.0 : val / tgt;
        }

        case CriterionType.CONTAINS: {
          const text = String(output).toLowerCase();
          const target = String(this.target).toLowerCase();
          return text.includes(target) ? 1.0 : 0.0;
        }

        case CriterionType.REGEX:
          return new RegExp(String(this.target)).test(String(output)) ? 1.0 : 0.0;

        case CriterionType.CUSTOM:
          if (this.eval_fn) {
            return Math.max(0, Math.min(1, this.eval_fn(output)));
          }
          return 0.0;

        default:
          return 0.0;
      }
    } catch {
      return 0.0;
    }
  }
}

export interface CriterionScore {
  score: number;
  weight: number;
  status: 'pass' | 'fail' | 'missing';
}

export class CriteriaSet {
  criteria: Criterion[] = [];

  add(criterion: Criterion): this {
    this.criteria.push(criterion);
    return this;
  }

  evaluate(outputs: Record<string, unknown>): [number, Record<string, CriterionScore>] {
    if (this.criteria.length === 0) return [0, {}];

    const scores: Record<string, CriterionScore> = {};
    let totalWeight = 0;
    let weightedSum = 0;
    let hasRequiredFail = false;

    for (const c of this.criteria) {
      const value = outputs[c.name];
      if (value === undefined || value === null) {
        scores[c.name] = { score: 0, weight: c.weight, status: 'missing' };
        if (c.required) hasRequiredFail = true;
        continue;
      }

      const score = c.evaluate(value);
      scores[c.name] = {
        score,
        weight: c.weight,
        status: score >= 0.5 ? 'pass' : 'fail',
      };

      if (c.required && score < 0.5) hasRequiredFail = true;

      weightedSum += score * c.weight;
      totalWeight += c.weight;
    }

    const overall = hasRequiredFail ? 0 : (totalWeight > 0 ? weightedSum / totalWeight : 0);
    return [overall, scores];
  }

  toDict(): Record<string, unknown> {
    return {
      criteria: this.criteria.map(c => ({
        name: c.name,
        description: c.description,
        type: c.ctype,
        weight: c.weight,
        required: c.required,
      })),
    };
  }
}

// ---- preset criteria builders ----

export function codeQualityCriteria(): CriteriaSet {
  const cs = new CriteriaSet();
  cs.add(new Criterion({ name: 'compiles', description: 'Code compiles/parses without errors', ctype: CriterionType.BOOLEAN, weight: 3.0, required: true }));
  cs.add(new Criterion({ name: 'tests_pass', description: 'All tests pass', ctype: CriterionType.BOOLEAN, weight: 2.5, required: true }));
  cs.add(new Criterion({ name: 'no_hardcoded', description: 'No hardcoded secrets or paths', ctype: CriterionType.BOOLEAN, weight: 2.0 }));
  cs.add(new Criterion({ name: 'documented', description: 'Functions have docstrings', ctype: CriterionType.NUMERIC, weight: 1.0 }));
  cs.add(new Criterion({ name: 'coverage', description: 'Test coverage ratio', ctype: CriterionType.THRESHOLD, weight: 1.5, target: 0.7 }));
  return cs;
}

export function researchCriteria(): CriteriaSet {
  const cs = new CriteriaSet();
  cs.add(new Criterion({ name: 'has_sources', description: 'Claims backed by sources', ctype: CriterionType.BOOLEAN, weight: 3.0, required: true }));
  cs.add(new Criterion({ name: 'source_count', description: 'Number of distinct sources', ctype: CriterionType.THRESHOLD, weight: 1.5, target: 3 }));
  cs.add(new Criterion({ name: 'coherent', description: 'Logical flow score', ctype: CriterionType.NUMERIC, weight: 2.0 }));
  cs.add(new Criterion({ name: 'actionable', description: 'Contains actionable conclusions', ctype: CriterionType.BOOLEAN, weight: 1.5 }));
  return cs;
}

export function automationCriteria(): CriteriaSet {
  const cs = new CriteriaSet();
  cs.add(new Criterion({ name: 'target_reached', description: 'Navigation reached target state', ctype: CriterionType.BOOLEAN, weight: 3.0, required: true }));
  cs.add(new Criterion({ name: 'no_errors', description: 'No JS errors or failed requests', ctype: CriterionType.BOOLEAN, weight: 2.0 }));
  cs.add(new Criterion({ name: 'data_extracted', description: 'Required data was captured', ctype: CriterionType.BOOLEAN, weight: 2.5, required: true }));
  cs.add(new Criterion({ name: 'under_time', description: 'Completed within time budget', ctype: CriterionType.BOOLEAN, weight: 1.0 }));
  return cs;
}

function coherenceScore(output: unknown): number {
  if (typeof output !== 'string') return 0;
  const text = output.trim();
  if (!text) return 0;
  const errorMarkers = ['traceback', 'error:', 'exception:', 'errno', 'failed to', '502', '503'];
  const lower = text.toLowerCase();
  for (const marker of errorMarkers) {
    if (lower.slice(0, 200).includes(marker)) return 0.2;
  }
  if (text.length < 30) return 0.4;
  const words = text.split(/\s+/);
  if (words.length < 5) return 0.5;
  return Math.min(1.0, 0.6 + words.length / 500);
}

function completenessScore(output: unknown): number {
  if (typeof output !== 'string') return 0;
  const text = output.trim();
  if (!text) return 0;
  const last = text[text.length - 1];
  if ('.!?)"]}>'.includes(last)) return 1.0;
  if (text.endsWith('```')) return 1.0;
  if (/[a-zA-Z]/.test(last) || last === ',') return 0.3;
  return 0.7;
}

export function defaultCriteria(): CriteriaSet {
  const cs = new CriteriaSet();
  cs.add(new Criterion({
    name: 'non_empty', description: 'Output is non-empty and substantive',
    ctype: CriterionType.CUSTOM, weight: 3.0, required: true,
    eval_fn: (o) => (typeof o === 'string' && o.trim().length > 20) ? 1.0 : 0.0,
  }));
  cs.add(new Criterion({
    name: 'coherent', description: 'Output reads as coherent text (not error messages or garbage)',
    ctype: CriterionType.CUSTOM, weight: 2.0,
    eval_fn: coherenceScore,
  }));
  cs.add(new Criterion({
    name: 'on_topic', description: 'Output addresses the objective (not off-topic filler)',
    ctype: CriterionType.CUSTOM, weight: 2.5,
    eval_fn: (o) => (typeof o === 'string' && o.trim().length > 50) ? 1.0 : 0.3,
  }));
  cs.add(new Criterion({
    name: 'no_truncation', description: 'Output appears complete (not cut off mid-sentence)',
    ctype: CriterionType.CUSTOM, weight: 1.5,
    eval_fn: completenessScore,
  }));
  return cs;
}

export function ensureCriteria(userCriteria: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (userCriteria && typeof userCriteria === 'object' && Object.keys(userCriteria).length > 0) {
    return userCriteria;
  }
  return defaultCriteria().toDict();
}
