'use strict';

// The voice page (talk.html): mic -> 16 kHz -> wake word / VAD / end of turn
// -> /api/talk/transcribe -> /api/talk/turn (the fast lane: a quick spoken
// reply, and a hand-off to the PA chat when it needs one; /api/chat directly
// when the fast lane is off); /api/chat/stream -> sentences -> TTS (the local
// Kokoro voice, or the browser's); and a face that shows which of those is
// happening. Pure logic is in talk.core.js (window.TalkCore); the local
// engines (onnxruntime-web models, Kokoro playback) in talk.voice.js
// (window.TalkVoice); the mic graph is termhub's voiceCapture.js
// (window.VoiceCapture, served here as talk.capture.js).

(function () {
  const C = window.TalkCore;
  const V = window.TalkVoice;
  const VC = window.VoiceCapture;
  const $ = (id) => document.getElementById(id);
  const TOUCH = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const MODELS = 'talk/models/';

  // ---- Settings (per-browser conveniences only) ---------------------------
  const PREFS_KEY = 'pa-talk-prefs';
  const PREFS_VERSION = 2;
  const prefs = Object.assign(
    {
      v: PREFS_VERSION,
      handsFree: !TOUCH, // phones: hold to talk
      deafWhileTalking: false,
      muted: false,
      threshold: C.VAD_DEFAULTS.minThreshold,
      endMs: C.VAD_DEFAULTS.endMs,
      voiceMode: 'auto',
      tts: 'auto',
      voice: '',
      kokoroVoice: '',
      wake: C.wakeDefault({ coarsePointer: TOUCH }),
      smartTurn: true,
    },
    (() => {
      try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      } catch {
        return {};
      }
    })()
  );
  // Version 1 saved tts: 'browser' for everyone (it was the only engine) and
  // hands-free on phones too: the local voice and hold-to-talk are the new defaults.
  if (!(prefs.v >= PREFS_VERSION)) {
    prefs.v = PREFS_VERSION;
    prefs.tts = 'auto';
    if (TOUCH) prefs.handsFree = false;
    if (prefs.wake == null) prefs.wake = C.wakeDefault({ coarsePointer: TOUCH });
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private window: settings just do not stick */
    }
  }

  // ---- The face -------------------------------------------------------------
  const st = { listening: false, talking: false, thinking: false, offline: false, concernedUntil: 0, happyUntil: 0, level: 0, pending: 0 };
  const EXPR = {
    idle: { brows: '  ', eyes: 'oo', mouth: ' \\_/ ' },
    asleep: { brows: '  ', eyes: '--', mouth: ' --- ' },
    awake: { brows: '  ', eyes: 'OO', mouth: '  o  ' },
    listening: { brows: '  ', eyes: 'OO', mouth: ' --- ' },
    thinking: { brows: '~~', eyes: '°°', mouth: '  ~  ' },
    // Sound is on its way (a natural voice is still being fetched): eyes up,
    // mouth shut — it never moves before the audio does.
    about: { brows: '  ', eyes: '°°', mouth: ' --- ' },
    talking: { brows: '  ', eyes: 'oo', mouth: ' --- ' },
    happy: { brows: '  ', eyes: '^^', mouth: '\\___/' },
    concerned: { brows: '/\\', eyes: 'oo', mouth: ' .-. ' },
  };
  // By openness, 0 (closed) to 3 (wide): TalkCore.createSpeechSync's mouth.
  const MOUTHS = [' --- ', ' -o- ', ' (o) ', ' (O) '];
  const MOOD = { idle: '', asleep: 'say "hey Jarvis"', awake: 'yes?', listening: 'listening', thinking: 'thinking', about: '', talking: '', happy: '', concerned: '' };
  const sync = C.createSpeechSync();
  let blinkUntil = 0;
  let nextBlink = Date.now() + 2500;
  let glance = 0;
  let nextGlance = Date.now() + 6000;
  let tick = 0;

  function currentExpr(now, f) {
    return C.expression({
      listening: st.listening,
      talking: f.face === 'talking',
      about: f.face === 'about',
      thinking: st.thinking || st.pending > 0,
      concerned: st.offline || now < st.concernedUntil,
      happy: now < st.happyUntil,
      awake: mic.on && conv.state === 'awake',
      asleep: mic.on && conv.state === 'asleep',
    });
  }

  function drawFace() {
    const now = Date.now();
    tick++;
    const f = sync.frame(now);
    const expr = currentExpr(now, f);
    const e = EXPR[expr];
    if (now > nextBlink) {
      blinkUntil = now + 140;
      nextBlink = now + 2500 + Math.random() * 4000;
    }
    if (now > nextGlance) {
      glance = expr === 'idle' ? [-1, 0, 1][Math.floor(Math.random() * 3)] : 0;
      nextGlance = now + 3000 + Math.random() * 6000;
    }
    const blink = now < blinkUntil && expr !== 'happy' && expr !== 'asleep';
    const eyeL = blink ? '-' : e.eyes[0];
    const eyeR = blink ? '-' : e.eyes[1];
    let mouth = e.mouth;
    if (expr === 'talking') mouth = MOUTHS[f.mouth] || MOUTHS[0];
    const dx = expr === 'thinking' ? 1 : glance;
    const row = (tpl, a, b, at = 5) => {
      const chars = tpl.split('');
      chars[at + dx] = a;
      chars[at + 6 + dx] = b;
      return chars.join('');
    };
    // Right-hand margin: thought dots while thinking, sound marks while
    // listening, a slow z while asleep.
    const dots = expr === 'thinking' ? ' ' + '.'.repeat(1 + (Math.floor(tick / 4) % 3)) : expr === 'asleep' ? ' ' + 'z'.repeat(1 + (Math.floor(tick / 12) % 3)) : '';
    const lvl = st.listening || expr === 'awake' ? Math.min(3, Math.round(st.level / Math.max(prefs.threshold, 0.001))) : 0;
    const wave = lvl ? ' ' + ')'.repeat(lvl) : '';
    const lines = [
      '   .---------.   ' + dots,
      row('  /           \\  ', e.brows[0] === ' ' ? ' ' : e.brows[0], e.brows[1] === ' ' ? ' ' : e.brows[1]),
      row(' |             | ', eyeL, eyeR) + wave,
      ' |             | ',
      ' |    ' + mouth + '    | ',
      '  \\           /  ',
      "   '---------'   ",
    ];
    const face = $('face');
    face.textContent = lines.join('\n');
    face.dataset.expr = expr;
    $('mood').textContent = MOOD[expr] || '';
    const bar = $('levelBar');
    if (bar) {
      bar.style.width = Math.min(100, (st.level / 0.06) * 100) + '%';
      $('threshMark').style.left = Math.min(100, (prefs.threshold / 0.06) * 100) + '%';
    }
  }

  function concerned(msg, ms = 5000) {
    st.concernedUntil = ms ? Date.now() + ms : Infinity; // 0: until the page is reloaded
    if (msg) notice(msg, ms);
  }
  let noticeTimer = null;
  function notice(msg, ms = 6000) {
    $('notice').textContent = msg || '';
    clearTimeout(noticeTimer);
    if (msg && ms) noticeTimer = setTimeout(() => ($('notice').textContent = ''), ms);
  }
  let heardTimer = null;
  function heard(text) {
    $('heard').textContent = text ? `“${text}”` : '';
    clearTimeout(heardTimer);
    if (text) heardTimer = setTimeout(() => ($('heard').textContent = ''), 12000);
  }

  // ---- Audio: one context for the mic and the voice ---------------------------
  //
  // Browsers start audio only after a gesture, unless the site is allowed to
  // play sound (an Edge app window with Sound: Allow; see the README). The
  // context is created at once and resumed: running -> no tap needed;
  // suspended -> one "tap once to enable Jarvis" prompt. On iOS the context
  // must be resumed and a sound started inside the tap itself, before any
  // await (unlockAudio).
  const audio = { ctx: null };
  function audioCtx() {
    if (!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return audio.ctx;
  }
  // Inside a gesture, synchronously.
  function unlockAudio() {
    const ctx = audioCtx();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    try {
      const b = ctx.createBuffer(1, 1, 22050);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    } catch {
      /* nothing to unlock */
    }
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  }

  // ---- Speech out -------------------------------------------------------------
  //
  // A backend speaks one sentence at a time and reports what the audio does,
  // not what was asked of it:
  //   speak(text, { onstart(voiceKey), onboundary(charLength), onlevel(0..1), onend, onfail? })
  //   cancel(), prefetch?(text)
  // onstart when sound begins, onend when it stops. onboundary per spoken
  // word where the engine knows (speechSynthesis does), onlevel with loudness
  // where the engine plays audio itself (Kokoro: Web Audio and an
  // AnalyserNode). The face follows these (TalkCore.createSpeechSync).
  const TTS_BACKENDS = {
    kokoro: V.createKokoro({ getCtx: audioCtx, voice: () => prefs.kokoroVoice || TTS_BACKENDS.kokoro.bestVoice() }),
    browser: {
      label: 'Browser (speechSynthesis)',
      available: () => 'speechSynthesis' in window,
      voices() {
        return speechSynthesis.getVoices().map((v) => ({ id: v.voiceURI, label: `${v.name} (${v.lang})`, v }));
      },
      // Natural/neural voices first (Edge's "… Online (Natural)", Chrome's
      // Google voices), in the page's language.
      bestVoice() {
        const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
        const score = ({ v }) =>
          (v.lang.toLowerCase().startsWith(lang) ? 10 : v.lang.toLowerCase().startsWith('en') ? 5 : 0) +
          (/natural/i.test(v.name) ? 6 : 0) + (/neural/i.test(v.name) ? 5 : 0) + (/online/i.test(v.name) ? 2 : 0) +
          (/google/i.test(v.name) ? 3 : 0) + (v.default ? 1 : 0);
        const all = this.voices().sort((a, b) => score(b) - score(a));
        return all[0] ? all[0].id : '';
      },
      speak(text, { onstart, onboundary, onend }) {
        const u = new SpeechSynthesisUtterance(text);
        const pick = this.voices().find((x) => x.id === (prefs.voice || this.bestVoice()));
        if (pick) {
          u.voice = pick.v;
          u.lang = pick.v.lang;
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(guard);
          onend();
        };
        // onend is not always fired (Chrome drops it for some voices).
        const guard = setTimeout(finish, 4000 + text.length * 120);
        u.onstart = () => onstart(pick ? pick.id : 'default');
        // Word boundaries are when a word is actually being said. Edge's
        // natural voices send them; some voices send none (the face loops).
        u.onboundary = (ev) => {
          if (ev.name && ev.name !== 'word') return;
          const len = ev.charLength || (/^\S+/.exec(text.slice(ev.charIndex || 0)) || [''])[0].length;
          onboundary(len);
        };
        u.onend = finish;
        u.onerror = finish;
        this._keep = u; // an utterance that is garbage-collected never ends
        speechSynthesis.speak(u);
      },
      cancel() {
        if ('speechSynthesis' in window) speechSynthesis.cancel();
      },
    },
  };
  const ttsName = () => C.chooseTts(prefs.tts, { kokoro: TTS_BACKENDS.kokoro.healthy, browser: TTS_BACKENDS.browser.available() }) || 'browser';

  const speaker = {
    queue: [],
    busy: false,
    lastEnd: 0,
    gen: 0, // a cancelled sentence's late onend must not end the next one
    backend() {
      return TTS_BACKENDS[ttsName()];
    },
    say(sentences) {
      for (const s of sentences) {
        if (prefs.muted) caption(s);
        else this.queue.push(s);
      }
      this.next();
      this.ahead();
    },
    // The next sentence is synthesised while this one plays.
    ahead() {
      const b = this.backend();
      if (b.prefetch && this.busy && this.queue.length) b.prefetch(this.queue[0]);
    },
    get speaking() {
      return this.busy || this.queue.length > 0;
    },
    next() {
      if (this.busy) return;
      const s = this.queue.shift();
      if (!s) {
        if (st.talking) {
          st.talking = false;
          sync.done();
          this.lastEnd = Date.now();
          st.happyUntil = Date.now() + 1800;
        }
        return;
      }
      this.busy = true;
      st.talking = true;
      caption(s);
      const gen = this.gen;
      const live = () => gen === this.gen;
      sync.queued();
      const name = ttsName();
      const handlers = {
        onstart: (key) => {
          if (!live()) return;
          sync.start(Date.now(), key);
          latency.audio(name === 'kokoro' ? TTS_BACKENDS.kokoro.lastFirstMs : null, name);
        },
        onboundary: (len) => live() && sync.boundary(Date.now(), len),
        onlevel: (lv) => live() && sync.level(Date.now(), lv),
        onend: () => {
          if (!live()) return;
          sync.end();
          this.busy = false;
          this.lastEnd = Date.now();
          this.next();
          this.ahead();
        },
        // Kokoro failed before a sound: this sentence in the browser's voice,
        // and the next ones too until the service answers healthy again.
        onfail: (err) => {
          if (!live()) return;
          voiceInfo.recheckSoon();
          if (TTS_BACKENDS.browser.available()) TTS_BACKENDS.browser.speak(s, handlers);
          else handlers.onend();
          if (err && err.status !== 503) console.warn('[talk] kokoro failed', err);
        },
      };
      TTS_BACKENDS[name].speak(s, handlers);
      this.ahead();
    },
    // Barge-in: the user started talking. Drop everything queued.
    cancel() {
      if (!st.talking && !this.queue.length) return;
      this.queue = [];
      this.gen++;
      for (const b of Object.values(TTS_BACKENDS)) b.cancel();
      this.busy = false;
      st.talking = false;
      sync.cancel();
      this.lastEnd = Date.now();
    },
    // The assistant's own voice may still be in the room for a moment.
    echoing() {
      return st.talking || Date.now() - this.lastEnd < 400;
    },
  };
  function caption(s) {
    $('caption').textContent = s;
  }

  // ---- What the local voice stack offers (GET api/talk/voice) -------------------------
  const voiceInfo = {
    data: null,
    timer: null,
    async check() {
      try {
        const r = await fetch('api/talk/voice');
        this.data = r.ok ? await r.json() : null;
      } catch {
        this.data = null;
      }
      const d = this.data || {};
      const k = TTS_BACKENDS.kokoro;
      k.healthy = !!(d.tts && d.tts.ok);
      k.list = d.voices || [];
      k.defaultVoice = d.defaultVoice || 'bf_isabella';
      fillBackends();
      fillVoices();
      return d;
    },
    recheckSoon() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.check(), 30000);
    },
  };

  // ---- Latency readout (?debug=1) ---------------------------------------------------
  // One set of wall-clock marks per turn (TalkCore.latencySlices names them);
  // the last few turns are shown under the face and logged to the console.
  const DEBUG = /[?&]debug=1\b/.test(location.search);
  const latency = {
    marks: null,
    rows: [],
    all: [],
    begin(m) {
      this.marks = Object.assign({}, m);
    },
    set(k, at = Date.now()) {
      if (this.marks && this.marks[k] == null) this.marks[k] = at;
    },
    // The first audio after the first reply closes the turn's row.
    audio(ttsMs, engine) {
      const m = this.marks;
      if (!m || m.firstReply == null || m.audioStart != null) return;
      m.audioStart = Date.now();
      m.tts = engine;
      if (ttsMs != null) m.ttsFirstMs = Math.round(ttsMs);
      this.all.push(m);
      window.__talkLatency = this.all; // for scripted measurement
      this.row(C.formatLatency(m), m);
    },
    // A fast-lane hand-off: the PA chat's first block, timed from the transcript.
    slow() {
      const m = this.marks;
      if (!m || !m.route || m.route === 'answer' || m.slowReply != null || m.transcribed == null) return;
      m.slowReply = Date.now();
      this.row(`  slow answer ${((m.slowReply - m.transcribed) / 1000).toFixed(1)}s after the transcript`, m);
    },
    row(line, m) {
      if (!DEBUG) return;
      console.log('[talk latency]', line, m);
      this.rows = [new Date().toLocaleTimeString() + '  ' + line, ...this.rows].slice(0, 6);
      $('debug').textContent = this.rows.join('\n');
    },
  };
  if (DEBUG) $('debug').hidden = false;

  // ---- Conversation: wake word, request, follow-ups ------------------------------------
  const conv = C.createConversation({ wake: !!prefs.wake });
  const wakeTrigger = C.createWakeTrigger();
  const stats = { wakeMs: [], vadMs: [] }; // per-frame model time, for ?debug=1
  window.__talkStats = stats;

  function onWake(how) {
    if (!conv.wake) return;
    speaker.cancel();
    cancelFastTurn();
    conv.on('wake', Date.now());
    V.chime(audio.ctx, 'wake');
    // "Hey Jarvis" itself is not part of the request: the pre-roll that held
    // it is dropped, and the VAD does not count its last syllable as a start.
    mic.preroll = [];
    mic.prerollLen = 0;
    mic.wokeAt = Date.now();
    if (engines.silero) engines.silero.reset();
    turn.reset();
    vadState.reset();
    warmVoice();
    if (TOUCH) wakeLock.acquire();
    if (DEBUG) console.log('[talk] wake', how || '', wakeTrigger.best.toFixed(3));
  }
  function sleep() {
    V.chime(audio.ctx, 'sleep');
    if (TOUCH) wakeLock.release();
  }
  // The conversation's clock: windows run out, a finished answer opens the
  // follow-up window.
  setInterval(() => {
    const now = Date.now();
    if (conv.state === 'busy' && !st.pending && !speaker.speaking && !st.thinking && !fast.abort && !mic.recording && now - speaker.lastEnd > 300) conv.on('idle', now);
    if (conv.tick(now) === 'sleep') sleep();
  }, 250);

  // ---- Speech in ----------------------------------------------------------------
  //
  // getUserMedia -> AudioWorklet (termhub's voiceCapture.js) -> 16 kHz chunks.
  // Asleep, only the wake word hears them. Otherwise Silero VAD gives each
  // 32 ms a speech probability, and the turn detector (TalkCore) decides
  // where an utterance starts and ends, asking smart-turn (api/talk/endpoint)
  // at the first pause. Without the models it falls back to the energy VAD.
  const PREROLL_MS = 350;
  const RATE = 16000;
  const mic = { on: false, cap: null, rs: null, frames: [], preroll: [], prerollLen: 0, recording: false, ptt: false, vadBuf: [], vadLen: 0, wakeBuf: [], wakeLen: 0 };
  const engines = { silero: null, wake: null, loading: null, busy: 0 };
  const owner = VC.createMicOwner({
    app: 'pa-talk',
    onTaken: ({ app }) => {
      stopMic();
      concerned(`${app} took the microphone. Tap the face to take it back.`, 0);
    },
  });
  const wakeLock = VC.createWakeLock();

  function makeVad() {
    return C.createVad({ minThreshold: prefs.threshold, endMs: prefs.endMs });
  }
  function makeTurn() {
    return C.createTurnDetector({ endMs: prefs.endMs });
  }
  let turn = makeTurn();
  let vadState = makeVad(); // the energy fallback

  async function loadEngines() {
    if (engines.loading) return engines.loading;
    engines.loading = (async () => {
      const info = voiceInfo.data || (await voiceInfo.check());
      const m = (info && info.models) || {};
      if (!m.ort) return;
      let ort;
      try {
        ort = await V.loadOrt(MODELS);
      } catch (err) {
        console.warn('[talk] onnxruntime-web', err);
        return;
      }
      await Promise.all([
        m.vad &&
          V.createSilero(ort, MODELS)
            .then((s) => (engines.silero = s))
            .catch((err) => console.warn('[talk] silero', err)),
        m.wake &&
          V.createWakeWord(ort, MODELS)
            .then((w) => (engines.wake = w))
            .catch((err) => console.warn('[talk] wake word', err)),
      ]);
    })().then(() => {
      // No wake-word model (not installed, or it failed to load): asleep
      // would never wake, so listen as before instead.
      if (conv.wake && !engines.wake) {
        conv.wake = false;
        notice('The wake word is not installed here (windows/install-voice.ps1): listening hands-free instead.', 8000);
      }
    });
    return engines.loading;
  }

  async function startMic() {
    if (mic.on) return true;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      st.offline = false;
      concerned('The microphone needs HTTPS or localhost. Open this page as http://127.0.0.1:7300/talk on this machine, or over an HTTPS address.', 0);
      return false;
    }
    const ctx = audioCtx();
    mic.rs = VC.createResampler(ctx.sampleRate, RATE);
    mic.cap = VC.createMicCapture({
      ctx,
      workletUrl: 'talk.worklet.js',
      onSamples: (chunk) => onChunk(mic.rs.push(chunk)),
      onEnded: () => {
        stopMic();
        concerned('The microphone was taken away (a call?). Tap the face to listen again.', 0);
      },
    });
    try {
      await mic.cap.start();
    } catch (err) {
      mic.cap = null;
      if (err.name === 'NotAllowedError') showTapPrompt('The microphone is blocked. Allow it in the address bar, then tap once to enable Jarvis.');
      else concerned(`No microphone: ${err.message || err.name}. Tap the face to try again.`, 0);
      return false;
    }
    mic.on = true;
    owner.claim();
    $('face').title = '';
    notice('');
    if (TOUCH && prefs.handsFree) wakeLock.acquire();
    return true;
  }

  function stopMic() {
    if (mic.cap) mic.cap.stop();
    mic.cap = null;
    mic.on = false;
    mic.recording = false;
    mic.ptt = false;
    st.listening = false;
    owner.release();
    wakeLock.release();
  }

  function onChunk(x) {
    if (!x.length) return;
    const now = Date.now();
    const level = C.rms(x);
    st.level = st.level * 0.6 + level * 0.4;
    mic.preroll.push(x);
    mic.prerollLen += x.length;
    while (mic.preroll.length > 1 && (mic.prerollLen - mic.preroll[0].length) / RATE * 1000 >= PREROLL_MS) mic.prerollLen -= mic.preroll.shift().length;
    if (mic.recording) mic.frames.push(x);

    if (conv.listensForWake()) {
      if (engines.wake) feed('wake', x, now);
      return;
    }
    if (mic.ptt || (!prefs.handsFree && !conv.wake)) return;
    const echo = speaker.echoing();
    if (echo && prefs.deafWhileTalking) {
      turn.reset();
      vadState.reset();
      return;
    }
    if (engines.silero) feed('vad', x, now);
    else onTurnEvent(vadState.step(level, now, (x.length / RATE) * 1000, { echo }), now, vadState);
  }

  // The models run one frame at a time, in order. A slow machine that falls
  // behind drops frames rather than answering late.
  const work = { chain: Promise.resolve(), queued: 0 };
  function feed(kind, x, now) {
    const key = kind === 'wake' ? 'wake' : 'vad';
    const size = kind === 'wake' ? engines.wake.frame : engines.silero.frame;
    mic[key + 'Buf'].push(x);
    mic[key + 'Len'] += x.length;
    if (mic[key + 'Len'] < size) return;
    const all = new Float32Array(mic[key + 'Len']);
    let off = 0;
    for (const c of mic[key + 'Buf']) {
      all.set(c, off);
      off += c.length;
    }
    let at = 0;
    const frames = [];
    while (all.length - at >= size) {
      frames.push(all.subarray(at, at + size));
      at += size;
    }
    mic[key + 'Buf'] = at < all.length ? [all.slice(at)] : [];
    mic[key + 'Len'] = all.length - at;
    for (const f of frames) {
      if (work.queued > 12) continue;
      work.queued++;
      const frame = f.slice();
      work.chain = work.chain
        .then(async () => {
          const t = performance.now();
          if (kind === 'wake') {
            if (!conv.listensForWake()) return;
            const score = await engines.wake.score(frame);
            note(stats.wakeMs, performance.now() - t);
            if (wakeTrigger.step(score, Date.now())) onWake('word');
          } else {
            if (conv.listensForWake()) return;
            const p = await engines.silero.prob(frame);
            note(stats.vadMs, performance.now() - t);
            const echo = speaker.echoing();
            onTurnEvent(turn.step(p, now, 32, { echo }), Date.now(), turn);
          }
        })
        .catch((err) => console.warn('[talk] model frame', err))
        .finally(() => work.queued--);
    }
  }
  function note(list, ms) {
    list.push(ms);
    if (list.length > 500) list.shift();
  }

  // The wake word fires as "Jarvis" ends; its tail is not the request.
  const WAKE_TAIL_MS = 300;
  // Each end-of-turn check is about the audio up to that pause.
  const endCheck = { token: 0, at: 0 };
  function onTurnEvent(ev, now, det) {
    if (!ev) return;
    if (ev === 'start') {
      if (!conv.accepts() || now - (mic.wokeAt || 0) < WAKE_TAIL_MS) return det.reset();
      speaker.cancel();
      beginUtterance();
      conv.on('speech', now);
      warmVoice();
    } else if (ev === 'check') {
      if (!mic.recording || !prefs.smartTurn || !(voiceInfo.data && voiceInfo.data.turn)) return;
      askSmartTurn(det, det.pending, now);
    } else if (ev === 'end') {
      finishTurn(det, now, 'silence');
    } else if (ev === 'cancel') {
      endUtterance(false);
      conv.on('nothing', now);
    }
  }

  // Is the speaker done? The last 8 s of the utterance, as 16-bit PCM.
  async function askSmartTurn(det, token, now) {
    const all = joinFrames(mic.frames);
    const tail = all.subarray(Math.max(0, all.length - 8 * RATE));
    endCheck.token = token;
    endCheck.at = now;
    let r;
    try {
      const res = await fetch('api/talk/endpoint', { method: 'POST', headers: { 'Content-Type': 'audio/L16; rate=16000', 'X-PA': '1' }, body: C.floatToPcm16(tail) });
      if (!res.ok) return;
      r = await res.json();
    } catch {
      return;
    }
    if (DEBUG) console.log('[talk] smart-turn', r, `${Date.now() - now} ms`);
    if (det.verdict(token, !!r.complete) === 'end') finishTurn(det, Date.now(), 'smart-turn', r.probability);
  }

  function finishTurn(det, now, by, p) {
    if (!mic.recording) return;
    latency.begin({ speechEnd: det.lastVoice, vadEnd: now, turnBy: by, turnP: p });
    endUtterance(true);
  }

  // While the user is still talking: the GPU voice is clocked up (it idles
  // at a low clock) and an unloaded transcriber starts loading (the PA does
  // both: POST api/talk/warm).
  let lastWarm = 0;
  function warmVoice() {
    if (Date.now() - lastWarm < 15000) return;
    lastWarm = Date.now();
    fetch('api/talk/warm', { method: 'POST', headers: { 'X-PA': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }

  function joinFrames(frames) {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const f of frames) {
      all.set(f, off);
      off += f.length;
    }
    return all;
  }

  function beginUtterance() {
    cancelFastTurn(); // barge-in: the fast reply in flight is dropped too
    mic.frames = mic.preroll.slice();
    mic.recording = true;
    st.listening = true;
  }

  function endUtterance(keep) {
    if (!mic.recording) return;
    mic.recording = false;
    st.listening = false;
    const frames = mic.frames;
    mic.frames = [];
    turn.reset();
    vadState.reset();
    if (!keep) return;
    const all = joinFrames(frames);
    if (all.length < RATE * 0.25) {
      conv.on('nothing', Date.now());
      return;
    }
    send(C.encodeWav(all, RATE));
  }

  async function post(path, body, type = 'application/json') {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': type, 'X-PA': '1' }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `${path} answered ${res.status}`), { status: res.status });
    return data;
  }

  async function send(wav) {
    st.pending++;
    try {
      let { text } = await post('api/talk/transcribe', wav, 'audio/wav');
      latency.set('transcribed');
      if (conv.wake) text = C.stripWakeWord(text);
      if (conv.wake && C.isStopPhrase(text)) {
        heard(text);
        speaker.cancel();
        cancelFastTurn();
        conv.on('stop', Date.now());
        st.happyUntil = Date.now() + 1500;
        sleep();
        return;
      }
      if (C.isNoise(text)) {
        conv.on('nothing', Date.now());
        return;
      }
      heard(text);
      conv.on('sent', Date.now());
      if (await fastTurn(text)) return;
      await post('api/chat', JSON.stringify({ text, source: 'voice' }));
      latency.set('posted');
    } catch (err) {
      // 409: the session waits on an answer in termhub; typed keys would pick
      // an option, so the chat refuses. Not retried — said once, out loud.
      if (err.status === 409) sayWaiting(err.message);
      else concerned(err.status === 404 ? 'The chat is not available on this dashboard yet.' : `Could not send that: ${err.message}`);
    } finally {
      st.pending--;
    }
  }

  // ---- The fast lane (POST api/talk/turn) ------------------------------------------
  //
  // The server decides in about a second whether it can answer itself
  // ("answer"), or says a short acknowledgement and hands the words to the PA
  // chat ("handoff"), or both. Its words stream back and are spoken sentence
  // by sentence through the same speaker queue; a hand-off's real answer
  // arrives on the chat stream like any other and is spoken as before. Returns
  // false only when nothing was handed off and the caller should send to
  // api/chat itself (fast lane off, unreachable, or it failed before deciding).
  const fast = { gen: 0, abort: null, off: false };

  function cancelFastTurn() {
    if (!fast.abort) return;
    fast.gen++;
    fast.abort.abort();
    fast.abort = null;
  }

  async function fastTurn(text) {
    if (fast.off) return false;
    cancelFastTurn();
    const ac = new AbortController();
    fast.abort = ac;
    const gen = fast.gen;
    const live = () => gen === fast.gen;
    let res;
    try {
      res = await fetch('api/talk/turn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PA': '1' }, body: JSON.stringify({ text }), signal: ac.signal });
    } catch {
      if (live()) fast.abort = null;
      return !live(); // barged in: dropped on purpose; otherwise unreachable
    }
    if (!res.ok) {
      fast.abort = null;
      const data = await res.json().catch(() => ({}));
      if (data.disabled || res.status === 404) fast.off = true; // PA_FAST_LANE=0: until reload
      return false;
    }
    latency.set('posted');
    const lines = C.createLineReader();
    const words = C.createUtteranceStream({ firstClause: true }); // the first clause is heard sooner
    const dec = new TextDecoder();
    let full = '';
    let decided = false;
    const handle = (ev) => {
      if (!live()) return;
      if (ev.type === 'decision') {
        decided = true;
        latency.set('decision');
        if (latency.marks) latency.marks.route = ev.route;
      } else if (ev.type === 'delta') {
        latency.set('firstToken');
        full += ev.text || '';
        const sentences = words.push(full);
        if (sentences.length) {
          latency.set('firstReply');
          speaker.say(sentences);
        }
      } else if (ev.type === 'handoff' && ev.error) {
        // 409: the PA chat is parked on a question in termhub.
        if (ev.status === 409) sayWaiting(ev.error);
        else concerned(`Could not hand that to the PA chat: ${ev.error}`);
      } else if (ev.type === 'done') {
        if (latency.marks && ev.model) latency.marks.model = ev.model;
      } else if (ev.type === 'error') {
        concerned(`The fast lane failed: ${ev.error}`);
      }
    };
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const ev of lines.push(dec.decode(value, { stream: true }))) handle(ev);
      }
    } catch {
      if (!live()) return true;
      fast.abort = null;
      if (!decided) return false;
    }
    if (!live()) return true;
    fast.abort = null;
    const rest = words.finish(full);
    if (rest.length) {
      latency.set('firstReply');
      speaker.say(rest);
    }
    return decided;
  }

  // The stream's activity line and the 409 usually say the same thing within
  // a second of each other: speak it once.
  let lastWaitingSaid = 0;
  function sayWaiting(text) {
    concerned(text || 'I am waiting on an answer in termhub.', 8000);
    if (Date.now() - lastWaitingSaid < 10000) return;
    lastWaitingSaid = Date.now();
    speaker.say(['I am waiting on an answer in termhub. Open the session to answer it.']);
  }

  // ---- Push-to-talk: hold Space or the button. Always available. ----------------------
  function pttDown() {
    if (mic.ptt) return;
    if (!mic.on) {
      enable();
      return;
    }
    speaker.cancel();
    if (conv.wake) conv.on('wake', Date.now());
    conv.on('speech', Date.now());
    mic.ptt = true;
    turn.reset();
    vadState.reset();
    $('ptt').classList.add('down');
    beginUtterance();
    warmVoice();
  }
  function pttUp() {
    if (!mic.ptt) return;
    mic.ptt = false;
    $('ptt').classList.remove('down');
    latency.begin({ speechEnd: Date.now(), vadEnd: Date.now(), turnBy: 'release' });
    endUtterance(true);
  }
  const typing = (t) => t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'range';
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || typing(e.target)) return;
    e.preventDefault();
    if (!mic.on) unlockAudio();
    pttDown();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || typing(e.target)) return;
    e.preventDefault();
    pttUp();
  });
  window.addEventListener('blur', pttUp);
  $('ptt').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!mic.on) unlockAudio();
    pttDown();
  });
  $('ptt').addEventListener('pointerup', pttUp);
  $('ptt').addEventListener('pointerleave', pttUp);
  $('ptt').addEventListener('contextmenu', (e) => e.preventDefault()); // a long press is not a menu

  // ---- Starting ---------------------------------------------------------------------
  //
  // enable(): start the mic (and the models). From a tap, unlockAudio() has
  // already run inside the gesture. Without one (the page just loaded) it
  // works only where the browser lets this site use sound and the mic
  // without a gesture; otherwise one prompt asks for a tap.
  let enabling = null;
  function enable() {
    if (enabling) return enabling;
    enabling = (async () => {
      const ctx = audioCtx();
      if (ctx.state !== 'running') {
        try {
          await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
        } catch {
          /* reported below */
        }
      }
      if (ctx.state !== 'running') {
        showTapPrompt();
        return false;
      }
      hideTapPrompt();
      loadEngines(); // in the background: the energy VAD covers until they load
      const ok = await startMic();
      if (ok && conv.wake) notice(TOUCH ? '' : 'Say "hey Jarvis". (Space or the button talks without it.)', 8000);
      return ok;
    })().finally(() => (enabling = null));
    return enabling;
  }

  function showTapPrompt(msg) {
    $('tapPrompt').hidden = false;
    $('tapPrompt').textContent = msg || 'Tap once to enable Jarvis';
  }
  function hideTapPrompt() {
    $('tapPrompt').hidden = true;
  }
  function tapped() {
    unlockAudio();
    hideTapPrompt();
    enable();
  }
  $('face').addEventListener('click', tapped);
  $('tapPrompt').addEventListener('click', tapped);

  // A phone that goes to the background loses the mic (iOS ends the track;
  // Android may keep it, but listening from a pocket is not wanted). Coming
  // back asks for one tap: the audio context needs a gesture again on iOS.
  document.addEventListener('visibilitychange', () => {
    if (!TOUCH) return;
    if (document.hidden) {
      if (mic.on) {
        stopMic();
        speaker.cancel();
        mic.resume = true;
      }
    } else if (mic.resume) {
      mic.resume = false;
      showTapPrompt('Tap to resume');
    }
  });

  // ---- The chat stream -------------------------------------------------------------
  const streams = new Map();
  // Which blocks of a turn are spoken (settings: "Speak while working").
  const turnVoice = C.createTurnVoice({ mode: prefs.voiceMode });
  const held = new Map(); // block id -> its sentences, until spoken or dropped
  function sayHeld(id) {
    if (id == null || !held.has(id)) return;
    speaker.say(held.get(id));
    held.clear();
  }
  setInterval(() => sayHeld(turnVoice.due(Date.now())), 250);

  function onEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'status') {
      st.offline = ev.text === 'offline';
      st.thinking = ev.text === 'thinking';
      if (ev.text === 'idle') {
        $('activity').textContent = '';
        sayHeld(turnVoice.end());
      }
      if (st.offline) notice('The PA chat session is not running. Open it from "session".', 0);
      else if ($('notice').textContent.startsWith('The PA chat session')) notice('');
      return;
    }
    if (ev.type === 'activity') {
      $('activity').textContent = ev.text || '';
      // The session is parked on a permission prompt or question: it can only
      // be answered in termhub, so say so instead of looking busy.
      if (/termhub/i.test(ev.text || '')) {
        st.thinking = false;
        sayWaiting(ev.text);
      } else st.thinking = true;
      conv.on('activity', Date.now());
      return;
    }
    if (ev.type === 'user') {
      turnVoice.userTurn(Date.now());
      held.clear();
      if (ev.source !== 'voice') {
        heard(ev.text);
        latency.begin({ posted: Date.now() }); // typed elsewhere: the turn starts here
      }
      return;
    }
    if (ev.type === 'assistant') {
      latency.set('firstReply');
      latency.slow();
      conv.on('activity', Date.now());
      let s = streams.get(ev.id);
      if (!s) {
        s = C.createUtteranceStream();
        streams.set(ev.id, s);
        if (streams.size > 50) streams.delete(streams.keys().next().value);
      }
      if (ev.partial) return speaker.say(s.push(ev.text));
      const sentences = s.finish(ev.text);
      const verdict = turnVoice.assistant(ev.id, ev.final, Date.now());
      if (verdict === 'speak') {
        held.clear();
        speaker.say(sentences);
      } else if (verdict === 'hold') {
        held.clear();
        held.set(ev.id, sentences);
      } else if (prefs.muted) caption(sentences.join(' '));
    }
  }

  function connect() {
    if (!window.EventSource) return concerned('This browser cannot follow the chat stream.', 0);
    const es = new EventSource('api/chat/stream');
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* a malformed event is skipped, not fatal */
      }
    };
    es.onopen = () => {
      if ($('notice').textContent.startsWith('Lost the dashboard')) notice('');
    };
    es.onerror = () => {
      st.thinking = false;
      concerned('Lost the dashboard connection; retrying…', 4000);
    };
  }

  // ---- Drill-down -------------------------------------------------------------------
  // Layer 2 is the dashboard (a relative link, so it works under termhub's
  // /pa/ proxy too); layer 3 is the PA chat's termhub session.
  $('toSession').addEventListener('click', async () => {
    const win = window.open('', '_blank');
    try {
      // The chat's own answer first (GET api/chat/session: its termhub url);
      // no session yet, or an older dashboard: start one with api/chat/open.
      let s = await fetch('api/chat/session').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      if (!s.sessionId) s = await post('api/chat/open', '{}');
      const meta = document.querySelector('meta[name="pa-termhub"]');
      // Under termhub's /pa/ proxy the server's loopback termhub URL is
      // unreachable from this device; the page's own origin is termhub.
      const proxied = location.pathname.startsWith('/pa/');
      const base = proxied ? location.origin : (meta && meta.content) || 'http://127.0.0.1:7000';
      const target = !proxied && s.url ? s.url : `${base.replace(/\/$/, '')}/#session=${encodeURIComponent(s.sessionId)}`;
      if (win) win.location = target;
      else location.href = target;
    } catch (err) {
      if (win) win.close();
      concerned(`Could not open the session: ${err.message}`);
    }
  });

  // ---- Settings panel -----------------------------------------------------------------
  function fillBackends() {
    const sel = $('ttsBackend');
    sel.innerHTML = '';
    const names = { auto: 'Automatic (local voice when it is up)', kokoro: TTS_BACKENDS.kokoro.label, browser: TTS_BACKENDS.browser.label };
    for (const id of C.TTS_PREFS) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = names[id] + (id === 'kokoro' && !TTS_BACKENDS.kokoro.healthy ? ' (not running)' : '');
      o.selected = id === prefs.tts;
      sel.appendChild(o);
    }
  }
  function fillVoices() {
    const name = ttsName();
    const b = TTS_BACKENDS[name];
    const sel = $('voice');
    const list = b.voices ? b.voices() : [];
    const mine = name === 'kokoro' ? prefs.kokoroVoice : prefs.voice;
    const chosen = mine || (b.bestVoice ? b.bestVoice() : '');
    sel.innerHTML = '';
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.label;
      o.selected = v.id === chosen;
      sel.appendChild(o);
    }
  }
  $('ttsBackend').onchange = (e) => {
    prefs.tts = e.target.value;
    savePrefs();
    speaker.cancel();
    fillVoices();
  };
  $('voice').onchange = (e) => {
    if (ttsName() === 'kokoro') prefs.kokoroVoice = e.target.value;
    else prefs.voice = e.target.value;
    savePrefs();
    speaker.cancel();
    speaker.say(['This is how I sound.']);
  };
  for (const key of ['handsFree', 'deafWhileTalking', 'muted', 'wake', 'smartTurn']) {
    $(key).checked = !!prefs[key];
    $(key).onchange = (e) => {
      prefs[key] = e.target.checked;
      savePrefs();
      if (key === 'muted' && prefs.muted) speaker.cancel();
      if (key === 'wake') {
        conv.wake = prefs.wake;
        if (prefs.wake && mic.on) loadEngines();
      }
    };
  }
  $('sensitivity').value = prefs.threshold;
  $('sensitivity').oninput = (e) => {
    prefs.threshold = Number(e.target.value);
    savePrefs();
    vadState = makeVad();
  };
  $('endMs').min = C.END_MS_MIN;
  $('endMs').max = C.END_MS_MAX;
  $('endMs').value = prefs.endMs;
  const showEndMs = () => ($('endMsLabel').textContent = `${prefs.endMs} ms`);
  showEndMs();
  $('endMs').oninput = (e) => {
    prefs.endMs = Number(e.target.value);
    savePrefs();
    showEndMs();
    vadState = makeVad();
    turn = makeTurn();
  };
  $('voiceMode').value = prefs.voiceMode;
  $('voiceMode').onchange = (e) => {
    prefs.voiceMode = e.target.value;
    turnVoice.mode = prefs.voiceMode;
    savePrefs();
  };
  $('toggleSettings').onclick = () => $('settings').classList.toggle('open');
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = fillVoices;
  fillBackends();
  fillVoices();

  // ---- Go -------------------------------------------------------------------------------
  savePrefs();
  setInterval(drawFace, 60); // a word's mouth pulse is 120-380 ms: two to six frames each
  $('face').title = 'Tap to start';
  $('ptt').textContent = TOUCH ? 'hold to talk' : 'hold Space (or here) to talk';
  drawFace();
  connect();
  voiceInfo.check().then(() => {
    // Desktop with the wake word on (or ?autostart=1): start listening now if
    // the browser allows it, else one tap prompt. Phones wait for a tap.
    if ((prefs.wake && !TOUCH) || /[?&]autostart=1\b/.test(location.search)) enable();
    else notice(TOUCH ? 'Tap the face to start; hold the button to talk.' : 'Tap the face (or press Space) to start listening.', 0);
  });
  setInterval(() => voiceInfo.check(), 60000);
})();
