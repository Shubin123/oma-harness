/**
 * OMA Page-Level Automation - SPA-aware scroll, observe, and extract.
 *
 * For web pages (which are almost always SPAs now), this layer:
 *   1. Observes the DOM for mutations (lazy-loaded content)
 *   2. Scrolls from start to end of page, waiting for each chunk to load
 *   3. Extracts structured content as it goes
 *   4. Handles infinite scroll, pagination, and modals
 *
 * The key insight: every modern web page is "just a SPA after all" -
 * content loads incrementally. The observer pattern catches it all.
 */

export enum ScrollStrategy {
  FULL_PAGE = 'full_page',
  INFINITE = 'infinite',
  PAGINATED = 'paginated',
  VIEWPORT = 'viewport',
}

export interface PageConfig {
  scrollStrategy: ScrollStrategy;
  scrollStepPx: number;
  scrollPauseMs: number;
  maxScrolls: number;
  mutationTimeoutMs: number;
  extractSelectors: string[];
  ignoreSelectors: string[];
}

export const DEFAULT_PAGE_CONFIG: PageConfig = {
  scrollStrategy: ScrollStrategy.FULL_PAGE,
  scrollStepPx: 800,
  scrollPauseMs: 500,
  maxScrolls: 200,
  mutationTimeoutMs: 3000,
  extractSelectors: [],
  ignoreSelectors: [
    'nav', 'footer', '.cookie-banner', '.modal-backdrop',
    "[aria-hidden='true']", '.ad', '.advertisement',
  ],
};

// ---- JavaScript injection snippets ----

export const OBSERVER_INJECT = `
(() => {
    if (window.__oma_observer) return 'already_attached';

    window.__oma_mutations = [];
    window.__oma_scroll_height = document.documentElement.scrollHeight;

    window.__oma_observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.addedNodes.length > 0) {
                window.__oma_mutations.push({
                    type: 'added',
                    count: m.addedNodes.length,
                    ts: Date.now(),
                });
            }
        }
    });

    window.__oma_observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    return 'attached';
})()
`;

export const CHECK_MUTATIONS = `
(() => {
    const mutations = window.__oma_mutations || [];
    const newHeight = document.documentElement.scrollHeight;
    const oldHeight = window.__oma_scroll_height || newHeight;
    window.__oma_mutations = [];
    window.__oma_scroll_height = newHeight;

    return JSON.stringify({
        mutation_count: mutations.length,
        height_changed: newHeight !== oldHeight,
        scroll_height: newHeight,
        scroll_top: window.scrollY,
        viewport_height: window.innerHeight,
        at_bottom: (window.scrollY + window.innerHeight) >= (newHeight - 50),
    });
})()
`;

export function scrollByScript(step: number): string {
  return `
(() => {
    window.scrollBy({ top: ${step}, behavior: 'smooth' });
    return JSON.stringify({
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
    });
})()
`;
}

export function extractTextScript(ignoreSelectors: string[], extractSelectors: string[]): string {
  return `
(() => {
    const ignore = ${JSON.stringify(ignoreSelectors)};
    const selectors = ${JSON.stringify(extractSelectors)};

    function isVisible(el) {
        const style = getComputedStyle(el);
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0';
    }

    function shouldIgnore(el) {
        return ignore.some(sel => el.closest(sel));
    }

    let targets;
    if (selectors.length > 0) {
        targets = Array.from(document.querySelectorAll(selectors.join(',')));
    } else {
        targets = [document.body];
    }

    const chunks = [];
    for (const target of targets) {
        if (!shouldIgnore(target) && isVisible(target)) {
            chunks.push(target.innerText.trim());
        }
    }

    return chunks.join('\\n---\\n');
})()
`;
}

export interface PageState {
  url: string;
  scrollPosition: number;
  scrollHeight: number;
  atBottom: boolean;
  contentChunks: string[];
  scrollCount: number;
  mutationsObserved: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export type JsFn = (script: string) => Promise<string> | string;
export type WaitFn = (seconds: number) => Promise<void>;

export class PageAutomator {
  /**
   * Automates scrolling and extraction for SPAs.
   *
   * Requires a JS executor - either:
   *   - MCP javascript_tool (browser extension)
   *   - Playwright page.evaluate
   *   - Selenium driver.execute_script
   *
   * Pass the executor as js_fn(script) -> result.
   */
  private js: JsFn;
  config: PageConfig;
  private wait: WaitFn;

  constructor(
    jsFn: JsFn,
    config?: Partial<PageConfig>,
    waitFn?: WaitFn,
  ) {
    this.js = jsFn;
    this.config = { ...DEFAULT_PAGE_CONFIG, ...config };
    this.wait = waitFn ?? ((s: number) => sleep(s * 1000));
  }

  /** Inject the mutation observer into the page. */
  async attachObserver(): Promise<string> {
    return await this.js(OBSERVER_INJECT);
  }

  /** Check current scroll position and pending mutations. */
  async checkState(): Promise<Record<string, unknown>> {
    const raw = await this.js(CHECK_MUTATIONS);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  /** Scroll down one step. */
  async scrollStep(): Promise<Record<string, unknown>> {
    const script = scrollByScript(this.config.scrollStepPx);
    const raw = await this.js(script);
    await this.wait(this.config.scrollPauseMs / 1000);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  /** Extract text content from the current viewport/page. */
  async extractContent(): Promise<string> {
    const script = extractTextScript(
      this.config.ignoreSelectors,
      this.config.extractSelectors,
    );
    return await this.js(script);
  }

  /**
   * The main automation: scroll from top to bottom,
   * extracting content along the way.
   *
   * For infinite scroll pages, keeps going until no new content appears.
   */
  async fullScrollAndExtract(): Promise<PageState> {
    const state: PageState = {
      url: '',
      scrollPosition: 0,
      scrollHeight: 0,
      atBottom: false,
      contentChunks: [],
      scrollCount: 0,
      mutationsObserved: 0,
    };

    // attach observer
    await this.attachObserver();
    await this.wait(0.5);

    // scroll to top first
    await this.js('window.scrollTo(0, 0)');
    await this.wait(0.3);

    // extract initial content
    const initial = await this.extractContent();
    if (initial) state.contentChunks.push(initial);

    while (state.scrollCount < this.config.maxScrolls) {
      // scroll down
      await this.scrollStep();
      state.scrollCount++;

      // check state
      const pageState = await this.checkState();
      state.scrollPosition = (pageState.scroll_top as number) ?? 0;
      state.scrollHeight = (pageState.scroll_height as number) ?? 0;
      state.atBottom = (pageState.at_bottom as boolean) ?? false;
      state.mutationsObserved += (pageState.mutation_count as number) ?? 0;

      // extract new content from current viewport
      const chunk = await this.extractContent();
      const recentChunks = state.contentChunks.slice(-3);
      if (chunk && !recentChunks.includes(chunk)) {
        state.contentChunks.push(chunk);
      }

      // check termination
      if (this.config.scrollStrategy === ScrollStrategy.FULL_PAGE) {
        if (state.atBottom) break;
      } else if (this.config.scrollStrategy === ScrollStrategy.INFINITE) {
        if (state.atBottom) {
          // wait a bit for potential lazy load
          await this.wait(this.config.mutationTimeoutMs / 1000);
          const recheck = await this.checkState();
          if (!(recheck.height_changed as boolean)) {
            break; // no new content loaded
          }
        }
      }
    }

    return state;
  }
}
