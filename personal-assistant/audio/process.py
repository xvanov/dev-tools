#!/usr/bin/env python3
"""Hourly pass: trim the silence, group what is left, transcribe it.

Runs over completed capture files (those with a `.done` marker) and turns each
into zero or more JSON sidecars, one per speech group. The Node side reads those
sidecars, pairs the mic and loopback groups that overlap in time into episodes,
and writes them to the store — so the audio-shaped work stays here and the
storage-shaped work stays there.

The VAD is energy-based against a measured noise floor rather than a trained
model. That is a deliberate limit: this is not trying to decide *whether speech
is present*, only *where the silence is*, and getting that slightly wrong costs
a few extra seconds of room tone in a transcript. A trained VAD would be another
dependency and another thing to install on a machine where the audio stack
already has enough moving parts.

Transcription reuses voice-dictation's always-warm faster-whisper server over
its TCP protocol: send an absolute path, read text back. No second model, no
second install, no GPU contention with the dictation hotkey.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import socket
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf

FRAME_MS = 30
PREROLL_S = 1.5
MIN_SPEECH_S = 0.6
MERGE_GAP_S = 0.7
GROUP_GAP_S = int(os.environ.get("PA_AUDIO_EPISODE_GAP_SECONDS", "90"))
MIN_GROUP_SPEECH_S = 3.0

TRANSCRIBE_HOST = os.environ.get("PA_TRANSCRIBE_HOST", "127.0.0.1")
TRANSCRIBE_PORT = int(os.environ.get("PA_TRANSCRIBE_PORT", "47821"))


def log(msg: str) -> None:
    print(f"{dt.datetime.now().isoformat(timespec='seconds')} [process] {msg}", flush=True)


def speech_runs(samples: np.ndarray, rate: int) -> list[tuple[float, float]]:
    """Returns [(start_s, end_s)] of speech, measured against the noise floor.

    The threshold is relative because the floor differs by an order of magnitude
    between a laptop mic in a quiet room and a headset on a call. A fixed one
    either keeps every hum or drops every quiet sentence.
    """
    frame = int(rate * FRAME_MS / 1000)
    if len(samples) < frame:
        return []

    usable = len(samples) - (len(samples) % frame)
    frames = samples[:usable].reshape(-1, frame)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1))
    if not len(rms):
        return []

    floor = float(np.percentile(rms, 20))
    peak = float(np.percentile(rms, 99))
    # An hour of near-silence has a floor and a peak that are both nothing.
    if peak < 1e-4:
        return []
    threshold = max(floor * 3.0, peak * 0.06, 1e-4)

    loud = rms > threshold
    runs: list[tuple[float, float]] = []
    start = None
    for i, is_loud in enumerate(loud):
        if is_loud and start is None:
            start = i
        elif not is_loud and start is not None:
            runs.append((start * FRAME_MS / 1000, i * FRAME_MS / 1000))
            start = None
    if start is not None:
        runs.append((start * FRAME_MS / 1000, len(loud) * FRAME_MS / 1000))

    # Merge runs separated by less than a breath, then drop the ones too short
    # to be a word. Order matters: merging first rescues a stuttered sentence
    # that filtering first would throw away in pieces.
    merged: list[list[float]] = []
    for start_s, end_s in runs:
        if merged and start_s - merged[-1][1] <= MERGE_GAP_S:
            merged[-1][1] = end_s
        else:
            merged.append([start_s, end_s])

    return [
        (max(0.0, s - PREROLL_S), e)
        for s, e in merged
        if e - s >= MIN_SPEECH_S
    ]


def group_runs(runs: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    """Splits speech into conversation-sized groups on long silences."""
    groups: list[list[tuple[float, float]]] = []
    for run in runs:
        if groups and run[0] - groups[-1][-1][1] <= GROUP_GAP_S:
            groups[-1].append(run)
        else:
            groups.append([run])
    return groups


def transcribe(path: str) -> str:
    """voice-dictation's transcribe_server protocol: send a path, read text."""
    try:
        with socket.create_connection((TRANSCRIBE_HOST, TRANSCRIBE_PORT), timeout=900) as s:
            s.sendall(os.path.abspath(path).encode("utf-8"))
            s.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                buf = s.recv(65536)
                if not buf:
                    break
                chunks.append(buf)
        text = b"".join(chunks).decode("utf-8", errors="replace")
        if text.startswith("ERROR:"):
            log(f"transcription error: {text[:200]}")
            return ""
        return text.strip()
    except OSError as exc:
        log(f"transcribe server unreachable on {TRANSCRIBE_HOST}:{TRANSCRIBE_PORT} ({exc})")
        return ""


def file_started_at(path: str) -> dt.datetime:
    """Capture names files by their slot start; fall back to mtime."""
    stem = os.path.splitext(os.path.basename(path))[0]
    try:
        return dt.datetime.strptime(stem, "%Y%m%dT%H%M").astimezone()
    except ValueError:
        return dt.datetime.fromtimestamp(os.path.getmtime(path)).astimezone()


def process_file(path: str, stream: str, keep_raw_hours: int) -> int:
    data, rate = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)

    started = file_started_at(path)
    runs = speech_runs(data, rate)
    groups = group_runs(runs)
    written = 0

    for group in groups:
        speech_seconds = sum(e - s for s, e in group)
        if speech_seconds < MIN_GROUP_SPEECH_S:
            continue

        pieces = [data[int(s * rate) : int(e * rate)] for s, e in group]
        trimmed = np.concatenate(pieces) if pieces else np.zeros(0, dtype="float32")

        group_start = started + dt.timedelta(seconds=group[0][0])
        group_end = started + dt.timedelta(seconds=group[-1][1])
        stamp = group_start.strftime("%Y%m%dT%H%M%S")
        out_wav = os.path.join(os.path.dirname(path), f"{stamp}-{stream}.speech.wav")
        sf.write(out_wav, trimmed, rate, subtype="PCM_16")

        text = transcribe(out_wav)

        sidecar = {
            "stream": stream,
            "started_at": group_start.isoformat(),
            "ended_at": group_end.isoformat(),
            "speech_seconds": round(speech_seconds, 1),
            "audio_path": out_wav,
            "source_file": path,
            "transcript": text,
            "segments": [
                {
                    "start": (started + dt.timedelta(seconds=s)).isoformat(),
                    "end": (started + dt.timedelta(seconds=e)).isoformat(),
                }
                for s, e in group
            ],
        }
        with open(out_wav.replace(".wav", ".json"), "w", encoding="utf-8") as fh:
            json.dump(sidecar, fh, indent=1)
        written += 1
        log(f"{os.path.basename(out_wav)} — {speech_seconds:.0f}s speech, {len(text)} chars")

    # The raw hour is the only thing here that is genuinely big. Once it has
    # been trimmed there is nothing in it the trimmed copy lacks except silence.
    age_hours = (dt.datetime.now().astimezone() - started).total_seconds() / 3600
    if age_hours >= keep_raw_hours:
        os.remove(path)
        for marker in (path + ".done",):
            if os.path.exists(marker):
                os.remove(marker)
        log(f"removed raw {os.path.basename(path)} ({age_hours:.1f}h old)")

    return written


def main() -> int:
    parser = argparse.ArgumentParser(description="Trim, group and transcribe captured audio")
    parser.add_argument("--spool", default=os.environ.get("PA_AUDIO_DIR"))
    parser.add_argument(
        "--keep-raw-hours",
        type=int,
        default=int(os.environ.get("PA_RETENTION_RAW_AUDIO_HOURS", "6")),
    )
    args = parser.parse_args()

    spool = args.spool or os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "personal-assistant", "audio"
    )

    total = 0
    for stream in ("mic", "loopback"):
        directory = os.path.join(spool, stream)
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if not name.endswith(".wav") or name.endswith(".speech.wav"):
                continue
            path = os.path.join(directory, name)
            # Only complete files. A file still being written would be trimmed
            # to whatever had reached the disk.
            if not os.path.exists(path + ".done"):
                continue
            if os.path.exists(path.replace(".wav", ".processed")):
                continue
            try:
                total += process_file(path, stream, args.keep_raw_hours)
                with open(path.replace(".wav", ".processed"), "w", encoding="utf-8") as fh:
                    fh.write(dt.datetime.now(dt.timezone.utc).isoformat())
            except Exception as exc:  # noqa: BLE001 - one bad file must not stop the pass
                log(f"failed on {name}: {exc!r}")

    log(f"wrote {total} speech group(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
