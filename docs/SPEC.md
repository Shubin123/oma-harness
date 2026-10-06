# OMA - Open Multi Agent

A harness for running tasks across multiple LLM subscriptions with invariant retry, criteria-driven evaluation, and graceful degradation.

## Architecture

```
objective
    |
    v
+-------------------+
|    Core Loop      |  <-- invariant: state always serializable
|  (retry + eval)   |      invariant: cost never exceeds budget unchecked
+-------------------+      invariant: provider calls wrapped in fallback
    |           |
    v           v
+--------+  +-----------+
|Provider|  | Criteria  |
|Registry|  |  Engine   |
+--------+  +-----------+
    |
    +-- claude (anthropic api)
    +-- gemini (google generativelanguage api)
    +-- chatgpt (openai api)
    +-- deepseek (openai-compatible)
    +-- glm/zhipu (openai-compatible)
    +-- kimi/moonshot (openai-compatible)
    |
    v
+-------------------+
|    Sanitizer      |  strips attribution, emdashes, filler
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

## 1. Core Loop Logic with Invariance

The loop maintains three invariants at every iteration:

1. **State is serializable** - `TaskState.snapshot()` can always produce a JSON dict that a new worker can consume
2. **Cost never exceeds budget unchecked** - before every provider call, remaining tokens are checked; if below reserve, handoff is triggered
3. **Provider calls use fallback** - every call walks the provider chain; no single provider failure kills the loop

```python
while attempts < max and not done:
    if near_outage: summarize_and_park()
    if timed_out: summarize_and_park()

    result = try_providers(state)  # walks chain
    result = sanitize(result)
    confidence = evaluate(result, criteria)

    if confidence >= threshold:
        done = True
    else:
        backoff()
```

The loop terminates in exactly one of:
- `DONE` - confidence threshold met
- `PARKED` (near outage) - tokens running low, handoff written
- `PARKED` (timeout) - wall clock exceeded, handoff written
- `PARKED` (max attempts) - retries exhausted, handoff written

## 2. Criteria Engine

Every task has explicit success criteria. No vague "is it good enough?"

```python
criteria = CriteriaSet()
criteria.add(Criterion("compiles", "Code compiles", BOOLEAN, weight=3.0, required=True))
criteria.add(Criterion("tests_pass", "Tests pass", BOOLEAN, weight=2.5, required=True))
criteria.add(Criterion("coverage", "Coverage ratio", THRESHOLD, weight=1.5, target=0.7))
```

Types: `BOOLEAN`, `NUMERIC`, `THRESHOLD`, `CONTAINS`, `REGEX`, `CUSTOM`

Each criterion has a weight (importance) and an optional `required` flag (hard gate). The overall confidence is the weighted average, zeroed if any required criterion fails.

Presets: `code_quality_criteria()`, `research_criteria()`, `automation_criteria()`

## 3. Sanitizer

Strips provider fingerprints so output is provider-neutral:

- Attribution patterns (all providers)
- Em dashes to commas/hyphens (context-aware)
- Curly quotes to straight
- AI filler phrases ("I'd be happy to", "Certainly!", etc.)
- Whitespace normalization

Composable pipeline - add custom passes with `.add_pass(fn)`.

## 4. Provider Registry

No SDK dependencies. Every provider is just:
- An HTTP endpoint
- Auth headers
- Request body builder
- Response parser

All six providers (Claude, Gemini, ChatGPT, DeepSeek, GLM, Kimi) use raw `urllib` calls. Four of six (ChatGPT, DeepSeek, GLM, Kimi) are OpenAI-compatible, so they share the same body/parse logic.

Auto-discovery from environment:
```
OMA_CLAUDE_KEY=...
OMA_GEMINI_KEY=...
OMA_OPENAI_KEY=...
OMA_DEEPSEEK_KEY=...
OMA_GLM_KEY=...
OMA_KIMI_KEY=...
```

Dynamic health tracking per provider:
- Success rate
- Average latency
- Cooldown on capacity/budget errors
- Auto-reorder fallback chain by score

## 5. Automation Layers

### Pixel Level
Framebuffer capture, click, type, key combos. Platform-aware (macOS/Linux/Windows). When MCP computer tools are available, delegates to those instead.

### Page Level
SPA-aware:
- Mutation observer injection (catches lazy-loaded content)
- Scroll from start to end with configurable strategy (full page, infinite, paginated)
- Content extraction with CSS selector targeting
- Deduplication of repeated chunks

### Memory Level
- **Working memory**: in-session, LRU-evicted, tag-searchable
- **Persistent memory**: JSON files per task, survives across sessions
- **Context optimizer**: packs the most important context into the provider's token budget
- **Handoff serialization**: everything the next worker needs

## 6. Edge Handling

### Near Outage (tokens low but can still write)
```
if remaining_tokens < reserve:
    note = summarize(completed, remaining, context)
    persist(note)
    park()
```

The handoff note includes: completed steps, remaining steps (priority ordered), critical context, artifacts produced, criteria, provider status.

### Outage Before Completion
The handoff was maintained incrementally (working memory + checkpoints), so the last state is the recovery point. The next worker gets:

```
From a fork of open-multi-agent, consider these patches
and create a working binary for macos on this computer
in order to complete the functionalities listed from most
important to least, checking off as many as possible.

Functionalities (priority order):
  [ ] 1. ...
  [ ] 2. ...
  [ ] 3. ...
```

## Usage

```python
from oma import OMA

agent = OMA.from_env()
result = agent.run(
    objective="scrape and analyze HN front page trends",
    criteria={"has_data": True, "formatted": True},
)

if result.status == Status.DONE:
    print(result.artifacts["final"])
elif result.status == Status.PARKED:
    print(result.context_for_next)
    # resume later:
    agent.run("continue", resume_from=result.task_id)
```

## File Structure

```
oma/
  oma.py                    # top-level orchestrator
  SPEC.md                   # this file
  core/
    loop.py                 # invariant retry loop
    criteria.py             # criteria engine
    sanitize.py             # output sanitizer
    edge.py                 # edge case handlers
  providers/
    base.py                 # provider interface
    registry.py             # provider registry + health
    http_providers.py       # raw HTTP connectors (all 6)
  automation/
    pixel.py                # framebuffer + click/key
    page.py                 # SPA scroll + observe + extract
    memory.py               # working + persistent memory
  templates/
    (prompt templates go here)
```
