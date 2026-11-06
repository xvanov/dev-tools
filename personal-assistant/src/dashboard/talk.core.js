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
  function createUtteranceStream() {
    let full = '';
    let emitted = 0;
    let finished = false;

    function ingest(text) {
      const t = String(text || '');
      if (t.startsWith(full)) full = t;
      else full += t;
    }

    return {
      // A partial event: only sentences known to be complete come back.
      push(text) {
        if (finished) return [];
        ingest(text);
        // speakable() trims; a trailing space is what proves "checked." ended.
        const { sentences } = splitSentences(speakable(full).text + (/\s$/.test(full) ? ' ' : ''));
        const fresh = sentences.slice(emitted);
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
        const fresh = sentences.slice(emitted);
        if (rest.trim()) fresh.push(rest.trim());
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
  // `endMs` of quiet (people pause mid-sentence). While the assistant itself
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
    endMs: 900,
    minUtteranceMs: 350,
    maxUtteranceMs: 30000,
  };

  function createVad(opts) {
    const o = Object.assign({}, VAD_DEFAULTS, opts || {});
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

  // ---- The face -------------------------------------------------------------
  //
  // Which expression wins when several things are true at once.
  function expression(s) {
    if (s.listening) return 'listening';
    if (s.talking) return 'talking';
    if (s.thinking) return 'thinking';
    if (s.concerned) return 'concerned';
    if (s.happy) return 'happy';
    return 'idle';
  }

  return {
    DETAILS,
    speakable,
    splitSentences,
    createUtteranceStream,
    VAD_DEFAULTS,
    createVad,
    rms,
    downsample,
    encodeWav,
    isNoise,
    expression,
  };
});
