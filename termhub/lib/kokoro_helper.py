#!/usr/bin/env python3
"""Warm Kokoro TTS worker for termhub's lib/tts.js.

Kokoro sounds far better than piper, but loading its 325 MB ONNX graph costs
0.5 s *every* time — and an announcement that already waits on a summariser
cannot afford to pay that per clip. So the model is loaded exactly once here and
the process stays resident, taking one request per line on stdin and writing the
WAV straight back on stdout. Node (lib/tts.js) owns the lifecycle: it spawns this
lazily, restarts it if it dies, and shuts it down when nobody has spoken for a
while.

Wire format, deliberately dumb so the Node side needs no parser:

  in   one JSON object per line: {"id":N,"text":"…","voice":"af_heart","speed":1.0}
  out  one JSON header line, followed by exactly `bytes` raw bytes when present:
         {"type":"ready","voices":[…],"loadMs":512}
         {"type":"audio","id":N,"bytes":123456}   + 123456 bytes of WAV
         {"type":"error","id":N,"error":"…"}

stdout is binary and carries nothing else; every diagnostic goes to stderr,
which the parent drains and discards (onnxruntime spams GPU-discovery warnings
there on every start).
"""

import io
import json
import os
import sys
import time


def emit(header, payload=b''):
    """One header line then its bytes, flushed together so a reader never
    blocks half-way through a frame."""
    out = sys.stdout.buffer
    out.write((json.dumps(header) + '\n').encode('utf-8'))
    if payload:
        out.write(payload)
    out.flush()


def main():
    model = os.environ.get('TERMHUB_KOKORO_MODEL', '')
    voices_bin = os.environ.get('TERMHUB_KOKORO_VOICES', '')
    if not model or not voices_bin:
        emit({'type': 'fatal', 'error': 'TERMHUB_KOKORO_MODEL/VOICES not set'})
        return 2

    t0 = time.time()
    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
        kokoro = Kokoro(model, voices_bin)
        voices = sorted(kokoro.get_voices())
    except Exception as e:  # noqa: BLE001 - the parent only cares that it failed
        emit({'type': 'fatal', 'error': '%s: %s' % (type(e).__name__, e)})
        return 3

    # The parent uses this to fill its voice list without ever loading the model
    # itself — /api/voice/status is polled, and a 325 MB load per poll is not an
    # option.
    emit({'type': 'ready', 'voices': voices, 'loadMs': int((time.time() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue  # a torn line is the parent's bug; dropping it beats dying
        rid = req.get('id')
        text = (req.get('text') or '').strip()
        voice = req.get('voice') or 'af_heart'
        try:
            speed = float(req.get('speed') or 1.0)
        except (TypeError, ValueError):
            speed = 1.0
        lang = req.get('lang') or 'en-us'

        if not text:
            emit({'type': 'error', 'id': rid, 'error': 'no text'})
            continue
        try:
            samples, rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
            buf = io.BytesIO()
            # PCM_16 rather than the float32 kokoro hands back: it halves the
            # bytes on the wire and is what every browser decodes without
            # thinking about it.
            sf.write(buf, samples, rate, format='WAV', subtype='PCM_16')
            wav = buf.getvalue()
            emit({'type': 'audio', 'id': rid, 'bytes': len(wav), 'rate': rate}, wav)
        except Exception as e:  # noqa: BLE001
            # One bad request (unknown voice, unpronounceable text) must not cost
            # the model load for every request after it.
            emit({'type': 'error', 'id': rid, 'error': '%s: %s' % (type(e).__name__, e)})

    return 0


if __name__ == '__main__':
    sys.exit(main())
