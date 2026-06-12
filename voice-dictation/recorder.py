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
  vd-running.flag — presence signals that recorder is active
"""

import json
import os
import platform
import socket
import sys
import tempfile
import threading
import time

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
                self._stop_event.set()
                return
            if os.path.exists(STOP_FLAG):
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
                    self._stop_event.set()
                    return

            if chunk_count >= max_chunks:
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
                text, _err = _transcribe(PREVIEW_WAV)
                if text and text != last_text:
                    last_text = text
                    if self._overlay:
                        self._overlay.update(text, "Recording...")
            except Exception:
                pass

    # ---- public ----------------------------------------------------------

    def record(self) -> tuple:
        """
        Open audio stream, run VAD + preview. Block until done.
        Returns (cancelled: bool, wav_path: str). wav_path is '' if cancelled.
        """
        device_id, device_name = _get_device()

        if self._overlay:
            self._overlay.set_device(device_name)

        def _cb(indata, frames, time_info, status):
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
        open(RUNNING_FLAG, "w").close()
    else:
        try:
            os.remove(RUNNING_FLAG)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _recording_thread(recorder: AudioRecorder, overlay) -> None:
    """Background thread: record → transcribe → LLM → clipboard → paste."""
    cancelled, wav_path = recorder.record()

    if cancelled or not wav_path:
        if overlay:
            overlay.set_status("Cancelled")
            overlay.close(delay_ms=600)
        return

    if overlay:
        overlay.set_status("Transcribing...")

    t0 = time.time()
    text, err = _transcribe(wav_path)
    t_whisper = time.time() - t0
    recorder.cleanup()

    if err:
        # Audio was captured but transcription itself failed — say so plainly
        # instead of the misleading "No speech detected".
        if overlay:
            overlay.set_status(f"Transcription failed: {err}")
            overlay.close(delay_ms=3500)
        return

    if not text:
        if overlay:
            overlay.set_status("No speech detected")
            overlay.close(delay_ms=1200)
        return

    t_cleanup = 0.0
    cleanup_backend = ""
    try:
        from llm_cleanup import cleanup as llm_cleanup
        t1 = time.time()
        text, cleanup_backend = llm_cleanup(text)
        t_cleanup = time.time() - t1
    except ImportError:
        pass

    pyperclip.copy(text)

    timing = f"Done  {t_whisper:.1f}s whisper"
    if cleanup_backend:
        timing += f"  {t_cleanup:.3f}s {cleanup_backend}"

    if overlay:
        overlay.show_done(text, timing)

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
    except Exception:
        pass


def run() -> None:
    _clear_flags()
    _set_running(True)

    try:
        from overlay import Overlay
        overlay = Overlay(silence_threshold=SILENCE_THRESHOLD)
    except Exception:
        overlay = None

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

    try:
        if overlay:
            overlay.set_status("Recording...")
            t = threading.Thread(
                target=_recording_thread, args=(recorder, overlay), daemon=True
            )
            t.start()
            overlay.mainloop()  # blocks on main thread (tkinter requirement)
            t.join(timeout=3)
        else:
            # Fallback: no overlay, blocking path
            cancelled, wav_path = recorder.record()
            if cancelled or not wav_path:
                return
            text, err = _transcribe(wav_path)
            recorder.cleanup()
            if err or not text:
                return
            try:
                from llm_cleanup import cleanup as llm_cleanup
                text = llm_cleanup(text)
            except ImportError:
                pass
            pyperclip.copy(text)
            _auto_paste()
    finally:
        _set_running(False)
        _clear_flags()


if __name__ == "__main__":
    if "--list-devices" in sys.argv:
        list_devices()
        sys.exit(0)
    run()
