# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for OMA - Open Multi Agent
# Builds a single-file executable with GUI and web dashboard bundled.
#
# Build with:  pyinstaller oma.spec --clean --noconfirm
# Override arch with:  OMA_TARGET_ARCH=universal2 pyinstaller oma.spec ...

import os
import sys

IS_MACOS = sys.platform == "darwin"

# 'universal2' needs a universal2 CPython (python.org build); default to the host arch.
TARGET_ARCH = os.environ.get("OMA_TARGET_ARCH") or None
CODESIGN_IDENTITY = os.environ.get("OMA_CODESIGN_IDENTITY") or None

a = Analysis(
    ['src/oma/cli.py'],
    pathex=['src'],
    binaries=[],
    datas=[],
    hiddenimports=[
        'oma',
        'oma.agent',
        'oma.cli',
        'oma.core',
        'oma.core.loop',
        'oma.core.criteria',
        'oma.core.sanitize',
        'oma.core.edge',
        'oma.providers',
        'oma.providers.base',
        'oma.providers.registry',
        'oma.providers.http_providers',
        'oma.providers.auth',
        'oma.providers.subscription',
        'oma.automation',
        'oma.automation.memory',
        'oma.automation.page',
        'oma.automation.pixel',
        'oma.gui',
        'oma.gui.app',
        'oma.gui.web',
        'json',
        'hashlib',
        'uuid',
        'urllib.request',
        'urllib.error',
        'urllib.parse',
        'http.server',
        'threading',
        'webbrowser',
        'pathlib',
        'getpass',
        'socket',
        'base64',
        'secrets',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib',
        'numpy',
        'pandas',
        'scipy',
        'PIL',
        'cv2',
        'torch',
        'tensorflow',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='oma',
    debug=False,
    bootloader_ignore_signals=False,
    # `strip` mangles Mach-O load commands, after which PyInstaller's own
    # install_name_tool pass fails with "malformed object". Never strip on macOS.
    strip=not IS_MACOS,
    # UPX corrupts macOS binaries and invalidates the ad-hoc signature.
    upx=not IS_MACOS,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    # argv_emulation is for Finder drag-and-drop onto an .app bundle; on a
    # console CLI it pulls in AppKit and stalls startup waiting for Apple events.
    argv_emulation=False,
    target_arch=TARGET_ARCH,
    codesign_identity=CODESIGN_IDENTITY,
    entitlements_file=None,
    icon=None,
)
