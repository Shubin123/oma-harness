/**
 * OMA Edge Handlers - graceful degradation at the limits.
 *
 * Two edge cases, two strategies:
 *
 * 1. NEAR OUTAGE (completion almost done, tokens running low):
 *    Summarize with remaining tokens. Pack the handoff note with
 *    everything the next worker needs to immediately pick up.
 *
 * 2. OUTAGE BEFORE COMPLETION (unexpected cutoff):
 *    The handoff was already being maintained incrementally,
 *    so the last checkpoint is the recovery point. The next worker
 *    gets a note pointing to the fork and patches to apply.
 */

import type { TaskState } from './loop.js';
import type { WorkingMemory } from '../automation/memory.js';

export interface HandoffNoteInit {
  task_id: string;
  objective: string;
  status: string;
  reason: string;
  timestamp?: number;
  completed_steps?: string[];
  artifacts_produced?: Record<string, string>;
  confidence_so_far?: number;
  remaining_steps?: string[];
  blockers?: string[];
  critical_context?: string;
  criteria?: Record<string, unknown>;
  provider_status?: Record<string, string>;
  patches_to_apply?: string[];
  binary_target?: string;
  priority_order?: string[];
}

export class HandoffNote {
  task_id: string;
  objective: string;
  status: string;
  reason: string;
  timestamp: number;
  completed_steps: string[];
  artifacts_produced: Record<string, string>;
  confidence_so_far: number;
  remaining_steps: string[];
  blockers: string[];
  critical_context: string;
  criteria: Record<string, unknown>;
  provider_status: Record<string, string>;
  patches_to_apply: string[];
  binary_target: string;
  priority_order: string[];

  constructor(init: HandoffNoteInit) {
    this.task_id = init.task_id;
    this.objective = init.objective;
    this.status = init.status;
    this.reason = init.reason;
    this.timestamp = init.timestamp ?? Date.now() / 1000;
    this.completed_steps = init.completed_steps ?? [];
    this.artifacts_produced = init.artifacts_produced ?? {};
    this.confidence_so_far = init.confidence_so_far ?? 0;
    this.remaining_steps = init.remaining_steps ?? [];
    this.blockers = init.blockers ?? [];
    this.critical_context = init.critical_context ?? '';
    this.criteria = init.criteria ?? {};
    this.provider_status = init.provider_status ?? {};
    this.patches_to_apply = init.patches_to_apply ?? [];
    this.binary_target = init.binary_target ?? '';
    this.priority_order = init.priority_order ?? [];
  }

  toPrompt(): string {
    const sections: string[] = [];
    const ts = new Date(this.timestamp * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');

    sections.push('=== OMA HANDOFF NOTE ===');
    sections.push(`task: ${this.task_id}`);
    sections.push(`objective: ${this.objective}`);
    sections.push(`status: ${this.status} (${this.reason})`);
    sections.push(`confidence: ${Math.round(this.confidence_so_far * 100)}%`);
    sections.push(`time: ${ts}`);

    if (this.critical_context) {
      sections.push('\n--- GRAB THIS FIRST ---');
      sections.push(this.critical_context);
    }

    if (this.completed_steps.length > 0) {
      sections.push('\n--- COMPLETED ---');
      this.completed_steps.forEach((step, i) => sections.push(`  ${i + 1}. ${step}`));
    }

    if (this.remaining_steps.length > 0) {
      sections.push('\n--- REMAINING (do these) ---');
      this.remaining_steps.forEach((step, i) => sections.push(`  ${i + 1}. ${step}`));
    }

    if (this.priority_order.length > 0) {
      sections.push('\n--- PRIORITY ORDER (most important first) ---');
      this.priority_order.forEach((feat, i) => sections.push(`  ${i + 1}. ${feat}`));
    }

    if (this.patches_to_apply.length > 0) {
      sections.push('\n--- PATCHES TO APPLY ---');
      this.patches_to_apply.forEach(p => sections.push(`  - ${p}`));
    }

    if (this.binary_target) {
      sections.push('\n--- BUILD TARGET ---');
      sections.push(`  ${this.binary_target}`);
    }

    if (this.blockers.length > 0) {
      sections.push('\n--- BLOCKERS ---');
      this.blockers.forEach(b => sections.push(`  ! ${b}`));
    }

    if (Object.keys(this.artifacts_produced).length > 0) {
      sections.push('\n--- ARTIFACTS ---');
      for (const [name, path] of Object.entries(this.artifacts_produced)) {
        sections.push(`  ${name}: ${path}`);
      }
    }

    if (Object.keys(this.criteria).length > 0) {
      sections.push('\n--- SUCCESS CRITERIA ---');
      sections.push(`  ${JSON.stringify(this.criteria, null, 2)}`);
    }

    if (Object.keys(this.provider_status).length > 0) {
      sections.push('\n--- PROVIDER STATUS ---');
      for (const [name, status] of Object.entries(this.provider_status)) {
        sections.push(`  ${name}: ${status}`);
      }
    }

    sections.push('\n=== END HANDOFF ===');
    return sections.join('\n');
  }

  toDict(): Record<string, unknown> {
    return {
      task_id: this.task_id,
      objective: this.objective,
      status: this.status,
      reason: this.reason,
      timestamp: this.timestamp,
      completed_steps: this.completed_steps,
      remaining_steps: this.remaining_steps,
      priority_order: this.priority_order,
      confidence: this.confidence_so_far,
      artifacts: this.artifacts_produced,
      criteria: this.criteria,
      patches: this.patches_to_apply,
      binary_target: this.binary_target,
      critical_context: this.critical_context,
    };
  }
}

export function nearOutageHandler(
  taskState: TaskState,
  workingMemory: WorkingMemory,
  remainingFeatures: string[],
  patches: string[] = [],
): HandoffNote {
  const completed = taskState.progress
    .filter(([, , conf]) => conf > 0.3)
    .map(([step, , conf]) => `${step}: conf=${conf.toFixed(2)}`);

  return new HandoffNote({
    task_id: taskState.task_id,
    objective: taskState.objective,
    status: 'near_outage',
    reason: `tokens ${taskState.tokens_used}/${taskState.tokens_budget}`,
    completed_steps: completed,
    remaining_steps: remainingFeatures,
    confidence_so_far: taskState.confidence,
    artifacts_produced: { ...taskState.artifacts },
    criteria: taskState.criteria,
    patches_to_apply: patches,
    priority_order: remainingFeatures,
    critical_context: workingMemory.summarize(2000),
  });
}

export function outageRecoveryPrompt(
  handoffNote: HandoffNote,
  forkRepo = '',
  targetPlatform = 'macos',
): string {
  const base = handoffNote.toPrompt();

  const recovery = [
    '\n=== RECOVERY INSTRUCTIONS ===',
    'From a fork of open-multi-agent, consider these patches',
    `and create a working binary for ${targetPlatform} on this computer`,
    'in order to complete the functionalities listed from most',
    'important to least, checking off as many as possible.',
  ];

  if (forkRepo) recovery.push(`\nFork: ${forkRepo}`);

  recovery.push('\nFunctionalities (priority order):');
  handoffNote.priority_order.forEach((feat, i) => {
    recovery.push(`  [ ] ${i + 1}. ${feat}`);
  });

  return base + recovery.join('\n');
}
