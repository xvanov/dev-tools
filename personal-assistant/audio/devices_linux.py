"""Which audio devices matter on Linux, asked of PipeWire or PulseAudio.

The Linux half of two questions capture.py asks:

    which mic is the call using?   `pactl list source-outputs` — every
                                   recording stream, its source and its app
    what is "loopback"?            the default sink's monitor source: what the
                                   speakers play, everyone else on the call

`pactl` is PulseAudio's CLI and talks to PipeWire through pipewire-pulse just
the same, so this one path covers both sound servers. It is the counterpart of
the WASAPI session walk in capture.py (Windows) and of the pactl read in
src/platform/linux.js, which the worker's meeting gate uses for "is another app
on the mic?". The parsers are pure, take pactl's text, and are tested by
test/platform.test.js through `python3 -I` with fixtures.

Our own processes are not a call: Python (this recorder, voice-dictation),
level meters, and anything recording a monitor are left out.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess

_NOT_A_CALL_APP = re.compile(r"pavucontrol|pwvucontrol|plasma-pa|gnome-shell|gsd-media-keys|pipewire-pulse", re.I)
_PYTHON = re.compile(r"^python[0-9.]*$", re.I)


def parse_short_sources(text: str) -> dict[str, str]:
    """`pactl list short sources` -> {index: source name}."""
    out: dict[str, str] = {}
    for line in (text or "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].isdigit() and parts[1]:
            out[parts[0]] = parts[1]
    return out


def parse_source_outputs(text: str) -> list[dict]:
    """`pactl list source-outputs` (LC_ALL=C) -> [{index, source, corked, props}]."""
    outputs: list[dict] = []
    cur: dict | None = None
    in_props = False
    for raw in (text or "").splitlines():
        head = re.match(r"^Source Output #(\d+)", raw)
        if head:
            cur = {"index": head.group(1), "source": None, "corked": False, "props": {}}
            outputs.append(cur)
            in_props = False
            continue
        if cur is None:
            continue
        line = raw.strip()
        if line == "Properties:":
            in_props = True
            continue
        prop = re.match(r'^([a-z0-9_.-]+) = "(.*)"$', line, re.I)
        if in_props and prop:
            cur["props"][prop.group(1)] = prop.group(2)
            continue
        field = re.match(r"^([A-Za-z ]+): (.*)$", line)
        if field:
            in_props = False
            if field.group(1) == "Source":
                cur["source"] = field.group(2).strip()
            elif field.group(1) == "Corked":
                cur["corked"] = field.group(2).strip() == "yes"
    return outputs


def _not_a_call(output: dict, source_name: str | None) -> bool:
    props = output["props"]
    binary = props.get("application.process.binary", "")
    if _PYTHON.match(os.path.basename(binary)):
        return True
    if _NOT_A_CALL_APP.search(f"{binary} {props.get('application.id', '')}"):
        return True
    if re.search(r"peak detect", props.get("media.name", ""), re.I):
        return True
    if source_name and source_name.endswith(".monitor"):
        return True
    return False


def active_sources(source_outputs_text: str, short_sources_text: str) -> list[str]:
    """Pure: names of the sources (mics) another app is recording from now."""
    sources = parse_short_sources(short_sources_text)
    names: list[str] = []
    for out in parse_source_outputs(source_outputs_text):
        name = sources.get(out["source"] or "")
        if not name or _not_a_call(out, name):
            continue
        if name not in names:
            names.append(name)
    return names


def _pactl(*args: str) -> str:
    env = dict(os.environ, LC_ALL="C")
    return subprocess.run(
        ["pactl", *args], capture_output=True, text=True, timeout=10, env=env, check=False
    ).stdout


def active_capture_ids() -> list[str]:
    """Source names a non-Python process is recording from right now.

    Empty when pactl is missing: capture then falls back to PA_AUDIO_MIC and
    the default source, and `pa doctor` reports the missing tool.
    """
    if not shutil.which("pactl"):
        return []
    return active_sources(_pactl("list", "source-outputs"), _pactl("list", "short", "sources"))


def monitor_of(sink_id: str) -> str:
    """The monitor source of a sink: PulseAudio and pipewire-pulse both name
    it `<sink name>.monitor`."""
    return f"{sink_id}.monitor"
