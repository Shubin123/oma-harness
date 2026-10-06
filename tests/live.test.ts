/** Explicit opt-in: uses locally available subscriptions, never prints credentials or conversation bodies. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AuthManager } from "@oma/core/providers/auth";
import { ProviderRegistry } from "@oma/core/providers/registry";
import {
  CodexSubscriptionProvider,
  readCodexLogin,
} from "@oma/core/providers/codex";
import { ChatService } from "../apps/dashboard/src/chat.js";
import { newId, DEFAULT_TIERS } from "@oma/shared";
const live = process.env.OMA_LIVE_TESTS === "1",
  manager = new AuthManager();
const codexConfig = manager.store.get("codex");
const authFile = codexConfig
  ? JSON.parse(codexConfig.value).auth_file
  : path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "auth.json",
    );
const model = codexConfig ? JSON.parse(codexConfig.value).model : "gpt-6.1-sol";
const claude = manager.store.get("claude");
const proof: Array<Record<string, unknown>> = [];
function saveProof() {
  fs.mkdirSync(".build_cache", { recursive: true });
  fs.writeFileSync(
    ".build_cache/live-delivery.json",
    JSON.stringify(
      { created_at: new Date().toISOString(), results: proof },
      null,
      2,
    ),
  );
}
for (const name of ["codex", "claude"]) {
  const available = name === "codex" ? fs.existsSync(authFile) : !!claude;
  (live && available ? test : test.skip)(
    name + " live linking and two-turn context through dashboard chat service",
    async () => {
      const started = Date.now(),
        registry = ProviderRegistry.fromCredentials(manager);
      if (name === "codex") {
        readCodexLogin(authFile);
        registry.register(
          "codex",
          new CodexSubscriptionProvider(authFile, model),
        );
      }
      const service = new ChatService(registry),
        nonce = "fruit-" + crypto.randomUUID().slice(0, 8),
        projectId = newId(),
        tiers = {
          ...DEFAULT_TIERS,
          primary: name,
          fallback: name,
          claude_max_calls: 1,
          claude_max_tokens: 4000,
        };
      let status = "failed",
        error: string | undefined,
        providerModel: string | undefined;
      try {
        const firstMessages = [
          {
            role: "user",
            content:
              "Remember this exact marker for the next question: " +
              nonce +
              ". Reply only ACK.",
          },
        ];
        const first = await service.send({
          project_id: projectId,
          request_id: newId(),
          messages: firstMessages,
          tiers,
        });
        assert.equal(first.status, "sent", first.error);
        assert.ok(first.output.trim());
        const second = await service.send({
          project_id: projectId,
          request_id: newId(),
          messages: [
            ...firstMessages,
            { role: "assistant", content: first.output },
            {
              role: "user",
              content:
                "What exact marker did I ask you to remember? Reply with the marker only.",
            },
          ],
          tiers,
          conversations: first.conversations,
        });
        assert.equal(second.status, "sent", second.error);
        assert.ok(
          second.output.includes(nonce),
          "Provider did not retain the previous user turn",
        );
        status = "passed";
        providerModel = name === "codex" ? model : undefined;
      } catch (e) {
        error = e instanceof Error ? e.message : "Live delivery failed";
        throw e;
      } finally {
        proof.push({
          provider: name,
          status,
          error,
          model: providerModel,
          duration_ms: Date.now() - started,
        });
        saveProof();
      }
    },
    60000,
  );
  if (live && !available) {
    proof.push({
      provider: name,
      status: "unavailable",
      reason: "No local credential available",
    });
    saveProof();
  }
}
