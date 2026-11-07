"""Tests for voice/server.py.

    python -I voice/selftest.py --unit          pure logic only (no torch, no GPU)
    python -I voice/selftest.py --models DIR    plus: the model files are there,
                                                smart-turn answers, Kokoro speaks
    python -I voice/selftest.py --live URL      plus: a running service answers

install-voice.ps1 runs the second form; exit status 0 means it all worked.
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.request
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

failures = []


def check(name, cond, detail=None):
    print(('ok   ' if cond else 'FAIL ') + name + ('' if detail is None else f'  ({detail})'), flush=True)
    if not cond:
        failures.append(name)


def unit():
    s = server.sentences('Hello there. How are you? I am fine!  Dr. Who is here.')
    check('sentences split on . ? ! but not after Dr.', s == ['Hello there.', 'How are you?', 'I am fine!', 'Dr. Who is here.'], s)
    check('sentences: empty text', server.sentences('   ') == [])
    check('sentences: no terminal punctuation', server.sentences('just words') == ['just words'])
    import numpy as np
    pcm = server.pcm16(np.array([0.0, 1.0, -1.0, 2.0], dtype=np.float32))
    check('pcm16 clips and packs little-endian', pcm == b'\x00\x00\xff\x7f\x01\x80\xff\x7f', pcm)
    w = server.wav_bytes(b'\x00\x00' * 160, 16000)
    a = server.read_turn_audio(w, 'audio/wav')
    check('read_turn_audio reads a 16 kHz WAV', len(a) == 160)
    a = server.read_turn_audio(b'\x00\x40\x00\xc0\x01', 'audio/L16')
    check('read_turn_audio reads raw PCM (odd byte dropped)', len(a) == 2 and abs(a[0] - 0.5) < 1e-6 and abs(a[1] + 0.5) < 1e-6, a)
    bad = server.wav_bytes(b'\x00\x00' * 10, 24000)
    try:
        server.read_turn_audio(bad, 'audio/wav')
        check('read_turn_audio refuses a 24 kHz WAV', False)
    except ValueError:
        check('read_turn_audio refuses a 24 kHz WAV', True)
    check('default voice is a known voice', 'bf_isabella' in server.VOICE_IDS)
    check('every voice id names its language', all(v[0] in 'ab' for v in server.VOICE_IDS))


def models(d):
    for f in ['smart-turn-v3.2-cpu.onnx', 'silero_vad.onnx', 'melspectrogram.onnx', 'embedding_model.onnx',
              'hey_jarvis_v0.1.onnx', 'ort/ort.wasm.min.js', 'ort/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.mjs']:
        p = os.path.join(d, f)
        check(f'model file {f}', os.path.exists(p) and os.path.getsize(p) > 0)
    import numpy as np
    turn = server.Turn(os.path.join(d, 'smart-turn-v3.2-cpu.onnx'))
    t = time.perf_counter()
    p = turn.predict(np.zeros(16000 * 2, dtype=np.float32))
    check('smart-turn answers a probability', 0.0 <= p <= 1.0, f'{p:.3f} in {round((time.perf_counter() - t) * 1000)} ms')
    tts = server.Tts(default_voice='bf_isabella')
    check('Kokoro is on the GPU', tts.device == 'cuda', tts.device)
    tts.warm()
    t = time.perf_counter()
    first = None
    n = 0
    for c in tts.synth('Good evening. This is Jarvis.', 'bf_isabella'):
        first = first or (time.perf_counter() - t)
        n += len(c)
    check('Kokoro speaks bf_isabella', n > server.SAMPLE_RATE // 2, f'{n / server.SAMPLE_RATE:.2f}s of audio, first chunk {round(first * 1000)} ms')


def live(url):
    h = json.load(urllib.request.urlopen(url + '/health', timeout=5))
    check('live /health ok', h.get('ok'), h)
    req = urllib.request.Request(url + '/tts?format=wav', data=json.dumps({'text': 'Testing one two.'}).encode(), method='POST')
    t = time.perf_counter()
    body = urllib.request.urlopen(req, timeout=30).read()
    with wave.open(io.BytesIO(body)) as w:
        check('live /tts returns 24 kHz audio', w.getframerate() == 24000 and w.getnframes() > 4000, f'{round((time.perf_counter() - t) * 1000)} ms')
    pcm = server.wav_bytes(b'\x00\x00' * 16000, 16000)
    req = urllib.request.Request(url + '/endpoint', data=pcm, method='POST', headers={'Content-Type': 'audio/wav'})
    r = json.load(urllib.request.urlopen(req, timeout=10))
    check('live /endpoint answers', 'probability' in r, r)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--unit', action='store_true')
    ap.add_argument('--models')
    ap.add_argument('--live')
    a = ap.parse_args()
    unit()
    if a.models and not a.unit:
        models(a.models)
    if a.live:
        live(a.live.rstrip('/'))
    print('voice selftest ' + ('FAILED: ' + ', '.join(failures) if failures else 'ok'))
    sys.exit(1 if failures else 0)
