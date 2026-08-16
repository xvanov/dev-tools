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


def _transcribe(audio_path: str) -> str:
    global _last_used, _model, _cuda_disabled_until
    with _lock:
        for attempt in (1, 2):
            try:
                _load()
                lang = None if LANGUAGE == "auto" else LANGUAGE
                segments, _info = _model.transcribe(audio_path, language=lang, beam_size=1)
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

    log(f"Listening on {HOST}:{PORT}  model={MODEL_NAME}/{DEVICE}. Idle unload after {IDLE_TIMEOUT}s.")
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
