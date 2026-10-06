import { snapshot } from "./serialization.js";
export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  created_at: number;
  kind?: string;
  status?:
    | "queued"
    | "sending"
    | "streaming"
    | "sent"
    | "failed"
    | "interrupted";
  request_id?: string;
  provider?: string;
  error?: string;
  [key: string]: unknown;
}
export interface Tiers {
  primary: string;
  fallback: string;
  claude_max_calls: number;
  claude_max_tokens: number;
}
export interface Project {
  schema_version: 1;
  revision: number;
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  messages: ChatMessage[];
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    classification?: Record<string, unknown>;
  }>;
  runs: Array<Record<string, any>>;
  input: string;
  workflow: any;
  tiers: Tiers;
  draft?: string;
  cleanup?: Record<string, any>;
  conversations?: Record<string, string>;
}
export const DEFAULT_TIERS: Tiers = {
  primary: "codex",
  fallback: "claude",
  claude_max_calls: 2,
  claude_max_tokens: 8000,
};
export const HELP =
  "/project new NAME · /project rename NAME · /projects · /task add TEXT · /task status ID todo|working|done|blocked · /tasks · /input TEXT · /output [NODE_ID] · /history · /run · /cleanup · /export · /help";
export const newId = () => crypto.randomUUID().replaceAll("-", "");
export function createProject(name: string): Project {
  if (!name.trim()) throw new Error("Project name is required");
  return {
    schema_version: 1,
    revision: 0,
    id: newId(),
    name: name.trim(),
    created_at: Date.now() / 1000,
    updated_at: Date.now() / 1000,
    messages: [],
    tasks: [],
    runs: [],
    input: "",
    workflow: null,
    tiers: { ...DEFAULT_TIERS },
  };
}
export function validateTiers(value: unknown): Tiers {
  const t = value as Tiers;
  if (
    !t ||
    typeof t.primary !== "string" ||
    !t.primary.trim() ||
    typeof t.fallback !== "string" ||
    !t.fallback.trim() ||
    ![t.claude_max_calls, t.claude_max_tokens].every(
      (n) => Number.isInteger(n) && n >= 0,
    )
  )
    throw new Error("Invalid provider tiers or Claude limits");
  return { ...t };
}
export function migrateProject(value: unknown): Project {
  const p = snapshot(value) as Project;
  if (
    !p ||
    !/^[a-f0-9]{32}$/.test(p.id) ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    !Array.isArray(p.messages) ||
    !Array.isArray(p.tasks) ||
    !Array.isArray(p.runs) ||
    typeof p.input !== "string"
  )
    throw new Error("Invalid project snapshot");
  if (p.schema_version !== undefined && p.schema_version !== 1)
    throw new Error("Unsupported project schema");
  for (const m of p.messages)
    if (
      !m ||
      typeof m.id !== "string" ||
      typeof m.role !== "string" ||
      typeof m.content !== "string"
    )
      throw new Error("Invalid chat message");
  for (const t of p.tasks)
    if (
      !t ||
      typeof t.id !== "string" ||
      typeof t.title !== "string" ||
      !["todo", "working", "done", "blocked"].includes(t.status)
    )
      throw new Error("Invalid task");
  if (!Number.isFinite(p.created_at) || !Number.isFinite(p.updated_at))
    throw new Error("Invalid project timestamps");
  if (
    p.workflow !== null &&
    (!p.workflow ||
      !Array.isArray(p.workflow.nodes) ||
      !Array.isArray(p.workflow.edges))
  )
    throw new Error("Invalid workflow");
  p.schema_version = 1;
  p.revision = Number.isInteger(p.revision) ? p.revision : 0;
  p.tiers = validateTiers(p.tiers || DEFAULT_TIERS);
  return p;
}
export function appendMessage(
  p: Project,
  role: string,
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  const message = {
    id: newId(),
    role,
    content,
    created_at: Date.now() / 1000,
    ...extra,
  };
  p.messages.push(message);
  return message;
}
export function conversationMessages(
  p: Project,
): Array<{ role: string; content: string }> {
  return p.messages
    .filter(
      (m) =>
        (!m.kind || m.kind === "chat" || m.kind === "imported_chat") &&
        !m.content.startsWith("/") &&
        !["failed", "interrupted", "queued"].includes(m.status || "") &&
        ["user", "assistant"].includes(m.role) &&
        m.content.trim(),
    )
    .map((m) => ({ role: m.role, content: m.content }));
}
export function applyCommand(
  p: Project,
  command: string,
  classify?: (text: string, context?: string) => Record<string, unknown>,
): string {
  if (command.startsWith("/project rename ")) {
    const name = command.slice(16).trim();
    if (!name) throw new Error("Project name is required");
    p.name = name;
    return "Renamed project to " + name;
  }
  if (command === "/help") return HELP;
  if (command.startsWith("/input ")) {
    p.input = command.slice(7);
    return "Workflow input updated.";
  }
  if (command.startsWith("/task add ")) {
    const title = command.slice(10).trim();
    if (!title) throw new Error("Task title is required");
    const task = { id: newId().slice(0, 8), title, status: "todo" };
    p.tasks.push(task);
    return "Added task " + task.id;
  }
  if (command.startsWith("/task status ")) {
    const parts = command.split(/\s+/);
    const task = p.tasks.find((t) => t.id === parts[2]);
    if (
      parts.length !== 4 ||
      !["todo", "working", "done", "blocked"].includes(parts[3]) ||
      !task
    )
      throw new Error("Use /task status ID todo|working|done|blocked");
    task.status = parts[3];
    return "Task updated.";
  }
  if (command === "/tasks")
    return (
      p.tasks.map((t) => `${t.id} [${t.status}] ${t.title}`).join("\n") ||
      "No tasks yet."
    );
  if (command === "/history")
    return (
      p.messages.map((m) => m.role + ": " + m.content).join("\n") ||
      "No saved messages."
    );
  if (command === "/output" || command.startsWith("/output ")) {
    const run = p.runs.at(-1);
    if (!run) return "No workflow output yet.";
    const id = command.slice(8).trim();
    return id
      ? run.node_results?.[id]?.output || "Node output not found."
      : Object.entries(run.node_results || {})
          .map(
            ([id, r]: [string, any]) => id + ": " + (r.output || r.error || ""),
          )
          .join("\n\n");
  }
  if (command === "/cleanup") {
    for (const t of p.tasks) {
      t.title = t.title.replace(/\s+/g, " ").trim();
      if (classify) t.classification = classify(t.title);
    }
    const run = p.runs.at(-1);
    const flags = Object.entries(run?.node_results || {})
      .filter(
        ([, r]: [string, any]) =>
          !["done", "pass-through"].includes(r.status) &&
          r.reason !== "branch_not_selected",
      )
      .map(([id, r]: [string, any]) => id + ": " + r.status);
    const summary = [
      "Project: " + p.name,
      "Input: " + p.input,
      "Latest workflow: " + (run?.status || "none"),
      ...p.tasks.map((t) => `[${t.status}] ${t.title}`),
      ...conversationMessages(p)
        .slice(-6)
        .map((m) => m.role + ": " + m.content.slice(0, 300)),
    ].join("\n");
    p.cleanup = {
      created_at: Date.now() / 1000,
      engine: "laya-typescript-rules",
      flags,
      summary,
      tasks_classified: p.tasks.length,
      classification: classify?.("Organize project " + p.name, summary),
    };
    return `Laya organized ${p.tasks.length} tasks; ${flags.length} incomplete steps flagged.\n${flags.join("\n")}`;
  }
  throw new Error("Unknown command. " + HELP);
}
