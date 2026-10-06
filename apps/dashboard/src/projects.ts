/** Legacy server snapshots remain readable for browser migration and CLI commands. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { OMA } from "@oma/core/agent";
import { LayaClassifier } from "@oma/core/core/layaClassifier";
import { makePrivateDir } from "@oma/core/platformCompat";
import {
  createProject,
  migrateProject,
  appendMessage,
  applyCommand,
  serialize,
  deserialize,
  conversationMessages,
  type Project,
} from "@oma/shared";
import { ChatService } from "./chat.js";
export type { Project } from "@oma/shared";
export class ProjectStore {
  constructor(readonly root = path.join(os.homedir(), ".oma", "projects")) {
    makePrivateDir(root);
  }
  private file(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid project ID");
    return path.join(this.root, id + ".json");
  }
  get(id: string): Project {
    const text = fs.readFileSync(this.file(id), "utf8");
    const parsed = JSON.parse(text);
    return migrateProject(
      parsed.version === 1 && "data" in parsed ? deserialize(text) : parsed,
    );
  }
  save(value: Project): Project {
    const p = migrateProject(value);
    p.updated_at = Date.now() / 1000;
    p.revision++;
    const dest = this.file(p.id),
      temp = dest + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, serialize(p), { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, dest);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    return p;
  }
  list(): Array<{ id: string; name: string; updated_at: number }> {
    return fs
      .readdirSync(this.root)
      .filter((f) => /^[a-f0-9]{32}\.json$/.test(f))
      .map((f) => {
        const p = this.get(f.slice(0, 32));
        return { id: p.id, name: p.name, updated_at: p.updated_at };
      })
      .sort((a, b) => b.updated_at - a.updated_at);
  }
  create(name: string): Project {
    return this.save(createProject(name));
  }
  message(
    id: string,
    role: string,
    content: string,
    extra: Record<string, unknown> = {},
  ): Project {
    const p = this.get(id);
    appendMessage(p, role, content, extra);
    return this.save(p);
  }
  recordRun(id: string | undefined, run: Record<string, unknown>): void {
    if (!id) return;
    const p = this.get(id);
    p.runs.push({
      id: crypto.randomUUID(),
      created_at: Date.now() / 1000,
      ...run,
    });
    appendMessage(p, "assistant", "Workflow " + run.status, {
      kind: "workflow",
      run,
    });
    this.save(p);
  }
  async command(
    id: string | undefined,
    command: string,
    agent: OMA | null,
  ): Promise<Record<string, unknown>> {
    command = command.trim();
    if (command.startsWith("/project new ")) {
      const p = this.create(command.slice(13));
      appendMessage(p, "user", command, { kind: "command" });
      const output = "Created project " + p.name;
      appendMessage(p, "assistant", output, { kind: "command" });
      return { project: this.save(p), output };
    }
    if (command === "/projects")
      return {
        projects: this.list(),
        output: this.list()
          .map((p) => p.name)
          .join("\n"),
      };
    if (!id) throw new Error("Create or select a project first");
    const p = this.get(id);
    appendMessage(p, "user", command, {
      kind: command.startsWith("/") ? "command" : "chat",
      status: "sent",
    });
    if (!command.startsWith("/")) {
      if (!agent) throw new Error("No provider available");
      this.save(p);
      const result = await new ChatService(agent.registry).send({
        project_id: p.id,
        request_id: crypto.randomUUID().replaceAll("-", ""),
        messages: conversationMessages(p),
        tiers: p.tiers,
      });
      appendMessage(p, "assistant", result.output, {
        kind: "chat",
        status: result.status,
        provider: result.provider,
        error: result.error,
      });
      return {
        project: this.save(p),
        output: result.output,
        error: result.error,
      };
    }
    const classifier = agent?.classifier || new LayaClassifier();
    const output = applyCommand(p, command, (text, context) =>
      classifier.encapsulate(text, context || "").toDict(),
    );
    appendMessage(p, "assistant", output, { kind: "command", status: "sent" });
    return { project: this.save(p), output };
  }
}
