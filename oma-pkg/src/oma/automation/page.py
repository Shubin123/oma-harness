"""
OMA Page-Level Automation -- SPA-aware scroll, observe, and extract.

For web pages (which are almost always SPAs now), this layer:
  1. Observes the DOM for mutations (lazy-loaded content)
  2. Scrolls from start to end of page, waiting for each chunk to load
  3. Extracts structured content as it goes
  4. Handles infinite scroll, pagination, and modals

The key insight: every modern web page is "just a SPA after all" --
content loads incrementally. The observer pattern catches it all.
"""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ScrollStrategy(Enum):
    FULL_PAGE = "full_page"          # scroll top to bottom
    INFINITE = "infinite"            # keep scrolling until no new content
    PAGINATED = "paginated"          # click next/pagination buttons
    VIEWPORT = "viewport"            # capture only visible content


@dataclass
class PageConfig:
    scroll_strategy: ScrollStrategy = ScrollStrategy.FULL_PAGE
    scroll_step_px: int = 800            # pixels per scroll step
    scroll_pause_ms: int = 500           # wait for lazy content
    max_scrolls: int = 200               # safety limit
    mutation_timeout_ms: int = 3000      # how long to wait for DOM mutations
    extract_selectors: list = field(default_factory=list)  # CSS selectors to extract
    ignore_selectors: list = field(default_factory=lambda: [
        "nav", "footer", ".cookie-banner", ".modal-backdrop",
        "[aria-hidden='true']", ".ad", ".advertisement",
    ])


# ---- JavaScript injection snippets ----

OBSERVER_INJECT = """
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
"""

CHECK_MUTATIONS = """
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
"""

SCROLL_BY = """
(() => {{
    window.scrollBy({{ top: {step}, behavior: 'smooth' }});
    return JSON.stringify({{
        scrollY: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
    }});
}})()
"""

EXTRACT_TEXT = """
(() => {{
    const ignore = {ignore_json};
    const selectors = {select_json};

    function isVisible(el) {{
        const style = getComputedStyle(el);
        return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0';
    }}

    function shouldIgnore(el) {{
        return ignore.some(sel => el.closest(sel));
    }}

    let targets;
    if (selectors.length > 0) {{
        targets = Array.from(document.querySelectorAll(selectors.join(',')));
    }} else {{
        targets = [document.body];
    }}

    const chunks = [];
    for (const target of targets) {{
        if (!shouldIgnore(target) && isVisible(target)) {{
            chunks.push(target.innerText.trim());
        }}
    }}

    return chunks.join('\\n---\\n');
}})()
"""


@dataclass
class PageState:
    """Tracks the state of page automation."""
    url: str = ""
    scroll_position: int = 0
    scroll_height: int = 0
    at_bottom: bool = False
    content_chunks: list = field(default_factory=list)
    scroll_count: int = 0
    mutations_observed: int = 0


class PageAutomator:
    """
    Automates scrolling and extraction for SPAs.

    Requires a JS executor -- either:
      - MCP javascript_tool (browser extension)
      - Playwright page.evaluate
      - Selenium driver.execute_script

    Pass the executor as js_fn(script) -> result.
    """

    def __init__(
        self,
        js_fn: Callable[[str], Any],
        config: PageConfig | None = None,
        wait_fn: Callable[[float], None] | None = None,
    ):
        self.js = js_fn
        self.config = config or PageConfig()
        self.wait = wait_fn or (lambda s: time.sleep(s))

    def attach_observer(self) -> str:
        """Inject the mutation observer into the page."""
        return str(self.js(OBSERVER_INJECT))

    def check_state(self) -> dict:
        """Check current scroll position and pending mutations."""
        raw = self.js(CHECK_MUTATIONS)
        state: dict = json.loads(raw) if isinstance(raw, str) else raw
        return state

    def scroll_step(self) -> dict:
        """Scroll down one step."""
        script = SCROLL_BY.format(step=self.config.scroll_step_px)
        raw = self.js(script)
        self.wait(self.config.scroll_pause_ms / 1000.0)
        position: dict = json.loads(raw) if isinstance(raw, str) else raw
        return position

    def extract_content(self) -> str:
        """Extract text content from the current viewport/page."""
        script = EXTRACT_TEXT.format(
            ignore_json=json.dumps(self.config.ignore_selectors),
            select_json=json.dumps(self.config.extract_selectors),
        )
        return str(self.js(script))

    def full_scroll_and_extract(self) -> PageState:
        """
        The main automation: scroll from top to bottom,
        extracting content along the way.

        For infinite scroll pages, keeps going until no new content appears.
        """
        state = PageState()

        # attach observer
        self.attach_observer()
        self.wait(0.5)

        # scroll to top first
        self.js("window.scrollTo(0, 0)")
        self.wait(0.3)

        # extract initial content
        initial = self.extract_content()
        if initial:
            state.content_chunks.append(initial)

        while state.scroll_count < self.config.max_scrolls:
            # scroll down
            self.scroll_step()
            state.scroll_count += 1

            # check state
            page_state = self.check_state()
            state.scroll_position = page_state.get("scroll_top", 0)
            state.scroll_height = page_state.get("scroll_height", 0)
            state.at_bottom = page_state.get("at_bottom", False)
            state.mutations_observed += page_state.get("mutation_count", 0)

            # extract new content from current viewport
            chunk = self.extract_content()
            if chunk and chunk not in state.content_chunks[-3:]:  # dedup recent
                state.content_chunks.append(chunk)

            # check termination
            if self.config.scroll_strategy == ScrollStrategy.FULL_PAGE:
                if state.at_bottom:
                    break

            elif self.config.scroll_strategy == ScrollStrategy.INFINITE:
                if state.at_bottom:
                    # wait a bit for potential lazy load
                    self.wait(self.config.mutation_timeout_ms / 1000.0)
                    recheck = self.check_state()
                    if not recheck.get("height_changed", False):
                        break  # no new content loaded

        return state
