'use strict';

// The voice page's pure logic (talk.html): what may be read aloud, how a
// streaming answer is cut into sentences, when the microphone counts as
// "someone is talking", and the WAV the transcriber is handed. No DOM, no
// audio APIs — the browser loads it as a script (window.TalkCore) and the
// tests require it (test/talk.test.js).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TalkCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const DETAILS = 'I put the details on the dashboard.';

  // ---- What is read aloud ------------------------------------------------
  //
  // Code, tables and URLs are useless spoken: "h t t p s colon slash slash".
  // They are dropped, and the answer ends with one pointer to the dashboard,
  // where the chat shows them in full. Markdown decoration is dropped and its
  // words kept.
  function speakable(text) {
    let s = String(text || '').replace(/\r\n?/g, '\n');
    let omitted = false;
    // Fenced code, closed or still streaming (an unclosed fence runs to the end).
    s = s.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, (m, lead) => {
      omitted = true;
      return lead + '\n';
    });
    // Tables: any line that starts with a pipe.
    s = s
      .split('\n')
      .filter((line) => {
        if (/^\s*\|/.test(line)) {
          omitted = true;
          return false;
        }
        return true;
      })
      .join('\n');
    // Markdown links keep their words: [the PR](https://…) -> "the PR".
    s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, (m, label) => {
      if (/^https?:\/\//i.test(label.trim()) || !label.trim()) {
        omitted = true;
        return 'the link';
      }
      return label;
    });
    // A bare URL becomes "the link": "the PR is at the link" still parses.
    s = s.replace(/<?\b(?:https?:\/\/|www\.)[^\s<>)]*[^\s<>).,!?;:'"]>?/gi, () => {
      omitted = true;
      return 'the link';
    });
    // Inline code: short identifiers are words; long snippets are code.
    s = s.replace(/`([^`\n]*)`/g, (m, inner) => {
      if (inner.length > 40) {
        omitted = true;
        return '';
      }
      return inner;
    });
    s = s
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
      .replace(/[ \t]+/g, ' ')
      .replace(/ +([.,!?;:])/g, '$1');
    return { text: s.trim(), omitted };
  }

  // ---- Sentences -----------------------------------------------------------
  //
  // A sentence ends at . ! ? (or …) followed by whitespace, or at a blank line
  // or a list item's line break. Abbreviations like "e.g." and decimals stay
  // inside: the dot is not followed by whitespace, or the word is known.
  const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx|incl)\.|\b[A-Z]\.)$/i;

  function splitSentences(text) {
    const out = [];
    let start = 0;
    const s = String(text || '');
    const re = /([.!?…]+["')\]]*)(\s+)|\n\s*\n|\n/g;
    let m;
    while ((m = re.exec(s))) {
      const end = m[1] ? m.index + m[1].length : m.index;
      const piece = s.slice(start, end);
      if (m[1] && ABBREV.test(piece)) continue;
      if (piece.trim()) out.push(piece.trim());
      start = m.index + m[0].length;
    }
    return { sentences: out, rest: s.slice(start) };
  }

  // Follows one assistant message as it streams and hands back the sentences
  // that are now complete, each exactly once. Accepts either cumulative text
  // (each event carries everything so far) or deltas (each carries the new
  // part): text that starts with what was already seen is cumulative.
  //
  // { firstClause: true }: the very first piece may end at a clause (a comma,
  // semicolon or colon after at least four words) instead of waiting for the
  // whole sentence. A neural voice synthesises a piece before any of it is
  // heard, so a long first sentence ("There is one overdue item, due on the
  // 29th, asked by …") is heard sooner as clause + rest.
  const CLAUSE_RE = /^((?:\S+\s+){3,}?\S*[^\s\d][,;:])\s+\S/;

  function createUtteranceStream(opts) {
    const o = Object.assign({ firstClause: false }, opts || {});
    let full = '';
    let emitted = 0;
    let finished = false;
    let clause = ''; // the first sentence's opening, already handed out

    function ingest(text) {
      const t = String(text || '');
      if (t.startsWith(full)) full = t;
      else full += t;
    }
    // The first sentence minus the clause already spoken.
    function trimClause(list) {
      if (!clause || emitted > 0 || !list.length || !list[0].startsWith(clause)) return list;
      const rest = list[0].slice(clause.length).trim();
      return rest ? [rest, ...list.slice(1)] : list.slice(1);
    }

    return {
      // A partial event: only sentences known to be complete come back.
      push(text) {
        if (finished) return [];
        ingest(text);
        // speakable() trims; a trailing space is what proves "checked." ended.
        const sp = speakable(full).text;
        const { sentences } = splitSentences(sp + (/\s$/.test(full) ? ' ' : ''));
        if (!sentences.length && o.firstClause && !clause) {
          const m = CLAUSE_RE.exec(sp);
          if (m) {
            clause = m[1];
            return [clause];
          }
          return [];
        }
        const fresh = trimClause(sentences.slice(emitted));
        emitted = sentences.length;
        return fresh;
      },
      // The final event (or the stream ending): everything left, plus the
      // pointer to the dashboard when something was too visual to say.
      finish(text) {
        if (finished) return [];
        finished = true;
        if (text != null) ingest(text);
        const sp = speakable(full);
        const { sentences, rest } = splitSentences(sp.text);
        const all = sentences.slice(emitted);
        if (rest.trim()) all.push(rest.trim());
        const fresh = trimClause(all);
        emitted = Infinity;
        if (sp.omitted) fresh.push(DETAILS);
        return fresh;
      },
      get text() {
        return full;
      },
    };
  }

  // ---- Voice activity ------------------------------------------------------
  //
  // Energy-based: one RMS value per audio frame. The noise floor follows the
  // room while nobody talks; speech is a frame well above it. A start needs
  // `startMs` of mostly-speech (a door slam is not a sentence), an end needs
  // `endMs` of quiet (people pause mid-sentence; 650 ms keeps a breath inside
  // the sentence and is the pause a person waits before answering, where
  // 900 ms felt slow — tunable in settings, never under END_MS_MIN). While the assistant itself
  // is speaking the bar is raised by `echoFactor` and a start needs
  // `bargeInMs`: its own voice leaking back into the mic must not count as
  // you, but you raising your voice over it must.
  const VAD_DEFAULTS = {
    minThreshold: 0.012,
    floorRatio: 3,
    floorAlpha: 0.05,
    echoFactor: 3,
    startMs: 150,
    bargeInMs: 350,
    endMs: 650,
    minUtteranceMs: 350,
    maxUtteranceMs: 30000,
  };

  const END_MS_MIN = 400;
  const END_MS_MAX = 1500;

  function createVad(opts) {
    const o = Object.assign({}, VAD_DEFAULTS, opts || {});
    o.endMs = Math.min(END_MS_MAX, Math.max(END_MS_MIN, Number(o.endMs) || VAD_DEFAULTS.endMs));
    let floor = o.minThreshold / o.floorRatio;
    let state = 'silence'; // silence | maybe | speech
    let since = 0; // when the current state's evidence began
    let lastVoice = 0;
    let voicedMs = 0;
    let startedAt = 0;

    function threshold(echo) {
      const t = Math.max(o.minThreshold, floor * o.floorRatio);
      return echo ? t * o.echoFactor : t;
    }

    return {
      get state() {
        return state;
      },
      get floor() {
        return floor;
      },
      // When the last voiced frame was: an 'end' comes endMs after it, and
      // that wait is the first slice of the reply's latency.
      get lastVoice() {
        return lastVoice;
      },
      get endMs() {
        return o.endMs;
      },
      threshold,
      // One frame. Returns 'start' when speech begins (the caller keeps a
      // little pre-roll so the first syllable survives), 'end' when it has
      // finished, 'cancel' when it was too short to be words, else null.
      step(rms, now, frameMs, ctx) {
        const echo = !!(ctx && ctx.echo);
        const loud = rms > threshold(echo);
        if (!loud && state !== 'speech') floor = floor + o.floorAlpha * (Math.min(rms, floor * 4 || rms) - floor);
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
        // speech
        if (rms > threshold(false)) lastVoice = now;
        if (now - startedAt >= o.maxUtteranceMs) {
          state = 'silence';
          // Thirty seconds without a pause is more likely a fan or music
          // than a person: take its level as the room's, or it would be
          // sent again, and again, every thirty seconds.
          floor = Math.max(floor, (rms * 1.1) / o.floorRatio);
          return 'end';
        }
        if (now - lastVoice >= o.endMs) {
          state = 'silence';
          return lastVoice - startedAt >= o.minUtteranceMs ? 'end' : 'cancel';
        }
        return null;
      },
      reset() {
        state = 'silence';
      },
    };
  }

  function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
  }

  // ---- Audio out to the transcriber ----------------------------------------
  //
  // faster-whisper wants 16 kHz mono; a 16-bit PCM WAV of that is ~32 KB per
  // second and decodes without ffmpeg guessing at a container.
  function downsample(samples, fromRate, toRate) {
    if (fromRate === toRate) return Float32Array.from(samples);
    const ratio = fromRate / toRate;
    const n = Math.floor(samples.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Average the source samples this one covers: a cheap low-pass.
      const a = Math.floor(i * ratio);
      const b = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = a; j < b; j++) sum += samples[j];
      out[i] = b > a ? sum / (b - a) : samples[a] || 0;
    }
    return out;
  }

  function encodeWav(samples, sampleRate) {
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

  // Whisper fills silence and noise with stock phrases from its training
  // subtitles. An utterance that is only one of these is dropped, not sent.
  const HALLUCINATIONS = new Set([
    '', 'you', 'thank you', 'thanks', 'thank you very much', 'thanks for watching',
    'thank you for watching', 'bye', 'okay', 'so', 'uh', 'um', 'hmm',
    'please subscribe', 'subtitles by the amara.org community',
  ]);

  function isNoise(text) {
    const t = String(text || '').toLowerCase().replace(/[^a-z0-9.' ]+/g, ' ').replace(/[.]+$/g, '').replace(/\s+/g, ' ').trim();
    return HALLUCINATIONS.has(t) || !/[a-z0-9]/.test(t);
  }

  // ---- Face and sound in sync ---------------------------------------------------
  //
  // The mouth follows the audio, not the queue. Handing a sentence to a speech
  // engine is not sound: Edge's "Online (Natural)" voices fetch it over the
  // network first (measured 340-690 ms warm, 1.7 s cold, from speak() to
  // onstart), and their first word boundary comes another 200-300 ms after
  // onstart. So:
  //
  //   queued    a sentence is with the engine, nothing audible yet. The first
  //             of a run shows 'about' (about to speak); one after another
  //             sentence keeps the talking face with the mouth closed.
  //   start     the engine says audio began.
  //   boundary  a word is being spoken: the mouth opens for about that word.
  //   level     an engine that plays audio itself (an <audio> element, Web
  //             Audio) can report loudness instead; the mouth follows it.
  //   end       this sentence's audio stopped: mouth closed.
  //   done      the queue is empty; cancel: barge-in.
  //
  // Engine-agnostic: speechSynthesis gives start/boundary/end, a local TTS
  // played through Web Audio gives start/level/end. Where neither boundaries
  // nor levels come, the mouth runs a gentle loop between start and end. A
  // voice that has produced boundaries before is trusted to keep doing so:
  // after its start, the mouth stays shut until the first word (or until
  // boundaryWaitMs passes without one, then it loops).
  const SYNC_DEFAULTS = { boundaryWaitMs: 800, wordGapMs: 900, levelHoldMs: 250, loopMs: 130 };
  const LOOP = [1, 2, 1, 0, 2, 3, 1, 0];

  function createSpeechSync(opts) {
    const o = Object.assign({}, SYNC_DEFAULTS, opts || {});
    const wordy = new Set(); // engine/voice keys seen producing boundaries
    let state = 'idle'; // idle | waiting | gap | speaking
    let spoke = false;
    let key = '';
    let startedAt = 0;
    let lastCue = 0; // last boundary
    let pulseAt = 0;
    let pulseUntil = 0;
    let pulseSize = 1;
    let levelAt = -Infinity;
    let level = 0;

    return {
      get state() {
        return state;
      },
      queued() {
        if (state === 'speaking') return;
        state = spoke ? 'gap' : 'waiting';
      },
      start(now, voiceKey) {
        state = 'speaking';
        key = String(voiceKey || '');
        startedAt = now;
        lastCue = 0;
        pulseUntil = 0;
        levelAt = -Infinity;
      },
      boundary(now, charLength) {
        if (state !== 'speaking') return;
        wordy.add(key);
        const n = Math.max(1, Number(charLength) || 4);
        lastCue = now;
        pulseAt = now;
        pulseUntil = now + Math.min(380, Math.max(120, n * 70));
        pulseSize = n > 6 ? 3 : n > 3 ? 2 : 1;
      },
      level(now, amplitude) {
        if (state !== 'speaking') return;
        levelAt = now;
        level = Number(amplitude) || 0;
      },
      end() {
        if (state === 'idle') return;
        state = 'gap';
        spoke = true;
      },
      done() {
        state = 'idle';
        spoke = false;
      },
      cancel() {
        state = 'idle';
        spoke = false;
      },
      // What to draw: face is 'about' | 'talking' | null (no speech going on:
      // the page's other states decide); mouth 0 (closed) .. 3 (wide open).
      frame(now) {
        if (state === 'idle') return { face: null, mouth: 0 };
        if (state === 'waiting') return { face: 'about', mouth: 0 };
        if (state === 'gap') return { face: 'talking', mouth: 0 };
        if (now - levelAt <= o.levelHoldMs) {
          return { face: 'talking', mouth: level < 0.02 ? 0 : level < 0.06 ? 1 : level < 0.15 ? 2 : 3 };
        }
        if (now < pulseUntil) {
          // Open on the word's first half, closing over the second.
          const half = (pulseUntil - pulseAt) / 2;
          return { face: 'talking', mouth: now - pulseAt < half ? pulseSize : Math.max(1, pulseSize - 1) };
        }
        if (wordy.has(key)) {
          // Between words, or the engine has not reached the first word yet.
          if (lastCue && now - lastCue < o.wordGapMs) return { face: 'talking', mouth: 0 };
          if (!lastCue && now - startedAt < o.boundaryWaitMs) return { face: 'talking', mouth: 0 };
        }
        return { face: 'talking', mouth: LOOP[Math.floor((now - startedAt) / o.loopMs) % LOOP.length] };
      },
    };
  }

  // ---- What is spoken during a turn ---------------------------------------------
  //
  // A turn is often "Let me check." -> a tool -> the answer. On a quick turn
  // the step is chatter; on a slow one it is the only sign of progress. Each
  // assistant block carries final (false: text before a tool call, the turn
  // goes on). Modes:
  //   all    speak every block
  //   final  speak only the answer
  //   auto   speak a step only once the turn has run progressMs: a step that
  //          arrives earlier is held, spoken if the turn is still running at
  //          progressMs, and dropped if the answer comes first.
  const VOICE_MODES = ['auto', 'all', 'final'];

  function createTurnVoice(opts) {
    const o = Object.assign({ mode: 'auto', progressMs: 4000 }, opts || {});
    let turnStart = null;
    let held = null;

    return {
      set mode(m) {
        o.mode = VOICE_MODES.includes(m) ? m : 'auto';
      },
      get mode() {
        return o.mode;
      },
      // The user said or typed something: a new turn.
      userTurn(now) {
        turnStart = now;
        held = null;
      },
      // An assistant block: 'speak' | 'hold' | 'drop'. Unknown finality
      // (undefined) is treated as the answer.
      assistant(id, final, now) {
        if (final !== false) {
          held = null;
          return 'speak';
        }
        if (o.mode === 'all') return 'speak';
        if (o.mode === 'final') return 'drop';
        if (turnStart == null || now - turnStart >= o.progressMs) return 'speak';
        held = id;
        return 'hold';
      },
      // Polled: the held step's id once the turn has run long enough.
      due(now) {
        if (held == null || turnStart == null || now - turnStart < o.progressMs) return null;
        const id = held;
        held = null;
        return id;
      },
      // The turn ended (idle) without an answer block: the step was all there is.
      end() {
        const id = held;
        held = null;
        turnStart = null;
        return id;
      },
    };
  }

  // ---- Latency readout (?debug=1) ---------------------------------------------------
  //
  // Wall-clock marks of one turn -> the slices, in ms (null when unknown):
  //   silence     last voiced frame -> the VAD calls the utterance done
  //   transcribe  -> the text is back from whisper (upload included)
  //   send        -> POST /api/chat answered (typed into the session)
  //   reply       -> the first assistant block reached the page (Claude's turn
  //               plus the transcript tail)
  //   voice       -> the speech engine started that block's audio
  //   total       last voiced frame (or the send) -> audio
  const SLICES = [
    ['silence', 'speechEnd', 'vadEnd'],
    ['transcribe', 'vadEnd', 'transcribed'],
    ['send', 'transcribed', 'posted'],
    ['reply', 'posted', 'firstReply'],
    ['voice', 'firstReply', 'audioStart'],
  ];

  function latencySlices(m) {
    const out = {};
    const ok = (x) => typeof x === 'number' && isFinite(x);
    for (const [name, a, b] of SLICES) out[name] = ok(m[a]) && ok(m[b]) ? Math.max(0, m[b] - m[a]) : null;
    const from = ok(m.speechEnd) ? m.speechEnd : ok(m.transcribed) ? m.transcribed : null;
    out.total = from != null && ok(m.audioStart) ? m.audioStart - from : null;
    return out;
  }

  // A fast-lane turn (POST /api/talk/turn) adds its route and two marks, both
  // timed from the transcript: `decision` (the route is known) and
  // `firstToken` (the first words of the fast reply). `posted` is when the
  // turn's response began; `firstReply` the first sentence handed to speech.
  function formatLatency(m) {
    const ok0 = (x) => typeof x === 'number' && isFinite(x);
    const s = latencySlices(m);
    const f = (v) => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
    let line = `silence ${f(s.silence)} · stt ${f(s.transcribe)} · send ${f(s.send)} · reply ${f(s.reply)} · voice ${f(s.voice)} = ${f(s.total)}`;
    // How the turn ended (smart-turn, the silence timer, a released button)
    // and the voice: the engine, and Kokoro's time to its first audio.
    const extra = [];
    if (m.turnBy) extra.push(`end by ${m.turnBy}${typeof m.turnP === 'number' ? ` (p ${m.turnP.toFixed(2)})` : ''}`);
    if (m.tts) extra.push(`${m.tts}${ok0(m.ttsFirstMs) ? ` ${f(m.ttsFirstMs)} to audio` : ''}`);
    if (extra.length) line += ` [${extra.join(', ')}]`;
    if (!m.route) return line;
    const ok = (x) => typeof x === 'number' && isFinite(x);
    const from = (k) => (ok(m.transcribed) && ok(m[k]) ? m[k] - m.transcribed : null);
    return `${m.route}: decide ${f(from('decision'))} · 1st token ${f(from('firstToken'))} | ${line}`;
  }

  // ---- The fast lane's stream ------------------------------------------------------
  //
  // POST /api/talk/turn answers in NDJSON: one JSON event per line. Lines can
  // be split across network chunks; push() returns the events now complete.
  function createLineReader() {
    let rest = '';
    return {
      push(text) {
        rest += String(text || '');
        const out = [];
        let i;
        while ((i = rest.indexOf('\n')) >= 0) {
          const line = rest.slice(0, i).trim();
          rest = rest.slice(i + 1);
          if (!line) continue;
          try {
            out.push(JSON.parse(line));
          } catch {
            /* a malformed line is skipped */
          }
        }
        return out;
      },
    };
  }

  // ---- Speech out: which engine --------------------------------------------
  //
  // 'kokoro' is the local neural voice (voice/server.py through
  // /api/talk/tts); 'browser' is speechSynthesis. The setting is 'auto'
  // (Kokoro when the service says it is healthy, else the browser), or one of
  // them by name; a named engine that is not there falls back to the other.
  const TTS_PREFS = ['auto', 'kokoro', 'browser'];

  function chooseTts(pref, avail) {
    const a = avail || {};
    const p = TTS_PREFS.includes(pref) ? pref : 'auto';
    if (p === 'browser' && a.browser) return 'browser';
    if (a.kokoro && p !== 'browser') return 'kokoro';
    if (a.browser) return 'browser';
    return a.kokoro ? 'kokoro' : null;
  }

  // ---- Speech out: fetching ahead ---------------------------------------------
  //
  // While one sentence plays, the next is already being synthesised: get(text)
  // returns the fetch for that text, started now or earlier by prefetch(text);
  // each started fetch is used once. At most `depth` are kept waiting (the
  // service has one GPU and serialises them anyway). clear() drops them all
  // (barge-in), calling `abort` on each.
  function createPrefetcher(opts) {
    const o = Object.assign({ depth: 2, start: null, abort: null }, opts || {});
    const waiting = []; // [{ text, job }]
    return {
      prefetch(text) {
        if (!text || waiting.some((w) => w.text === text)) return;
        if (waiting.length >= o.depth) return;
        waiting.push({ text, job: o.start(text) });
      },
      get(text) {
        const i = waiting.findIndex((w) => w.text === text);
        if (i >= 0) return waiting.splice(i, 1)[0].job;
        return o.start(text);
      },
      clear() {
        while (waiting.length) {
          const w = waiting.shift();
          if (o.abort) o.abort(w.job);
        }
      },
      get size() {
        return waiting.length;
      },
    };
  }

  // 16-bit little-endian PCM arriving in network chunks of any length (an odd
  // byte waits for the next chunk) -> Float32 samples.
  function createPcmDecoder() {
    let carry = null;
    return {
      push(bytes) {
        let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (carry) {
          const j = new Uint8Array(carry.length + b.length);
          j.set(carry, 0);
          j.set(b, carry.length);
          b = j;
          carry = null;
        }
        const n = b.length >> 1;
        if (b.length & 1) carry = b.slice(b.length - 1);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let v = b[2 * i] | (b[2 * i + 1] << 8);
          if (v >= 0x8000) v -= 0x10000;
          out[i] = v / 32768;
        }
        return out;
      },
    };
  }

  // Float samples -> 16-bit PCM bytes (what /api/talk/endpoint reads).
  function floatToPcm16(samples) {
    const out = new Uint8Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      const v = x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
      out[2 * i] = v & 0xff;
      out[2 * i + 1] = (v >> 8) & 0xff;
    }
    return out;
  }

  // ---- End of turn ------------------------------------------------------------------
  //
  // Silence alone is a poor judge: "send the report to… [thinking] …the
  // finance team" has a pause in the middle, and a 650 ms wait cuts it there,
  // while waiting longer makes every answer slow. So each frame comes with a
  // speech probability (Silero VAD; the energy VAD's verdict where Silero is
  // not loaded), and once the speaker has been quiet for `checkMs` (200) the
  // caller asks smart-turn ("does this sound finished?") about the audio so
  // far. Finished: the turn ends there, ~450 ms sooner than the timer.
  // Not finished, or no answer: it ends at `endMs` of silence as before (the
  // user's "Pause before sending"). A voice that comes back during the check
  // makes its answer stale.
  //
  // step() returns 'start' | 'check' | 'end' | 'cancel' | null. After a
  // 'check', the caller calls verdict(token, complete); it returns 'end' when
  // that ends the turn now. The echo flag (the assistant is talking) raises
  // the bar for a start, as the energy VAD does.
  const TURN_DEFAULTS = {
    onProb: 0.5, // a frame at or over this is speech
    offProb: 0.35, // once talking, frames over this still count as voice
    echoProb: 0.85, // while the assistant speaks
    startMs: 150,
    bargeInMs: 350,
    checkMs: 200,
    endMs: 650,
    minUtteranceMs: 350,
    maxUtteranceMs: 30000,
  };

  function createTurnDetector(opts) {
    const o = Object.assign({}, TURN_DEFAULTS, opts || {});
    o.endMs = Math.min(END_MS_MAX, Math.max(END_MS_MIN, Number(o.endMs) || TURN_DEFAULTS.endMs));
    let state = 'silence'; // silence | maybe | speech
    let since = 0;
    let voicedMs = 0;
    let lastVoice = 0;
    let startedAt = 0;
    let token = 0; // the check in flight, if any
    let checked = false; // this pause has been asked about

    return {
      get state() {
        return state;
      },
      get lastVoice() {
        return lastVoice;
      },
      get startedAt() {
        return startedAt;
      },
      get endMs() {
        return o.endMs;
      },
      get pending() {
        return token;
      },
      step(prob, now, frameMs, ctx) {
        const echo = !!(ctx && ctx.echo);
        if (state === 'silence') {
          if (prob >= (echo ? o.echoProb : o.onProb)) {
            state = 'maybe';
            since = now;
            voicedMs = frameMs;
            lastVoice = now;
          }
          return null;
        }
        if (state === 'maybe') {
          if (prob >= (echo ? o.echoProb : o.onProb)) {
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
            checked = false;
            token = 0;
            return 'start';
          }
          return null;
        }
        // speech
        if (prob >= o.offProb) {
          lastVoice = now;
          if (checked || token) {
            // Talking again: whatever the check says is about a pause that ended.
            checked = false;
            token = 0;
          }
        }
        if (now - startedAt >= o.maxUtteranceMs) {
          state = 'silence';
          token = 0;
          return 'end';
        }
        const quiet = now - lastVoice;
        if (quiet >= o.endMs) {
          state = 'silence';
          token = 0;
          return lastVoice - startedAt >= o.minUtteranceMs ? 'end' : 'cancel';
        }
        if (!checked && quiet >= o.checkMs && lastVoice - startedAt >= o.minUtteranceMs) {
          checked = true;
          token = now;
          return 'check';
        }
        return null;
      },
      // The check's token is `pending` right after step() returned 'check'.
      verdict(t, complete) {
        if (!t || t !== token || state !== 'speech') return null;
        token = 0;
        if (!complete) return null;
        state = 'silence';
        return 'end';
      },
      reset() {
        state = 'silence';
        token = 0;
        checked = false;
      },
    };
  }

  // ---- Wake word and conversation -------------------------------------------------------
  //
  // With the wake word on, the page listens for "hey Jarvis" and nothing else:
  // no transcription, nothing leaves the browser. States:
  //   asleep     only the wake word is heard
  //   awake      woken (a chime): the next utterance is the request; no
  //              speech within `awakeMs` and it goes back to sleep
  //   busy       a request is being answered (transcribing, the fast lane,
  //              the PA chat, speaking); a hand-off can take a while
  //   follow     the answer is done: for `followMs` (8 s) a follow-up needs
  //              no wake word; silence puts it to sleep
  // Events: wake, speech (an utterance began), sent (one was sent), stop (a
  // stop phrase: "stop", "thanks Jarvis"), idle (nothing pending and nothing
  // being said), activity (still working: a reply arrived). tick(now)
  // returns 'sleep' when a window ran out. With the wake word off the machine
  // stays 'open': every utterance is a request (the hands-free mode).
  const WAKE_DEFAULTS = { awakeMs: 6000, followMs: 8000, busyMaxMs: 180000 };

  function createConversation(opts) {
    const o = Object.assign({ wake: true }, WAKE_DEFAULTS, opts || {});
    let state = o.wake ? 'asleep' : 'open';
    let until = Infinity;
    const go = (s, now, ms) => {
      state = s;
      until = ms == null ? Infinity : now + ms;
      return s;
    };
    return {
      get state() {
        return state;
      },
      get wake() {
        return o.wake;
      },
      set wake(on) {
        o.wake = !!on;
        state = o.wake ? 'asleep' : 'open';
        until = Infinity;
      },
      // Does an utterance that starts now count as a request?
      accepts() {
        return state !== 'asleep';
      },
      // Should the wake-word detector run? Only asleep: awake, every
      // utterance is already a request (whisper's "Jarvis, …" is stripped).
      listensForWake() {
        return o.wake && state === 'asleep';
      },
      on(ev, now) {
        if (!o.wake) return state;
        if (ev === 'wake') return go('awake', now, o.awakeMs);
        if (ev === 'stop') return go('asleep', now);
        if (state === 'asleep') return state;
        if (ev === 'speech') return go('busy', now, o.busyMaxMs);
        if (ev === 'sent' || ev === 'activity') return state === 'busy' ? go('busy', now, o.busyMaxMs) : state;
        if (ev === 'idle' && state === 'busy') return go('follow', now, o.followMs);
        if (ev === 'nothing' && state === 'busy') return go('follow', now, o.followMs); // the utterance was noise
        return state;
      },
      tick(now) {
        if (!o.wake || now < until) return null;
        go('asleep', now);
        return 'sleep';
      },
    };
  }

  // "Stop", "thanks Jarvis", "that's all": end the conversation, send nothing.
  const STOP_RE = /^(?:(?:ok(?:ay)?|alright|no)[,.!]?\s+)?(?:stop(?: it| talking| listening)?|shush|be quiet|quiet|cancel|never ?mind|that'?s (?:all|it)(?: for now)?|(?:thanks?|thank you|cheers),? jarvis|(?:good ?bye|bye|goodnight|good night|sleep),? jarvis|go to sleep|that will be all)(?:,? jarvis)?[\s.!]*$/i;

  function isStopPhrase(text) {
    return STOP_RE.test(String(text || '').trim());
  }

  // whisper hears the tail of the wake word in the request ("Jarvis, what's
  // on today?"): it is not part of what was asked.
  function stripWakeWord(text) {
    return String(text || '')
      .replace(/^\s*(?:(?:hey|hi|okay|ok|a)[,.]?\s+)?jarvis[,.!?]?\s*/i, '')
      .replace(/^\s*,\s*/, '')
      .trim();
  }

  // The wake word's score per 80 ms frame -> a detection: at or over
  // `threshold`, then nothing for `refractoryMs` (one "hey Jarvis" scores over
  // the bar for several frames in a row), and never in the first `warmupFrames`
  // frames (the model's feature window is still filling).
  function createWakeTrigger(opts) {
    const o = Object.assign({ threshold: 0.5, refractoryMs: 1500, warmupFrames: 16 }, opts || {});
    let frames = 0;
    let quietUntil = 0;
    let best = 0;
    return {
      get best() {
        return best;
      },
      step(score, now) {
        frames++;
        if (frames <= o.warmupFrames) return false;
        best = Math.max(best, score);
        if (now < quietUntil || !(score >= o.threshold)) return false;
        quietUntil = now + o.refractoryMs;
        return true;
      },
      reset() {
        frames = 0;
        quietUntil = 0;
      },
    };
  }

  // The wake word: on by default where a desk is likely (a fine pointer), off
  // on phones (always-on mic drains the battery, and the phone is in a pocket).
  function wakeDefault(env) {
    const e = env || {};
    return !e.coarsePointer;
  }

  // ---- The face -------------------------------------------------------------
  //
  // Which expression wins when several things are true at once. 'about' is
  // the moment between handing a sentence to the speech engine and hearing it;
  // 'awake' the wake word was just heard; 'asleep' waiting for it.
  function expression(s) {
    if (s.listening) return 'listening';
    if (s.talking) return 'talking';
    if (s.about) return 'about';
    if (s.thinking) return 'thinking';
    if (s.awake) return 'awake';
    if (s.concerned) return 'concerned';
    if (s.happy) return 'happy';
    if (s.asleep) return 'asleep';
    return 'idle';
  }

  return {
    DETAILS,
    speakable,
    splitSentences,
    createUtteranceStream,
    VAD_DEFAULTS,
    END_MS_MIN,
    END_MS_MAX,
    createVad,
    createSpeechSync,
    VOICE_MODES,
    createTurnVoice,
    latencySlices,
    formatLatency,
    createLineReader,
    rms,
    downsample,
    encodeWav,
    isNoise,
    expression,
    TTS_PREFS,
    chooseTts,
    createPrefetcher,
    createPcmDecoder,
    floatToPcm16,
    TURN_DEFAULTS,
    createTurnDetector,
    WAKE_DEFAULTS,
    createConversation,
    isStopPhrase,
    stripWakeWord,
    createWakeTrigger,
    wakeDefault,
  };
});
