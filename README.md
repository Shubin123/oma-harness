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

### Standalone binaries

Download the binary for your platform from the
[latest release](https://github.com/Shubin123/oma-harness/releases/latest) --
macOS (arm64/x64), Linux (x64) and Windows (x64) are built from every tag, with
a `SHA256SUMS` file to check them against.

```bash
# macOS / Linux
tar -xzf oma-macos-arm64.tar.gz && chmod +x oma-macos-arm64 && ./oma-macos-arm64 --help
```

```powershell
# Windows
Expand-Archive oma-windows-x64.zip -DestinationPath . ; .\oma-windows-x64.exe --help
```

Or build them yourself -- one command, same on every platform:

```bash
python tools/build.py            # both binaries into dist/
python tools/build.py --help     # targets, cleaning, wheel building
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

Twenty-two providers, eighteen of them usable without paying, zero SDK
dependencies. Every call is raw `urllib` (Python) or `fetch` (TypeScript).

```bash
oma providers --free      # what you can use without paying, with signup links
oma providers --catalog   # everything, grouped by what it costs
oma tiers                 # where requests went, and what escalated
```

| Tier | Providers | What you get |
|------|-----------|--------------|
| `local` | Ollama, LM Studio | Unlimited, on your own hardware. No account. |
| `free` | Groq, Cerebras, Google AI Studio, OpenRouter, GitHub Models, Cloudflare Workers AI | Free within published rate limits. No card. |
| `freemium` | Mistral, Cohere, NVIDIA NIM, SambaNova, Hugging Face, Together, Hyperbolic, DeepInfra, Nebius, GLM | A free allowance, then billed. |
| `paid` | Claude, OpenAI, DeepSeek, Kimi | Billed per token from the first call. |

Signing up is something you do yourself -- `oma providers --free` prints the
link for each one, and the dashboard's **Providers** tab links straight to it,
takes the pasted key, and checks it against the provider's API before storing
it encrypted.

Adding a provider is a catalog entry in `oma/providers/catalog.py`, not new
transport code: the HTTP table and environment discovery are both generated
from it. Model identifiers are resolved against each provider's live model
list, so a retired model name falls back to a working one instead of failing
the first call of a task.

### Tiering

The router spends free capacity before it spends money. Candidates are grouped
by tier and the cheapest group with anyone left in it wins; when a free
provider trips its rate limit the quota manager takes it out of the running,
that group empties, and the next request escalates on its own. Every escalation
is recorded, so `oma tiers` and the dashboard can show the moment a task
stopped being free.

```python
from oma.core.tiers import TierMode, TierPolicy
from oma.providers.catalog import Tier

# Never spend anything: the router selects nothing rather than reaching for a
# metered provider -- which is what an unattended loop needs.
agent.router.tier_policy = TierPolicy(mode=TierMode.FREE_ONLY)

# Or set a ceiling and let it escalate up to that point.
agent.router.tier_policy = TierPolicy(max_tier=Tier.FREEMIUM)
```

### Connection modes

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

- **Pixel**: framebuffer capture, click, type, key combos. macOS uses `screencapture` and `cliclick`, Linux `grim` and `xdotool`, Windows calls user32/gdi32 through `ctypes` (no PowerShell, which Defender's AMSI blocks for screen capture, and no extra packages). Delegates to MCP computer tools when available.
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
oma providers --free         List providers usable without paying, with signup links
oma providers --catalog      List every supported provider, grouped by cost
oma tiers                    Show the tier policy, spend by tier, and escalations

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

Credentials are encrypted at rest using PBKDF2-HMAC-SHA256 (100k iterations) with a hardware-derived machine key, stored in `~/.oma/credentials.json` restricted to the owner: mode `0600` on macOS and Linux, and an `icacls` ACL naming only your account (plus the system principals, the equivalent of root's access to a `0600` file) on Windows. Writes are atomic (temp file + rename) to prevent corruption under concurrent access. Both API keys and browser session cookies/tokens are supported with auto-detection.

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

tools/                       # cross-platform build driver
  build.py                   # builds binaries, archives, checksums
  build.mjs                  # node wrapper so npm scripts find Python

oma-pkg/                     # distributable Python package
  pyproject.toml             # hatchling build config
  oma.spec                   # PyInstaller spec
  src/oma/                   # package source
    platform_compat.py       # machine id + owner-only files (POSIX and Windows)
    agent.py                 # OMA orchestrator (enhanced)
    cli.py                   # CLI entry point
    gui/
      app.py                 # native GUI (pywebview)
      web.py                 # web dashboard (built-in HTTP server)
    providers/
      auth.py                # credential store (encrypted, atomic)
      catalog.py             # every provider, its tier, and where to sign up
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

## Building

`tools/build.py` is the only build implementation: the Makefile, the npm
scripts and CI all call it, so a local build and a release build take the same
steps. It needs Python 3.10+ and, for the Node binary, Node 20+.

```bash
python tools/build.py                 # Python and Node binaries for this platform
python tools/build.py --target python # one runtime only
python tools/build.py --wheel         # also build the wheel and sdist
python tools/build.py --clean         # ignore the build cache
python tools/build.py --skip-tests    # skip the pre-build test run
```

Artifacts land in `dist/`: the binaries, one archive each (`.tar.gz` on Unix,
`.zip` on Windows), and `SHA256SUMS`. Repeat builds reuse the cache in
`.build_cache/` and skip work whose inputs have not changed.

On macOS and Linux the Makefile wraps the same commands (`make build`,
`make test`, `make lint`). Windows has no make by default, so call the script
directly.

Releases are cut by pushing a tag: `git tag v0.2.1 && git push origin v0.2.1`.
The release workflow builds on macOS arm64, macOS x64, Linux x64 and Windows
x64, then publishes the archives and checksums to a GitHub release.

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

Requirements: Python >= 3.10, Node.js >= 20 (for the TypeScript implementation and its binary). Supported on macOS, Linux and Windows.

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
