"""
OMA GUI - Native graphical application.

Strategy:
  1. Try pywebview for a native window wrapping the web dashboard (best on macOS)
  2. Fall back to launching the web dashboard in the default browser

The web dashboard (gui/web.py) is the actual UI -- this module just
provides the native window wrapper around it.

On macOS, pywebview gives a proper app window with native title bar.
On Linux/Windows, falls back to browser since pywebview dependencies
can be harder to install.
"""

import os
import sys
import threading
import time


def _find_free_port(start: int = 8384) -> int:
    """Find an available port starting from the given number."""
    import socket
    for port in range(start, start + 100):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(("127.0.0.1", port))
            s.close()
            return port
        except OSError:
            continue
    return start


def _start_server(port: int) -> threading.Thread:
    """Start the web dashboard server in a background thread."""
    from oma.gui.web import run_web

    def serve():
        run_web(host="127.0.0.1", port=port, open_browser=False)

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    return t


def _wait_for_server(port: int, timeout: float = 10.0) -> bool:
    """Wait for the server to be ready."""
    import urllib.error
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1)
            return True
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.1)
    return False


def run_native(port: int | None = None):
    """
    Launch OMA in a native window using pywebview.

    Falls back to browser if pywebview is not available.
    """
    if port is None:
        port = _find_free_port()

    # start the web server
    _start_server(port)

    if not _wait_for_server(port):
        print("ERROR: Dashboard server failed to start")
        sys.exit(1)

    url = f"http://127.0.0.1:{port}"

    # try pywebview for native window
    try:
        import webview

        webview.create_window(
            "OMA - Open Multi Agent",
            url,
            width=1100,
            height=750,
            min_size=(800, 500),
            text_select=True,
        )
        webview.start(
            debug=os.environ.get("OMA_DEBUG") == "1",
            gui="cef" if sys.platform == "win32" else None,
        )
        return

    except ImportError:
        pass
    except Exception as e:
        print(f"pywebview failed ({e}), falling back to browser")

    # fallback: open in default browser
    import webbrowser
    print(f"OMA Dashboard: {url}")
    webbrowser.open(url)

    # keep the main thread alive
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass


def main():
    """Entry point for `oma gui` and the `oma-gui` script."""
    run_native()


if __name__ == "__main__":
    main()
