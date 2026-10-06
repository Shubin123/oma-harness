# OMA harness

A Bun and TypeScript monorepo for conversational messages, project management, tiered provider routing, and live workflow execution.

Install Bun 1.4.2, then run from the repository root:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run start --no-browser
```

Open http://127.0.0.1:8384. `bun run start` opens the dashboard automatically. The CLI runs directly with `bun apps/cli/src/index.ts --help`.

The workspaces are `packages/core` (providers, routing, RALPH, memory, and Laya rules), `packages/shared` (project schemas and snapshot serialization), `apps/dashboard` (HTTP server and browser application), and `apps/cli` (commands). All executable application, build, and test code is TypeScript. Shell scripts and Make targets forward to Bun. The previous Python implementations and Node build drivers have been retired; Git history retains them.

## Connections and messages

Use the Connect tab to **Link Codex and test a message** or **Link Claude Code and test a message**. Codex uses the existing local `auth.json` under `CODEX_HOME` or `~/.codex`, and rereads refreshed tokens on every request. Claude Code uses its existing subscription login and handles its own token refresh. Only connection configuration is stored in the harness credential file; managed OAuth tokens are not copied into it. Linking can verify a real provider reply before reporting success.

The Claude web-cookie adapter remains available for existing sessions. It validates every HTTP response, supports modern and legacy streaming events, and requires a nonempty completed reply. Web-cookie requests can return HTTP 403 even when a separate Claude Code login works; use the Claude Code connection in that case.

Chat sends conversation history directly to the selected provider. Codex receives structured user and assistant roles. Claude Code receives the complete conversation on stdin, with tools, MCP servers, hooks, skills, automatic retries, and transcript persistence disabled. Its final result must confirm success. This keeps browser history authoritative and avoids spawning empty web chats. The web-cookie connector reuses a project-scoped conversation ID saved in the browser.

Primary and fallback tiers are explicit. Claude defaults to at most two connector calls and an estimated 8,000-token allowance per workflow or chat send, including retries. Zero calls disables Claude. Reservations account for estimated input and permitted output; actual reported usage is reconciled afterward. Claude Code also limits agentic turns to one and receives an output-token cap. Provider overhead and tokenization can differ from estimates, so this is not a guaranteed billing ceiling or a daily account quota. Ordinary chat and workflows never substitute an offline demonstration reply for a failed provider request.

## Browser projects

Projects, complete chat histories, drafts, tasks, provider tiers, workflow graphs, outputs, conversation IDs, and delivery states are stored in **IndexedDB**. Outgoing messages are committed before sending; streaming replies are committed as they arrive. Reloaded interrupted sends retain their partial output and offer an explicit retry. Same-process duplicate request IDs replay the original delivery receipt. Receipts are bounded and kept in server memory; after a server restart, retrying an uncertain delivery can send it again.

Commands and project edits work when backend API calls are unavailable. Legacy `~/.oma/projects` snapshots are imported for IDs missing from the browser, preserving existing local records. Subsequent browser edits do not depend on those server files. Export and Import preserve snapshots; importing does not overwrite an existing project ID. Export projects before clearing browser site data or moving to another browser or origin. Persistent browser storage is requested when supported, but the browser controls whether it grants that request.

Snapshots use explicit schema versions and a lossless codec for JSON values, dates, maps, sets, bigint, and undefined. Unsupported objects, functions, cycles, invalid schemas, nonfinite numbers, and concurrent stale revisions fail visibly. Server task memory uses atomic writes and reads earlier plain JSON files. Credentials are excluded from browser project storage.

Available commands:

```text
/project new NAME
/project rename NAME
/projects
/task add TEXT
/task status ID todo|working|done|blocked
/tasks
/input TEXT
/run
/output [NODE_ID]
/history
/cleanup
/export
/help
```

The workflow panel shows queued, working, done, parked, failed, blocked, and skipped states as they arrive. It saves run state with each event. Graph edits and input changes are cached. Branch nodes select an output port; inactive branches are skipped and failed or parked predecessors block dependent work. Cycles, unknown endpoints, duplicate node IDs, and invalid budgets are rejected.

Laya cleanup runs the local TypeScript rules classifier, normalizes task titles, creates an extractive project summary, and flags incomplete workflow steps. This is the TypeScript classifier, not the Python Laya model runtime. Cleanup preserves messages and outputs. AGY remains unconfigured until its provider or integration is identified.

## Verification and builds

```sh
bun run check          # strict type checks, all bundles, unit/integration and Chromium tests
bun run test           # provider, routing, persistence, workflow and failure tests
bun run test:browser   # actual browser storage and end-to-end message tests
bun run test:live      # opt-in live subscription linking and two-turn context tests
bun run test:watch     # persistent offline testing process
bun run build          # Bun CLI, core, dashboard and browser bundles
bun run build:binary   # self-contained Bun CLI executable at dist/oma
```

The watcher records `.build_cache/test-watch.pid`, `test-status.json`, and `test-history.json`. Its current state appears in the dashboard. Live tests use existing credentials, skip unavailable connections, and save redacted results in `.build_cache/live-delivery.json`. Failed live delivery fails the test; no production test-token bypass exists.

Tests cover Codex token refresh and account headers, Claude thread reuse, both providers' text streaming and context, empty/interrupted/malformed replies, HTTP 401/403/429/503, request deduplication, fallback and Claude limits, browser reloads, offline commands, and cache error handling. The retained offline RALPH demo is explicitly a simulation and does not establish a real provider connection.

CI checks the Bun monorepo on Linux, macOS, and Windows. Releases build native Bun executables. Claude Code remains an external optional connector dependency for that subscription route. See [storage details](STORAGE_AND_SECURITY.md) and [harness specification](docs/SPEC.md).
