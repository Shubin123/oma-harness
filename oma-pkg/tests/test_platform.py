"""
Cross-platform behaviour tests.

Credential storage and pixel automation are the two places where the harness
touches the operating system directly, so they are also the two places where
Windows and POSIX diverge. These tests pin the behaviour that has to hold on
every platform, plus the Windows-only backend where it can run.
"""

import struct

import pytest

from oma import platform_compat
from oma.automation import pixel
from tests.conftest import assert_owner_only, loosen_permissions

pytestmark = pytest.mark.unit


class TestMachineIdentity:
    def test_machine_id_is_stable_and_non_empty(self):
        first = platform_compat.machine_id()
        assert first
        assert first == platform_compat.machine_id()

    def test_current_user_is_reported(self):
        assert platform_compat.current_user()


class TestOwnerOnlyPaths:
    def test_private_dir_is_owner_only(self, tmp_path):
        target = tmp_path / "nested" / "store"
        created = platform_compat.make_private_dir(target)
        assert created.is_dir()
        assert_owner_only(target)

    def test_restrict_to_owner_locks_down_a_shared_file(self, tmp_path):
        path = tmp_path / "creds.json"
        path.write_text("secret")
        loosen_permissions(path)
        assert not platform_compat.is_owner_only(path)

        assert platform_compat.restrict_to_owner(path) is True
        assert platform_compat.is_owner_only(path)

    def test_restrict_to_owner_reports_missing_paths(self, tmp_path):
        assert platform_compat.restrict_to_owner(tmp_path / "absent") is False
        assert platform_compat.is_owner_only(tmp_path / "absent") is False
        assert platform_compat.describe_permissions(tmp_path / "absent") is None

    def test_description_matches_the_documented_expectation(self, tmp_path):
        path = tmp_path / "creds.json"
        path.write_text("secret")
        platform_compat.restrict_to_owner(path)
        assert platform_compat.describe_permissions(path) == \
            platform_compat.expected_permissions(is_dir=False)
        assert platform_compat.describe_permissions(tmp_path) == \
            platform_compat.expected_permissions(is_dir=True)


class TestPixelAutomationDispatch:
    def test_delegate_takes_priority_over_native_commands(self):
        calls = []

        def delegate(action, **kwargs):
            calls.append((action, kwargs))
            return "delegated.png"

        automator = pixel.PixelAutomator(mcp_delegate=delegate)
        assert automator.capture() == "delegated.png"
        automator.click(pixel.ClickTarget(x=1, y=2))
        automator.type_text(pixel.TypeAction(text="hi"))
        automator.key("ctrl+c")
        assert [c[0] for c in calls] == ["screenshot", "click", "type", "key"]

    @pytest.mark.parametrize("method,args", [
        ("capture", ()),
        ("click", (pixel.ClickTarget(x=0, y=0),)),
        ("type_text", (pixel.TypeAction(text="x"),)),
        ("key", ("ctrl+c",)),
    ])
    def test_unknown_platform_fails_loudly(self, method, args):
        """A silent no-op would look like automation that ran and did nothing."""
        automator = pixel.PixelAutomator()
        automator.system = "Plan9"
        with pytest.raises(RuntimeError, match="unsupported platform"):
            getattr(automator, method)(*args)


class TestWin32Backend:
    """The PNG encoder and combo parser are pure, so they run everywhere."""

    def test_png_encoding_round_trips_dimensions_and_pixels(self):
        from oma.automation import win32

        # One red and one blue pixel, in the BGRA order GDI hands back.
        bgra = bytes([0, 0, 255, 255]) + bytes([255, 0, 0, 255])
        png = win32.encode_png(2, 1, bgra)

        assert png[:8] == b"\x89PNG\r\n\x1a\n"
        width, height = struct.unpack(">II", png[16:24])
        assert (width, height) == (2, 1)

        import zlib
        start = png.index(b"IDAT") + 4
        length = struct.unpack(">I", png[start - 8:start - 4])[0]
        raw = zlib.decompress(png[start:start + length])
        # filter byte, then RGBA for each pixel
        assert raw == bytes([0, 255, 0, 0, 255, 0, 0, 255, 255])

    @pytest.mark.parametrize("combo,expected", [
        ("enter", ([], 0x0D)),
        ("ctrl+shift+f5", ([0x11, 0x10], 0x74)),
        ("alt+tab", ([0x12], 0x09)),
    ])
    def test_named_combos_parse_without_a_keyboard_layout(self, combo, expected):
        from oma.automation import win32

        assert win32.parse_combo(combo) == expected

    @pytest.mark.parametrize("combo", ["", "ctrl+nosuchkey", "hyper+c"])
    def test_unparseable_combos_are_rejected(self, combo):
        from oma.automation import win32

        with pytest.raises(ValueError):
            win32.parse_combo(combo)

    @pytest.mark.skipif(not platform_compat.IS_WINDOWS, reason="needs user32")
    def test_virtual_screen_has_a_positive_size(self):
        from oma.automation import win32

        _, _, width, height = win32.virtual_screen()
        assert width > 0 and height > 0

    @pytest.mark.skipif(not platform_compat.IS_WINDOWS, reason="needs a desktop")
    def test_capture_writes_a_png_of_the_requested_region(self, tmp_path):
        from oma.automation import win32

        path = win32.capture(str(tmp_path / "shot.png"),
                             pixel.ScreenRegion(x=0, y=0, width=32, height=16))
        data = open(path, "rb").read()
        assert data[:8] == b"\x89PNG\r\n\x1a\n"
        assert struct.unpack(">II", data[16:24]) == (32, 16)
