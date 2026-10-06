import { test } from "bun:test";
import assert from "node:assert/strict";
import { serialize, deserialize, snapshot } from "./serialization.js";
import {
  createProject,
  migrateProject,
  applyCommand,
  appendMessage,
  conversationMessages,
} from "./projects.js";
test("Snapshots preserve nested Maps, Sets, dates, bigint, undefined and reserved keys", () => {
  const value = {
    date: new Date("2026-10-06T00:00:00Z"),
    map: new Map([["key", new Set([1, 2])]]),
    integer: 99n,
    undefined: undefined,
    array: [undefined, { __type: "date" }],
    repeated: null as any,
  };
  value.repeated = value.map;
  assert.deepEqual(deserialize(serialize(value)), value);
  assert.notEqual(snapshot(value), value);
});
test("Snapshots reject cycles, nonfinite values, functions and unsupported schema versions", () => {
  const p: any = {};
  p.self = p;
  for (const value of [p, NaN, Infinity, () => {}, Symbol("x"), new Error("x")])
    assert.throws(() => serialize(value));
  assert.throws(() => deserialize('{"version":99,"data":null}'));
});
test("Project migration validates shape, preserves data, and rejects invalid imports", () => {
  const p = createProject("Cache");
  appendMessage(p, "user", "Remember this", { kind: "chat", status: "sent" });
  appendMessage(p, "assistant", "remembered", { kind: "chat", status: "sent" });
  appendMessage(p, "assistant", "command result", { kind: "command" });
  appendMessage(p, "user", "failed", { kind: "chat", status: "failed" });
  applyCommand(p, "/task add Build a parser");
  applyCommand(p, "/input hello");
  const legacy: any = snapshot(p);
  delete legacy.schema_version;
  delete legacy.revision;
  assert.equal(migrateProject(legacy).schema_version, 1);
  assert.equal(migrateProject(legacy).input, "hello");
  assert.deepEqual(
    conversationMessages(p).map((m) => m.content),
    ["Remember this", "remembered"],
  );
  for (const invalid of [
    { ...p, id: "../credentials" },
    { ...p, messages: [{}] },
    { ...p, tasks: [{ id: "x", title: "t", status: "banana" }] },
    { ...p, tiers: { ...p.tiers, claude_max_calls: -1 } },
    { ...p, schema_version: 9 },
  ])
    assert.throws(() => migrateProject(invalid));
});
