'use strict';

// The voice page (talk.html): mic -> VAD -> /api/talk/transcribe ->
// /api/chat (source "voice"); /api/chat/stream -> sentences -> TTS; and a
// face that shows which of those is happening. Pure logic is in
// talk.core.js (window.TalkCore).

(function () {
  const C = window.TalkCore;
  const $ = (id) => document.getElementById(id);

  // ---- Settings (per-browser conveniences only) ---------------------------
  const PREFS_KEY = 'pa-talk-prefs';
  const prefs = Object.assign(
    { handsFree: true, deafWhileTalking: false, muted: false, threshold: C.VAD_DEFAULTS.minThreshold, tts: 'browser', voice: '' },
    (() => {
      try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      } catch {
        return {};
      }
    })()
  );
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
    listening: { brows: '  ', eyes: 'OO', mouth: ' --- ' },
    thinking: { brows: '~~', eyes: '°°', mouth: '  ~  ' },
    talking: { brows: '  ', eyes: 'oo', mouth: ' --- ' },
    happy: { brows: '  ', eyes: '^^', mouth: '\\___/' },
    concerned: { brows: '/\\', eyes: 'oo', mouth: ' .-. ' },
  };
  const MOUTHS = [' --- ', ' -o- ', ' (o) ', ' (O) ', ' -o- ', ' ___ '];
  const MOOD = { idle: '', listening: 'listening', thinking: 'thinking', talking: '', happy: '', concerned: '' };
  let blinkUntil = 0;
  let nextBlink = Date.now() + 2500;
  let glance = 0;
  let nextGlance = Date.now() + 6000;
  let mouthFrame = 0;
  let tick = 0;

  function currentExpr(now) {
    return C.expression({
      listening: st.listening,
      talking: st.talking,
      thinking: st.thinking || st.pending > 0,
      concerned: st.offline || now < st.concernedUntil,
      happy: now < st.happyUntil,
    });
  }

  function drawFace() {
    const now = Date.now();
    tick++;
    const expr = currentExpr(now);
    const e = EXPR[expr];
    if (now > nextBlink) {
      blinkUntil = now + 140;
      nextBlink = now + 2500 + Math.random() * 4000;
    }
    if (now > nextGlance) {
      glance = expr === 'idle' ? [-1, 0, 1][Math.floor(Math.random() * 3)] : 0;
      nextGlance = now + 3000 + Math.random() * 6000;
    }
    const blink = now < blinkUntil && expr !== 'happy';
    const eyeL = blink ? '-' : e.eyes[0];
    const eyeR = blink ? '-' : e.eyes[1];
    let mouth = e.mouth;
    if (expr === 'talking') {
      if (tick % 2 === 0) mouthFrame = Math.floor(Math.random() * MOUTHS.length);
      mouth = MOUTHS[mouthFrame];
    }
    const dx = expr === 'thinking' ? 1 : glance;
    const row = (tpl, a, b, at = 5) => {
      const chars = tpl.split('');
      chars[at + dx] = a;
      chars[at + 6 + dx] = b;
      return chars.join('');
    };
    // Right-hand margin: thought dots while thinking, sound marks while listening.
    const dots = expr === 'thinking' ? ' ' + '.'.repeat(1 + (Math.floor(tick / 4) % 3)) : '';
    const lvl = st.listening ? Math.min(3, Math.round(st.level / Math.max(prefs.threshold, 0.001))) : 0;
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
  setInterval(drawFace, 90);

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

  // ---- Speech out -------------------------------------------------------------
  //
  // A backend speaks one sentence at a time: speak(text, {onstart, onend})
  // and cancel(). The browser's speechSynthesis is the first; a local neural
  // TTS (an HTTP endpoint returning audio) slots in as another entry here
  // without touching the queue, the face or barge-in.
  const TTS_BACKENDS = {
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
      speak(text, { onstart, onend }) {
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
        u.onstart = onstart;
        u.onend = finish;
        u.onerror = finish;
        this._keep = u; // an utterance that is garbage-collected never ends
        speechSynthesis.speak(u);
      },
      cancel() {
        speechSynthesis.cancel();
      },
    },
  };

  const speaker = {
    queue: [],
    busy: false,
    lastEnd: 0,
    backend() {
      return TTS_BACKENDS[prefs.tts] && TTS_BACKENDS[prefs.tts].available() ? TTS_BACKENDS[prefs.tts] : TTS_BACKENDS.browser;
    },
    say(sentences) {
      for (const s of sentences) {
        if (prefs.muted) caption(s);
        else this.queue.push(s);
      }
      this.next();
    },
    next() {
      if (this.busy) return;
      const s = this.queue.shift();
      if (!s) {
        if (st.talking) {
          st.talking = false;
          this.lastEnd = Date.now();
          st.happyUntil = Date.now() + 1800;
        }
        return;
      }
      this.busy = true;
      st.talking = true;
      caption(s);
      this.backend().speak(s, {
        onstart: () => {},
        onend: () => {
          this.busy = false;
          this.lastEnd = Date.now();
          this.next();
        },
      });
    },
    // Barge-in: the user started talking. Drop everything queued.
    cancel() {
      if (!st.talking && !this.queue.length) return;
      this.queue = [];
      this.backend().cancel();
      this.busy = false;
      st.talking = false;
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

  // ---- Speech in ----------------------------------------------------------------
  const PREROLL_MS = 350;
  const mic = { ctx: null, rate: 48000, frames: [], preroll: [], recording: false, ptt: false, vad: null };

  async function startMic() {
    if (mic.ctx) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      st.offline = false;
      concerned('The microphone needs HTTPS or localhost. Open this page as http://127.0.0.1:7300/talk on this machine, or over an HTTPS address.', 0);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (err) {
      concerned(`No microphone: ${err.message || err.name}. Allow it in the address bar and tap the face.`, 0);
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    mic.ctx = ctx;
    mic.rate = ctx.sampleRate;
    mic.vad = C.createVad({ minThreshold: prefs.threshold });
    const src = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but runs everywhere with no extra module
    // file; 1024 samples is ~21 ms at 48 kHz — fine for an energy VAD.
    const proc = ctx.createScriptProcessor(1024, 1, 1);
    const frameMs = (1024 / ctx.sampleRate) * 1000;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    proc.onaudioprocess = (ev) => onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)), frameMs);
    $('face').title = '';
    notice('');
  }

  function onFrame(frame, frameMs) {
    const now = Date.now();
    const level = C.rms(frame);
    st.level = st.level * 0.6 + level * 0.4;
    mic.preroll.push(frame);
    while (mic.preroll.length * frameMs > PREROLL_MS) mic.preroll.shift();
    if (mic.recording) mic.frames.push(frame);
    if (mic.ptt || !prefs.handsFree) return;
    const echo = speaker.echoing();
    if (echo && prefs.deafWhileTalking) {
      mic.vad.reset();
      return;
    }
    const ev = mic.vad.step(level, now, frameMs, { echo });
    if (ev === 'start') {
      speaker.cancel();
      beginUtterance();
    } else if (ev === 'end') endUtterance(true);
    else if (ev === 'cancel') endUtterance(false);
  }

  function beginUtterance() {
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
    if (!keep) return;
    const total = frames.reduce((n, f) => n + f.length, 0);
    if (total < mic.rate * 0.25) return;
    const all = new Float32Array(total);
    let off = 0;
    for (const f of frames) {
      all.set(f, off);
      off += f.length;
    }
    const wav = C.encodeWav(C.downsample(all, mic.rate, 16000), 16000);
    send(wav);
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
      const { text } = await post('api/talk/transcribe', wav, 'audio/wav');
      if (C.isNoise(text)) return;
      heard(text);
      await post('api/chat', JSON.stringify({ text, source: 'voice' }));
    } catch (err) {
      concerned(err.status === 404 ? 'The chat is not available on this dashboard yet.' : `Could not send that: ${err.message}`);
    } finally {
      st.pending--;
    }
  }

  // Push-to-talk: hold Space or the button. Always available, even hands-free.
  function pttDown() {
    if (mic.ptt) return;
    if (!mic.ctx) {
      wake();
      return;
    }
    speaker.cancel();
    mic.ptt = true;
    mic.vad.reset();
    $('ptt').classList.add('down');
    beginUtterance();
  }
  function pttUp() {
    if (!mic.ptt) return;
    mic.ptt = false;
    $('ptt').classList.remove('down');
    endUtterance(true);
  }
  const typing = (t) => t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'range';
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || typing(e.target)) return;
    e.preventDefault();
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
    pttDown();
  });
  $('ptt').addEventListener('pointerup', pttUp);
  $('ptt').addEventListener('pointerleave', pttUp);

  // Browsers allow audio (mic and speech) only after a gesture: the first tap
  // on the face (or Space) wakes it.
  async function wake() {
    if (mic.ctx) return;
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    await startMic();
    if (mic.ctx && mic.ctx.state === 'suspended') await mic.ctx.resume();
  }
  $('face').addEventListener('click', wake);

  // ---- The chat stream -------------------------------------------------------------
  const streams = new Map();
  function onEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'status') {
      st.offline = ev.text === 'offline';
      st.thinking = ev.text === 'thinking';
      if (ev.text === 'idle') $('activity').textContent = '';
      if (st.offline) notice('The PA chat session is not running. Open it from "session".', 0);
      else if ($('notice').textContent.startsWith('The PA chat session')) notice('');
      return;
    }
    if (ev.type === 'activity') {
      st.thinking = true;
      $('activity').textContent = ev.text || '';
      return;
    }
    if (ev.type === 'user') {
      if (ev.source !== 'voice') heard(ev.text);
      return;
    }
    if (ev.type === 'assistant') {
      let s = streams.get(ev.id);
      if (!s) {
        s = C.createUtteranceStream();
        streams.set(ev.id, s);
        if (streams.size > 50) streams.delete(streams.keys().next().value);
      }
      speaker.say(ev.partial ? s.push(ev.text) : s.finish(ev.text));
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
      const { sessionId } = await post('api/chat/open', '{}');
      const meta = document.querySelector('meta[name="pa-termhub"]');
      const base = location.pathname.startsWith('/pa/') ? location.origin : (meta && meta.content) || 'http://127.0.0.1:7000';
      const target = `${base.replace(/\/$/, '')}/#session=${encodeURIComponent(sessionId)}`;
      if (win) win.location = target;
      else location.href = target;
    } catch (err) {
      if (win) win.close();
      concerned(`Could not open the session: ${err.message}`);
    }
  });

  // ---- Settings panel -----------------------------------------------------------------
  function fillVoices() {
    const b = speaker.backend();
    const sel = $('voice');
    const list = b.voices ? b.voices() : [];
    const chosen = prefs.voice || (b.bestVoice ? b.bestVoice() : '');
    sel.innerHTML = '';
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.label;
      o.selected = v.id === chosen;
      sel.appendChild(o);
    }
  }
  for (const [id, b] of Object.entries(TTS_BACKENDS)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = b.label;
    o.disabled = !b.available();
    o.selected = id === prefs.tts;
    $('ttsBackend').appendChild(o);
  }
  $('ttsBackend').onchange = (e) => {
    prefs.tts = e.target.value;
    prefs.voice = '';
    savePrefs();
    fillVoices();
  };
  $('voice').onchange = (e) => {
    prefs.voice = e.target.value;
    savePrefs();
    speaker.cancel();
    speaker.say(['This is how I sound.']);
  };
  for (const key of ['handsFree', 'deafWhileTalking', 'muted']) {
    $(key).checked = !!prefs[key];
    $(key).onchange = (e) => {
      prefs[key] = e.target.checked;
      savePrefs();
      if (key === 'muted' && prefs.muted) speaker.cancel();
    };
  }
  $('sensitivity').value = prefs.threshold;
  $('sensitivity').oninput = (e) => {
    prefs.threshold = Number(e.target.value);
    savePrefs();
    if (mic.vad) mic.vad = C.createVad({ minThreshold: prefs.threshold });
  };
  $('toggleSettings').onclick = () => $('settings').classList.toggle('open');
  if ('speechSynthesis' in window) {
    fillVoices();
    speechSynthesis.onvoiceschanged = fillVoices;
  }

  // ---- Go -------------------------------------------------------------------------------
  $('face').title = 'Tap to start';
  notice('Tap the face (or press Space) to start listening.', 0);
  drawFace();
  connect();
  if (/[?&]autostart=1\b/.test(location.search)) wake();
})();
