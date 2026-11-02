"""Where capture and processing find the spool when nobody passes --spool.

The same default as the worker's (src/platform: `defaults.dataDir`): under
%LOCALAPPDATA% on Windows, under $XDG_DATA_HOME (~/.local/share) elsewhere.
The installers always pass PA_AUDIO_DIR, so this only matters by hand.
"""
from __future__ import annotations

import os
import sys


def data_dir() -> str:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "personal-assistant")


def default_spool() -> str:
    return os.path.join(data_dir(), "audio")
