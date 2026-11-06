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
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

const DIR = __dirname;
const ASSETS = {
  '/talk.core.js': 'talk.core.js',
  '/talk.page.js': 'talk.page.js',
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

async function transcribe(audio, opts) {
  const file = path.join(os.tmpdir(), `pa-talk-${process.pid}-${crypto.randomBytes(6).toString('hex')}.wav`);
  await fs.promises.writeFile(file, audio);
  try {
    return await askWhisper(file, opts);
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
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
    if (config.fastLane.enabled) require('../chat/fastLane').snapshotCache().warm();
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

module.exports = { route, transcribe, askWhisper, MAX_AUDIO_BYTES };
