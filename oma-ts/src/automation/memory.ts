/**
 * OMA Memory-Level Automation - dynamic analysis and state tracking.
 *
 * Memory management for multi-agent runs:
 *   - Conversation history compression
 *   - Working memory (what's relevant right now)
 *   - Long-term memory (persisted facts across runs)
 *   - Context window optimization
 *   - Handoff state serialization
 *
 * The memory layer answers: "what does the next worker need to know?"
 */

import fs from 'node:fs';
import path from 'node:path';

export interface MemoryEntry {
  key: string;
  value: unknown;
  created_at: number;
  accessed_at: number;
  access_count: number;
  ttl_s: number;        // 0 = no expiry
  tags: string[];
  source: string;       // which agent/step produced this
}

function isEntryExpired(entry: MemoryEntry): boolean {
  if (entry.ttl_s <= 0) return false;
  return (Date.now() / 1000) - entry.created_at > entry.ttl_s;
}

function touchEntry(entry: MemoryEntry): void {
  entry.accessed_at = Date.now() / 1000;
  entry.access_count++;
}

export class WorkingMemory {
  /**
   * In-session memory with LRU eviction and tag-based retrieval.
   *
   * This is what the current agent has in its "head" -
   * facts, intermediate results, and decisions.
   */
  _store = new Map<string, MemoryEntry>();
  maxEntries: number;
  maxTokens: number;

  constructor(maxEntries = 200, maxTokens = 50_000) {
    this.maxEntries = maxEntries;
    this.maxTokens = maxTokens;
  }

  put(
    key: string,
    value: unknown,
    opts?: { tags?: string[]; ttl_s?: number; source?: string },
  ): void {
    const now = Date.now() / 1000;
    this._store.set(key, {
      key,
      value,
      created_at: now,
      accessed_at: now,
      access_count: 0,
      ttl_s: opts?.ttl_s ?? 0,
      tags: opts?.tags ?? [],
      source: opts?.source ?? '',
    });
    this._evictIfNeeded();
  }

  get(key: string): unknown | null {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (isEntryExpired(entry)) {
      this._store.delete(key);
      return null;
    }
    touchEntry(entry);
    return entry.value;
  }

  /** Find all non-expired entries with a given tag. */
  search(tag: string): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    for (const entry of this._store.values()) {
      if (isEntryExpired(entry)) continue;
      if (entry.tags.includes(tag)) {
        touchEntry(entry);
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Compress working memory into a text summary for handoff.
   * Prioritizes by access frequency and recency.
   */
  summarize(maxTokens = 5000): string {
    const entries = [...this._store.values()]
      .filter(e => !isEntryExpired(e))
      .sort((a, b) => {
        if (b.access_count !== a.access_count) return b.access_count - a.access_count;
        return b.accessed_at - a.accessed_at;
      });

    const lines: string[] = [];
    let estTokens = 0;
    for (const entry of entries) {
      const line = `[${entry.key}] (${entry.tags.join(',')}): ${JSON.stringify(entry.value)}`;
      const lineTokens = Math.ceil(line.length / 4);
      if (estTokens + lineTokens > maxTokens) break;
      lines.push(line);
      estTokens += lineTokens;
    }

    return lines.join('\n');
  }

  private _evictIfNeeded(): void {
    // remove expired
    for (const [key, entry] of this._store) {
      if (isEntryExpired(entry)) this._store.delete(key);
    }

    // LRU eviction
    while (this._store.size > this.maxEntries) {
      let oldest: MemoryEntry | null = null;
      for (const entry of this._store.values()) {
        if (!oldest || entry.accessed_at < oldest.accessed_at) {
          oldest = entry;
        }
      }
      if (oldest) this._store.delete(oldest.key);
    }
  }

  toDict(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [key, entry] of this._store) {
      if (!isEntryExpired(entry)) {
        result[key] = {
          value: entry.value,
          tags: entry.tags,
          access_count: entry.access_count,
          source: entry.source,
        };
      }
    }
    return result;
  }
}

export class PersistentMemory {
  /**
   * Cross-session memory stored as JSON files.
   *
   * Each task gets a memory directory. Workers read previous
   * state and write their additions.
   */
  private base: string;

  constructor(baseDir = '.oma_memory') {
    this.base = baseDir;
    fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.base, 0o700);
    } catch { /* ignore */ }
  }

  private _path(taskId: string): string {
    return path.join(this.base, `${taskId}.json`);
  }

  load(taskId: string): Record<string, unknown> {
    const p = this._path(taskId);
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
      }
    } catch { /* ignore */ }
    return { entries: {}, handoffs: [], created_at: Date.now() / 1000 };
  }

  save(taskId: string, data: Record<string, unknown>): void {
    data.updated_at = Date.now() / 1000;
    const p = this._path(taskId);
    fs.writeFileSync(
      p,
      JSON.stringify(data, null, 2),
      { mode: 0o600 },
    );
    try {
      fs.chmodSync(p, 0o600);
    } catch { /* ignore */ }
  }

  appendHandoff(taskId: string, handoffSummary: string, workerId = ''): void {
    const data = this.load(taskId);
    const handoffs = (data.handoffs as Array<Record<string, unknown>>) ?? [];
    handoffs.push({
      worker_id: workerId,
      summary: handoffSummary,
      timestamp: Date.now() / 1000,
    });
    data.handoffs = handoffs;
    this.save(taskId, data);
  }

  mergeWorking(taskId: string, working: WorkingMemory): void {
    const data = this.load(taskId);
    const entries = (data.entries as Record<string, unknown>) ?? {};
    Object.assign(entries, working.toDict());
    data.entries = entries;
    this.save(taskId, data);
  }

  flush(taskId?: string): number {
    if (taskId) {
      const p = this._path(taskId);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        return 1;
      }
      return 0;
    }

    let count = 0;
    if (fs.existsSync(this.base)) {
      for (const file of fs.readdirSync(this.base)) {
        if (file.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(this.base, file));
            count++;
          } catch { /* ignore */ }
        }
      }
    }
    return count;
  }

  listTasks(): string[] {
    if (!fs.existsSync(this.base)) return [];
    return fs.readdirSync(this.base)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5));
  }
}

export class ContextOptimizer {
  /**
   * Manages the context window budget for a provider call.
   *
   * Given a token budget, packs the most important context:
   *   1. System prompt (always included)
   *   2. Current task state
   *   3. Recent working memory
   *   4. Relevant long-term memory
   *   5. Conversation history (compressed)
   */
  budget: number;

  constructor(tokenBudget = 100_000) {
    this.budget = tokenBudget;
  }

  buildContext(opts: {
    system: string;
    task_state: Record<string, unknown>;
    working: WorkingMemory;
    persistent?: Record<string, unknown> | null;
    history?: Array<Record<string, string>> | null;
  }): [string, Array<Record<string, string>>] {
    let used = Math.ceil(opts.system.length / 4);

    // task state always goes in system
    const stateText = `\n\nCurrent task state:\n${JSON.stringify(opts.task_state, null, 2)}`;
    used += Math.ceil(stateText.length / 4);
    let systemFull = opts.system + stateText;

    // working memory summary
    const memoryBudget = Math.min(Math.floor(this.budget / 4), 10_000);
    const memoryText = opts.working.summarize(memoryBudget);
    if (memoryText) {
      systemFull += `\n\nWorking memory:\n${memoryText}`;
      used += Math.ceil(memoryText.length / 4);
    }

    // persistent memory (previous handoffs)
    if (opts.persistent) {
      const handoffs = opts.persistent.handoffs as Array<Record<string, string>> | undefined;
      if (handoffs?.length) {
        const recent = handoffs.slice(-3);
        const handoffText = recent
          .map((h, i) => `[handoff ${i + 1}] ${(h.summary ?? '').slice(0, 500)}`)
          .join('\n');
        systemFull += `\n\nPrevious worker handoffs:\n${handoffText}`;
        used += Math.ceil(handoffText.length / 4);
      }
    }

    // conversation history: fit what we can, newest first
    const messages: Array<Record<string, string>> = [];
    if (opts.history) {
      for (const msg of [...opts.history].reverse()) {
        const msgTokens = Math.ceil(JSON.stringify(msg).length / 4);
        if (used + msgTokens > this.budget * 0.8) break; // leave 20% for response
        messages.unshift(msg);
        used += msgTokens;
      }
    }

    return [systemFull, messages];
  }
}
