"""
Windows pixel automation through user32/gdi32 directly.

The obvious implementation shells out to PowerShell, but Defender's AMSI
classifies `CopyFromScreen` scripts as screen-scraping malware and blocks them
with "This script contains malicious content" whenever PowerShell is launched
from a child process. Calling the same Win32 entry points through ctypes is
not subject to that, needs no third-party package, and is faster besides.

The screen and input entry points only work on Windows, but the module stays
importable everywhere: `ctypes.wintypes` is unavailable off Windows, so the
structures that need it are declared only when it loads. That keeps the pure
parts -- PNG encoding and key-combination parsing -- testable on any platform.
"""

import ctypes
import struct
import zlib
from typing import Any

wintypes: Any = None
try:
    from ctypes import wintypes
except (ImportError, ValueError):  # pragma: no cover - exercised off Windows
    pass

# --- GDI capture ---------------------------------------------------------

SRCCOPY = 0x00CC0020
CAPTUREBLT = 0x40000000
DIB_RGB_COLORS = 0
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

# --- input ---------------------------------------------------------------

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

MOUSE_BUTTONS = {
    "left": (0x0002, 0x0004),
    "right": (0x0008, 0x0010),
    "middle": (0x0020, 0x0040),
}

MODIFIER_KEYS = {
    "ctrl": 0x11, "control": 0x11,
    "alt": 0x12, "option": 0x12,
    "shift": 0x10,
    "win": 0x5B, "cmd": 0x5B, "super": 0x5B, "meta": 0x5B,
}

NAMED_KEYS = {
    "enter": 0x0D, "return": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B,
    "space": 0x20, "backspace": 0x08, "delete": 0x2E, "del": 0x2E,
    "insert": 0x2D, "home": 0x24, "end": 0x23, "pgup": 0x21, "pageup": 0x21,
    "pgdn": 0x22, "pagedown": 0x22, "up": 0x26, "down": 0x28,
    "left": 0x25, "right": 0x27, "capslock": 0x14, "printscreen": 0x2C,
}
NAMED_KEYS.update({f"f{n}": 0x6F + n for n in range(1, 13)})


# ctypes.wintypes is Windows-only, so the structures that build on it are
# declared only where they can be. Off Windows the entry points that use
# them raise before any structure is needed.
if wintypes is not None:
    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]


    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG), ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]


    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]


    class _INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


def _last_error() -> int:
    """
    The code from the last failing Win32 call.

    `ctypes.get_last_error` is defined only in Windows builds of the standard
    library, so it is looked up rather than called directly -- otherwise a
    type-checker running on Linux flags every use.
    """
    getter = getattr(ctypes, "get_last_error", None)
    return getter() if getter else 0


def _require_windows():
    if wintypes is None:
        raise RuntimeError("the Win32 automation backend only runs on Windows")


def _user32():
    _require_windows()
    return ctypes.WinDLL("user32", use_last_error=True)


def _gdi32():
    _require_windows()
    return ctypes.WinDLL("gdi32", use_last_error=True)


def encode_png(width: int, height: int, bgra: bytes) -> bytes:
    """
    Encode a top-down BGRA buffer as a PNG.

    Pure zlib and struct, so captures need no imaging library. GDI hands back
    rows in BGRA order, which PNG wants as RGBA.
    """
    stride = width * 4
    rows = bytearray()
    for y in range(height):
        pixels = bytearray(bgra[y * stride:(y + 1) * stride])
        pixels[0::4], pixels[2::4] = pixels[2::4], pixels[0::4]  # BGRA -> RGBA
        rows.append(0)  # filter type 0 (None) for this scanline
        rows.extend(pixels)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
        + chunk(b"IEND", b"")
    )


def virtual_screen() -> tuple:
    """(x, y, width, height) spanning every attached monitor."""
    user32 = _user32()
    user32.SetProcessDPIAware()
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


def capture(path: str, region=None) -> str:
    """BitBlt the screen (or `region`) into `path` as a PNG. Returns `path`."""
    user32, gdi32 = _user32(), _gdi32()

    if region is None:
        x, y, width, height = virtual_screen()
    else:
        x, y, width, height = region.x, region.y, region.width, region.height
    if width <= 0 or height <= 0:
        raise ValueError(f"invalid capture size: {width}x{height}")

    screen_dc = user32.GetDC(None)
    if not screen_dc:
        raise OSError("could not open a device context for the screen")

    mem_dc = bitmap = None
    try:
        mem_dc = gdi32.CreateCompatibleDC(screen_dc)
        bitmap = gdi32.CreateCompatibleBitmap(screen_dc, width, height)
        if not mem_dc or not bitmap:
            raise OSError("could not allocate a capture bitmap")
        gdi32.SelectObject(mem_dc, bitmap)

        # CAPTUREBLT includes layered windows, which is what a user sees.
        if not gdi32.BitBlt(mem_dc, 0, 0, width, height, screen_dc, x, y,
                            SRCCOPY | CAPTUREBLT):
            raise OSError(f"screen capture failed: {_last_error()}")

        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = width
        info.bmiHeader.biHeight = -height  # negative: top-down rows
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0  # BI_RGB

        buffer = ctypes.create_string_buffer(width * height * 4)
        if not gdi32.GetDIBits(mem_dc, bitmap, 0, height, buffer,
                               ctypes.byref(info), DIB_RGB_COLORS):
            raise OSError("could not read pixels out of the capture bitmap")

        with open(path, "wb") as f:
            f.write(encode_png(width, height, buffer.raw))
        return path
    finally:
        if bitmap:
            gdi32.DeleteObject(bitmap)
        if mem_dc:
            gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(None, screen_dc)


def _send(inputs) -> None:
    user32 = _user32()
    array = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        raise OSError(f"input was rejected by the system: {_last_error()}")


def _key_input(vk: int, scan: int, flags: int) -> "INPUT":
    return INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(
        ki=KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=None)
    ))


def click(x: int, y: int, button: str = "left", clicks: int = 1) -> None:
    """Move the pointer to (x, y) and click."""
    user32 = _user32()
    user32.SetProcessDPIAware()
    if not user32.SetCursorPos(int(x), int(y)):
        raise OSError(f"could not move the pointer: {_last_error()}")

    down, up = MOUSE_BUTTONS.get(button, MOUSE_BUTTONS["left"])
    events = []
    for _ in range(max(1, clicks)):
        for flag in (down, up):
            events.append(INPUT(type=INPUT_MOUSE, u=_INPUTUNION(
                mi=MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=flag,
                              time=0, dwExtraInfo=None)
            )))
    _send(events)


def type_text(text: str, delay_ms: int = 0) -> None:
    """
    Type `text` as Unicode key events.

    KEYEVENTF_UNICODE sends the character itself rather than a scan code, so
    the result does not depend on the active keyboard layout.
    """
    import time

    for ch in text:
        encoded = ch.encode("utf-16-le")
        # Characters outside the BMP arrive as a surrogate pair; both halves
        # have to be sent for the target app to reassemble them.
        for (unit,) in struct.iter_unpack("<H", encoded):
            _send([
                _key_input(0, unit, KEYEVENTF_UNICODE),
                _key_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ])
        if delay_ms:
            time.sleep(delay_ms / 1000.0)


def parse_combo(combo: str) -> tuple:
    """
    Split 'ctrl+shift+t' into ([modifier vks], key vk).

    Raises ValueError for anything that has no virtual-key equivalent, so a
    typo fails loudly instead of sending the wrong keystroke.
    """
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        raise ValueError("empty key combination")

    modifiers = []
    for part in parts[:-1]:
        if part not in MODIFIER_KEYS:
            raise ValueError(f"unknown modifier in key combination: {combo}")
        modifiers.append(MODIFIER_KEYS[part])

    key = parts[-1]
    if key in NAMED_KEYS:
        return modifiers, NAMED_KEYS[key]
    if key in MODIFIER_KEYS and not modifiers:
        return [], MODIFIER_KEYS[key]
    if len(key) == 1:
        vk = _user32().VkKeyScanW(ctypes.c_wchar(key))
        if vk == -1:
            raise ValueError(f"no key on this layout produces: {key}")
        return modifiers, vk & 0xFF
    raise ValueError(f"unknown key in combination: {combo}")


def press_combo(combo: str) -> None:
    """Press a combination such as 'ctrl+shift+t'."""
    modifiers, key = parse_combo(combo)
    events = [_key_input(vk, 0, 0) for vk in modifiers]
    events.append(_key_input(key, 0, 0))
    events.append(_key_input(key, 0, KEYEVENTF_KEYUP))
    events.extend(_key_input(vk, 0, KEYEVENTF_KEYUP) for vk in reversed(modifiers))
    _send(events)
