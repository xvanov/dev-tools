'use strict';

// The voice page's local engines (talk.html), browser only: window.TalkVoice.
//
//   loadOrt(base)            onnxruntime-web (WASM, one thread), served by the
//                            PA from PA_VOICE_MODELS at talk/models/ort/
//   createSilero(ort, base)  Silero VAD v5: 512 samples of 16 kHz -> P(speech)
//   createWakeWord(ort,base) openWakeWord "hey jarvis": 1280 samples (80 ms)
//                            of 16 kHz -> a score; three small models in a
//                            row (mel spectrogram -> speech embedding -> the
//                            wake-word classifier), ported from
//                            openwakeword/utils.py AudioFeatures
//   createKokoro(opts)       a speech backend for talk.page.js's table: the
//                            local Kokoro voice (POST api/talk/tts, 24 kHz
//                            16-bit PCM streamed), played through Web Audio
//   chime(ctx, kind)         the wake and sleep sounds
//
// Everything here runs in the page: the wake word and the VAD hear the room,
// and none of that audio leaves the browser. Pure logic (the prefetcher, the
// PCM decoder, the state machines) is in talk.core.js and tested there.

(function () {
  const C = window.TalkCore;

  // ---- onnxruntime-web ----------------------------------------------------------
  let ortPromise = null;
  function loadOrt(base) {
    if (ortPromise) return ortPromise;
    ortPromise = new Promise((resolve, reject) => {
      if (window.ort) return resolve(window.ort);
      const s = document.createElement('script');
      s.src = base + 'ort/ort.wasm.min.js';
      s.onload = () => (window.ort ? resolve(window.ort) : reject(new Error('onnxruntime-web did not load')));
      s.onerror = () => reject(new Error('onnxruntime-web is not installed (run windows/install-voice.ps1)'));
      document.head.appendChild(s);
    }).then((ort) => {
      ort.env.wasm.wasmPaths = new URL(base + 'ort/', location.href).href;
      // Threads need cross-origin isolation, which termhub's /pa/ proxy does
      // not give; one thread is plenty for these models.
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';
      return ort;
    });
    ortPromise.catch(() => (ortPromise = null));
    return ortPromise;
  }

  async function session(ort, url) {
    return ort.InferenceSession.create(url, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }

  // ---- Silero VAD v5 ------------------------------------------------------------------
  // As silero_vad's own OnnxWrapper: each 512-sample window is fed with the
  // previous window's last 64 samples in front, and the recurrent state is
  // carried from call to call.
  async function createSilero(ort, base) {
    const sess = await session(ort, base + 'silero_vad.onnx');
    const CTX = 64;
    const N = 512;
    let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    let context = new Float32Array(CTX);
    const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
    return {
      frame: N,
      async prob(samples) {
        const x = new Float32Array(CTX + N);
        x.set(context, 0);
        x.set(samples.subarray(0, N), CTX);
        context = x.slice(x.length - CTX);
        const out = await sess.run({ input: new ort.Tensor('float32', x, [1, CTX + N]), state, sr });
        state = out.stateN;
        return out.output.data[0];
      },
      reset() {
        state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
        context = new Float32Array(CTX);
      },
    };
  }

  // ---- openWakeWord: "hey jarvis" ---------------------------------------------------------
  // Per 80 ms (1280 samples, as int16 values in float32, which is what the
  // mel model was exported for): the mel model over the last 1280 + 480
  // samples gives 8 new frames of 32 mel bins (scaled x/10 + 2); the
  // embedding model over the last 76 mel frames gives one 96-d feature; the
  // classifier scores the last 16 features (~1.3 s).
  async function createWakeWord(ort, base, model = 'hey_jarvis_v0.1.onnx') {
    const [mel, emb, cls] = await Promise.all([
      session(ort, base + 'melspectrogram.onnx'),
      session(ort, base + 'embedding_model.onnx'),
      session(ort, base + model),
    ]);
    const FRAME = 1280;
    const RAW = FRAME + 480;
    const MEL_WIN = 76;
    const FEATS = 16;
    let raw = new Float32Array(RAW);
    let mels = [];
    let feats = [];
    function reset() {
      raw = new Float32Array(RAW);
      mels = Array.from({ length: MEL_WIN }, () => new Float32Array(32).fill(1));
      feats = Array.from({ length: FEATS }, () => new Float32Array(96));
    }
    reset();
    const melIn = mel.inputNames[0];
    const embIn = emb.inputNames[0];
    const clsIn = cls.inputNames[0];
    return {
      frame: FRAME,
      reset,
      // samples: 1280 floats in -1..1 at 16 kHz -> score 0..1
      async score(samples) {
        raw.copyWithin(0, FRAME);
        for (let i = 0; i < FRAME; i++) raw[RAW - FRAME + i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
        const m = await mel.run({ [melIn]: new ort.Tensor('float32', raw.slice(), [1, RAW]) });
        const spec = m[mel.outputNames[0]];
        const n = spec.data.length / 32;
        for (let f = 0; f < n; f++) {
          const row = new Float32Array(32);
          for (let b = 0; b < 32; b++) row[b] = spec.data[f * 32 + b] / 10 + 2;
          mels.push(row);
        }
        if (mels.length > MEL_WIN) mels = mels.slice(mels.length - MEL_WIN);
        const win = new Float32Array(MEL_WIN * 32);
        for (let f = 0; f < MEL_WIN; f++) win.set(mels[f], f * 32);
        const e = await emb.run({ [embIn]: new ort.Tensor('float32', win, [1, MEL_WIN, 32, 1]) });
        feats.push(Float32Array.from(e[emb.outputNames[0]].data));
        if (feats.length > FEATS) feats.shift();
        const x = new Float32Array(FEATS * 96);
        for (let f = 0; f < FEATS; f++) x.set(feats[f], f * 96);
        const s = await cls.run({ [clsIn]: new ort.Tensor('float32', x, [1, FEATS, 96]) });
        return s[cls.outputNames[0]].data[0];
      },
    };
  }

  // ---- Kokoro through the PA -------------------------------------------------------------
  // A backend for talk.page.js's TTS table: speak() reports the audio, not
  // the request — onstart when the first sample is audible, onlevel with an
  // AnalyserNode's loudness every ~40 ms (the face's mouth), onend when the
  // last sample has played. While one sentence plays, the next is already
  // being fetched (prefetch), so sentences follow each other without the
  // ~250 ms synthesis gap. Audio is played as it streams in.
  function createKokoro({ getCtx, voice }) {
    const jobs = C.createPrefetcher({ depth: 2, start: startFetch, abort: (j) => j.abort() });
    let playing = null; // { sources, timers, stop() }

    function startFetch(text) {
      const ac = new AbortController();
      const job = { chunks: [], done: false, error: null, wake: null, abort: () => ac.abort(), t0: performance.now(), firstMs: null };
      const notify = () => job.wake && job.wake();
      (async () => {
        const res = await fetch('api/talk/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-PA': '1' },
          body: JSON.stringify({ text, voice: voice() }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw Object.assign(new Error(data.error || `tts answered ${res.status}`), { status: res.status });
        }
        const dec = C.createPcmDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const f = dec.push(value);
          if (f.length) {
            if (job.firstMs == null) job.firstMs = performance.now() - job.t0;
            job.chunks.push(f);
            notify();
          }
        }
      })().then(
        () => {
          job.done = true;
          notify();
        },
        (err) => {
          job.error = err;
          job.done = true;
          notify();
        }
      );
      return job;
    }

    function stopPlaying() {
      if (!playing) return;
      const p = playing;
      playing = null;
      p.stop();
    }

    return {
      label: 'Kokoro (local neural voice)',
      healthy: false,
      list: [],
      available() {
        return this.healthy;
      },
      voices() {
        return this.list.map((v) => ({ id: v.id, label: `${v.label}` }));
      },
      bestVoice() {
        return this.defaultVoice || 'bf_isabella';
      },
      prefetch(text) {
        jobs.prefetch(text);
      },
      lastFirstMs: null,
      speak(text, { onstart, onlevel, onend, onfail }) {
        stopPlaying();
        const ctx = getCtx();
        const job = jobs.get(text);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.connect(ctx.destination);
        const buf = new Float32Array(analyser.fftSize);
        const sources = [];
        const timers = [];
        let next = 0; // where the next chunk starts, in ctx time
        let used = 0; // chunks scheduled
        let started = false;
        let finished = false;
        const self = this;
        const p = {
          stop() {
            finished = true;
            job.wake = null;
            job.abort();
            for (const t of timers) clearTimeout(t);
            clearInterval(levelTimer);
            for (const s of sources) {
              try {
                s.onended = null;
                s.stop();
              } catch {
                /* not started */
              }
            }
            try {
              analyser.disconnect();
            } catch {
              /* gone */
            }
          },
        };
        playing = p;
        const finish = () => {
          if (finished) return;
          p.stop();
          if (playing === p) playing = null;
          onend();
        };
        const levelTimer = setInterval(() => {
          if (!started) return;
          analyser.getFloatTimeDomainData(buf);
          onlevel(C.rms(buf));
        }, 40);
        function pump() {
          if (finished) return;
          if (job.error && !used) {
            // Nothing played: the service failed. The page falls back (onfail)
            // to the browser's voice for this sentence.
            finished = true;
            p.stop();
            if (playing === p) playing = null;
            self.healthy = false;
            if (onfail) onfail(job.error);
            else onend();
            return;
          }
          while (used < job.chunks.length) {
            const data = job.chunks[used++];
            const b = ctx.createBuffer(1, data.length, 24000);
            b.copyToChannel(data, 0);
            const s = ctx.createBufferSource();
            s.buffer = b;
            s.connect(analyser);
            const at = Math.max(next, ctx.currentTime + 0.02);
            s.start(at);
            next = at + b.duration;
            sources.push(s);
            if (!started) {
              started = true;
              self.lastFirstMs = job.firstMs;
              timers.push(setTimeout(() => !finished && onstart('kokoro:' + voice()), Math.max(0, (at - ctx.currentTime) * 1000)));
            }
          }
          if (job.done) {
            // Everything is scheduled: end when the last sample has played.
            const left = Math.max(0, (next - ctx.currentTime) * 1000);
            timers.push(setTimeout(finish, left + 30));
            job.wake = null;
          }
        }
        job.wake = pump;
        pump();
      },
      cancel() {
        jobs.clear();
        stopPlaying();
      },
    };
  }

  // ---- Sounds ----------------------------------------------------------------------------
  // Woken: two rising notes. Asleep: one falling. Quiet, short, synthesised.
  function chime(ctx, kind = 'wake') {
    if (!ctx || ctx.state !== 'running') return;
    const notes = kind === 'wake' ? [[660, 0], [990, 0.09]] : [[700, 0], [440, 0.1]];
    for (const [f, t] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const at = ctx.currentTime + t;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.07, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.18);
    }
  }

  window.TalkVoice = { loadOrt, createSilero, createWakeWord, createKokoro, chime };
})();
