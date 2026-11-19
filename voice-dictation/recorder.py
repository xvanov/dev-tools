#!/usr/bin/env python3
"""
Push-to-talk recorder: VAD auto-stop, live preview overlay, LLM cleanup, auto-paste.

Usage:
  python recorder.py                 # normal operation
  python recorder.py --list-devices  # print available input devices and exit

Device selection:
  Set VD_DEVICE env var to a device index (integer) or a substring of the device name.
  Example: set VD_DEVICE=Yeti  or  set VD_DEVICE=2
  Leave unset to use the Windows default input device.

IPC via flag files in the system temp directory:
  vd-cancel.flag  — cancel, discard recording (written by Esc hotkey / overlay)
  vd-stop.flag    — stop early and transcribe (written by 2nd hotkey press)
  vd-running.flag — holds the recorder's PID while it is active; the hotkey
                    scripts treat a flag whose PID is dead as stale

Diagnostics (recorder.log next to this file, VD_RECORDER_LOG to move it):
  every session logs its phases, timings and errors with tracebacks. A
  watchdog gives each phase a deadline; on expiry it logs every thread's stack,
  clears the flags and exits, so a hang can never leave the hotkey wedged.
  VD_WATCHDOG=0 disables it.
"""

import json
import os
import platform
import shutil
import socket
import sys
import tempfile
import threading
import time
import traceback

import numpy as np
import pyperclip
import sounddevice as sd
import soundfile as sf

SAMPLE_RATE = 16_000
CHANNELS = 1
DTYPE = "int16"
CHUNK_SECS = 0.1  # VAD resolution

SILENCE_THRESHOLD = float(os.environ.get("VD_SILENCE_THRESHOLD", "0.01"))
SILENCE_DURATION = float(os.environ.get("VD_SILENCE_DURATION", "2.0"))
MAX_DURATION = float(os.environ.get("VD_MAX_DURATION", "120.0"))

TRANSCRIBE_HOST = os.environ.get("TRANSCRIBE_HOST", "127.0.0.1")
TRANSCRIBE_PORT = int(os.environ.get("TRANSCRIBE_PORT", "47821"))

_TMP = tempfile.gettempdir()
CANCEL_FLAG = os.path.join(_TMP, "vd-cancel.flag")
STOP_FLAG = os.path.join(_TMP, "vd-stop.flag")
RUNNING_FLAG = os.path.join(_TMP, "vd-running.flag")
PREVIEW_WAV = os.path.join(_TMP, "vd-preview.wav")
FINAL_WAV = os.path.join(_TMP, "vd-final.wav")

IS_WINDOWS = platform.system() == "Windows"

LOG_PATH = os.environ.get(
    "VD_RECORDER_LOG",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "recorder.log"),
)
LOG_MAX_BYTES = 2 * 1024 * 1024
LOW_DISK_MB = int(os.environ.get("VD_LOW_DISK_MB", "500"))
WATCHDOG_ON = os.environ.get("VD_WATCHDOG", "1").strip() != "0"

# Per-phase deadlines (seconds). Each covers the phase's own timeouts with room
# to spare: transcription is a 60 s socket timeout, Claude cleanup 15 s (one
# retry), Ollama 20 s. "done" is the overlay's done state, where the user may
# browse history; past it the window is closed regardless.
PHASE_DEADLINES = {
    "starting": 30,
    "recording": MAX_DURATION + 30,
    "transcribing": 90,
    "cleanup": 45,
    "paste": 15,
    "done": 900,
    "closing": 15,
}


# ---------------------------------------------------------------------------
# Logging — the recorder runs under pythonw, where stderr goes nowhere, so an
# uncaught exception used to vanish and leave the overlay (and running flag)
# up forever. Everything worth knowing lands in recorder.log instead.
# ---------------------------------------------------------------------------

_SESSION = f"{os.getpid()}"
_log_lock = threading.Lock()


def log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} [{_SESSION}] {msg}"
    with _log_lock:
        try:
            if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
                os.replace(LOG_PATH, LOG_PATH + ".1")
            with open(LOG_PATH, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass  # a full disk can make logging fail too; never let it crash us


def log_exc(msg: str, exc: BaseException) -> None:
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).rstrip()
    log(f"{msg}: {exc!r} | {_disk_note()}\n{tb}")


def _free_mb(path: str = _TMP) -> int:
    try:
        return int(shutil.disk_usage(path).free // (1024 * 1024))
    except OSError:
        return -1


def _disk_note() -> str:
    return f"temp free={_free_mb()} MB"


def _short_error(exc: BaseException) -> str:
    """What the overlay shows for a pipeline failure."""
    if isinstance(exc, OSError) and (exc.errno == 28 or getattr(exc, "winerror", None) in (39, 112)):
        return "disk full — free space and retry"
    if "No space" in str(exc) or "disk full" in str(exc).lower():
        return "disk full — free space and retry"
    s = str(exc) or exc.__class__.__name__
    return s if len(s) <= 80 else s[:77] + "..."


def _thread_excepthook(args) -> None:
    log_exc(f"uncaught exception in thread {args.thread.name if args.thread else '?'}", args.exc_value)


def _stacks() -> str:
    names = {t.ident: t.name for t in threading.enumerate()}
    out = []
    for ident, frame in sys._current_frames().items():
        out.append(f"--- thread {names.get(ident, ident)}\n" + "".join(traceback.format_stack(frame)).rstrip())
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Watchdog
# ---------------------------------------------------------------------------

class Watchdog:
    """Deadline per pipeline phase. On expiry: log the phase and every thread's
    stack (the root-cause evidence), then call on_expire (default: clear the
    flags and hard-exit — a wedged tkinter main loop or C call can't be
    unwound any other way)."""

    def __init__(self, on_expire=None, deadlines=None, clock=time.monotonic):
        self._deadlines = deadlines or PHASE_DEADLINES
        self._clock = clock
        self._on_expire = on_expire or _watchdog_exit
        self._lock = threading.Lock()
        self.phase = None
        self._phase_started = 0.0
        self._deadline = None
        self._fired = False

    def arm(self, phase: str) -> None:
        with self._lock:
            prev, elapsed = self.phase, self._clock() - self._phase_started
            if prev == phase:
                self._deadline = self._clock() + self._deadlines[phase]
                return
            self.phase = phase
            self._phase_started = self._clock()
            self._deadline = self._phase_started + self._deadlines[phase]
        if prev:
            log(f"phase {prev} -> {phase} ({elapsed:.2f}s)")
        else:
            log(f"phase {phase}")

    def check(self) -> bool:
        """True (and fires once) when the current phase is past its deadline."""
        with self._lock:
            if self._fired or self._deadline is None or self._clock() < self._deadline:
                return False
            self._fired = True
            phase, limit = self.phase, self._deadlines[self.phase]
        log(f"WATCHDOG: phase '{phase}' exceeded {limit:.0f}s | {_disk_note()}\n{_stacks()}")
        self._on_expire(phase)
        return True

    def start(self) -> None:
        def _loop():
            while not self.check():
                time.sleep(1.0)
        threading.Thread(target=_loop, name="watchdog", daemon=True).start()


def _watchdog_exit(phase: str) -> None:
    _set_running(False)
    _clear_flags()
    log(f"WATCHDOG: exiting (stuck in {phase})")
    os._exit(3)


# ---------------------------------------------------------------------------
# Server info
# ---------------------------------------------------------------------------

_SERVER_INFO_FILE = os.path.join(_TMP, "vd-server-info.json")


def _read_server_info() -> str:
    """Return 'model/device' string from the info file written by transcribe_server."""
    try:
        with open(_SERVER_INFO_FILE) as f:
            info = json.load(f)
        return f"{info.get('model', '?')}/{info.get('device', '?')}"
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Device selection
# ---------------------------------------------------------------------------

def _get_device() -> tuple:
    """Return (device_id, device_name) based on VD_DEVICE env var or system default."""
    vd_device = os.environ.get("VD_DEVICE", "").strip()

    if not vd_device:
        try:
            idx = sd.default.device[0]  # input device index
            name = sd.query_devices(idx)["name"]
        except Exception:
            idx, name = None, "default"
        return idx, name

    # Integer index
    try:
        idx = int(vd_device)
        name = sd.query_devices(idx)["name"]
        return idx, name
    except (ValueError, Exception):
        pass

    # Name substring match
    for i, dev in enumerate(sd.query_devices()):
        if vd_device.lower() in dev["name"].lower() and dev["max_input_channels"] > 0:
            return i, dev["name"]

    # Fallback with warning
    try:
        idx = sd.default.device[0]
        name = sd.query_devices(idx)["name"]
    except Exception:
        idx, name = None, "default"
    return idx, f"{name} (VD_DEVICE '{vd_device}' not found)"


def list_devices() -> None:
    """Print all available input devices to stdout."""
    print("Available input devices:")
    print(f"  {'IDX':>4}  {'NAME'}")
    print(f"  {'---':>4}  {'----'}")
    try:
        default_in = sd.default.device[0]
    except Exception:
        default_in = -1
    for i, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            marker = " <-- default" if i == default_in else ""
            print(f"  {i:>4}  {dev['name']}{marker}")
    print()
    print("To select a device, set VD_DEVICE env var to the index or a name substring.")
    print("Example:  set VD_DEVICE=Yeti   or   set VD_DEVICE=2")


# ---------------------------------------------------------------------------
# Transcription helpers
# ---------------------------------------------------------------------------

def _transcribe(wav_path: str) -> tuple:
    """Send wav_path to transcribe_server.py over TCP.

    Returns (text, error). On success error is None and text may be '' (genuine
    silence). On failure text is '' and error is a short human-readable reason,
    so callers can distinguish "no speech" from a broken transcription pipeline
    instead of reporting every failure as silence.
    """
    try:
        with socket.create_connection((TRANSCRIBE_HOST, TRANSCRIBE_PORT), timeout=60) as s:
            s.sendall(wav_path.encode("utf-8"))
            s.shutdown(socket.SHUT_WR)
            chunks = []
            while True:
                buf = s.recv(65536)
                if not buf:
                    break
                chunks.append(buf)
        text = b"".join(chunks).decode("utf-8", errors="replace").strip()
        if text.startswith("ERROR:"):
            return "", text[len("ERROR:"):].strip() or "transcription server error"
        return text, None
    except ConnectionRefusedError:
        return "", "transcription server offline"
    except socket.timeout:
        return "", "transcription timed out"
    except Exception as exc:
        return "", str(exc) or exc.__class__.__name__


# ---------------------------------------------------------------------------
# Auto-paste
# ---------------------------------------------------------------------------

def _auto_paste() -> None:
    """Simulate Ctrl+V at the OS level so the transcript lands at the cursor."""
    time.sleep(0.08)  # brief pause so focus has returned to the target window
    if IS_WINDOWS:
        import ctypes
        VK_CONTROL, VK_V, KEYEVENTF_KEYUP = 0x11, 0x56, 0x0002
        kbe = ctypes.windll.user32.keybd_event
        kbe(VK_CONTROL, 0, 0, 0)
        kbe(VK_V, 0, 0, 0)
        kbe(VK_V, 0, KEYEVENTF_KEYUP, 0)
        kbe(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
    else:
        import subprocess
        try:
            subprocess.run(["xdotool", "key", "ctrl+v"], check=False, timeout=3)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# WAV helper
# ---------------------------------------------------------------------------

def _write_wav(path: str, frames: list) -> None:
    data = np.concatenate(frames).reshape(-1, CHANNELS)
    sf.write(path, data, SAMPLE_RATE, subtype="PCM_16")


# ---------------------------------------------------------------------------
# AudioRecorder
# ---------------------------------------------------------------------------

class AudioRecorder:
    def __init__(self, overlay=None):
        self._overlay = overlay
        self._frames: list = []
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._cancelled = False
        self.stop_reason = ""
        self._preview_errors: set = set()

    # ---- internal threads ------------------------------------------------

    def _rms(self, chunk: np.ndarray) -> float:
        return float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2))) / 32768.0

    def _vad_loop(self) -> None:
        silence_chunks = 0
        speech_detected = False
        silence_needed = int(SILENCE_DURATION / CHUNK_SECS)
        max_chunks = int(MAX_DURATION / CHUNK_SECS)
        chunk_count = 0

        while not self._stop_event.is_set():
            time.sleep(CHUNK_SECS)
            chunk_count += 1

            if os.path.exists(CANCEL_FLAG):
                self._cancelled = True
                self.stop_reason = "cancel"
                self._stop_event.set()
                return
            if os.path.exists(STOP_FLAG):
                self.stop_reason = "hotkey"
                self._stop_event.set()
                return

            with self._lock:
                if not self._frames:
                    continue
                chunk = self._frames[-1]

            rms = self._rms(chunk)

            if self._overlay:
                self._overlay.update_level(rms)

            if rms > SILENCE_THRESHOLD:
                speech_detected = True
                silence_chunks = 0
            elif speech_detected:
                silence_chunks += 1
                if silence_chunks >= silence_needed:
                    self.stop_reason = "silence"
                    self._stop_event.set()
                    return

            if chunk_count >= max_chunks:
                self.stop_reason = "max-duration"
                self._stop_event.set()

    def _preview_loop(self) -> None:
        """Send partial WAV to transcription server every second, update overlay."""
        last_text = ""
        while not self._stop_event.is_set():
            time.sleep(1.0)
            with self._lock:
                if len(self._frames) < int(1.0 / CHUNK_SECS):
                    continue
                snapshot = list(self._frames)
            try:
                _write_wav(PREVIEW_WAV, snapshot)
                text, err = _transcribe(PREVIEW_WAV)
                if err:
                    self._note_preview_error(err)
                if text and text != last_text:
                    last_text = text
                    if self._overlay:
                        self._overlay.update(text, "Recording...")
            except Exception as exc:
                # Previews are best-effort, but a failing one is the early
                # warning for the final pass (e.g. disk full): log each distinct
                # error once rather than swallowing it.
                self._note_preview_error(exc)

    def _note_preview_error(self, err) -> None:
        key = repr(err) if isinstance(err, BaseException) else str(err)
        if key in self._preview_errors:
            return
        self._preview_errors.add(key)
        if isinstance(err, BaseException):
            log_exc("preview failed", err)
        else:
            log(f"preview failed: {err}")

    # ---- public ----------------------------------------------------------

    def record(self) -> tuple:
        """
        Open audio stream, run VAD + preview. Block until done.
        Returns (cancelled: bool, wav_path: str). wav_path is '' if cancelled.
        """
        device_id, device_name = _get_device()

        log(f"recording on device {device_id!r} ({device_name})")
        if self._overlay:
            self._overlay.set_device(device_name)

        statuses = []

        def _cb(indata, frames, time_info, status):
            if status and len(statuses) < 20:
                statuses.append(str(status))
            with self._lock:
                self._frames.append(indata.copy())

        blocksize = int(SAMPLE_RATE * CHUNK_SECS)
        vad_t = threading.Thread(target=self._vad_loop, daemon=True)
        preview_t = threading.Thread(target=self._preview_loop, daemon=True)

        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype=DTYPE,
            blocksize=blocksize,
            device=device_id,
            callback=_cb,
        ):
            vad_t.start()
            preview_t.start()
            self._stop_event.wait()

        vad_t.join(timeout=1)
        preview_t.join(timeout=1)

        with self._lock:
            n = len(self._frames)
        log(
            f"stopped: reason={self.stop_reason or '?'} audio={n * CHUNK_SECS:.1f}s"
            + (f" stream-status={sorted(set(statuses))}" if statuses else "")
        )

        if self._cancelled:
            return True, ""

        with self._lock:
            if not self._frames:
                return False, ""
            _write_wav(FINAL_WAV, self._frames)

        return False, FINAL_WAV

    @staticmethod
    def cleanup() -> None:
        for path in (PREVIEW_WAV, FINAL_WAV):
            try:
                os.remove(path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Flag file helpers
# ---------------------------------------------------------------------------

def _clear_flags() -> None:
    for path in (CANCEL_FLAG, STOP_FLAG):
        try:
            os.remove(path)
        except OSError:
            pass


def _set_running(active: bool) -> None:
    if active:
        # The PID lets the hotkey scripts tell a live recorder from a flag left
        # behind by one that died (killed, crashed, power loss).
        with open(RUNNING_FLAG, "w") as f:
            f.write(str(os.getpid()))
    else:
        try:
            os.remove(RUNNING_FLAG)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _overlay_call(overlay, method: str, *args, **kwargs) -> None:
    """Call an overlay method, tolerating a window that is already gone."""
    if not overlay:
        return
    try:
        getattr(overlay, method)(*args, **kwargs)
    except Exception as exc:
        log(f"overlay.{method} failed: {exc!r}")


def _finish(overlay, wd, status: str, delay_ms: int) -> None:
    wd.arm("closing")
    _overlay_call(overlay, "set_status", status)
    _overlay_call(overlay, "close", delay_ms=delay_ms)


def _recording_thread(recorder: AudioRecorder, overlay, wd=None) -> None:
    """Background thread: record → transcribe → LLM → clipboard → paste.

    Any exception ends the session visibly (error in the overlay, window
    closed, so the running flag clears) and is logged with its traceback.
    Before this, an exception here killed the thread silently and left the
    overlay's main loop — and the running flag — up forever."""
    wd = wd or Watchdog()  # never started: tracks and logs phases only
    try:
        _pipeline(recorder, overlay, wd)
    except Exception as exc:
        log_exc(f"pipeline failed in phase {wd.phase}", exc)
        _finish(overlay, wd, f"Error: {_short_error(exc)}", 5000)


def _pipeline(recorder: AudioRecorder, overlay, wd) -> None:
    wd.arm("recording")
    cancelled, wav_path = recorder.record()

    if cancelled or not wav_path:
        log("cancelled" if cancelled else "no audio captured")
        _finish(overlay, wd, "Cancelled" if cancelled else "No audio captured", 600 if cancelled else 1500)
        return

    wd.arm("transcribing")
    _overlay_call(overlay, "set_status", "Transcribing...")

    t0 = time.time()
    text, err = _transcribe(wav_path)
    t_whisper = time.time() - t0
    recorder.cleanup()
    log(f"transcribed in {t_whisper:.2f}s: chars={len(text)}" + (f" error={err}" if err else ""))

    if err:
        # Audio was captured but transcription itself failed — say so plainly
        # instead of the misleading "No speech detected".
        _finish(overlay, wd, f"Transcription failed: {err}", 3500)
        return

    if not text:
        _finish(overlay, wd, "No speech detected", 1200)
        return

    wd.arm("cleanup")
    t_cleanup = 0.0
    cleanup_backend = ""
    try:
        from llm_cleanup import cleanup as llm_cleanup
        t1 = time.time()
        text, cleanup_backend = llm_cleanup(text)
        t_cleanup = time.time() - t1
        log(f"cleanup {cleanup_backend} in {t_cleanup:.2f}s")
    except ImportError:
        pass

    wd.arm("paste")
    pyperclip.copy(text)

    timing = f"Done  {t_whisper:.1f}s whisper"
    if cleanup_backend:
        timing += f"  {t_cleanup:.3f}s {cleanup_backend}"

    _overlay_call(overlay, "show_done", text, timing)

    # Paste before overlay closes — user's window still has focus since we
    # never stole it.
    _auto_paste()

    # History append (async-safe, fast JSONL append)
    try:
        import history as vd_history
        model_info = _read_server_info()
        vd_history.append_entry(
            text,
            whisper_seconds=t_whisper,
            cleanup_seconds=t_cleanup if cleanup_backend else None,
            cleanup_backend=cleanup_backend,
            whisper_model=model_info,
        )
    except Exception as exc:
        log_exc("history append failed", exc)

    log("pasted")
    wd.arm("done")


def run() -> None:
    _clear_flags()
    _set_running(True)
    threading.excepthook = _thread_excepthook
    sys.excepthook = lambda t, v, tb: log_exc("uncaught exception", v)

    free = _free_mb()
    log(f"start: python {sys.version.split()[0]}, temp {_TMP}, {_disk_note()}")
    low_disk = 0 <= free < LOW_DISK_MB
    if low_disk:
        log(f"WARNING: low disk space ({free} MB free) — recording may fail")

    wd = Watchdog()  # only enforces deadlines once started
    wd.arm("starting")
    if WATCHDOG_ON:
        wd.start()

    try:
        from overlay import Overlay
        overlay = Overlay(silence_threshold=SILENCE_THRESHOLD)
    except Exception as exc:
        log_exc("overlay unavailable, running headless", exc)
        overlay = None

    try:
        # Show Whisper model + cleanup backend in overlay
        if overlay:
            model_info = _read_server_info()
            if model_info:
                overlay.set_model(model_info)
            try:
                from llm_cleanup import get_active_backend
                overlay.set_backend(get_active_backend())
            except ImportError:
                pass

        recorder = AudioRecorder(overlay=overlay)

        if overlay:
            overlay.set_status(f"Recording... LOW DISK: {free} MB free" if low_disk else "Recording...")
            t = threading.Thread(
                target=_recording_thread, args=(recorder, overlay, wd), name="pipeline", daemon=True
            )
            t.start()
            overlay.mainloop()  # blocks on main thread (tkinter requirement)
            wd.arm("closing")
            t.join(timeout=3)
        else:
            # Fallback: no overlay, same pipeline on this thread
            _recording_thread(recorder, None, wd)
    except Exception as exc:
        log_exc("recorder failed", exc)
    finally:
        _set_running(False)
        _clear_flags()
        log("exit")


if __name__ == "__main__":
    if "--list-devices" in sys.argv:
        list_devices()
        sys.exit(0)
    run()
