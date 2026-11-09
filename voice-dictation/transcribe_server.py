#!/usr/bin/env python3
"""Always-warm transcription server.

Listens on a TCP loopback socket. Loads the model on first request, unloads
after IDLE_TIMEOUT seconds to free GPU memory.

Configure via environment variables:
  WHISPER_MODEL       Model name (default: small)
  WHISPER_DEVICE      cuda or cpu (default: cuda)
  WHISPER_COMPUTE     float16 / int8_float16 / int8 (default: float16)
  WHISPER_LANGUAGE    Language code or 'auto' (default: en)
  TRANSCRIBE_HOST     Bind host (default: 127.0.0.1)
  TRANSCRIBE_PORT     Bind port (default: 47821)
  IDLE_TIMEOUT_SEC    Seconds before unloading (default: 1800)
  CUDA_RETRY_SEC      Seconds to stay on CPU after a GPU failure (default: 600)
  VD_SERVER_LOG       Log file path (default: server.log beside this script)
  VD_ACTIVITY_LOG     Speech-activity log (default: speech-activity.jsonl in the
                      data dir: %LOCALAPPDATA%/voice-dictation or ~/.local/voice-dictation)

Every request is also one line in the speech-activity log: when its audio
ended (the file's mtime) and how long it was. Everything that dictates goes
through this server (the hotkey, termhub's mic, the PA's voice page), so the
PA's meeting capture reads the log to tell your own dictation from a meeting
(personal-assistant/src/audio/selfSpeech.ts). Times and lengths only, no text.
"""
import gc
import os
import socket
import sys
import tempfile
import threading
import time

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "float16")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "en")
HOST = os.environ.get("TRANSCRIBE_HOST", "127.0.0.1")
PORT = int(os.environ.get("TRANSCRIBE_PORT", "47821"))
IDLE_TIMEOUT = int(os.environ.get("IDLE_TIMEOUT_SEC", "1800"))
CUDA_RETRY_SEC = int(os.environ.get("CUDA_RETRY_SEC", "600"))

LOG_PATH = os.environ.get(
    "VD_SERVER_LOG",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.log"),
)
LOG_MAX_BYTES = 2 * 1024 * 1024


def _data_dir() -> str:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
    else:
        base = os.path.join(os.path.expanduser("~"), ".local")
    return os.path.join(base, "voice-dictation")


ACTIVITY_LOG = os.environ.get("VD_ACTIVITY_LOG", os.path.join(_data_dir(), "speech-activity.jsonl"))
ACTIVITY_MAX_BYTES = 1024 * 1024
ACTIVITY_KEEP_SEC = 3 * 86400

_model = None
_lock = threading.Lock()
_last_used = 0.0

# Device the model is actually loaded on. Starts as the configured device and is
# downgraded to CPU for CUDA_RETRY_SEC once a GPU error is seen, so a transient
# CUDA failure (driver update, another process hogging VRAM) degrades instead of
# breaking every request — but does not silently pin the server to CPU forever.
_active_device = DEVICE
_active_compute = COMPUTE
_cuda_disabled_until = 0.0


def log(msg: str) -> None:
    """Print and append to LOG_PATH. The server usually runs windowless, so
    stdout goes nowhere; without this a CPU fallback is invisible."""
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
            os.replace(LOG_PATH, LOG_PATH + ".1")
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _is_gpu_error(exc: Exception) -> bool:
    s = str(exc).lower()
    return any(k in s for k in ("cuda", "cublas", "cudnn", "out of memory", "gpu", "nvrtc"))


def _desired_device() -> tuple:
    if DEVICE == "cpu" or time.time() < _cuda_disabled_until:
        return "cpu", "int8"
    return DEVICE, COMPUTE


def _load() -> None:
    global _model, _last_used, _active_device, _active_compute
    want_device, want_compute = _desired_device()
    if _model is not None and want_device != _active_device:
        # Cooldown expired (or a fallback just tripped): swap the loaded model.
        log(f"Switching model from {_active_device} to {want_device}.")
        _unload()
    if _model is None:
        _active_device, _active_compute = want_device, want_compute
        log(f"Loading {MODEL_NAME} on {_active_device} ({_active_compute})...")
        _model = WhisperModel(MODEL_NAME, device=_active_device, compute_type=_active_compute)
        _write_info_file()
        log(f"Model loaded on {_active_device}.")
    _last_used = time.time()


def _unload() -> None:
    global _model
    if _model is not None:
        del _model
        _model = None
        gc.collect()
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass


def _idle_watcher() -> None:
    while True:
        time.sleep(60)
        with _lock:
            if _model is not None and (time.time() - _last_used) > IDLE_TIMEOUT:
                log("Unloading model (idle timeout).")
                _unload()


RATE = 16000
# Whisper decodes 30 s windows. Within one, timestamps buy nothing; across
# several, they are where the next window starts without cutting a word.
ONE_WINDOW_SEC = 28


def _read_audio(path: str):
    """A 16 kHz mono 16-bit WAV (the PA's and the recorder's) as float32 samples;
    None for any other file, which faster-whisper decodes itself. Its decoder
    (PyAV, then a gc.collect on every call) costs ~50 ms of a ~250 ms request."""
    import wave

    import numpy as np

    try:
        with wave.open(path, "rb") as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != RATE:
                return None
            pcm = w.readframes(w.getnframes())
    except (wave.Error, EOFError):
        return None
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def _options(audio) -> dict:
    """faster-whisper's options for this audio (None: not read here, length unknown)."""
    opts = {"language": None if LANGUAGE == "auto" else LANGUAGE, "beam_size": 1}
    if audio is not None and len(audio) <= ONE_WINDOW_SEC * RATE:
        opts["without_timestamps"] = True
    return opts


def _transcribe(audio_path: str) -> str:
    global _last_used, _model, _cuda_disabled_until
    with _lock:
        for attempt in (1, 2):
            try:
                _load()
                audio = _read_audio(audio_path)
                if attempt == 1:
                    note_activity(audio_path, None if audio is None else len(audio) / RATE)
                source = audio_path if audio is None else audio
                segments, _info = _model.transcribe(source, **_options(audio))
                text = " ".join(seg.text.strip() for seg in segments)
                _last_used = time.time()
                return text
            except Exception as exc:
                # First GPU failure: drop the model, fall back to CPU for
                # CUDA_RETRY_SEC, and retry once. Anything else (or a second
                # failure) propagates to the client.
                if attempt == 1 and _active_device != "cpu" and _is_gpu_error(exc):
                    log(f"GPU transcription failed ({exc}); on CPU for {CUDA_RETRY_SEC}s.")
                    _cuda_disabled_until = time.time() + CUDA_RETRY_SEC
                    _unload()
                    continue
                raise


def _iso(t: float) -> str:
    import datetime as dt

    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def note_activity(audio_path: str, seconds, now: float = None, path: str = None) -> None:
    """One line per request: {at, end, seconds, file}. `end` is the audio file's
    mtime — when that speech ended, even when the request waited behind a long
    one. Past ACTIVITY_MAX_BYTES only the last ACTIVITY_KEEP_SEC is kept.
    Never raises: a lost line must not fail a transcription."""
    import json

    path = path or ACTIVITY_LOG
    now = time.time() if now is None else now
    try:
        end = os.path.getmtime(audio_path)
    except OSError:
        end = now
    entry = {
        "at": _iso(now),
        "end": _iso(end),
        "seconds": None if seconds is None else round(float(seconds), 2),
        "file": os.path.basename(audio_path),
    }
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        if os.path.getsize(path) > ACTIVITY_MAX_BYTES:
            import datetime as dt

            keep = []
            with open(path, encoding="utf-8") as f:
                for line in f:
                    try:
                        at = dt.datetime.fromisoformat(json.loads(line)["at"].replace("Z", "+00:00")).timestamp()
                    except Exception:
                        continue
                    if now - at < ACTIVITY_KEEP_SEC:
                        keep.append(line if line.endswith("\n") else line + "\n")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(keep)
            os.replace(tmp, path)
    except Exception:
        pass


def _no_throttle() -> bool:
    """Opt out of Windows power throttling (EcoQoS) and raise the priority a step.
    The server runs windowless, so Windows parks it on efficiency cores; its CPU
    half (features, decoding loop) then loses to whatever else runs, as the PA's
    smart-turn check does at the same moment. As personal-assistant/voice/server.py."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        import ctypes.wintypes as w

        class PPT(ctypes.Structure):
            _fields_ = [("Version", w.ULONG), ("ControlMask", w.ULONG), ("StateMask", w.ULONG)]

        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.GetCurrentProcess.restype = w.HANDLE
        k.SetProcessInformation.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        k.SetProcessInformation.restype = w.BOOL
        k.SetPriorityClass.argtypes = [w.HANDLE, w.DWORD]
        me = k.GetCurrentProcess()
        # ProcessPowerThrottling (4): EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION, state 0 = never throttled.
        s = PPT(1, 0x1 | 0x4, 0)
        ok = k.SetProcessInformation(me, 4, ctypes.byref(s), ctypes.sizeof(s))
        k.SetPriorityClass(me, 0x8000)  # ABOVE_NORMAL_PRIORITY_CLASS
        return bool(ok)
    except Exception:
        return False


def _write_info_file() -> None:
    import json
    path = os.path.join(tempfile.gettempdir(), "vd-server-info.json")
    with open(path, "w") as f:
        json.dump({"model": MODEL_NAME, "device": _active_device, "compute": _active_compute}, f)


def main() -> int:
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        server.bind((HOST, PORT))
    except OSError:
        log(f"Port {PORT} already in use — another instance is running. Exiting.")
        return 1
    server.listen(4)

    _write_info_file()
    threading.Thread(target=_idle_watcher, daemon=True).start()
    throttle = "off" if _no_throttle() else "as Windows decides"

    log(f"Listening on {HOST}:{PORT}  model={MODEL_NAME}/{DEVICE}. Idle unload after {IDLE_TIMEOUT}s. Power throttling {throttle}.")
    while True:
        conn, _addr = server.accept()
        try:
            data = conn.recv(8192).decode("utf-8", errors="replace").strip()
            if not data:
                conn.sendall(b"")
                continue
            text = _transcribe(data)
            conn.sendall(text.encode("utf-8"))
        except Exception as exc:
            try:
                conn.sendall(f"ERROR: {exc}".encode("utf-8"))
            except Exception:
                pass
            log(f"request error: {exc}")
        finally:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
