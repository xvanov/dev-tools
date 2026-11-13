"""The PA's local voice service: speech out (Kokoro-82M on the GPU) and the
end-of-turn judge (smart-turn v3.2 on the CPU), on loopback only.

    python -I voice/server.py [--port 47830] [--models DIR] [--voice bf_isabella]

    GET  /health    {ok, ready, device, voices, defaultVoice, sampleRate, turn}
    GET  /voices    {voices: [{id, label, lang}], defaultVoice}
    POST /tts       {"text", "voice"?, "speed"?} -> 24 kHz mono audio, streamed:
                    raw 16-bit little-endian PCM (audio/L16), sentence by
                    sentence as each is synthesised; ?format=wav buffers one WAV
    POST /warm      a tiny synthesis that clocks the GPU up (it idles at 210 MHz,
                    and the first sentence after a quiet minute pays for it)
    POST /endpoint  16 kHz mono 16-bit PCM (audio/L16, or a WAV) of the turn so
                    far -> {complete, probability, ms}: is the speaker done?

The PA dashboard proxies these (src/dashboard/talk.js) as /api/talk/tts and
/api/talk/endpoint, so the page works through termhub's /pa/ proxy too, where
this port is not reachable. Plain HTTP, no WebSocket: the /pa/ proxy passes
only HTTP. Standard library server, one thread per request; the GPU is behind
one lock (Kokoro is not re-entrant), smart-turn behind another.

Windows parks background processes on efficiency cores (EcoQoS) and this
laptop runs them 5-10x slower for it; the service opts itself out at start.
"""

import argparse
import io
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SAMPLE_RATE = 24000
TURN_RATE = 16000
TURN_SECONDS = 8
MAX_TEXT = 2000
MAX_TURN_BYTES = TURN_RATE * 2 * 30

# Kokoro-82M's English voices: lang 'a' American, 'b' British (the first letter).
def english_voice_ids():
    """Kokoro's English voices as downloaded (voices/*.pt in the Hugging Face cache): ids are
    <lang><gender>_<name>, lang 'a' American or 'b' British. Read from disk, not hard-coded, so
    the list follows the model; British first, since the default is British."""
    hub = os.environ.get('HF_HUB_CACHE') or os.path.join(
        os.environ.get('HF_HOME') or os.path.join(os.path.expanduser('~'), '.cache', 'huggingface'), 'hub')
    ids = set()
    snaps = os.path.join(hub, 'models--hexgrad--Kokoro-82M', 'snapshots')
    for snap in (os.listdir(snaps) if os.path.isdir(snaps) else []):
        vdir = os.path.join(snaps, snap, 'voices')
        for f in (os.listdir(vdir) if os.path.isdir(vdir) else []):
            if f.endswith('.pt') and f[:1] in ('a', 'b') and f[1:2] in ('f', 'm') and f[2:3] == '_':
                ids.add(f[:-3])
    return sorted(ids, key=lambda v: (v[0] != 'b', v))


VOICE_IDS_ORDERED = english_voice_ids() or ['bf_isabella']


def voice_label(voice_id):
    """'bf_emma' -> 'Emma (British)': labels come from Kokoro's own ids, not a hand-written list."""
    region = 'British' if voice_id.startswith('b') else 'American'
    return f"{voice_id.split('_', 1)[1].capitalize()} ({region})"


VOICES = [(v, voice_label(v)) for v in VOICE_IDS_ORDERED]
VOICE_IDS = {v for v, _ in VOICES}


def no_throttle():
    """Opt this process out of Windows power throttling (EcoQoS) and raise it a step."""
    if os.name != 'nt':
        return False
    try:
        import ctypes
        import ctypes.wintypes as w

        class PPT(ctypes.Structure):
            _fields_ = [('Version', w.ULONG), ('ControlMask', w.ULONG), ('StateMask', w.ULONG)]

        k = ctypes.WinDLL('kernel32', use_last_error=True)
        # Declared, not guessed: the process pseudo-handle is a 64-bit -1, and
        # ctypes' default int would hand the call a truncated one.
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


_SENTENCE = re.compile(r'(?<=[.!?…])["\')\]]*\s+')


_ABBREV = re.compile(r'(?:\b(?i:dr|mr|mrs|ms|st|vs|etc|approx|no|e\.g|i\.e)\.|\b[A-Z]\.)$')


def sentences(text):
    """Split into sentences so the first one is spoken before the rest is synthesised."""
    out = []
    for s in _SENTENCE.split(str(text or '')):
        s = s.strip()
        if not s:
            continue
        if out and _ABBREV.search(out[-1]):
            out[-1] += ' ' + s
        else:
            out.append(s)
    return out


class Tts:
    def __init__(self, device='cuda', default_voice='bf_isabella', log=print):
        import torch
        from kokoro import KModel, KPipeline

        self.torch = torch
        self.device = device if (device != 'cuda' or torch.cuda.is_available()) else 'cpu'
        self.default_voice = default_voice if default_voice in VOICE_IDS else 'bf_isabella'
        t = time.time()
        self.model = KModel(repo_id='hexgrad/Kokoro-82M').to(self.device).eval()
        self.pipes = {lc: KPipeline(lang_code=lc, repo_id='hexgrad/Kokoro-82M', model=self.model) for lc in ('a', 'b')}
        self.lock = threading.Lock()
        # Every voice now, so no request waits on a download or a disk read.
        for v, _ in VOICES:
            try:
                self.pipes[v[0]].load_voice(v)
            except Exception as e:  # a voice missing offline is skipped, not fatal
                log(f'voice {v} not loaded: {e}')
        self.load_s = round(time.time() - t, 1)
        self.warm_ms = None

    def voice(self, v):
        return v if v in VOICE_IDS else self.default_voice

    def synth(self, text, voice=None, speed=1.0):
        """Yields float32 numpy chunks at 24 kHz, a sentence (or less) at a time."""
        v = self.voice(voice)
        pipe = self.pipes[v[0]]
        for s in sentences(text):
            with self.lock, self.torch.inference_mode():
                parts = [r.audio for r in pipe(s, voice=v, speed=speed) if r.audio is not None]
            for a in parts:
                yield a.detach().cpu().numpy()

    def warm(self):
        t = time.perf_counter()
        for _ in self.synth('Hello there.', self.default_voice):
            pass
        ms = round((time.perf_counter() - t) * 1000)
        self.warm_ms = ms
        return ms


class Turn:
    """smart-turn v3.2: the last 8 s of the turn -> probability the speaker is done."""

    def __init__(self, model_path, threads=2):
        import numpy as np
        import onnxruntime as ort
        from transformers import WhisperFeatureExtractor

        self.np = np
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(model_path, so, providers=['CPUExecutionProvider'])
        self.fe = WhisperFeatureExtractor(chunk_length=TURN_SECONDS)
        self.lock = threading.Lock()

    def predict(self, audio):
        np = self.np
        n = TURN_SECONDS * TURN_RATE
        # As smart-turn's own inference.py: keep the end; pad short audio at the front.
        a = audio[-n:] if len(audio) > n else np.pad(audio, (n - len(audio), 0))
        feats = self.fe(a, sampling_rate=TURN_RATE, return_tensors='np', padding='max_length',
                        max_length=n, truncation=True, do_normalize=True).input_features.astype(np.float32)
        with self.lock:
            out = self.sess.run(None, {'input_features': feats})
        p = float(np.asarray(out[0]).reshape(-1)[0])
        return p


def pcm16(chunk):
    import numpy as np
    return (np.clip(chunk, -1.0, 1.0) * 32767).astype('<i2').tobytes()


def wav_bytes(pcm, rate):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def read_turn_audio(body, content_type):
    """16 kHz mono 16-bit: raw PCM, or a WAV of that."""
    import numpy as np
    if body[:4] == b'RIFF':
        with wave.open(io.BytesIO(body)) as w:
            if w.getframerate() != TURN_RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
                raise ValueError('WAV must be 16 kHz mono 16-bit')
            body = w.readframes(w.getnframes())
    if len(body) % 2:
        body = body[:-1]
    return np.frombuffer(body, dtype='<i2').astype(np.float32) / 32768.0


class State:
    tts = None
    turn = None
    error = None
    ready = False
    throttle_off = False
    started = time.time()


def make_handler(state, log):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'pa-voice/1'
        # Headers and body go out as separate writes; with Nagle on, the
        # body waits for the client's delayed ACK: up to 200 ms per answer.
        disable_nagle_algorithm = True

        def log_message(self, fmt, *args):  # quiet: one line per error only
            pass

        def _json(self, status, obj):
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def _body(self, limit):
            n = int(self.headers.get('Content-Length') or 0)
            if n > limit:
                raise ValueError('body too large')
            return self.rfile.read(n) if n else b''

        def _guard(self):
            # Loopback callers only, and no browser page may call it directly:
            # the PA proxies it, and that is the only caller that sets no Origin.
            host = (self.headers.get('Host') or '').split(':')[0]
            if host not in ('127.0.0.1', 'localhost', '[::1]'):
                self._json(403, {'error': 'loopback Host only'})
                return False
            if self.headers.get('Origin'):
                self._json(403, {'error': 'not for browsers: go through the PA (/api/talk/...)'})
                return False
            return True

        def do_GET(self):
            if not self._guard():
                return
            path = self.path.split('?')[0]
            if path == '/health':
                t = state.tts
                return self._json(200, {
                    'ok': state.ready and state.error is None,
                    'ready': state.ready,
                    'error': state.error,
                    'device': t.device if t else None,
                    'defaultVoice': t.default_voice if t else None,
                    'voices': len(VOICES),
                    'sampleRate': SAMPLE_RATE,
                    'turn': state.turn is not None,
                    'loadSeconds': t.load_s if t else None,
                    'warmMs': t.warm_ms if t else None,
                    'throttleOff': state.throttle_off,
                    'uptimeSeconds': round(time.time() - state.started),
                })
            if path == '/voices':
                return self._json(200, {
                    'voices': [{'id': v, 'label': l, 'lang': 'en-GB' if v[0] == 'b' else 'en-US'} for v, l in VOICES],
                    'defaultVoice': state.tts.default_voice if state.tts else 'bf_isabella',
                })
            self._json(404, {'error': 'not found'})

        def do_POST(self):
            if not self._guard():
                return
            path, _, query = self.path.partition('?')
            try:
                if path == '/tts':
                    return self._tts(query)
                if path == '/warm':
                    self._body(4096)
                    if not state.ready:
                        return self._json(503, {'error': 'warming up'})
                    return self._json(200, {'ms': state.tts.warm()})
                if path == '/endpoint':
                    return self._endpoint()
            except ValueError as e:
                return self._json(400, {'error': str(e)})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as e:
                log(f'{path} failed: {e!r}')
                try:
                    return self._json(500, {'error': str(e)[:300]})
                except Exception:
                    return
            self._json(404, {'error': 'not found'})

        def _tts(self, query):
            if not state.ready:
                return self._json(503, {'error': state.error or 'warming up'})
            try:
                req = json.loads(self._body(64 * 1024) or b'{}')
            except json.JSONDecodeError:
                raise ValueError('bad json')
            text = str(req.get('text') or '').strip()
            if not text:
                raise ValueError('text must be a non-empty string')
            if len(text) > MAX_TEXT:
                raise ValueError(f'text is over {MAX_TEXT} characters')
            speed = float(req.get('speed') or 1.0)
            speed = min(1.6, max(0.6, speed))
            voice = state.tts.voice(req.get('voice'))
            t0 = time.perf_counter()
            if 'format=wav' in query:
                pcm = b''.join(pcm16(c) for c in state.tts.synth(text, voice, speed))
                data = wav_bytes(pcm, SAMPLE_RATE)
                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('X-Voice', voice)
                self.send_header('X-Synth-Ms', str(round((time.perf_counter() - t0) * 1000)))
                self.end_headers()
                self.wfile.write(data)
                return
            gen = state.tts.synth(text, voice, speed)
            # The first chunk before the headers: a failure is still a clean 500.
            first = next(gen, None)
            self.send_response(200)
            self.send_header('Content-Type', f'audio/L16; rate={SAMPLE_RATE}; channels=1')
            self.send_header('X-Sample-Rate', str(SAMPLE_RATE))
            self.send_header('X-Voice', voice)
            self.send_header('X-First-Ms', str(round((time.perf_counter() - t0) * 1000)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()

            def chunk(b):
                if b:
                    self.wfile.write(f'{len(b):x}\r\n'.encode() + b + b'\r\n')
                    self.wfile.flush()

            if first is not None:
                chunk(pcm16(first))
            for c in gen:
                chunk(pcm16(c))
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()

        def _endpoint(self):
            if state.turn is None:
                return self._json(503, {'error': 'smart-turn is not loaded'})
            body = self._body(MAX_TURN_BYTES)
            audio = read_turn_audio(body, self.headers.get('Content-Type', ''))
            if len(audio) < TURN_RATE // 10:
                raise ValueError('need at least 100 ms of audio')
            t0 = time.perf_counter()
            p = state.turn.predict(audio)
            return self._json(200, {'complete': p >= 0.5, 'probability': round(p, 4), 'ms': round((time.perf_counter() - t0) * 1000)})

    return Handler


class VoiceHTTPServer(ThreadingHTTPServer):
    """One owner of the port, on every OS. http.server sets SO_REUSEADDR, which on Windows
    (unlike POSIX) lets a second process bind and LISTEN on a port that is already listening:
    two services ran side by side, the stale one holding 1.3 GB of VRAM and answering some
    requests. Windows gets SO_EXCLUSIVEADDRUSE instead (and no SO_REUSEADDR), so the second
    bind fails with EADDRINUSE; POSIX keeps SO_REUSEADDR, which there only skips TIME_WAIT."""
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def health_answers(host, port, timeout=2.0):
    """True when a pa-voice already answers /health on host:port (loading or ready)."""
    try:
        with urllib.request.urlopen(f'http://{host}:{port}/health', timeout=timeout) as r:
            return 'ok' in json.loads(r.read().decode('utf8'))
    except Exception:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=int(os.environ.get('PA_VOICE_PORT', '47830')))
    ap.add_argument('--models', default=os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'personal-assistant', 'voice-models'))
    ap.add_argument('--voice', default=os.environ.get('PA_VOICE', 'bf_isabella'))
    ap.add_argument('--device', default='cuda')
    args = ap.parse_args(argv)
    if args.host not in ('127.0.0.1', 'localhost', '::1'):
        sys.exit('pa-voice binds loopback only')

    def log(msg):
        print(time.strftime('%H:%M:%S'), msg, flush=True)

    state = State()
    state.throttle_off = no_throttle()
    if health_answers(args.host, args.port):
        log(f'pa-voice is already running on http://{args.host}:{args.port}; not starting a second one')
        sys.exit(0)
    try:
        srv = VoiceHTTPServer((args.host, args.port), make_handler(state, log))
    except OSError as e:
        log(f'cannot bind {args.host}:{args.port} ({e}): another process owns the port; exiting')
        sys.exit(1)
    srv.daemon_threads = True
    log(f'pa-voice listening on http://{args.host}:{args.port} (loading models)')

    def load():
        try:
            turn_path = os.path.join(args.models, 'smart-turn-v3.2-cpu.onnx')
            if os.path.exists(turn_path):
                state.turn = Turn(turn_path)
                state.turn.predict(__import__('numpy').zeros(TURN_RATE, dtype='float32'))
                log('smart-turn loaded')
            else:
                log(f'no {turn_path}: /endpoint is off (run windows/install-voice.ps1 or linux/install-voice.sh)')
            state.tts = Tts(device=args.device, default_voice=args.voice, log=log)
            for _ in range(2):
                state.tts.warm()
            state.ready = True
            log(f'Kokoro ready on {state.tts.device} in {state.tts.load_s}s; warm sentence {state.tts.warm_ms} ms')
        except Exception as e:
            state.error = f'{type(e).__name__}: {e}'
            log(f'load failed: {state.error}')

    threading.Thread(target=load, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
