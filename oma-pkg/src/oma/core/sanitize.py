"""
OMA Sanitizer -- strip provider fingerprints from output.

Removes:
  - Claude/Anthropic attribution markers
  - Em dashes (replaced with hyphens or commas depending on context)
  - Provider-specific phrasing patterns
  - System prompt leakage markers

The sanitizer is idempotent: running it twice produces the same output.
"""

import re
from collections.abc import Callable

# ---- pattern registry ----

# attribution patterns (case-insensitive)
ATTRIBUTION_PATTERNS = [
    r"(?i)co-authored-by:\s*claude[^\n]*",
    r"(?i)generated\s+(with|by)\s+claude[^\n]*",
    r"(?i)powered\s+by\s+(claude|anthropic)[^\n]*",
    r"(?i)anthropic['’]?s?\s+claude[^\n]*",
    r"(?i)\bclaude\s+(ai|assistant|code|opus|sonnet|haiku|fable|mythos)\b",
    r"(?i)as\s+an?\s+ai\s+(language\s+)?model",
    r"(?i)as\s+an?\s+ai\s+assistant",
    r"(?i)i['’]m\s+claude\b",
    # gemini/google
    r"(?i)generated\s+(with|by)\s+gemini[^\n]*",
    r"(?i)powered\s+by\s+google\s+ai[^\n]*",
    # chatgpt/openai
    r"(?i)generated\s+(with|by)\s+chatgpt[^\n]*",
    r"(?i)powered\s+by\s+openai[^\n]*",
    r"(?i)as\s+chatgpt\b",
    # deepseek
    r"(?i)generated\s+(with|by)\s+deepseek[^\n]*",
    # generic
    r"(?i)\[ai-generated\]",
    r"(?i)\[auto-generated\s+content\]",
]

# em dash and its unicode variants
EM_DASH_RE = re.compile(r"—|–|--+")

# curly quotes to straight
CURLY_QUOTES = {
    "‘": "'",   # left single
    "’": "'",   # right single
    "“": '"',   # left double
    "”": '"',   # right double
}

# common ai-speak filler
FILLER_PATTERNS = [
    (r"(?i)\bI'd be happy to\s+", ""),
    (r"(?i)\bCertainly!\s*", ""),
    (r"(?i)\bOf course!\s*", ""),
    (r"(?i)\bAbsolutely!\s*", ""),
    (r"(?i)\bGreat question!\s*", ""),
    (r"(?i)\bThat's a great question[.!]\s*", ""),
    (r"(?i)\bHere's what I found:\s*", ""),
    (r"(?i)\bLet me help you with that[.!]\s*", ""),
]


def strip_attributions(text: str) -> str:
    for pat in ATTRIBUTION_PATTERNS:
        text = re.sub(pat, "", text)
    return text


def replace_em_dashes(text: str) -> str:
    """
    Context-aware em dash replacement:
      - " -- " or " --- " between words -> ", " (clause break)
      - at line start (bullet style) -> "- "
      - otherwise -> " - "
    """
    # bullet-style at line start
    text = re.sub(r"(?m)^[—–]\s*", "- ", text)

    # between spaces (clause break) -> comma
    def _clause_replace(m):
        return ", "

    text = re.sub(r"\s+[—–]+\s+", _clause_replace, text)
    text = re.sub(r"\s+--+\s+", _clause_replace, text)

    # any remaining
    text = EM_DASH_RE.sub(" - ", text)
    return text


def straighten_quotes(text: str) -> str:
    for curly, straight in CURLY_QUOTES.items():
        text = text.replace(curly, straight)
    return text


def strip_filler(text: str) -> str:
    for pat, repl in FILLER_PATTERNS:
        text = re.sub(pat, repl, text)
    return text


def collapse_whitespace(text: str) -> str:
    # collapse multiple blank lines to max 2
    text = re.sub(r"\n{3,}", "\n\n", text)
    # trailing spaces on lines
    text = re.sub(r"[ \t]+$", "", text, flags=re.MULTILINE)
    return text.strip()


class Sanitizer:
    """
    Composable sanitizer pipeline.
    Default pipeline: attributions -> em dashes -> quotes -> filler -> whitespace.
    Add custom passes with .add_pass(fn).
    """

    def __init__(self, enable_all: bool = True):
        self.passes: list[Callable[[str], str]] = []
        if enable_all:
            self.passes = [
                strip_attributions,
                replace_em_dashes,
                straighten_quotes,
                strip_filler,
                collapse_whitespace,
            ]

    def add_pass(self, fn: Callable[[str], str]) -> "Sanitizer":
        self.passes.append(fn)
        return self

    def __call__(self, text: str) -> str:
        for fn in self.passes:
            text = fn(text)
        return text


# convenience singleton
sanitize = Sanitizer()
