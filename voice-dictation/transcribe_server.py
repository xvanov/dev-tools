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

_model = None
_lock = threading.Lock()
_last_used = 0.0

# Device the model is actually loaded on. Starts as the configured device but
# is downgraded to CPU permanently (for this process) once a GPU error is seen,
# so a transient/﻿persistent CUDA failure self-heals instead of breaking every
# request until restart.
_active_device = DEVICE
_active_compute = COMPUTE
_cuda_disabled = False


def _is_gpu_error(exc: Exception) -> bool:
    s = str(exc).lower()
    return any(k in s for k in ("cuda", "cublas", "cudnn", "out of memory", "gpu", "nvrtc"))


def _load() -> None:
    global _model, _last_used, _active_device, _active_compute
    if _model is None:
        if _cuda_disabled or DEVICE == "cpu":
            _active_device, _active_compute = "cpu", "int8"
        else:
            _active_device, _active_compute = DEVICE, COMPUTE
        print(f"Loading {MODEL_NAME} on {_active_device} ({_active_compute})...", flush=True)
        _model = WhisperModel(MODEL_NAME, device=_active_device, compute_type=_active_compute)
        _write_info_file()
        print(f"Model loaded on {_active_device}.", flush=True)
    _last_used = time.time()


def _unload() -> None:
    global _model
    if _model is not None:
        print("Unloading model (idle timeout).", flush=True)
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
                _unload()


def _transcribe(audio_path: str) -> str:
    global _last_used, _model, _cuda_disabled
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
                # First GPU failure: drop the model, disable CUDA for the rest
                # of this process, and retry once on CPU. Anything else (or a
                # second failure) propagates to the client.
                if attempt == 1 and not _cuda_disabled and DEVICE != "cpu" and _is_gpu_error(exc):
                    print(f"GPU transcription failed ({exc}); falling back to CPU.", flush=True)
                    _cuda_disabled = True
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
        print(f"Port {PORT} already in use — another instance is running. Exiting.", flush=True)
        return 1
    server.listen(4)

    _write_info_file()
    threading.Thread(target=_idle_watcher, daemon=True).start()

    print(f"Listening on {HOST}:{PORT}  model={MODEL_NAME}/{DEVICE}. Idle unload after {IDLE_TIMEOUT}s.", flush=True)
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
            print(f"request error: {exc}", file=sys.stderr, flush=True)
        finally:
            conn.close()


if __name__ == "__main__":
    sys.exit(main())
