#!/usr/bin/env python3
"""Always-on dual-stream capture.

Records two streams separately and never mixes them:

    mic       what you said
    loopback  what came out of the speakers - everyone else on the call

That separation is the single most useful decision in the capture design. It
gives speaker attribution for free, with no diarization model and no
misattributed quotes, and it works whether or not the tenant ever allows Teams
transcripts, because nothing has to join the meeting.

Raw audio is written continuously and trimmed later by process.py rather than
gated live by a VAD. A VAD bug then costs a bloated file; live gating would cost
the first three seconds of every sentence, which is where people say the thing
that matters.

Controls, because always-on is only tolerable with an off switch that does not
depend on the rest of the system working:

    pa mic pause 30      writes the pause file; capture stops within a second
    pa mic on            removes it

The pause file stops *capture*, not merely transcription. A paused recorder
holds no device handle at all.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import soundcard as sc
import soundfile as sf

# soundcard warns on every dropped block ("data discontinuity in recording").
# On an always-on recorder that is a warning per few seconds, forever, and it
# says nothing actionable: a dropped block is a few milliseconds of audio, and
# the pass that reads these files measures silence rather than counting samples.
warnings.filterwarnings("ignore", category=sc.SoundcardRuntimeWarning)

SAMPLE_RATE = int(os.environ.get("PA_AUDIO_SAMPLE_RATE", "16000"))
BLOCK = 4096
ROLL_MINUTES = int(os.environ.get("PA_AUDIO_ROLL_MINUTES", "60"))


def log(msg: str) -> None:
    print(f"{dt.datetime.now().isoformat(timespec='seconds')} [capture] {msg}", flush=True)


def paused(pause_file: str) -> bool:
    """True while the pause file exists and its timestamp is in the future.

    An expired pause file is treated as "on" rather than deleted here: deleting
    it is `pa mic on`'s job, and a capture process that quietly re-armed itself
    by editing state would be exactly the wrong instinct in this module.
    """
    if not os.path.exists(pause_file):
        return False
    try:
        with open(pause_file, "r", encoding="utf-8") as fh:
            until = fh.read().strip()
        if not until:
            return True
        return dt.datetime.fromisoformat(until.replace("Z", "+00:00")) > dt.datetime.now(dt.timezone.utc)
    except (OSError, ValueError):
        # An unreadable pause file means someone asked for silence in a way we
        # cannot parse. Honour the request.
        return True


def recorder_for(stream: str):
    """Opens the device and returns (recorder_context, device_name).

    Loopback follows the *default output device*, so switching to headphones
    mid-call changes which device we must be recording. The name is returned so
    the caller can notice the change and reopen.
    """
    if stream == "loopback":
        speaker = sc.default_speaker()
        device = sc.get_microphone(id=str(speaker.name), include_loopback=True)
        return device, speaker.name
    device = sc.default_microphone()
    return device, device.name


def slot_path(spool: str, stream: str, when: dt.datetime) -> str:
    stamp = when.strftime("%Y%m%dT%H%M")
    directory = os.path.join(spool, stream)
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, f"{stamp}.wav")


def slot_start(now: dt.datetime) -> dt.datetime:
    """Rounds down to the roll boundary so both streams land in aligned files."""
    minutes = (now.minute // ROLL_MINUTES) * ROLL_MINUTES if ROLL_MINUTES < 60 else 0
    return now.replace(minute=minutes, second=0, microsecond=0)


def finish(path: str) -> None:
    """Marks a rolled file complete. process.py only touches files with this."""
    if os.path.exists(path):
        with open(path + ".done", "w", encoding="utf-8") as fh:
            fh.write(dt.datetime.now(dt.timezone.utc).isoformat())


def run(stream: str, spool: str, pause_file: str) -> int:
    log(f"stream={stream} spool={spool} rate={SAMPLE_RATE} roll={ROLL_MINUTES}m")
    current_slot: dt.datetime | None = None
    current_path: str | None = None
    writer: sf.SoundFile | None = None
    device_name: str | None = None

    def close_writer():
        nonlocal writer, current_path, current_slot
        if writer is not None:
            writer.close()
            writer = None
        if current_path:
            finish(current_path)
        current_path = None
        current_slot = None

    while True:
        if paused(pause_file):
            if writer is not None:
                log("paused — releasing the device")
                close_writer()
            time.sleep(1.0)
            continue

        try:
            device, name = recorder_for(stream)
            if device_name is not None and name != device_name:
                log(f"output device changed: {device_name} -> {name}")
                close_writer()
            device_name = name

            with device.recorder(samplerate=SAMPLE_RATE, channels=1, blocksize=BLOCK) as rec:
                log(f"recording from {name}")
                while not paused(pause_file):
                    data = rec.record(numframes=SAMPLE_RATE)  # one second
                    now = dt.datetime.now()
                    slot = slot_start(now)

                    if slot != current_slot:
                        close_writer()
                        current_slot = slot
                        current_path = slot_path(spool, stream, slot)
                        writer = sf.SoundFile(
                            current_path, mode="w", samplerate=SAMPLE_RATE,
                            channels=1, subtype="PCM_16",
                        )
                        log(f"rolled to {os.path.basename(current_path)}")

                    mono = np.asarray(data, dtype="float32").reshape(-1)
                    writer.write(mono)
                    writer.flush()

                    # The default output device can change without an error
                    # being raised on the open stream; a headphone switch
                    # mid-call would otherwise record silence for an hour.
                    if stream == "loopback":
                        try:
                            if str(sc.default_speaker().name) != device_name:
                                break
                        except Exception:  # noqa: BLE001 - device enumeration is flaky mid-switch
                            pass

        except KeyboardInterrupt:
            close_writer()
            log("stopped")
            return 0
        except Exception as exc:  # noqa: BLE001 - any device error should retry, not exit
            log(f"device error: {exc!r} — retrying in 5s")
            close_writer()
            device_name = None
            time.sleep(5.0)


def main() -> int:
    parser = argparse.ArgumentParser(description="Always-on audio capture (one process per stream)")
    parser.add_argument("--stream", choices=["mic", "loopback"], required=True)
    parser.add_argument("--spool", default=os.environ.get("PA_AUDIO_DIR"))
    parser.add_argument("--pause-file", default=os.environ.get("PA_AUDIO_PAUSE_FILE"))
    args = parser.parse_args()

    spool = args.spool or os.path.join(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "personal-assistant", "audio"
    )
    pause_file = args.pause_file or os.path.join(os.path.dirname(spool), "audio.paused")
    os.makedirs(spool, exist_ok=True)
    return run(args.stream, spool, pause_file)


if __name__ == "__main__":
    sys.exit(main())
