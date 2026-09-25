"""
Tests for OMA Page-Level Automation (SPA scroll, observe, and extract).
"""

import json
from unittest.mock import MagicMock

import pytest

from oma.automation.page import (
    PageAutomator,
    PageConfig,
    PageState,
    ScrollStrategy,
)


def test_page_config_defaults():
    config = PageConfig()
    assert config.scroll_strategy == ScrollStrategy.FULL_PAGE
    assert config.scroll_step_px == 800
    assert config.scroll_pause_ms == 500
    assert config.max_scrolls == 200
    assert config.mutation_timeout_ms == 3000
    assert "nav" in config.ignore_selectors
    assert "footer" in config.ignore_selectors
    assert config.extract_selectors == []


def test_page_state_initialization():
    state = PageState()
    assert state.url == ""
    assert state.scroll_position == 0
    assert state.scroll_height == 0
    assert state.at_bottom is False
    assert state.content_chunks == []
    assert state.scroll_count == 0
    assert state.mutations_observed == 0


def test_attach_observer():
    js_mock = MagicMock(return_value="attached")
    automator = PageAutomator(js_fn=js_mock)

    res = automator.attach_observer()
    assert res == "attached"
    assert js_mock.call_count == 1
    call_arg = js_mock.call_args[0][0]
    assert "MutationObserver" in call_arg


def test_check_state_dict_and_str():
    # Test when js_fn returns dict directly
    js_dict = MagicMock(return_value={
        "mutation_count": 3,
        "height_changed": True,
        "scroll_height": 2400,
        "scroll_top": 800,
        "viewport_height": 800,
        "at_bottom": False,
    })
    automator = PageAutomator(js_fn=js_dict)
    state = automator.check_state()
    assert state["mutation_count"] == 3
    assert state["scroll_height"] == 2400

    # Test when js_fn returns json string
    js_str = MagicMock(return_value=json.dumps({
        "mutation_count": 0,
        "height_changed": False,
        "scroll_height": 2400,
        "scroll_top": 1600,
        "viewport_height": 800,
        "at_bottom": True,
    }))
    automator_str = PageAutomator(js_fn=js_str)
    state_str = automator_str.check_state()
    assert state_str["at_bottom"] is True


def test_scroll_step():
    js_mock = MagicMock(return_value=json.dumps({"scrollY": 800, "scrollHeight": 2000}))
    wait_mock = MagicMock()
    config = PageConfig(scroll_step_px=800, scroll_pause_ms=200)
    automator = PageAutomator(js_fn=js_mock, config=config, wait_fn=wait_mock)

    pos = automator.scroll_step()
    assert pos["scrollY"] == 800
    assert wait_mock.call_count == 1
    assert wait_mock.call_args[0][0] == 0.2


def test_extract_content():
    js_mock = MagicMock(return_value="Header text\n---\nMain paragraph")
    config = PageConfig(extract_selectors=["article", ".main"])
    automator = PageAutomator(js_fn=js_mock, config=config)

    content = automator.extract_content()
    assert "Header text" in content
    assert js_mock.call_count == 1
    script = js_mock.call_args[0][0]
    assert "article" in script
    assert ".main" in script


def test_full_scroll_and_extract_full_page():
    # Simulate a page that reaches bottom after 2 scroll steps
    calls = {"scroll_count": 0}

    def fake_js(script: str):
        if "MutationObserver" in script:
            return "attached"
        if "scrollTo(0, 0)" in script:
            return None
        if "scrollBy" in script:
            calls["scroll_count"] += 1
            return json.dumps({"scrollY": calls["scroll_count"] * 500, "scrollHeight": 1200})
        if "CHECK_MUTATIONS" in script or "mutation_count" in script:
            is_bottom = calls["scroll_count"] >= 2
            return json.dumps({
                "mutation_count": 2 if calls["scroll_count"] < 2 else 0,
                "height_changed": False,
                "scroll_height": 1200,
                "scroll_top": calls["scroll_count"] * 500,
                "viewport_height": 600,
                "at_bottom": is_bottom,
            })
        if "EXTRACT_TEXT" in script or "isVisible" in script:
            return f"Content chunk after step {calls['scroll_count']}"
        return ""

    wait_mock = MagicMock()
    config = PageConfig(
        scroll_strategy=ScrollStrategy.FULL_PAGE,
        scroll_step_px=500,
        max_scrolls=10,
    )
    automator = PageAutomator(js_fn=fake_js, config=config, wait_fn=wait_mock)

    state = automator.full_scroll_and_extract()
    assert state.scroll_count == 2
    assert state.at_bottom is True
    assert len(state.content_chunks) >= 2
    assert state.mutations_observed == 2


def test_full_scroll_and_extract_infinite():
    # Simulate infinite scroll where new content loads once, then stops
    state_step = {"count": 0, "infinite_loaded": False}

    check_calls = 0

    def fake_js(script: str):
        nonlocal check_calls
        if "MutationObserver" in script:
            return "attached"
        if "scrollTo(0, 0)" in script:
            return None
        if "scrollBy" in script:
            state_step["count"] += 1
            return json.dumps({"scrollY": state_step["count"] * 800, "scrollHeight": 2000})
        if "CHECK_MUTATIONS" in script or "mutation_count" in script:
            check_calls += 1
            if check_calls == 1:
                # First scroll, reached bottom of initial page
                return json.dumps({
                    "mutation_count": 0,
                    "height_changed": False,
                    "scroll_height": 1000,
                    "scroll_top": 800,
                    "viewport_height": 800,
                    "at_bottom": True,
                })
            elif check_calls == 2:
                # Recheck after pause: infinite content loaded!
                return json.dumps({
                    "mutation_count": 5,
                    "height_changed": True,
                    "scroll_height": 2000,
                    "scroll_top": 800,
                    "viewport_height": 800,
                    "at_bottom": False,
                })
            else:
                # Second scroll, reached bottom again and no more content
                return json.dumps({
                    "mutation_count": 0,
                    "height_changed": False,
                    "scroll_height": 2000,
                    "scroll_top": 1600,
                    "viewport_height": 800,
                    "at_bottom": True,
                })
        if "EXTRACT_TEXT" in script or "isVisible" in script:
            return f"Infinite chunk {state_step['count']}"
        return ""

    wait_mock = MagicMock()
    config = PageConfig(
        scroll_strategy=ScrollStrategy.INFINITE,
        max_scrolls=10,
        mutation_timeout_ms=100,
    )
    automator = PageAutomator(js_fn=fake_js, config=config, wait_fn=wait_mock)

    state = automator.full_scroll_and_extract()
    assert state.scroll_count == 2
    assert state.at_bottom is True
    assert len(state.content_chunks) >= 2


def test_full_scroll_deduplication():
    # Verify duplicate content chunks are not added repeatedly
    def fake_js(script: str):
        if "MutationObserver" in script or "scrollTo" in script:
            return ""
        if "scrollBy" in script:
            return "{}"
        if "mutation_count" in script:
            return json.dumps({"mutation_count": 0, "scroll_height": 1000, "scroll_top": 500, "at_bottom": True})
        if "isVisible" in script:
            return "Repeated Content"
        return ""

    config = PageConfig(scroll_strategy=ScrollStrategy.FULL_PAGE, max_scrolls=5)
    automator = PageAutomator(js_fn=fake_js, config=config, wait_fn=lambda _: None)
    state = automator.full_scroll_and_extract()

    # Initial extract + one scroll step returning identical content should not add duplicate
    assert state.content_chunks == ["Repeated Content"]
