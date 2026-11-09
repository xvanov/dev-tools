'use strict';

// The voice page ("layer 1"): /talk, a face that listens and talks back.
// The browser does the listening (mic, VAD) and the speaking (TTS); this
// module serves the page and its scripts, and proxies an utterance to
// voice-dictation's faster-whisper server so the same warm model that does
// dictation and meeting capture turns it into text. The text then goes to
// /api/chat like anything typed (src/dashboard/talk.html, talk.page.js).
//
// The transcriber's protocol (voice-dictation/transcribe_server.py) is a raw
// TCP exchange: send an absolute path to an audio file, read the transcript
// (or "ERROR: …") until the server closes (one request, one answer; see askWhisper). So the uploaded WAV is written to a
// temp file first and removed afterwards, whatever happens.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;
type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;
type IncomingMessage = import('http').IncomingMessage;
type HttpErr = Error & { status?: number; code?: string; retry?: boolean };
type WhisperOpts = { host?: unknown; port?: unknown; timeoutMs?: number | undefined; minReplyMs?: number | undefined };
type Span = { setAttribute(k: string, v: unknown): void };

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config.ts');
const { logger } = require('../log.ts');
const log = logger('talk');

// Pure: a page's latency report -> the fields worth logging, or null. Numbers
// only (ms, bounded), short strings only: nothing the user said is in it.
function sanitizeLatency(b: unknown) {
  if (!b || typeof b !== 'object') return null;
  const o = b as Row;
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) && v >= 0 && v < 600_000 ? Math.round(v) : undefined);
  const str = (v: unknown) => (typeof v === 'string' && /^[\w .:()-]{1,24}$/.test(v) ? v : undefined);
  const out: Record<string, number | string | undefined> = { speechToAudioMs: num(o.total), silenceMs: num(o.silence), sttMs: num(o.transcribe), sendMs: num(o.send), replyMs: num(o.reply), voiceMs: num(o.voice), route: str(o.route), endBy: str(o.turnBy), tts: str(o.tts) };
  if (out.speechToAudioMs === undefined) return null;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const DIR = __dirname;
const ASSETS: Record<string, string> = {
  '/talk.core.js': 'talk.core.js',
  '/talk.page.js': 'talk.page.js',
  '/talk.voice.js': 'talk.voice.js',
  // termhub's mic capture (web/voiceCapture.js, web/micWorklet.js), copied:
  // test/voiceCaptureCopy.test.js fails when the copies drift.
  '/talk.capture.js': 'voiceCapture.js',
  '/talk.worklet.js': 'micWorklet.js',
};
// The page's models, by name: nothing else under PA_VOICE_MODELS is served.
const MODEL_FILES: Record<string, string> = {
  'silero_vad.onnx': 'application/octet-stream',
  'melspectrogram.onnx': 'application/octet-stream',
  'embedding_model.onnx': 'application/octet-stream',
  'hey_jarvis_v0.1.onnx': 'application/octet-stream',
  'ort/ort.wasm.min.js': 'text/javascript; charset=utf-8',
  'ort/ort-wasm-simd-threaded.mjs': 'text/javascript; charset=utf-8',
  'ort/ort-wasm-simd-threaded.wasm': 'application/wasm',
};
const MODEL_GROUPS: Record<string, string[]> = {
  vad: ['silero_vad.onnx'],
  wake: ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'],
  ort: ['ort/ort.wasm.min.js', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm'],
};
// 30 s of 16 kHz 16-bit mono is ~1 MB; anything far past that is not one utterance.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

function readBody(req: Req, limit: number = MAX_AUDIO_BYTES) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > limit) {
        const err: HttpErr = new Error('audio too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// One request to the faster-whisper server: path in, text out.
//
// The path is written and the socket is NOT half-closed. The server reads one
// request (`conn.recv`), answers, and closes, so the FIN adds nothing; and
// under Bun `socket.end()` does not half-close, it closes the connection
// outright: the client saw "closed, no data" within milliseconds and returned
// empty text, the WAV was deleted, and the transcriber then failed to open it
// (WinError 10054, "No such file"). A close with no reply bytes after almost no
// time is a failed exchange, never "the user said nothing": whisper takes
// tens of milliseconds even on silence. askWhisper retries such a failure once.
const MIN_REPLY_MS = 40;
function askWhisperOnce(file: string, { host, port, timeoutMs, minReplyMs = MIN_REPLY_MS }: WhisperOpts) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const started = Date.now();
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs, () => sock.destroy(Object.assign(new Error('transcriber timed out'), { status: 504 })));
    sock.on('connect', () => sock.write(file + '\n', 'utf8'));
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.on('error', (err: HttpErr) => {
      if (!err.status) {
        err.status = 503;
        err.message = `transcriber not reachable on ${host}:${port} (${err.code || err.message})`;
      }
      reject(err);
    });
    sock.on('close', (hadError: boolean) => {
      if (hadError) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.startsWith('ERROR:')) return reject(Object.assign(new Error(text.slice(6).trim() || 'transcriber error'), { status: 502 }));
      if (!text && Date.now() - started < minReplyMs) {
        return reject(Object.assign(new Error('transcriber closed the connection without a reply'), { status: 502, retry: true }));
      }
      resolve(text.trim());
    });
  });
}

async function askWhisper(file: string, { host = config.audio.transcribeHost, port = config.audio.transcribePort, timeoutMs = TIMEOUT_MS, minReplyMs }: WhisperOpts = {}) {
  const o = { host, port, timeoutMs, minReplyMs };
  try {
    return await askWhisperOnce(file, o);
  } catch (err) {
    if (!(err as HttpErr).retry) throw err;
    return askWhisperOnce(file, o); // once; a second failure is an error too
  }
}
let whisperUsedAt = 0;
let whisperBusy = 0;
async function transcribe(audio: Buffer, opts?: WhisperOpts) {
  const file = path.join(os.tmpdir(), `pa-talk-${process.pid}-${crypto.randomBytes(6).toString('hex')}.wav`);
  await fs.promises.writeFile(file, audio);
  whisperBusy++;
  try {
    return await askWhisper(file, opts);
  } finally {
    whisperBusy--;
    whisperUsedAt = Date.now();
    fs.promises.unlink(file).catch(() => {});
  }
}

// The whole voice path, warmed while the user is still talking (the page
// calls POST /api/talk/warm when an utterance starts, and GET /talk does it
// on open): the GPU voice is clocked up, and the transcriber, which unloads
// its model after half an hour idle and takes ~6 s to load it again, is
// handed a quarter second of silence. Fire and forget.
//
// From an utterance's start (keep), the transcriber is handed that silence
// every WHISPER_PING_GAP_MS until the end-of-turn check or the transcription
// arrives (stopWhisperWarm), WHISPER_PING_MAX_MS at most: the laptop GPU
// clocks down within seconds of idle, and the first transcription after a
// pause took 530-800 ms against ~230-350 ms with the pings. One ping still
// running when the real request comes delays it by its remainder (~150 ms
// at worst; the transcriber takes one request at a time).
const SILENCE_WAV = Buffer.from(require('./talk.core').encodeWav(new Float32Array(4000), 16000));
const WHISPER_PING_GAP_MS = 400;
const WHISPER_PING_MAX_MS = 10_000;
// An utterance and its turn, from the warm at its start: the fast lane's
// snapshot is refreshed then if it would go stale within this.
const UTTERANCE_MS = 20_000;
const whisperPings = { until: 0, running: false };
function keepWhisperWarm(now: number = Date.now(), { gapMs = WHISPER_PING_GAP_MS, maxMs = WHISPER_PING_MAX_MS }: { gapMs?: number; maxMs?: number } = {}) {
  whisperPings.until = now + maxMs;
  if (whisperPings.running) return;
  whisperPings.running = true;
  (async () => {
    while (Date.now() < whisperPings.until) {
      if (!whisperBusy) await transcribe(SILENCE_WAV).catch(() => {});
      if (Date.now() < whisperPings.until) await new Promise((r) => setTimeout(r, gapMs));
    }
  })().finally(() => {
    whisperPings.running = false;
  });
}
function stopWhisperWarm() {
  whisperPings.until = 0;
}
function warmVoicePath(now: number = Date.now(), { keep = false }: { keep?: boolean } = {}) {
  voiceRequest('POST', 'warm', { body: Buffer.from('{}'), headers: { 'Content-Type': 'application/json' }, timeoutMs: 5000 })
    .then((r: IncomingMessage) => r.resume())
    .catch(() => {});
  if (keep) return keepWhisperWarm(now);
  if (now - whisperUsedAt > 5 * 60_000) {
    whisperUsedAt = now;
    transcribe(SILENCE_WAV).catch(() => {});
  }
}

// ---- The local voice service (voice/server.py) ---------------------------------

// One request to the service. Resolves with the response (unread), rejects
// with status 503 when it is not there or not configured.
function voiceRequest(method: string, p: string, { body = null, headers = {}, timeoutMs = 15_000, base = config.voice.url }: { body?: Buffer | null; headers?: Record<string, unknown>; timeoutMs?: number; base?: unknown } = {}) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    if (!base) return reject(Object.assign(new Error('the voice service is off (PA_VOICE_URL=off)'), { status: 503 }));
    let u: URL;
    try {
      u = new URL(p, base + '/');
    } catch {
      return reject(Object.assign(new Error(`PA_VOICE_URL is not a URL: ${base}`), { status: 503 }));
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) } },
      resolve
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('the voice service timed out'), { status: 504 })));
    req.on('error', (err: HttpErr) => {
      if (!err.status) {
        err.status = 503;
        err.message = `the voice service is not reachable at ${base} (${err.code || err.message})`;
      }
      reject(err);
    });
    req.end(body || undefined);
  });
}

async function voiceJson(method: string, p: string, opts?: Parameters<typeof voiceRequest>[2]) {
  const res = await voiceRequest(method, p, opts);
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c);
  let data: Row = {};
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    /* not JSON: data stays empty */
  }
  return { status: res.statusCode, data };
}

function modelsPresent(dir: string = config.voice.models) {
  const has = (f: string) => {
    try {
      return fs.statSync(path.join(dir, f)).size > 0;
    } catch {
      return false;
    }
  };
  const out: Record<string, boolean> = {};
  for (const [k, files] of Object.entries(MODEL_GROUPS)) out[k] = files.every(has);
  return out;
}

// What the page needs to choose its engines: GET /api/talk/voice. The health
// answer is cached briefly (the page asks on load and on each wake), the
// voice list once it has been read.
const voiceCache: { at: number; health: Row | null; voices: unknown } = { at: 0, health: null, voices: null };
async function voiceInfo(now: number = Date.now()) {
  if (now - voiceCache.at > 3000) {
    voiceCache.at = now;
    voiceCache.health = await voiceJson('GET', 'health', { timeoutMs: 1500 })
      .then((r) => r.data)
      .catch((err: Error) => ({ ok: false, error: err.message }));
    if (voiceCache.health.ok && !voiceCache.voices) {
      voiceCache.voices = await voiceJson('GET', 'voices', { timeoutMs: 1500 })
        .then((r) => r.data.voices || null)
        .catch(() => null);
    }
  }
  const h = voiceCache.health || {};
  return {
    tts: { ok: !!h.ok, ready: !!h.ready, error: h.error || null, device: h.device || null, warmMs: h.warmMs ?? null },
    turn: !!(h.ok && h.turn),
    voices: voiceCache.voices || [],
    defaultVoice: config.voice.defaultVoice,
    models: modelsPresent(),
  };
}

// Streams the service's answer through, status and audio headers included.
async function proxyVoice(req: Req, res: Res, p: string, { send, limit, contentType }: { send: Ctx['send']; limit?: number | undefined; contentType?: string | null | undefined }) {
  const body = await readBody(req, limit);
  let up: IncomingMessage;
  try {
    up = await voiceRequest('POST', p, { body, headers: { 'Content-Type': contentType || req.headers['content-type'] || 'application/octet-stream' }, timeoutMs: 30_000 });
  } catch (err) {
    send(res, (err as HttpErr).status || 503, { error: (err as HttpErr).message });
    return;
  }
  const headers: import('http').OutgoingHttpHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' };
  for (const [k, v] of Object.entries(up.headers)) {
    if (k === 'content-type' || k.startsWith('x-')) headers[k] = v;
  }
  res.writeHead(up.statusCode as number, headers);
  // The page went away (barge-in): stop reading, and the service stops writing.
  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });
  up.on('error', () => res.destroy());
  up.pipe(res);
}

function serveModel(res: Res, name: string, { send }: { send: Ctx['send'] }) {
  const type = MODEL_FILES[name];
  if (!type) return send(res, 404, { error: 'unknown model file' });
  const file = path.join(config.voice.models, name);
  fs.stat(file, (err: Error | null, st: import('fs').Stats) => {
    if (err || !st.isFile()) return send(res, 404, { error: `${name} is not installed: run windows/install-voice.ps1` });
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      // Versioned by the installer; a day keeps a reload from re-fetching 11 MB.
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

function pageHtml(token: string | null = null) {
  // Where the "session" link goes: the dashboard's termhub (PA_TERMHUB_URL).
  // Opened through termhub's /pa/ proxy, the page uses its own origin instead.
  const termhub = String(config.termhub.url || '').replace(/"/g, '&quot;');
  // The page token (src/dashboard/server.js): the Approve/Deny buttons on a
  // permission prompt send it back (POST /api/chat/permission).
  const page = token ? `\n<meta name="pa-page" content="${String(token).replace(/[^A-Za-z0-9_-]/g, '')}">` : '';
  return fs.readFileSync(path.join(DIR, 'talk.html'), 'utf8').replace('</head>', `<meta name="pa-termhub" content="${termhub}">${page}\n</head>`);
}

// Returns true when it answered the request.
// The voice page is not a meeting. What it says and when it holds the mic go
// to the logs meeting capture reads (src/audio/selfSpeech.ts): a spoken turn
// or reply marks the time as yours, and while the page listens its browser is
// not counted as a call by the meeting gate.
const talkNoted: Record<string, number> = {};
function noteTalk(what: string, now: number = Date.now()) {
  if (now - (talkNoted[what] || 0) < 5000) return;
  talkNoted[what] = now;
  require('../audio/selfSpeech.ts').append(config.audio.selfSpeech.talkLog, { at: new Date(now).toISOString(), what }, now);
}

function noteMic(on: boolean, userAgent: unknown, now: number = Date.now()) {
  const file = config.audio.selfSpeech.talkMicFile;
  try {
    if (!on) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), browser: require('../audio/selfSpeech.ts').browserOf(userAgent) }));
  } catch {
    /* best effort: the gate then counts the browser, as before */
  }
}

async function route(req: Req, res: Res, url: URL, { send, issuePageToken = null }: { send: Ctx['send']; issuePageToken?: Ctx['issuePageToken'] | null }) {
  if (req.method === 'GET' && url.pathname === '/talk') {
    // The fast lane's snapshot of the day is built now, not on the first turn.
    // So is the local fast model loaded (Ollama), and the GPU voice clocked up.
    if (config.fastLane.enabled) {
      const fl = require('../chat/fastLane.ts');
      fl.snapshotCache().warm();
      fl.warm();
    }
    warmVoicePath();
    send(res, 200, pageHtml(issuePageToken ? issuePageToken() : null), 'text/html; charset=utf-8');
    return true;
  }
  if (req.method === 'GET' && ASSETS[url.pathname]) {
    send(res, 200, fs.readFileSync(path.join(DIR, ASSETS[url.pathname] as string), 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/talk/transcribe') {
    // Same guard as every POST: a custom header forces a CORS preflight.
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
    stopWhisperWarm();
    const audio = await readBody(req);
    if (audio.length < 44) {
      send(res, 400, { error: 'no audio' });
      return true;
    }
    const started = Date.now();
    const text = await transcribe(audio);
    send(res, 200, { text, ms: Date.now() - started });
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/talk/models/')) {
    serveModel(res, decodeURIComponent(url.pathname.slice('/talk/models/'.length)), { send });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/talk/voice') {
    send(res, 200, await voiceInfo());
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/talk/warm') {
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
    req.resume();
    warmVoicePath(Date.now(), { keep: true });
    // An utterance has begun: its turn comes in a second or more. A snapshot
    // rebuilt inside the turn held the loop and re-primed Ollama under it
    // (+100-250 ms to the first token); rebuilt now, it is primed by then.
    if (config.fastLane.enabled) require('../chat/fastLane.ts').snapshotCache().warm({ marginMs: UTTERANCE_MS });
    send(res, 202, { ok: true });
    return true;
  }
  // One line per spoken turn: end of speech -> first audio, and its slices.
  // The page measures it (talk.core.js latencySlices); this puts it in the PA's
  // log so latency can be followed without opening devtools.
  if (req.method === 'POST' && url.pathname === '/api/talk/latency') {
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
    let body: unknown = {};
    try {
      body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
    } catch {
      /* a malformed report is dropped */
    }
    const fields = sanitizeLatency(body);
    if (fields) log.info('voice turn latency', fields);
    noteTalk('turn');
    send(res, 202, { ok: !!fields });
    return true;
  }
  const VOICE_POSTS: Record<string, [string, number, string | null]> = { '/api/talk/tts': ['tts', 64 * 1024, 'application/json'], '/api/talk/endpoint': ['endpoint', MAX_AUDIO_BYTES, null] };
  const voicePost = VOICE_POSTS[url.pathname];
  if (req.method === 'POST' && voicePost) {
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
    const [p, limit, type] = voicePost;
    if (p === 'endpoint') stopWhisperWarm(); // the user has paused: the transcription is next
    if (p === 'tts') noteTalk('tts');
    await proxyVoice(req, res, p, { send, limit, contentType: type });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/talk/turn') {
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
    noteTalk('turn');
    await turn(req, res, { send });
    return true;
  }
  // The page holds the mic ({on: true}, every 20 s while listening) or let it go.
  if (req.method === 'POST' && url.pathname === '/api/talk/mic') {
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
    let body: { on?: unknown } = {};
    try {
      body = JSON.parse((await readBody(req, 1024)).toString('utf8') || '{}');
    } catch {
      /* malformed: treated as off */
    }
    noteMic(body.on === true, req.headers['user-agent']);
    send(res, 202, { ok: true });
    return true;
  }
  return false;
}

// One spoken turn through the fast lane, streamed as NDJSON: one JSON event
// per line (decision, delta…, handoff, done; src/chat/fastLane.js runTurn).
// Off (PA_FAST_LANE=0): 404 { disabled: true }, and the page sends to
// /api/chat itself, as before.
async function turn(req: Req, res: Res, { send }: { send: Ctx['send'] }) {
  if (!config.fastLane.enabled) {
    send(res, 404, { error: 'the fast lane is off (PA_FAST_LANE=0)', disabled: true });
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
  } catch {
    send(res, 400, { error: 'bad json' });
    return;
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    send(res, 400, { error: 'text must be a non-empty string' });
    return;
  }
  if (text.length > 4000) {
    send(res, 400, { error: 'text is over 4000 characters' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  });
  // The page went away (barge-in aborts its fetch): stop the model. A
  // hand-off already made stands — the PA chat has the words.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  const emit = (e: Row) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(e) + '\n');
  };
  try {
    // Meter's voice-turn hop (plan 7.5): the whole fast-lane turn, with the route and the model's first-token time.
    const telemetry = require('../telemetry');
    await telemetry.span('voice.turn', 'voice turn', {}, async (s: Span | null) => {
      const seen = (e: Row) => {
        if (e?.type === 'done' && s) {
          if (e.route) s.setAttribute('route', String(e.route));
          if (Number.isFinite(e.firstTokenMs)) s.setAttribute('first_token_ms', e.firstTokenMs);
        } else if (e?.type === 'error') telemetry.fail(s, 'turn error');
        emit(e);
      };
      await require('../chat/fastLane.ts').runTurn({ text, emit: seen, signal: ac.signal });
    });
  } catch (err) {
    if (!ac.signal.aborted) emit({ type: 'error', error: (err as Error).message });
  }
  if (!res.writableEnded) res.end();
}

module.exports = { route, sanitizeLatency, transcribe, askWhisper, keepWhisperWarm, stopWhisperWarm, voiceInfo, modelsPresent, MODEL_FILES, MAX_AUDIO_BYTES };
