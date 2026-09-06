"""
OMA Pixel-Level Automation -- framebuffer capture, click, and key injection.

The lowest level of automation. Works with any UI, any app.
Approach:
  1. Capture the framebuffer (screenshot)
  2. Send to vision model for element detection
  3. Click or type at computed coordinates
  4. Capture again to verify state change

Platform support:
  - macOS: screencapture + cliclick / AppleScript
  - Linux: scrot/grim + xdotool/ydotool
  - Windows: PowerShell screen capture + SendKeys

When running inside a harness with browser tools (MCP computer_* tools),
delegates to those instead of raw commands.
"""

import subprocess
import platform
import tempfile
import time
import os
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass
class ScreenRegion:
    x: int
    y: int
    width: int
    height: int


@dataclass
class ClickTarget:
    x: int
    y: int
    button: str = "left"    # left, right, middle
    clicks: int = 1


@dataclass
class TypeAction:
    text: str
    delay_ms: int = 50      # inter-keystroke delay


class PixelAutomator:
    """
    Platform-aware pixel-level automation.

    For use outside of browser/MCP contexts.
    Inside those contexts, prefer the higher-level tools.
    """

    def __init__(self, mcp_delegate=None):
        """
        Args:
            mcp_delegate: if provided, a callable that accepts
                          (action, **kwargs) and delegates to MCP
                          computer_* tools instead of native commands.
        """
        self.system = platform.system()
        self.delegate = mcp_delegate

    def capture(self, region: Optional[ScreenRegion] = None) -> str:
        """
        Capture framebuffer to a temp PNG. Returns path.
        """
        if self.delegate:
            return self.delegate("screenshot", region=region)

        path = os.path.join(tempfile.gettempdir(), f"oma_capture_{int(time.time())}.png")

        if self.system == "Darwin":
            cmd = ["screencapture", "-x"]  # -x = no sound
            if region:
                cmd.extend(["-R", f"{region.x},{region.y},{region.width},{region.height}"])
            cmd.append(path)

        elif self.system == "Linux":
            if region:
                geom = f"{region.width}x{region.height}+{region.x}+{region.y}"
                cmd = ["grim", "-g", geom, path]
            else:
                cmd = ["grim", path]

        elif self.system == "Windows":
            # powershell screenshot
            ps = (
                f"Add-Type -AssemblyName System.Windows.Forms;"
                f"$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"
                f"$b = New-Object Drawing.Bitmap($s.Width,$s.Height);"
                f"$g = [Drawing.Graphics]::FromImage($b);"
                f"$g.CopyFromScreen($s.Location,[Drawing.Point]::Empty,$s.Size);"
                f"$b.Save('{path}')"
            )
            cmd = ["powershell", "-Command", ps]
        else:
            raise RuntimeError(f"unsupported platform: {self.system}")

        subprocess.run(cmd, check=True, capture_output=True, timeout=10)
        return path

    def click(self, target: ClickTarget):
        """Click at pixel coordinates."""
        if self.delegate:
            return self.delegate("click", x=target.x, y=target.y,
                                 button=target.button, clicks=target.clicks)

        if self.system == "Darwin":
            action = "c" if target.button == "left" else "rc"
            for _ in range(target.clicks):
                subprocess.run(
                    ["cliclick", f"{action}:{target.x},{target.y}"],
                    check=True, capture_output=True, timeout=5
                )

        elif self.system == "Linux":
            btn_map = {"left": "1", "right": "3", "middle": "2"}
            btn = btn_map.get(target.button, "1")
            subprocess.run(
                ["xdotool", "mousemove", str(target.x), str(target.y),
                 "click", "--repeat", str(target.clicks), btn],
                check=True, capture_output=True, timeout=5
            )

    def type_text(self, action: TypeAction):
        """Type text with inter-keystroke delay."""
        if self.delegate:
            return self.delegate("type", text=action.text)

        if self.system == "Darwin":
            subprocess.run(
                ["cliclick", f"t:{action.text}"],
                check=True, capture_output=True, timeout=30
            )

        elif self.system == "Linux":
            subprocess.run(
                ["xdotool", "type", "--delay", str(action.delay_ms), action.text],
                check=True, capture_output=True, timeout=30
            )

    def key(self, combo: str):
        """Press a key combination (e.g., 'cmd+c', 'ctrl+shift+t')."""
        if self.delegate:
            return self.delegate("key", combo=combo)

        if self.system == "Darwin":
            subprocess.run(
                ["cliclick", f"kp:{combo}"],
                check=True, capture_output=True, timeout=5
            )

        elif self.system == "Linux":
            subprocess.run(
                ["xdotool", "key", combo],
                check=True, capture_output=True, timeout=5
            )

    def wait_for_change(
        self,
        region: Optional[ScreenRegion] = None,
        timeout_s: float = 10.0,
        poll_interval_s: float = 0.5,
    ) -> bool:
        """
        Wait until the framebuffer changes in the given region.
        Returns True if a change was detected, False on timeout.
        """
        import hashlib

        baseline = self.capture(region)
        with open(baseline, "rb") as f:
            baseline_hash = hashlib.sha256(f.read()).hexdigest()

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            time.sleep(poll_interval_s)
            current = self.capture(region)
            with open(current, "rb") as f:
                current_hash = hashlib.sha256(f.read()).hexdigest()
            if current_hash != baseline_hash:
                return True

        return False
