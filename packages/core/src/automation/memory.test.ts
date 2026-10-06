import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistentMemory } from "./memory.js";
import { TaskState } from "../core/loop.js";
test("Task memory migrates legacy JSON, atomically saves rich snapshots, and preserves earlier files on invalid writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oma-memory-"));
  try {
    const m = new PersistentMemory(dir);
    fs.writeFileSync(
      path.join(dir, "task.json"),
      '{"entries":{"legacy":true}}',
    );
    assert.deepEqual(m.load("task").entries, { legacy: true });
    m.save("task", {
      entries: {
        map: new Map([["result", new Set([1, 2])]]),
        date: new Date("2026-10-06"),
        count: 5n,
      },
    });
    assert.deepEqual(
      (m.load("task").entries as any).map,
      new Map([["result", new Set([1, 2])]]),
    );
    const saved = fs.readFileSync(path.join(dir, "task.json"), "utf8");
    assert.throws(() => m.save("task", { value: () => {} }));
    assert.equal(fs.readFileSync(path.join(dir, "task.json"), "utf8"), saved);
    assert.throws(() => m.load("../credentials"));
    fs.writeFileSync(path.join(dir, "broken.json"), "{bad");
    assert.throws(() => m.load("broken"), /restore/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("Task snapshots hash nested values deterministically and are isolated from later mutations", () => {
  const a = new TaskState({
    task_id: "task",
    objective: "test",
    strategy: { nested: { b: 2, a: 1 } },
    criteria: { values: new Map([["x", 1]]) },
  });
  const snapshot = a.snapshot();
  a.strategy.nested = { a: 2, b: 2 };
  assert.notEqual(snapshot.checksum, a.snapshot().checksum);
  assert.deepEqual(snapshot.strategy.nested, { a: 1, b: 2 });
  const b = new TaskState({ ...a, strategy: { nested: { b: 2, a: 1 } } });
  assert.equal(snapshot.checksum, b.snapshot().checksum);
});
