/**
 * OMA Sanitizer - strip provider fingerprints from output.
 *
 * Removes:
 *   - Claude/Anthropic attribution markers
 *   - Em dashes (replaced with hyphens or commas depending on context)
 *   - Provider-specific phrasing patterns
 *   - System prompt leakage markers
 *
 * The sanitizer is idempotent: running it twice produces the same output.
 */

// attribution patterns (case-insensitive)
const ATTRIBUTION_PATTERNS: RegExp[] = [
  /co-authored-by:\s*claude[^\n]*/gi,
  /generated\s+(with|by)\s+claude[^\n]*/gi,
  /powered\s+by\s+(claude|anthropic)[^\n]*/gi,
  /anthropic['']?s?\s+claude[^\n]*/gi,
  /\bclaude\s+(ai|assistant|code|opus|sonnet|haiku|fable|mythos)\b/gi,
  /as\s+an?\s+ai\s+(language\s+)?model/gi,
  /as\s+an?\s+ai\s+assistant/gi,
  /i['']m\s+claude\b/gi,
  // gemini/google
  /generated\s+(with|by)\s+gemini[^\n]*/gi,
  /powered\s+by\s+google\s+ai[^\n]*/gi,
  // chatgpt/openai
  /generated\s+(with|by)\s+chatgpt[^\n]*/gi,
  /powered\s+by\s+openai[^\n]*/gi,
  /as\s+chatgpt\b/gi,
  // deepseek
  /generated\s+(with|by)\s+deepseek[^\n]*/gi,
  // generic
  /\[ai-generated\]/gi,
  /\[auto-generated\s+content\]/gi,
];

// em dash and variants
const EM_DASH_RE = /—|–|--+/g;

// curly quotes to straight
const CURLY_QUOTES: Record<string, string> = {
  '‘': "'", // left single
  '’': "'", // right single
  '“': '"', // left double
  '”': '"', // right double
};

// common ai-speak filler
const FILLER_PATTERNS: [RegExp, string][] = [
  [/\bI'd be happy to\s+/gi, ''],
  [/\bCertainly!\s*/gi, ''],
  [/\bOf course!\s*/gi, ''],
  [/\bAbsolutely!\s*/gi, ''],
  [/\bGreat question!\s*/gi, ''],
  [/\bThat's a great question[.!]\s*/gi, ''],
  [/\bHere's what I found:\s*/gi, ''],
  [/\bLet me help you with that[.!]\s*/gi, ''],
];

export function stripAttributions(text: string): string {
  for (const pat of ATTRIBUTION_PATTERNS) {
    text = text.replace(pat, '');
  }
  return text;
}

export function replaceEmDashes(text: string): string {
  // bullet-style at line start
  text = text.replace(/^[—–]\s*/gm, '- ');
  // between spaces (clause break) -> comma
  text = text.replace(/\s+[—–]+\s+/g, ', ');
  text = text.replace(/\s+--+\s+/g, ', ');
  // any remaining
  text = text.replace(EM_DASH_RE, ' - ');
  return text;
}

export function straightenQuotes(text: string): string {
  for (const [curly, straight] of Object.entries(CURLY_QUOTES)) {
    text = text.replaceAll(curly, straight);
  }
  return text;
}

export function stripFiller(text: string): string {
  for (const [pat, repl] of FILLER_PATTERNS) {
    text = text.replace(pat, repl);
  }
  return text;
}

export function collapseWhitespace(text: string): string {
  // collapse multiple blank lines to max 2
  text = text.replace(/\n{3,}/g, '\n\n');
  // trailing spaces on lines
  text = text.replace(/[ \t]+$/gm, '');
  return text.trim();
}

export type SanitizerPass = (text: string) => string;

export class Sanitizer {
  passes: SanitizerPass[] = [];

  constructor(enableAll = true) {
    if (enableAll) {
      this.passes = [
        stripAttributions,
        replaceEmDashes,
        straightenQuotes,
        stripFiller,
        collapseWhitespace,
      ];
    }
  }

  addPass(fn: SanitizerPass): this {
    this.passes.push(fn);
    return this;
  }

  run(text: string): string {
    for (const fn of this.passes) {
      text = fn(text);
    }
    return text;
  }
}

// convenience singleton
export const sanitize = new Sanitizer();
