# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for OMA - Open Multi Agent
# Builds a single-file executable with GUI and web dashboard bundled.
#
# Build with:  pyinstaller oma.spec --clean --noconfirm
# Override arch with:  OMA_TARGET_ARCH=universal2 pyinstaller oma.spec ...

import os
import sys

IS_MACOS = sys.platform == "darwin"
IS_WINDOWS = os.name == "nt"

# `strip` is a binutils tool: it exists on Linux, is absent on Windows (where
# PyInstaller then logs a traceback per collected binary), and mangles Mach-O
# load commands on macOS, after which install_name_tool fails with
# "malformed object".
STRIP = not IS_MACOS and not IS_WINDOWS

# UPX corrupts macOS binaries and invalidates the ad-hoc signature, and packed
# executables trip antivirus heuristics on Windows. Opt in explicitly.
USE_UPX = os.environ.get("OMA_USE_UPX") == "1"

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
        'oma.platform_compat',
        'oma.core',
        'oma.core.loop',
        'oma.core.criteria',
        'oma.core.sanitize',
        'oma.core.edge',
        'oma.core.router',
        'oma.core.tiers',
        'oma.core.omniroute_bridge',
        'oma.providers',
        'oma.providers.base',
        'oma.providers.catalog',
        'oma.providers.registry',
        'oma.providers.http_providers',
        'oma.providers.auth',
        'oma.providers.subscription',
        'oma.automation',
        'oma.automation.memory',
        'oma.automation.page',
        'oma.automation.pixel',
        'oma.automation.win32',
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
        'time',
        'random',
        'math',
        'statistics',
        'collections',
        'dataclasses',
        'enum',
        'typing',
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
    strip=STRIP,
    upx=USE_UPX,
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
