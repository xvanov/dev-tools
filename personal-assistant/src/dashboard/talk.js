'use strict';

// The voice page ("layer 1"): /talk, a face that listens and talks back.
// The browser does the listening (mic, VAD) and the speaking (TTS); this
// module serves the page and its scripts, and proxies an utterance to
// voice-dictation's faster-whisper server so the same warm model that does
// dictation and meeting capture turns it into text. The text then goes to
// /api/chat like anything typed (src/dashboard/talk.html, talk.page.js).
//
// The transcriber's protocol (voice-dictation/transcribe_server.py) is a raw
// TCP exchange: send an absolute path to an audio file, half-close, read the
// transcript (or "ERROR: …") until EOF. So the uploaded WAV is written to a
// temp file first and removed afterwards, whatever happens.

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

const DIR = __dirname;
const ASSETS = {
  '/talk.core.js': 'talk.core.js',
  '/talk.page.js': 'talk.page.js',
  '/talk.voice.js': 'talk.voice.js',
  // termhub's mic capture (web/voiceCapture.js, web/micWorklet.js), copied:
  // test/voiceCaptureCopy.test.js fails when the copies drift.
  '/talk.capture.js': 'voiceCapture.js',
  '/talk.worklet.js': 'micWorklet.js',
};
// The page's models, by name: nothing else under PA_VOICE_MODELS is served.
const MODEL_FILES = {
  'silero_vad.onnx': 'application/octet-stream',
  'melspectrogram.onnx': 'application/octet-stream',
  'embedding_model.onnx': 'application/octet-stream',
  'hey_jarvis_v0.1.onnx': 'application/octet-stream',
  'ort/ort.wasm.min.js': 'text/javascript; charset=utf-8',
  'ort/ort-wasm-simd-threaded.mjs': 'text/javascript; charset=utf-8',
  'ort/ort-wasm-simd-threaded.wasm': 'application/wasm',
};
const MODEL_GROUPS = {
  vad: ['silero_vad.onnx'],
  wake: ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx'],
  ort: ['ort/ort.wasm.min.js', 'ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm'],
};
// 30 s of 16 kHz 16-bit mono is ~1 MB; anything far past that is not one utterance.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

function readBody(req, limit = MAX_AUDIO_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        const err = new Error('audio too large');
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
function askWhisper(file, { host = config.audio.transcribeHost, port = config.audio.transcribePort, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs, () => sock.destroy(Object.assign(new Error('transcriber timed out'), { status: 504 })));
    sock.on('connect', () => sock.end(file, 'utf8'));
    sock.on('data', (d) => chunks.push(d));
    sock.on('error', (err) => {
      if (!err.status) {
        err.status = 503;
        err.message = `transcriber not reachable on ${host}:${port} (${err.code || err.message})`;
      }
      reject(err);
    });
    sock.on('close', (hadError) => {
      if (hadError) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.startsWith('ERROR:')) return reject(Object.assign(new Error(text.slice(6).trim() || 'transcriber error'), { status: 502 }));
      resolve(text.trim());
    });
  });
}

let whisperUsedAt = 0;
async function transcribe(audio, opts) {
  const file = path.join(os.tmpdir(), `pa-talk-${process.pid}-${crypto.randomBytes(6).toString('hex')}.wav`);
  await fs.promises.writeFile(file, audio);
  try {
    return await askWhisper(file, opts);
  } finally {
    whisperUsedAt = Date.now();
    fs.promises.unlink(file).catch(() => {});
  }
}

// The whole voice path, warmed while the user is still talking (the page
// calls POST /api/talk/warm when an utterance starts, and GET /talk does it
// on open): the GPU voice is clocked up, and the transcriber, which unloads
// its model after half an hour idle and takes ~6 s to load it again, is
// handed a quarter second of silence. Fire and forget.
const SILENCE_WAV = Buffer.from(require('./talk.core').encodeWav(new Float32Array(4000), 16000));
function warmVoicePath(now = Date.now()) {
  voiceRequest('POST', 'warm', { body: Buffer.from('{}'), headers: { 'Content-Type': 'application/json' }, timeoutMs: 5000 })
    .then((r) => r.resume())
    .catch(() => {});
  if (now - whisperUsedAt > 5 * 60_000) {
    whisperUsedAt = now;
    transcribe(SILENCE_WAV).catch(() => {});
  }
}

// ---- The local voice service (voice/server.py) ---------------------------------

// One request to the service. Resolves with the response (unread), rejects
// with status 503 when it is not there or not configured.
function voiceRequest(method, p, { body = null, headers = {}, timeoutMs = 15_000, base = config.voice.url } = {}) {
  return new Promise((resolve, reject) => {
    if (!base) return reject(Object.assign(new Error('the voice service is off (PA_VOICE_URL=off)'), { status: 503 }));
    let u;
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
    req.on('error', (err) => {
      if (!err.status) {
        err.status = 503;
        err.message = `the voice service is not reachable at ${base} (${err.code || err.message})`;
      }
      reject(err);
    });
    req.end(body || undefined);
  });
}

async function voiceJson(method, p, opts) {
  const res = await voiceRequest(method, p, opts);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  let data = {};
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    /* not JSON: data stays empty */
  }
  return { status: res.statusCode, data };
}

function modelsPresent(dir = config.voice.models) {
  const has = (f) => {
    try {
      return fs.statSync(path.join(dir, f)).size > 0;
    } catch {
      return false;
    }
  };
  const out = {};
  for (const [k, files] of Object.entries(MODEL_GROUPS)) out[k] = files.every(has);
  return out;
}

// What the page needs to choose its engines: GET /api/talk/voice. The health
// answer is cached briefly (the page asks on load and on each wake), the
// voice list once it has been read.
const voiceCache = { at: 0, health: null, voices: null };
async function voiceInfo(now = Date.now()) {
  if (now - voiceCache.at > 3000) {
    voiceCache.at = now;
    voiceCache.health = await voiceJson('GET', 'health', { timeoutMs: 1500 })
      .then((r) => r.data)
      .catch((err) => ({ ok: false, error: err.message }));
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
async function proxyVoice(req, res, p, { send, limit, contentType }) {
  const body = await readBody(req, limit);
  let up;
  try {
    up = await voiceRequest('POST', p, { body, headers: { 'Content-Type': contentType || req.headers['content-type'] || 'application/octet-stream' }, timeoutMs: 30_000 });
  } catch (err) {
    send(res, err.status || 503, { error: err.message });
    return;
  }
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' };
  for (const [k, v] of Object.entries(up.headers)) {
    if (k === 'content-type' || k.startsWith('x-')) headers[k] = v;
  }
  res.writeHead(up.statusCode, headers);
  // The page went away (barge-in): stop reading, and the service stops writing.
  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });
  up.on('error', () => res.destroy());
  up.pipe(res);
}

function serveModel(res, name, { send }) {
  const type = MODEL_FILES[name];
  if (!type) return send(res, 404, { error: 'unknown model file' });
  const file = path.join(config.voice.models, name);
  fs.stat(file, (err, st) => {
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

function pageHtml() {
  // Where the "session" link goes: the dashboard's termhub (PA_TERMHUB_URL).
  // Opened through termhub's /pa/ proxy, the page uses its own origin instead.
  const termhub = String(config.termhub.url || '').replace(/"/g, '&quot;');
  return fs.readFileSync(path.join(DIR, 'talk.html'), 'utf8').replace('</head>', `<meta name="pa-termhub" content="${termhub}">\n</head>`);
}

// Returns true when it answered the request.
async function route(req, res, url, { send }) {
  if (req.method === 'GET' && url.pathname === '/talk') {
    // The fast lane's snapshot of the day is built now, not on the first turn.
    // So is the local fast model loaded (Ollama), and the GPU voice clocked up.
    if (config.fastLane.enabled) {
      const fl = require('../chat/fastLane');
      fl.snapshotCache().warm();
      fl.warm();
    }
    warmVoicePath();
    send(res, 200, pageHtml(), 'text/html; charset=utf-8');
    return true;
  }
  if (req.method === 'GET' && ASSETS[url.pathname]) {
    send(res, 200, fs.readFileSync(path.join(DIR, ASSETS[url.pathname]), 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/talk/transcribe') {
    // Same guard as every POST: a custom header forces a CORS preflight.
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
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
    warmVoicePath();
    send(res, 202, { ok: true });
    return true;
  }
  const VOICE_POSTS = { '/api/talk/tts': ['tts', 64 * 1024, 'application/json'], '/api/talk/endpoint': ['endpoint', MAX_AUDIO_BYTES, null] };
  if (req.method === 'POST' && VOICE_POSTS[url.pathname]) {
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
    const [p, limit, type] = VOICE_POSTS[url.pathname];
    await proxyVoice(req, res, p, { send, limit, contentType: type });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/talk/turn') {
    if (req.headers['x-pa'] !== '1') {
      send(res, 403, { error: 'missing X-PA header' });
      return true;
    }
    await turn(req, res, { send });
    return true;
  }
  return false;
}

// One spoken turn through the fast lane, streamed as NDJSON: one JSON event
// per line (decision, delta…, handoff, done; src/chat/fastLane.js runTurn).
// Off (PA_FAST_LANE=0): 404 { disabled: true }, and the page sends to
// /api/chat itself, as before.
async function turn(req, res, { send }) {
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
  const emit = (e) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(e) + '\n');
  };
  try {
    await require('../chat/fastLane').runTurn({ text, emit, signal: ac.signal });
  } catch (err) {
    if (!ac.signal.aborted) emit({ type: 'error', error: err.message });
  }
  if (!res.writableEnded) res.end();
}

module.exports = { route, transcribe, askWhisper, voiceInfo, modelsPresent, MODEL_FILES, MAX_AUDIO_BYTES };
