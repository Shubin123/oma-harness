# OMA (Open Multi Agent)

A harness for running tasks across multiple LLM subscriptions with invariant retry, criteria-driven evaluation, and graceful degradation. Zero SDK dependencies -- every provider call is raw HTTP.

## What it does

OMA lets you define a task, point it at your LLM subscriptions (API keys or browser session credentials), and let it retry across providers until it either meets your success criteria or gracefully parks with a handoff note for the next worker to pick up.

The core loop maintains three invariants at every iteration:

1. **State is always serializable** -- `TaskState.snapshot()` produces a JSON dict any worker can resume from
2. **Cost never exceeds budget unchecked** -- remaining tokens are verified before every provider call; if below reserve, handoff fires
3. **Provider calls use fallback** -- every call walks the provider chain; no single provider failure kills the loop

## Install

### Python (pip)

```bash
pip install oma-harness          # core
pip install oma-harness[gui]     # with desktop GUI (pywebview)
pip install oma-harness[all]     # everything
```

### TypeScript (npm)

```bash
npm install oma-harness
```

### macOS binary

```bash
cd oma-pkg
./build_macos.sh
# produces dist/oma -- a standalone binary
```

## Quick start

```bash
# set at least one provider key
export OMA_CLAUDE_KEY=sk-ant-api03-...
export OMA_OPENAI_KEY=sk-proj-...

# run a task from the CLI
oma run "analyze the top 10 HN posts today"

# launch the web dashboard
oma web

# launch the native GUI
oma gui
```

### Python API

```python
from oma import OMA

agent = OMA.from_env()
result = agent.run(
    objective="build a CSV parser",
    criteria={"compiles": True, "handles_quotes": True},
)

print(result.status)       # Status.DONE | Status.PARKED
print(result.confidence)   # 0.92
print(result.artifacts["final"])
```

### TypeScript API

```typescript
import { OMA } from 'oma-harness';

const agent = OMA.fromEnv();
const result = await agent.run({
  objective: 'build a CSV parser',
  criteria: { compiles: true, handles_quotes: true },
});

console.log(result.status);
console.log(result.artifacts.get('final'));
```

### Resume a parked task

```python
# if a task was parked (near-outage, timeout, or max attempts),
# the next worker resumes from persistent memory:
result = agent.run("continue", resume_from=result.task_id)
```

## Providers

Six LLM providers, two connection modes, zero SDK dependencies. All via raw `urllib` (Python) or `fetch` (TypeScript).

| Provider | Env var | API style | Subscription mode |
|----------|---------|-----------|-------------------|
| Claude | `OMA_CLAUDE_KEY` | Anthropic Messages | claude.ai session cookie |
| ChatGPT | `OMA_OPENAI_KEY` | OpenAI Chat Completions | chatgpt.com access token |
| Gemini | `OMA_GEMINI_KEY` | Google GenerativeLanguage | gemini.google.com session |
| DeepSeek | `OMA_DEEPSEEK_KEY` | OpenAI-compatible | -- |
| GLM/Zhipu | `OMA_GLM_KEY` | OpenAI-compatible | -- |
| Kimi/Moonshot | `OMA_KIMI_KEY` | OpenAI-compatible | -- |

**API key mode**: set `OMA_<PROVIDER>_KEY` env vars, or store them via `oma auth add <provider> <key>`.

**Subscription mode**: use your existing paid subscriptions (Claude Pro, ChatGPT Plus, Gemini Advanced) by providing browser session cookies/tokens. Same models, no separate API billing.

```bash
# store credentials securely (encrypted, owner-only file permissions)
oma auth add claude sk-ant-api03-...
oma auth add chatgpt "eyJ..."  --type token
oma auth add deepseek sk-...

# check what's configured
oma auth status
oma auth info
```

The registry auto-discovers providers from environment and stored credentials, tracks health per provider (success rate, latency, cooldowns), and dynamically reorders the fallback chain.

## Architecture

```
objective
    |
    v
+-------------------+
|    Core Loop      |  invariant: state always serializable
|  (retry + eval)   |  invariant: cost never exceeds budget unchecked
+-------------------+  invariant: provider calls wrapped in fallback
    |           |
    v           v
+--------+  +-----------+
|Provider|  | Criteria  |
|Registry|  |  Engine   |
+--------+  +-----------+
    |
    +-- Claude (Anthropic API / subscription)
    +-- ChatGPT (OpenAI API / subscription)
    +-- Gemini (Google API / subscription)
    +-- DeepSeek (OpenAI-compatible)
    +-- GLM/Zhipu (OpenAI-compatible)
    +-- Kimi/Moonshot (OpenAI-compatible)
    |
    v
+-------------------+
|    Sanitizer      |  strips attribution, em dashes, filler
+-------------------+
    |
    v
+-------------------+
| Automation Layers |
|  pixel | page |   |
|     memory        |
+-------------------+
    |
    v
+-------------------+
|  Edge Handlers    |  near-outage summary / outage recovery
+-------------------+
```

### Core loop

The loop terminates in exactly one of four states: `DONE` (confidence threshold met), `PARKED` with a handoff note (tokens running low, wall clock exceeded, or retries exhausted). Every parked state includes a serialized handoff that the next worker can resume from.

### Criteria engine

Every task has explicit, typed success criteria with weights and hard gates. No vague "is it good enough?" -- the criteria engine computes a weighted confidence score and zeroes it if any required criterion fails.

```python
from oma import CriteriaSet, Criterion, CriterionType

criteria = CriteriaSet()
criteria.add(Criterion("compiles", "Code compiles", CriterionType.BOOLEAN, weight=3.0, required=True))
criteria.add(Criterion("tests_pass", "Tests pass", CriterionType.BOOLEAN, weight=2.5, required=True))
criteria.add(Criterion("coverage", "Coverage ratio", CriterionType.THRESHOLD, weight=1.5, target=0.7))
```

Built-in presets: `code_quality_criteria()`, `research_criteria()`, `automation_criteria()`.

### Sanitizer

Strips provider fingerprints so output is provider-neutral: attribution patterns (all providers), em dashes to commas/hyphens (context-aware), curly quotes to straight, AI filler phrases. Composable pipeline -- add custom passes with `.add_pass(fn)`.

### Automation layers

- **Pixel**: framebuffer capture, click, type, key combos. Platform-aware (macOS/Linux/Windows). Delegates to MCP computer tools when available.
- **Page**: SPA-aware with mutation observer injection, configurable scroll strategies (full page, infinite, paginated), CSS selector targeting, deduplication.
- **Memory**: working memory (in-session, LRU-evicted, tag-searchable), persistent memory (JSON per task, survives across sessions), context optimizer (packs important context into the provider's token budget).

### Edge handling

Near-outage (tokens low but can still write) triggers a summarization of completed steps, remaining steps, critical context, and provider status -- serialized as a handoff note. If outage hits before completion, the last incremental checkpoint is the recovery point.

## CLI reference

```
oma run <objective>          Run a task
oma run <obj> --criteria '{}'  Run with explicit criteria (JSON)
oma run <obj> --resume <id>  Resume a parked task

oma status                   Show agent status
oma providers                List configured providers

oma auth add <provider> <key>    Store a credential
oma auth remove <provider>       Remove a credential
oma auth status                  List stored credentials
oma auth verify [provider]       Verify credentials against APIs
oma auth info                    Show storage paths and encryption
oma auth flush --all [-y]        Securely wipe all credentials
oma auth flush --all --include-memory  Also wipe task memory

oma memory list              List stored task checkpoints
oma memory flush [-y]        Flush all task memory
oma memory flush --task-id <id>  Flush specific task

oma gui                      Launch native GUI (requires pywebview)
oma web [--port 8384]        Launch web dashboard
```

## Credential storage and security

Credentials are encrypted at rest using PBKDF2-HMAC-SHA256 (100k iterations) with a hardware-derived machine key, stored in `~/.oma/credentials.json` with `0600` permissions. Writes are atomic (temp file + rename) to prevent corruption under concurrent access. Both API keys and browser session cookies/tokens are supported with auto-detection.

See [STORAGE_AND_SECURITY.md](STORAGE_AND_SECURITY.md) for the full architecture, inspection commands, and flushing procedures.

## Project structure

```
oma/                         # reference implementation (standalone Python)
  oma.py                     # top-level orchestrator
  SPEC.md                    # architecture spec
  core/
    loop.py                  # invariant retry loop
    criteria.py              # criteria engine
    sanitize.py              # output sanitizer
    edge.py                  # edge case handlers
  providers/
    base.py                  # provider interface
    registry.py              # provider registry + health tracking
    http_providers.py        # raw HTTP connectors (all 6)
  automation/
    pixel.py                 # framebuffer + click/key
    page.py                  # SPA scroll + observe + extract
    memory.py                # working + persistent memory

oma-pkg/                     # distributable Python package
  pyproject.toml             # hatchling build config
  build_macos.sh             # macOS binary builder
  src/oma/                   # package source
    agent.py                 # OMA orchestrator (enhanced)
    cli.py                   # CLI entry point
    gui/
      app.py                 # native GUI (pywebview)
      web.py                 # web dashboard (built-in HTTP server)
    providers/
      auth.py                # credential store (encrypted, atomic)
      subscription.py        # subscription-based providers
      ...
    ...
  tests/                     # test suite (unit, functional, smoke, e2e, integration)

oma-ts/                      # TypeScript implementation
  package.json               # npm package config
  tsconfig.json              # TypeScript config
  src/
    agent.ts                 # OMA orchestrator
    cli.ts                   # CLI entry point
    core/                    # loop, criteria, sanitize, edge
    providers/               # auth, registry, HTTP providers, subscription
    automation/              # pixel, page, memory
    gui/
      web.ts                 # web dashboard
```

## Testing

```bash
cd oma-pkg

# install dev dependencies
pip install -e ".[dev]"

# run the full suite
pytest

# run by tier
pytest -m unit          # fast, no external dependencies
pytest -m functional    # component workflows
pytest -m smoke         # quick health checks
pytest -m e2e           # full pipeline
pytest -m live          # hits real provider endpoints (needs keys)
```

## Development

Requirements: Python >= 3.10, Node.js >= 18 (for the TypeScript implementation).

```bash
# Python
cd oma-pkg
pip install -e ".[dev]"
ruff check src/
mypy src/

# TypeScript
cd oma-ts
npm install
npm run build
npm test
```

## License

MIT
