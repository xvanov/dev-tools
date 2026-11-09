'use strict';

// Is anyone else in this conversation? The evidence capture keeps beside the
// audio, so a recording of you alone is never filed as a meeting.
//
// Capture records whenever the meeting gate is open, and the gate opens for
// any app on the microphone — the voice page in a browser, for one. What it
// then hears is often only you: push-to-talk dictation to Claude Code, a
// conversation with Jarvis, Jarvis's own replies on the speakers. All of that
// already lives in your sessions; none of it is a meeting. Three logs say
// when it happened, each written by the thing that knows:
//
//   speech      voice-dictation's transcribe server, one line per request
//               (voice-dictation/transcribe_server.py): every dictation —
//               the hotkey, termhub's mic, the voice page — passes through
//               it. The PA's own capture files (*.speech.wav) are skipped.
//   talk        the voice page's turns and spoken replies (src/dashboard/talk.ts)
//   calls       the apps the gate counted as a call, while they held the mic
//               (src/audio/gate.ts)
//
// Speech groups (sidecars) that are mostly inside a dictation or talk window
// are yours and are dropped before episodes are made. A mic-only episode is
// a call only when a call app held the mic during it. Everything here but
// the appenders is pure.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Window = { start: number; end: number; why: string };
type Part = { started_at: string; ended_at: string; segments?: Array<{ start: string; end: string }> };

const fs = require('fs');
const path = require('path');

const KEEP_MS = 3 * 86400_000;
const MAX_BYTES = 1024 * 1024;
// A dictation's audio ends at its file's mtime; the hotkey's preview rewrites
// the file every second, so a recording is a run of these.
const DICTATION_PAD_MS = 2000;
// The voice page asks for a reply, then speaks it in pieces; a spoken piece
// rarely runs past this.
const TALK_AFTER_MS = { turn: 60_000, tts: 30_000 } as Record<string, number>;
// The gate polls every few seconds and logs a held mic at most every 30 s.
const CALL_PAD_MS = 40_000;
// A speech group this much inside your own windows is yours.
const SELF_SHARE = 0.6;

function ms(v: unknown) {
  return new Date(v as string).getTime();
}

function lines(text: unknown) {
  const out: any[] = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line */
    }
  }
  return out;
}

/**
 * Pure: dictation windows from voice-dictation's speech-activity log. Each
 * line is {at, end, seconds, file}: `end` is when the audio file was last
 * written, i.e. when that speech ended. The PA's own capture files are not
 * dictation and are skipped.
 */
function dictationWindows(text: unknown): Window[] {
  const out: Window[] = [];
  for (const e of lines(text)) {
    if (/\.speech\.wav$/i.test(String(e.file || ''))) continue;
    const end = Number.isFinite(ms(e.end)) ? ms(e.end) : ms(e.at);
    if (!Number.isFinite(end)) continue;
    const seconds = Number(e.seconds) > 0 ? Number(e.seconds) : 30;
    out.push({ start: end - seconds * 1000 - DICTATION_PAD_MS, end: end + DICTATION_PAD_MS, why: 'dictation' });
  }
  return out;
}

/** Pure: voice-page windows ({at, what: 'turn'|'tts'} lines): you asking, Jarvis answering. */
function talkWindows(text: unknown): Window[] {
  const out: Window[] = [];
  for (const e of lines(text)) {
    const at = ms(e.at);
    if (!Number.isFinite(at)) continue;
    out.push({ start: at - 30_000, end: at + (TALK_AFTER_MS[e.what] ?? 30_000), why: 'talk' });
  }
  return out;
}

/** Pure: when a call app held the microphone ({at, apps} lines from the gate). */
function callWindows(text: unknown): Window[] {
  const out: Window[] = [];
  for (const e of lines(text)) {
    const at = ms(e.at);
    if (!Number.isFinite(at) || !Array.isArray(e.apps) || !e.apps.length) continue;
    out.push({ start: at - 10_000, end: at + CALL_PAD_MS, why: e.apps.join(', ') });
  }
  return out;
}

function covered(start: number, end: number, windows: Window[]) {
  if (!(end > start)) return 0;
  // Merge the windows that touch [start, end], then sum their overlap.
  const hits = windows
    .filter((w) => w.end > start && w.start < end)
    .map((w) => [Math.max(w.start, start), Math.min(w.end, end)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const h of hits) {
    if (cur && h[0] <= cur[1]) cur[1] = Math.max(cur[1], h[1]);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [h[0], h[1]];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/**
 * Pure: the share (0..1) of a speech group's speech that falls inside the
 * windows — by its segments when the sidecar has them, else its span.
 */
function selfShare(part: Part, windows: Window[]) {
  const segs = Array.isArray(part.segments) && part.segments.length ? part.segments : [{ start: part.started_at, end: part.ended_at }];
  let speech = 0;
  let mine = 0;
  for (const s of segs) {
    const a = ms(s.start);
    const b = ms(s.end);
    if (!(b > a)) continue;
    speech += b - a;
    mine += covered(a, b, windows);
  }
  return speech > 0 ? mine / speech : 0;
}

/** Pure: sidecars split into the ones that are someone's conversation and the ones that are you alone. */
function splitSelfSpeech<T extends Part>(sidecars: T[], windows: Window[], { share = SELF_SHARE }: { share?: number } = {}) {
  const kept: T[] = [];
  const self: T[] = [];
  for (const s of sidecars) (windows.length && selfShare(s, windows) >= share ? self : kept).push(s);
  return { kept, self };
}

/**
 * Pure: did a call app hold the mic during this episode? At least a fifth of
 * it, or a minute, inside the call windows.
 */
function heldByCall(episode: { started_at: string; ended_at: string }, windows: Window[]) {
  const a = ms(episode.started_at);
  const b = ms(episode.ended_at);
  if (!(b > a) || !windows.length) return false;
  const c = covered(a, b, windows);
  return c >= 60_000 || c >= 0.2 * (b - a);
}

// ------------------------------------------------------------------ files --

function readText(file: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Appends one JSON line; past MAX_BYTES the file is rewritten with only the
 * last KEEP_MS of lines. Never throws: losing a line of evidence must not
 * stop the gate or the voice page.
 */
function append(file: string, entry: Record<string, unknown>, now: number = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    if (fs.statSync(file).size > MAX_BYTES) {
      const keep = lines(readText(file)).filter((e) => now - ms(e.at) < KEEP_MS);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
      fs.renameSync(tmp, file);
    }
  } catch {
    /* evidence is best effort */
  }
}

/** Every window the logs hold: {self} (dictation and voice page) and {calls}. */
function load(files: { dictationLog: string; talkLog: string; callLog: string }) {
  return {
    self: [...dictationWindows(readText(files.dictationLog)), ...talkWindows(readText(files.talkLog))],
    calls: callWindows(readText(files.callLog)),
  };
}

// The voice page says it holds the mic ({at, browser}); the gate then does not
// count that browser as a call.
const TALK_MIC_FRESH_MS = 75_000;

function browserOf(userAgent: unknown) {
  const ua = String(userAgent || '');
  if (/Edg\//.test(ua)) return 'msedge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'browser';
}

function readTalkMic(file: string, now: number = Date.now()) {
  const raw = readText(file);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return now - ms(v.at) < TALK_MIC_FRESH_MS ? { browser: String(v.browser || 'browser') } : null;
  } catch {
    return null;
  }
}

module.exports = {
  dictationWindows,
  talkWindows,
  callWindows,
  selfShare,
  splitSelfSpeech,
  heldByCall,
  append,
  load,
  browserOf,
  readTalkMic,
  SELF_SHARE,
};
