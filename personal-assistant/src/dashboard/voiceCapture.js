// Mic capture for server-side transcription: getUserMedia -> AudioWorklet (or
// ScriptProcessor) -> 16 kHz mono -> energy VAD -> one WAV per utterance.
//
// Shared code, deliberately free of termhub: web/app.js drives it for the 🎤
// button, and the PA's /talk page can load the same file (it is served at
// `/voiceCapture.js` on the termhub origin the PA is proxied under) instead of
// keeping its own copy. The VAD, the box-filter downsample and the WAV encoder
// started life in personal-assistant/src/dashboard/talk.core.js.
//
// Two halves:
//   - pure (node-testable, test/voiceCapture.test.js): createResampler,
//     encodeWav, rms, createVad, createUtteranceRecorder, isNoise.
//   - browser: createMicCapture (the audio graph), createMicOwner (one tab
//     holds the mic: BroadcastChannel 'voice-mic'), createWakeLock.
//
// UMD so a classic <script> gets `window.VoiceCapture` and node gets
// module.exports.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceCapture = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TARGET_RATE = 16000;

  // ---- resampling -------------------------------------------------------------
  //
  // Phones capture at 48 kHz (iOS) or 44.1 kHz (some Android); whisper wants
  // 16 kHz. Don't ask the AudioContext for 16 kHz: iOS ignores or rejects it.
  // Streaming, so the fractional position carries across chunks — resampling
  // each 1024-sample chunk on its own drifts at 44.1 kHz, where the ratio is
  // not a whole number. Each output sample is the average of the source
  // samples it covers: a box low-pass, cheap and enough against aliasing for
  // speech.
  function createResampler(fromRate, toRate) {
    toRate = toRate || TARGET_RATE;
    const ratio = fromRate / toRate;
    let carry = new Float32Array(0);
    let pos = 0;
    return {
      ratio,
      push(chunk) {
        if (ratio === 1) return Float32Array.from(chunk);
        const all = new Float32Array(carry.length + chunk.length);
        all.set(carry, 0);
        all.set(chunk, carry.length);
        const out = [];
        while (pos + ratio <= all.length) {
          const a = Math.floor(pos);
          const b = Math.floor(pos + ratio);
          let sum = 0;
          for (let j = a; j < b; j++) sum += all[j];
          out.push(b > a ? sum / (b - a) : all[a]);
          pos += ratio;
        }
        const keep = Math.floor(pos);
        carry = all.slice(keep);
        pos -= keep;
        return Float32Array.from(out);
      },
      reset() {
        carry = new Float32Array(0);
        pos = 0;
      },
    };
  }

  // ---- WAV ----------------------------------------------------------------------
  //
  // 16-bit PCM mono: ~32 KB per second at 16 kHz, and decodes without ffmpeg
  // having to guess at a container.
  function encodeWav(samples, sampleRate) {
    sampleRate = sampleRate || TARGET_RATE;
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (off, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return buf;
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
  }

  // ---- energy VAD ---------------------------------------------------------------
  //
  // States: silence -> maybe (loud, not yet long enough) -> speech -> silence.
  // The threshold follows the room: a noise floor tracked while quiet, times
  // floorRatio, never under minThreshold. `endMs` of quiet after the last
  // voiced frame ends the utterance (700 ms by default, clamped to 400-1500);
  // an utterance shorter than minUtteranceMs is a cough or a click: 'cancel'.
  // While our own audio is playing (`echo`), the bar is raised by echoFactor.
  const VAD_DEFAULTS = {
    minThreshold: 0.012,
    floorRatio: 3,
    floorAlpha: 0.05,
    echoFactor: 3,
    startMs: 150,
    bargeInMs: 350,
    endMs: 700,
    minUtteranceMs: 350,
    maxUtteranceMs: 30000,
  };
  const END_MS_MIN = 400;
  const END_MS_MAX = 1500;

  function createVad(opts) {
    const o = Object.assign({}, VAD_DEFAULTS, opts || {});
    o.endMs = Math.min(END_MS_MAX, Math.max(END_MS_MIN, Number(o.endMs) || VAD_DEFAULTS.endMs));
    let floor = o.minThreshold / o.floorRatio;
    let state = 'silence';
    let since = 0;
    let lastVoice = 0;
    let voicedMs = 0;
    let startedAt = 0;

    function threshold(echo) {
      const t = Math.max(o.minThreshold, floor * o.floorRatio);
      return echo ? t * o.echoFactor : t;
    }

    return {
      get state() { return state; },
      get floor() { return floor; },
      get lastVoice() { return lastVoice; },
      get endMs() { return o.endMs; },
      threshold,
      // One frame. 'start' when speech begins, 'end' when it has finished,
      // 'cancel' when it was too short to be words, else null.
      step(level, now, frameMs, ctx) {
        const echo = !!(ctx && ctx.echo);
        const loud = level > threshold(echo);
        if (!loud && state !== 'speech') floor = floor + o.floorAlpha * (Math.min(level, floor * 4 || level) - floor);
        if (state === 'silence') {
          if (loud) {
            state = 'maybe';
            since = now;
            voicedMs = frameMs;
            lastVoice = now;
          }
          return null;
        }
        if (state === 'maybe') {
          if (loud) {
            voicedMs += frameMs;
            lastVoice = now;
          }
          if (now - lastVoice > 200) {
            state = 'silence';
            return null;
          }
          if (voicedMs >= (echo ? o.bargeInMs : o.startMs)) {
            state = 'speech';
            startedAt = since;
            return 'start';
          }
          return null;
        }
        if (level > threshold(false)) lastVoice = now;
        if (now - startedAt >= o.maxUtteranceMs) {
          state = 'silence';
          // Thirty seconds without a pause is a fan or music more often than a
          // person: take its level as the room's, or it is sent again and again.
          floor = Math.max(floor, (level * 1.1) / o.floorRatio);
          return 'end';
        }
        if (now - lastVoice >= o.endMs) {
          state = 'silence';
          return lastVoice - startedAt >= o.minUtteranceMs ? 'end' : 'cancel';
        }
        return null;
      },
      reset() { state = 'silence'; },
    };
  }

  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // ---- utterances -----------------------------------------------------------------
  //
  // Feed it 16 kHz chunks; it hands back whole utterances.
  //   mode 'vad'     hands-free: the VAD decides where an utterance starts and
  //                  ends. A pre-roll (preRollMs) is kept so the first syllable
  //                  — heard before the VAD was sure — is not clipped.
  //   mode 'manual'  push-to-talk: everything between start and flush() is the
  //                  utterance; the VAD only measures whether anything was said
  //                  (a release after silence sends nothing — whisper turns
  //                  silence into "Thank you.").
  // push() returns null or one event: {type:'start'}, {type:'end', samples},
  // {type:'cancel'}. flush() ends whatever is in progress: {samples} or null.
  function createUtteranceRecorder(opts) {
    const o = Object.assign({ mode: 'vad', rate: TARGET_RATE, preRollMs: 300, minVoicedMs: 200, maxManualMs: 60000 }, opts || {});
    const vad = createVad(o.vad);
    let pre = [];
    let preLen = 0;
    let chunks = [];
    let recording = o.mode === 'manual';
    let voicedMs = 0;
    let totalMs = 0;
    const preMax = Math.round((o.preRollMs / 1000) * o.rate);

    function take() {
      const samples = concat(chunks);
      chunks = [];
      return samples;
    }

    return {
      vad,
      get mode() { return o.mode; },
      get recording() { return recording; },
      push(samples, now) {
        const frameMs = (samples.length / o.rate) * 1000;
        const level = rms(samples);
        if (o.mode === 'manual') {
          chunks.push(samples);
          totalMs += frameMs;
          if (level > vad.threshold(false)) voicedMs += frameMs;
          vad.step(level, now, frameMs);
          if (totalMs >= o.maxManualMs) {
            const out = this.flush();
            return out ? { type: 'end', samples: out.samples } : { type: 'cancel' };
          }
          return null;
        }
        const ev = vad.step(level, now, frameMs);
        if (!recording) {
          pre.push(samples);
          preLen += samples.length;
          while (pre.length > 1 && preLen - pre[0].length >= preMax) preLen -= pre.shift().length;
          if (ev === 'start') {
            recording = true;
            chunks = pre;
            pre = [];
            preLen = 0;
            return { type: 'start' };
          }
          return null;
        }
        chunks.push(samples);
        if (ev === 'end') {
          recording = false;
          return { type: 'end', samples: take() };
        }
        if (ev === 'cancel') {
          recording = false;
          chunks = [];
          return { type: 'cancel' };
        }
        return null;
      },
      flush() {
        if (o.mode === 'manual') {
          const enough = voicedMs >= o.minVoicedMs;
          const samples = take();
          voicedMs = 0;
          totalMs = 0;
          return enough && samples.length ? { samples } : null;
        }
        if (!recording) return null;
        recording = false;
        vad.reset();
        const samples = take();
        return samples.length ? { samples } : null;
      },
    };
  }

  // Whisper fills silence and noise with stock phrases from its training
  // subtitles. A transcript that is only one of these is dropped, not typed.
  const HALLUCINATIONS = new Set([
    '', 'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching',
    'thank you for watching', 'bye', 'uh', 'um', 'hmm',
    'please subscribe', 'subtitles by the amara.org community',
  ]);

  function isNoise(text) {
    const t = String(text || '').toLowerCase().replace(/[^a-z0-9.' ]+/g, ' ').replace(/[.]+$/g, '').replace(/\s+/g, ' ').trim();
    return HALLUCINATIONS.has(t) || !/[a-z0-9]/.test(t);
  }

  // ---- browser: the audio graph ------------------------------------------------------
  //
  // `ctx` is an AudioContext the caller created and resumed INSIDE the user's
  // tap (iOS only lets a context run from a gesture; create it after an
  // `await getUserMedia` and it may stay suspended). getUserMedia itself needs
  // no gesture. AudioWorklet where the browser has it, ScriptProcessor (old
  // Safari) otherwise. onSamples gets Float32 chunks at ctx.sampleRate.
  // onEnded(reason) fires when the OS takes the mic away (a call, Siri, the
  // tab losing the device) — the track ends, nothing errors.
  const workletLoaded = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function createMicCapture(opts) {
    const o = Object.assign({ workletUrl: '/micWorklet.js' }, opts || {});
    let stream = null;
    let source = null;
    let node = null;
    let sink = null;
    let stopped = false;

    async function start() {
      stopped = false;
      const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
      if (!md || !md.getUserMedia) {
        const err = new Error('getUserMedia is not available here (an insecure origin?)');
        err.name = 'NotSupportedError';
        throw err;
      }
      stream = await md.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (stopped) { stop(); throw Object.assign(new Error('stopped while opening'), { name: 'AbortError' }); }
      const ctx = o.ctx;
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* reported below */ } }
      source = ctx.createMediaStreamSource(stream);
      // Muted output: ScriptProcessor only runs while connected to the
      // destination, and some engines pull a worklet only when it is too.
      sink = ctx.createGain();
      sink.gain.value = 0;
      let via = 'script-processor';
      if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        try {
          if (!workletLoaded.get(ctx)) {
            workletLoaded.set(ctx, ctx.audioWorklet.addModule(o.workletUrl));
          }
          await workletLoaded.get(ctx);
          node = new AudioWorkletNode(ctx, 'termhub-mic', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
          node.port.onmessage = (ev) => { if (!stopped) o.onSamples(ev.data, ctx.sampleRate); };
          via = 'worklet';
        } catch (e) {
          workletLoaded.delete(ctx);
          node = null;
        }
      }
      if (!node) {
        node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (ev) => {
          if (!stopped) o.onSamples(new Float32Array(ev.inputBuffer.getChannelData(0)), ctx.sampleRate);
        };
      }
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      for (const t of stream.getAudioTracks()) {
        t.onended = () => { if (!stopped && o.onEnded) o.onEnded('track-ended'); };
      }
      return { via, rate: ctx.sampleRate, state: ctx.state };
    }

    function stop() {
      stopped = true;
      try { if (source) source.disconnect(); } catch (e) {}
      try { if (node) { node.disconnect(); if (node.port) node.port.onmessage = null; else node.onaudioprocess = null; } } catch (e) {}
      try { if (sink) sink.disconnect(); } catch (e) {}
      if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch (e) {} }
      stream = source = node = sink = null;
    }

    return { start, stop, get active() { return !!stream && !stopped; } };
  }

  // ---- browser: one tab holds the mic ---------------------------------------------------
  //
  // Two tabs on the same origin (termhub and the PA's /talk, which is proxied
  // under /pa/ on the same origin) each holding a mic stream: on iOS the second
  // one's capture is taken away or fails with `audio-capture`. Protocol, on
  // BroadcastChannel 'voice-mic': {type:'claim', owner, app} when a tab opens
  // the mic; every other holder releases and calls onTaken({app}).
  function createMicOwner(opts) {
    const o = Object.assign({ app: 'termhub', channel: 'voice-mic' }, opts || {});
    const owner = `${o.app}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    let holding = false;
    let bc = null;
    try { bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(o.channel) : null; } catch (e) { bc = null; }
    if (bc) {
      bc.onmessage = (ev) => {
        const m = ev && ev.data;
        if (!m || m.type !== 'claim' || m.owner === owner || !holding) return;
        holding = false;
        if (o.onTaken) o.onTaken({ app: m.app || 'another tab' });
      };
    }
    return {
      owner,
      get holding() { return holding; },
      claim() {
        holding = true;
        if (bc) { try { bc.postMessage({ type: 'claim', owner, app: o.app }); } catch (e) {} }
      },
      release() { holding = false; },
      close() { holding = false; if (bc) { try { bc.close(); } catch (e) {} } },
    };
  }

  // ---- browser: keep the screen on while listening ------------------------------------
  //
  // A phone that locks mid-dictation suspends the page and kills capture.
  // Screen Wake Lock (iOS 16.4+, Chrome) stops the auto-lock; the browser drops
  // it by itself when the page is hidden. Failure is silent: it is a nicety.
  function createWakeLock() {
    let lock = null;
    let want = false;
    return {
      async acquire() {
        want = true;
        if (lock || typeof navigator === 'undefined' || !navigator.wakeLock) return false;
        try {
          lock = await navigator.wakeLock.request('screen');
          lock.addEventListener('release', () => { lock = null; });
          if (!want) { try { await lock.release(); } catch (e) {} lock = null; }
          return true;
        } catch (e) {
          lock = null;
          return false;
        }
      },
      release() {
        want = false;
        const l = lock;
        lock = null;
        if (l) { try { l.release(); } catch (e) {} }
      },
      get held() { return !!lock; },
    };
  }

  return {
    TARGET_RATE,
    VAD_DEFAULTS,
    END_MS_MIN,
    END_MS_MAX,
    createResampler,
    encodeWav,
    rms,
    createVad,
    createUtteranceRecorder,
    isNoise,
    createMicCapture,
    createMicOwner,
    createWakeLock,
  };
});
