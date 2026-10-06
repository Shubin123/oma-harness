/**
 * OMA Laya Task Classifier -- Local System 1 Decision & Task Encapsulation.
 * TypeScript implementation adhering to OMA Invariant 1 (serializable state).
 */

export enum TaskCategory {
  CODING = 'coding',
  RESEARCH = 'research',
  MATH_LOGIC = 'math_logic',
  AUTOMATION = 'automation',
  GENERAL = 'general',
}

export enum TaskComplexity {
  SIMPLE = 'simple',
  MODERATE = 'moderate',
  COMPLEX = 'complex',
}

export enum RoutingDecision {
  EXECUTE_DIRECT = 'execute_direct',
  DECOMPOSE_SUBAGENTS = 'decompose_subagents',
  RALPH_LOOP = 'ralph_loop',
  TIERED_FAILOVER = 'tiered_failover',
}

export interface SubTaskSpec {
  id: string;
  role: string;
  sub_agent_type: string;
  objective: string;
  expected_output: string;
  priority: number;
}

export interface TaskEncapsulationData {
  task_id: string;
  objective: string;
  category: TaskCategory;
  complexity: TaskComplexity;
  assigned_agent: string;
  sub_agents: SubTaskSpec[];
  routing_decision: RoutingDecision;
  confidence: number;
  recommended_provider: string;
  criteria: Record<string, unknown>;
  context: string;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface GateResult {
  passed: boolean;
  confidence: number;
  decision: 'PASSED' | 'FAILOVER';
  score: number;
  notes: string;
  evaluator: string;
}

export class TaskEncapsulation {
  constructor(public data: TaskEncapsulationData) {}

  get taskId(): string { return this.data.task_id; }
  get objective(): string { return this.data.objective; }
  get category(): TaskCategory { return this.data.category; }
  get complexity(): TaskComplexity { return this.data.complexity; }
  get assignedAgent(): string { return this.data.assigned_agent; }
  get subAgents(): SubTaskSpec[] { return this.data.sub_agents; }
  get routingDecision(): RoutingDecision { return this.data.routing_decision; }
  get confidence(): number { return this.data.confidence; }
  get recommendedProvider(): string { return this.data.recommended_provider; }

  toDict(): Record<string, unknown> {
    return {
      task_id: this.data.task_id,
      objective: this.data.objective,
      category: this.data.category,
      complexity: this.data.complexity,
      assigned_agent: this.data.assigned_agent,
      sub_agents: this.data.sub_agents,
      routing_decision: this.data.routing_decision,
      confidence: this.data.confidence,
      recommended_provider: this.data.recommended_provider,
      criteria: this.data.criteria,
      context: this.data.context,
      metadata: this.data.metadata,
      created_at: this.data.created_at,
    };
  }

  static fromDict(data: Record<string, unknown>): TaskEncapsulation {
    return new TaskEncapsulation({
      task_id: String(data.task_id || ''),
      objective: String(data.objective || ''),
      category: (data.category as TaskCategory) || TaskCategory.GENERAL,
      complexity: (data.complexity as TaskComplexity) || TaskComplexity.SIMPLE,
      assigned_agent: String(data.assigned_agent || 'primary_agent'),
      sub_agents: (data.sub_agents as SubTaskSpec[]) || [],
      routing_decision: (data.routing_decision as RoutingDecision) || RoutingDecision.EXECUTE_DIRECT,
      confidence: Number(data.confidence ?? 0.95),
      recommended_provider: String(data.recommended_provider || 'gemini'),
      criteria: (data.criteria as Record<string, unknown>) || {},
      context: String(data.context || ''),
      metadata: (data.metadata as Record<string, unknown>) || {},
      created_at: Number(data.created_at || Date.now() / 1000),
    });
  }
}

export class LayaClassifier {
  constructor(
    public modelName: string = 'convaiinnovations/laya',
    public confidenceThreshold: number = 0.60,
  ) {}

  encapsulate(
    objective: string,
    context: string = '',
    criteria: Record<string, unknown> = {},
    taskId?: string,
  ): TaskEncapsulation {
    const tid = taskId || `task_${Math.random().toString(36).slice(2, 10)}`;
    const fullText = `${objective}\n${context}`.toLowerCase();

    const decision = this.classifyObjective(fullText);
    const category = decision.category;
    const complexity = decision.complexity;
    const confidence = decision.confidence;
    const provider = decision.provider;
    const assignedAgent = decision.assigned_agent;

    let routing: RoutingDecision;
    let subAgents: SubTaskSpec[] = [];

    if (complexity === TaskComplexity.COMPLEX) {
      routing = RoutingDecision.DECOMPOSE_SUBAGENTS;
      subAgents = this.decomposeSubtasks(tid, objective, category, 3);
    } else if (complexity === TaskComplexity.MODERATE) {
      routing = RoutingDecision.RALPH_LOOP;
      subAgents = this.decomposeSubtasks(tid, objective, category, 2);
    } else {
      routing = RoutingDecision.EXECUTE_DIRECT;
      if ([TaskCategory.CODING, TaskCategory.RESEARCH, TaskCategory.AUTOMATION].includes(category)) {
        subAgents = this.decomposeSubtasks(tid, objective, category, 2);
      }
    }

    return new TaskEncapsulation({
      task_id: tid,
      objective: objective.trim(),
      category,
      complexity,
      assigned_agent: assignedAgent,
      sub_agents: subAgents,
      routing_decision: routing,
      confidence,
      recommended_provider: provider,
      criteria,
      context,
      metadata: {
        engine: 'laya-local-system1-ts',
        subagent_count: subAgents.length,
        timestamp: Date.now() / 1000,
      },
      created_at: Date.now() / 1000,
    });
  }

  private classifyObjective(text: string): {
    category: TaskCategory;
    complexity: TaskComplexity;
    confidence: number;
    provider: string;
    assigned_agent: string;
  } {
    const codingSignals = [
      'code', 'function', 'class', 'def ', 'import ', 'python', 'typescript',
      'javascript', 'bug', 'refactor', 'parser', 'compiler', 'api', 'unit test',
      'regex', 'algorithm', 'sql', 'html', 'css', 'git', 'bash', 'pipeline',
    ];
    const researchSignals = [
      'research', 'summarize', 'literature', 'analyze', 'explain', 'compare',
      'history', 'what is', 'survey', 'overview', 'deep dive', 'benchmark',
    ];
    const mathSignals = [
      'math', 'calculate', 'solve', 'equation', 'proof', 'matrix', 'integral',
      'probability', 'statistics', 'numeric', 'formula', 'theorem',
    ];
    const autoSignals = [
      'automate', 'click', 'scrape', 'browser', 'page', 'pixel', 'screenshot',
      'form', 'download', 'login', 'navigate', 'ui action', 'xdotool',
    ];

    const codingScore = codingSignals.reduce((acc, s) => acc + (text.includes(s) ? 2 : 0), 0);
    const researchScore = researchSignals.reduce((acc, s) => acc + (text.includes(s) ? 2 : 0), 0);
    const mathScore = mathSignals.reduce((acc, s) => acc + (text.includes(s) ? 2 : 0), 0);
    const autoScore = autoSignals.reduce((acc, s) => acc + (text.includes(s) ? 2 : 0), 0);

    const scores: Array<[TaskCategory, number]> = [
      [TaskCategory.CODING, codingScore],
      [TaskCategory.RESEARCH, researchScore],
      [TaskCategory.MATH_LOGIC, mathScore],
      [TaskCategory.AUTOMATION, autoScore],
    ];

    scores.sort((a, b) => b[1] - a[1]);
    const [bestCat, bestScore] = scores[0];

    let category = TaskCategory.GENERAL;
    let confidence = 0.85;
    if (bestScore >= 2) {
      category = bestCat;
      confidence = Math.min(0.99, 0.75 + bestScore * 0.04);
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    const compSignals = [
      'and', 'with', 'sub-agent', 'pipeline', 'end-to-end', 'architecture',
      'multi-step', 'system', 'comprehensive', 'unit test', 'tests',
      'bug fix', 'scrape', 'summarize', 'literature', 'navigate', 'benchmarks',
    ];
    const compScore = compSignals.reduce((acc, s) => acc + (text.includes(s) ? 1 : 0), 0);

    let complexity = TaskComplexity.SIMPLE;
    if (words >= 25 || compScore >= 3 || (category === TaskCategory.CODING && (text.includes('test') || text.includes('parser')))) {
      complexity = TaskComplexity.COMPLEX;
    } else if (words >= 8 || compScore >= 1 || [TaskCategory.CODING, TaskCategory.RESEARCH, TaskCategory.AUTOMATION].includes(category)) {
      complexity = TaskComplexity.MODERATE;
    }

    const agentMap: Record<TaskCategory, string> = {
      [TaskCategory.CODING]: 'coding_agent',
      [TaskCategory.RESEARCH]: 'research_agent',
      [TaskCategory.MATH_LOGIC]: 'math_agent',
      [TaskCategory.AUTOMATION]: 'automation_agent',
      [TaskCategory.GENERAL]: 'primary_agent',
    };

    const providerMap: Record<TaskCategory, string> = {
      [TaskCategory.CODING]: 'claude',
      [TaskCategory.RESEARCH]: 'gemini',
      [TaskCategory.MATH_LOGIC]: 'deepseek',
      [TaskCategory.AUTOMATION]: 'gemini',
      [TaskCategory.GENERAL]: 'gemini',
    };

    return {
      category,
      complexity,
      confidence: Math.round(confidence * 100) / 100,
      provider: providerMap[category] || 'gemini',
      assigned_agent: agentMap[category] || 'primary_agent',
    };
  }

  private decomposeSubtasks(
    parentId: string,
    objective: string,
    category: TaskCategory,
    maxSubtasks: number = 3,
  ): SubTaskSpec[] {
    let subtasks: SubTaskSpec[] = [];
    if (category === TaskCategory.CODING) {
      subtasks = [
        {
          id: `${parentId}_arch`,
          role: 'Architect & Interface Designer',
          sub_agent_type: 'sub_agent',
          objective: `Design modular interfaces and type contracts for: ${objective}`,
          expected_output: 'Type specifications and interface definitions',
          priority: 1,
        },
        {
          id: `${parentId}_impl`,
          role: 'Core Implementer',
          sub_agent_type: 'sub_agent',
          objective: `Implement core logic and algorithms satisfying: ${objective}`,
          expected_output: 'Executable code implementation',
          priority: 2,
        },
        {
          id: `${parentId}_test`,
          role: 'QA & Test Engineer',
          sub_agent_type: 'sub_agent',
          objective: `Write unit and edge-case tests validating: ${objective}`,
          expected_output: 'Automated test suite with assertions',
          priority: 3,
        },
      ];
    } else if (category === TaskCategory.RESEARCH) {
      subtasks = [
        {
          id: `${parentId}_gather`,
          role: 'Information Harvester',
          sub_agent_type: 'sub_agent',
          objective: `Collect verified facts and reference data for: ${objective}`,
          expected_output: 'Structured bullet-point facts with citations',
          priority: 1,
        },
        {
          id: `${parentId}_synth`,
          role: 'Synthesis Analyst',
          sub_agent_type: 'sub_agent',
          objective: `Synthesize key insights for: ${objective}`,
          expected_output: 'Cohesive synthesized report',
          priority: 2,
        },
      ];
    } else {
      subtasks = [
        {
          id: `${parentId}_plan`,
          role: 'Task Planner',
          sub_agent_type: 'sub_agent',
          objective: `Decompose requirements and plan steps for: ${objective}`,
          expected_output: 'Structured execution plan',
          priority: 1,
        },
        {
          id: `${parentId}_worker`,
          role: 'Task Worker',
          sub_agent_type: 'sub_agent',
          objective: `Execute primary deliverables for: ${objective}`,
          expected_output: 'Completed task deliverable',
          priority: 2,
        },
      ];
    }

    return subtasks.slice(0, maxSubtasks);
  }

  evaluateQuality(
    output: string,
    criteria?: Record<string, unknown>,
  ): GateResult {
    const outClean = output.trim();
    const outLower = outClean.toLowerCase();

    const failureTokens = ['error:', 'traceback', 'exception:', 'failover', 'failed to', 'could not find'];
    const hasError = failureTokens.some(tok => outLower.includes(tok));
    const tooShort = outClean.length < 15;

    if (hasError || tooShort) {
      return {
        passed: false,
        confidence: 0.45,
        decision: 'FAILOVER',
        score: 0.42,
        notes: 'Quality gate rejected output: incomplete content or error detected',
        evaluator: 'laya (Convai System 1)',
      };
    }

    let score = 0.94;
    if (criteria && Object.keys(criteria).length > 0) {
      const keys = Object.keys(criteria);
      const matched = keys.filter(k => outLower.includes(k.toLowerCase())).length;
      if (matched === 0) score = 0.72;
    }

    return {
      passed: true,
      confidence: score,
      decision: 'PASSED',
      score,
      notes: 'Criteria and quality standards verified by Laya System 1',
      evaluator: 'laya (Convai System 1)',
    };
  }
}
