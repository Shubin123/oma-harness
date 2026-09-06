# OMA - Open Multi Agent

A harness for running tasks across multiple LLM subscriptions with invariant retry, criteria-driven evaluation, and graceful degradation.

## Install

```bash
pip install oma-harness          # core
pip install oma-harness[gui]     # with desktop GUI
pip install oma-harness[web]     # with web dashboard
pip install oma-harness[all]     # everything
```

## Quick start

```bash
# set at least one provider key
export OMA_CLAUDE_KEY=sk-...
export OMA_OPENAI_KEY=sk-...

# run a task
oma run "analyze the top 10 HN posts today"

# launch GUI
oma gui

# launch web dashboard
oma web
```

## Python API

```python
from oma import OMA

agent = OMA.from_env()
result = agent.run(
    objective="build a CSV parser",
    criteria={"compiles": True, "handles_quotes": True},
)

print(result.status)       # Status.DONE
print(result.confidence)   # 0.92
print(result.artifacts["final"])
```

## Providers

Six LLM subscriptions, zero SDK dependencies. All via raw HTTP.

| Provider | Env var | API style |
|----------|---------|-----------|
| Claude | `OMA_CLAUDE_KEY` | Anthropic Messages |
| Gemini | `OMA_GEMINI_KEY` | Google GenerativeLanguage |
| ChatGPT | `OMA_OPENAI_KEY` | OpenAI Chat Completions |
| DeepSeek | `OMA_DEEPSEEK_KEY` | OpenAI-compatible |
| GLM | `OMA_GLM_KEY` | OpenAI-compatible |
| Kimi | `OMA_KIMI_KEY` | OpenAI-compatible |

The registry auto-discovers from env, tracks health per provider, and reorders the fallback chain dynamically.

## Architecture

- **Core loop**: invariant retry with token/time budgets and provider fallback
- **Criteria engine**: weighted, typed success criteria with hard gates
- **Sanitizer**: strips provider attribution, em dashes, AI filler
- **Providers**: unified HTTP layer for 6 LLM subscriptions
- **Automation**: pixel (framebuffer), page (SPA scroll/observe), memory (working + persistent)
- **Edge handlers**: near-outage summarization and outage recovery handoff

## License

MIT
