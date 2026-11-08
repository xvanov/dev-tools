'use strict';

// Server-side speech-to-text for the 🎤 button:
//
//   GET  /api/transcribe[?local=1]   -> {available, backend, local, peer, reason}
//   POST /api/transcribe  (audio/wav) -> {text, ms, backend[, peer]}
//
// Why it exists: on a phone the browser's own SpeechRecognition is the least
// dependable part of the voice loop — Dictation switched off, home-screen mode,
// the phone's language, Android's beep on every start(), no route to Apple's or
// Google's service. The page now records the audio itself (web/voiceCapture.js)
// and sends one 16 kHz mono WAV per utterance here.
//
// Where the words come from, first that works:
//
//   1. local  voice-dictation's faster-whisper server on THIS machine
//             (voice-dictation/transcribe_server.py, TCP 127.0.0.1:47821 by
//             default). Its protocol is a path, not bytes: send an absolute path
//             to an audio file, half-close, read the text (or "ERROR: …") until
//             EOF. So the upload is written to a private temp file first and
//             removed afterwards. That also means the server must run on the
//             same machine as this front — it opens the path itself.
//   2. peer   a configured peer termhub (lib/peers.js — peers.json or
//             TERMHUB_PEERS, the same list the dashboard reads) whose own
//             `GET /api/transcribe?local=1` says it has a local whisper. Only
//             peers in that list, never a URL from the request: this must not
//             turn the front into a fetcher for anything on the tailnet. The
//             forwarded request carries `X-Termhub-Transcribe-Hop: 1`, which
//             makes the peer answer from its LOCAL backend only, so two
//             machines pointing at each other can never loop.
//   3. none   503 with a reason; the page falls back to SpeechRecognition.
//
// Configuration (env):
//   TERMHUB_TRANSCRIBE=off            no server-side transcription at all
//   TERMHUB_TRANSCRIBE_HOST/_PORT     the local whisper (default 127.0.0.1:47821;
//                                     voice-dictation's TRANSCRIBE_HOST/_PORT are
//                                     read as a fallback, so one setting serves both)
//   TERMHUB_TRANSCRIBE_PEER           `off` = never forward; a host or URL = only
//                                     that peer (it must still be a configured peer);
//                                     unset = any configured peer that has one
//
// Bounded, because any tailnet page can reach it: the usual CSRF guard
// (X-Termhub + a non-simple Content-Type, lib/requestGuard.js — audio/wav is
// fine), a body cap, a RIFF/WAVE check before anything is written, a rate cap
// across all clients, and at most MAX_ACTIVE transcriptions in flight with a
// short queue (lib/limit.js; overflow is a 503, not a wait).
//
// Served by the FRONT, for the reason lib/exec.js is: an update swaps the
// front and never restarts sessiond.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const fs = require('fs');
const os = require('os');
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createLimiter } = require('./limit');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 47821;            // voice-dictation/transcribe_server.py
// 30 s of 16 kHz 16-bit mono is ~0.96 MB; the page's VAD caps an utterance at
// 30 s and push-to-talk at 60 s. Anything past this is not one utterance.
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const WHISPER_TIMEOUT_MS = 120_000;    // a cold model load is 10-30 s
const PEER_TIMEOUT_MS = 60_000;
const LOCAL_PROBE_MS = 800;
const LOCAL_CACHE_MS = 10_000;
const PEER_CACHE_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;
const MAX_ACTIVE = 2;
const MAX_QUEUED = 4;
const HOP_HEADER = 'x-termhub-transcribe-hop';
const WAV_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

function settings(env: Record<string, string | undefined> = process.env) {
  const port = Number(env.TERMHUB_TRANSCRIBE_PORT || env.TRANSCRIBE_PORT || DEFAULT_PORT);
  return {
    enabled: String(env.TERMHUB_TRANSCRIBE || '').toLowerCase() !== 'off',
    host: env.TERMHUB_TRANSCRIBE_HOST || env.TRANSCRIBE_HOST || DEFAULT_HOST,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    peer: String(env.TERMHUB_TRANSCRIBE_PEER || '').trim(),
  };
}

/** Pure: is this body a RIFF/WAVE file worth handing to whisper? null = yes, else why not. */
function wavProblem(buf: any) {
  if (!buf || buf.length < 44) return 'no audio';
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 'not a WAV file';
  return null;
}

/** Pure: which configured peers may serve, given TERMHUB_TRANSCRIBE_PEER. */
function eligiblePeers(peerUrls: any, peerSetting: any) {
  const s = String(peerSetting || '').trim().toLowerCase();
  if (s === 'off' || s === '0' || s === 'none') return [];
  if (!s) return [...peerUrls];
  return peerUrls.filter((u: any) => {
    let host = '';
    try { host = new URL(u).hostname.toLowerCase(); } catch { return false; }
    return u.toLowerCase() === s || u.toLowerCase() === s.replace(/\/+$/, '') || host === s || host.split('.')[0] === s;
  });
}

/**
 * Pure: the backend selection.
 *   localUp   whether the local whisper answered a connect
 *   peers     [{url, local: true|false|null}] in configured order
 *   hop       the request already came from a peer: local only
 * -> {kind:'local'} | {kind:'peer', url} | {kind:'none', reason}
 */
function chooseBackend({ enabled = true, localUp, peers = [], hop = false, host, port }: { enabled?: boolean | undefined; localUp?: any; peers?: any; hop?: boolean | undefined; host?: any; port?: any }) {
  if (!enabled) return { kind: 'none', reason: 'server-side transcription is off on this machine (TERMHUB_TRANSCRIBE=off)' };
  if (localUp) return { kind: 'local' };
  const where = `${host || DEFAULT_HOST}:${port || DEFAULT_PORT}`;
  if (hop) return { kind: 'none', reason: `no whisper server on ${where} on this machine` };
  const peer = peers.find((p: any) => p && p.local === true);
  if (peer) return { kind: 'peer', url: peer.url };
  const asked = peers.length;
  return {
    kind: 'none',
    reason: `no whisper server on ${where}`
      + (asked ? `, and none of ${asked} configured peer${asked === 1 ? '' : 's'} has one` : ', and no peer termhub is configured'),
  };
}

// ---- the local whisper server --------------------------------------------------

function probePort(host: any, port: any, timeoutMs: any = LOCAL_PROBE_MS) {
  return new Promise<any>((resolve) => {
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (ok: any) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => finish(false));
    // transcribe_server.py reads an empty request, answers nothing and closes:
    // a bare connect is a harmless probe.
    sock.on('connect', () => { sock.end(); finish(true); });
    sock.on('error', () => finish(false));
  });
}

// One request to the faster-whisper server: path in, text out.
function askWhisper(file: any, { host, port, timeoutMs = WHISPER_TIMEOUT_MS }: { host?: any; port?: any; timeoutMs?: any }) {
  return new Promise<any>((resolve, reject) => {
    const chunks: any[] = [];
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs, () => sock.destroy(Object.assign(new Error('the whisper server timed out'), { status: 504 })));
    sock.on('connect', () => sock.end(file, 'utf8'));
    sock.on('data', (d: any) => chunks.push(d));
    sock.on('error', (err: any) => {
      if (!err.status) {
        err.status = 503;
        err.unreachable = true;
        err.message = `whisper server not reachable on ${host}:${port} (${err.code || err.message})`;
      }
      reject(err);
    });
    sock.on('close', (hadError: any) => {
      if (hadError) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.startsWith('ERROR:')) return reject(Object.assign(new Error(text.slice(6).trim() || 'whisper error'), { status: 502 }));
      resolve(text.trim());
    });
  });
}

async function transcribeLocal(audio: any, { host, port, tmpDir = os.tmpdir() }: { host?: any; port?: any; tmpDir?: any }) {
  const file = path.join(tmpDir, `termhub-stt-${process.pid}-${crypto.randomBytes(8).toString('hex')}.wav`);
  await fs.promises.writeFile(file, audio, { mode: 0o600 });
  try {
    return await askWhisper(path.resolve(file), { host, port });
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

// ---- peers -------------------------------------------------------------------

// The peer's MagicDNS name, resolved like lib/peers.js does: the system
// resolver first, `tailscale status` for a .ts.net name it can't find (a box
// with Tailscale DNS turned off next to a corporate VPN). TLS still verifies
// against the name.
let tsMap = { at: 0, map: new Map() };
function tailnetIp(hostname: any, hostsFromStatus: any) {
  if (Date.now() - tsMap.at < 60_000) return Promise.resolve(tsMap.map.get(hostname.toLowerCase()) || null);
  return new Promise<any>((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err: any, stdout: any) => {
      let map = new Map();
      if (!err) { try { map = hostsFromStatus(JSON.parse(stdout)); } catch {} }
      tsMap = { at: Date.now(), map };
      resolve(map.get(hostname.toLowerCase()) || null);
    });
  });
}

function makeLookup(hostsFromStatus: any) {
  return (hostname: any, options: any, cb: any) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, options, (err: any, address: any, family: any) => {
      if (!err || !/\.ts\.net$/i.test(hostname) || !hostsFromStatus) return cb(err, address, family);
      tailnetIp(hostname, hostsFromStatus).then((ip) => {
        if (!ip) return cb(err);
        if (options && options.all) return cb(null, [{ address: ip, family: 4 }]);
        return cb(null, ip, 4);
      }, () => cb(err));
    });
  };
}

// POST the WAV to a peer's /api/transcribe, as a program (no Origin): the
// peer's guard wants its own name in Host (the URL gives it), X-Termhub and a
// non-simple Content-Type, like any other client.
function postToPeer(url: any, audio: any, { timeoutMs = PEER_TIMEOUT_MS, lookup }: { timeoutMs?: any; lookup?: any } = {}) {
  return new Promise<any>((resolve, reject) => {
    let target;
    try { target = new URL('/api/transcribe', url); } catch (e: any) { return reject(e); }
    const lib = target.protocol === 'http:' ? http : https;
    const req = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname,
      method: 'POST',
      timeout: timeoutMs,
      lookup,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': audio.length,
        'X-Termhub': '1',
        'X-Termhub-Transcribe-Hop': '1',
      },
    }, (res: any) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c: any) => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        if (res.statusCode === 200 && body && typeof body.text === 'string') return resolve(body.text);
        const err: any = new Error(`peer ${target.host} answered ${res.statusCode}${body && body.error ? `: ${body.error}` : ''}`);
        err.status = res.statusCode === 503 ? 503 : 502;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`peer ${target.host} timed out`), { status: 504 })));
    req.on('error', (e: any) => reject(Object.assign(e, { status: e.status || 502 })));
    req.end(audio);
  });
}

// ---- the route -----------------------------------------------------------------

function readBody(req: any, limit: any) {
  return new Promise<any>((resolve, reject) => {
    const chunks: any[] = [];
    let size = 0;
    let over = false;
    req.on('data', (d: any) => {
      if (over) return;
      size += d.length;
      if (size > limit) { over = true; chunks.length = 0; return; }
      chunks.push(d);
    });
    req.on('end', () => (over
      ? reject(Object.assign(new Error(`audio is over ${limit} bytes`), { status: 413 }))
      : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

/**
 * Everything is injectable for tests: `env`, the peer list, and the two
 * network calls. Defaults are the real ones.
 */
function createTranscriber({
  env = process.env,
  listPeers,
  fetchJson,
  hostsFromStatus,
  now = () => Date.now(),
  tmpDir,
  rateMax = RATE_MAX,
}: { env?: Record<string, string | undefined>; listPeers?: any; fetchJson?: any; hostsFromStatus?: any; now?: any; tmpDir?: any; rateMax?: any } = {}) {
  if (!listPeers || !fetchJson) {
    const peers = require('./peers.ts');
    listPeers = listPeers || peers.list;
    fetchJson = fetchJson || peers.fetchJson;
    hostsFromStatus = hostsFromStatus || peers.hostsFromStatus;
  }
  const lookup = makeLookup(hostsFromStatus);
  const limit = createLimiter({ max: MAX_ACTIVE, queue: MAX_QUEUED, name: 'transcription' });
  let localCache = { at: -Infinity, up: false, key: '' };
  const peerCache = new Map();   // url -> {at, local}
  let windowStart = 0;
  let inWindow = 0;

  async function localUp(cfg: any, { fresh = false }: { fresh?: boolean | undefined } = {}) {
    const key = `${cfg.host}:${cfg.port}`;
    if (!fresh && localCache.key === key && now() - localCache.at < LOCAL_CACHE_MS) return localCache.up;
    const up = await probePort(cfg.host, cfg.port);
    localCache = { at: now(), up, key };
    return up;
  }

  async function peerStates(cfg: any) {
    const urls = eligiblePeers(listPeers(), cfg.peer);
    return Promise.all(urls.map(async (url: any) => {
      const hit = peerCache.get(url);
      if (hit && now() - hit.at < PEER_CACHE_MS) return { url, local: hit.local };
      const r = await fetchJson(`${url}/api/transcribe?local=1`, { timeoutMs: 2500 }).catch(() => null);
      const local = !!(r && r.local && r.local.available);
      peerCache.set(url, { at: now(), local });
      return { url, local };
    }));
  }

  async function resolve({ hop = false, fresh = false }: { hop?: boolean | undefined; fresh?: boolean | undefined } = {}) {
    const cfg = settings(env);
    if (!cfg.enabled) return { cfg, choice: chooseBackend({ enabled: false }), peers: [], up: false };
    const up = await localUp(cfg, { fresh });
    const peers = up || hop ? [] : await peerStates(cfg);
    return { cfg, up, peers, choice: chooseBackend({ localUp: up, peers, hop, host: cfg.host, port: cfg.port }) };
  }

  function allow() {
    const t = now();
    if (t - windowStart > RATE_WINDOW_MS) { windowStart = t; inWindow = 0; }
    if (inWindow >= rateMax) return false;
    inWindow += 1;
    return true;
  }

  async function status({ localOnly = false }: { localOnly?: boolean | undefined } = {}) {
    const { cfg, up, peers, choice } = await resolve({ hop: localOnly });
    return {
      available: choice.kind !== 'none',
      backend: choice.kind === 'none' ? null : choice.kind,
      local: { available: !!up, host: cfg.host, port: cfg.port },
      peer: choice.kind === 'peer' ? choice.url : null,
      peersAsked: peers.length,
      reason: choice.reason || null,
    };
  }

  // One utterance through the chosen backend. A local server that was up a few
  // seconds ago and is not now (restarting, unloaded and crashed) is re-checked
  // once and the peer tried instead, rather than failing the utterance.
  async function run(audio: any, { hop }: { hop?: any }) {
    let { cfg, choice } = await resolve({ hop });
    const started = now();
    if (choice.kind === 'local') {
      try {
        const text = await transcribeLocal(audio, { host: cfg.host, port: cfg.port, tmpDir });
        return { text, ms: now() - started, backend: 'local' };
      } catch (e: any) {
        if (!e.unreachable) throw e;
        localCache = { at: -Infinity, up: false, key: '' };
        ({ cfg, choice } = await resolve({ hop, fresh: true }));
        if (choice.kind === 'local') throw e;
      }
    }
    if (choice.kind === 'peer') {
      try {
        const text = await postToPeer(choice.url, audio, { lookup });
        return { text, ms: now() - started, backend: 'peer', peer: choice.url };
      } catch (e: any) {
        peerCache.delete(choice.url);   // ask it again next time
        throw e;
      }
    }
    throw Object.assign(new Error(choice.reason), { status: 503, reason: 'no-backend' });
  }

  function handle(req: any, res: any, url: any, { sendJson }: { sendJson?: any }) {
    if (url.pathname !== '/api/transcribe') return false;
    if (req.method === 'GET') {
      status({ localOnly: url.searchParams.get('local') === '1' })
        .then((s) => sendJson(res, 200, s))
        .catch((e: any) => sendJson(res, 500, { available: false, error: String(e.message || e) }));
      return true;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      sendJson(res, 405, { error: 'GET or POST only' });
      req.resume();
      return true;
    }
    const type = String(req.headers['content-type'] || '').split(';')[0]!.trim().toLowerCase();
    if (!WAV_TYPES.has(type)) {
      sendJson(res, 415, { error: 'send a 16 kHz mono WAV as audio/wav' });
      req.resume();
      return true;
    }
    if (!allow()) {
      sendJson(res, 429, { error: 'too many transcriptions — slow down' });
      req.resume();
      return true;
    }
    const hop = req.headers[HOP_HEADER] === '1';
    readBody(req, MAX_AUDIO_BYTES)
      .then((audio) => {
        const bad = wavProblem(audio);
        if (bad) throw Object.assign(new Error(bad), { status: 400 });
        return limit(() => run(audio, { hop })).catch((e: any) => {
          if (e.busy) throw Object.assign(new Error('transcription is busy — try again'), { status: 503, reason: 'busy' });
          throw e;
        });
      })
      .then((out) => sendJson(res, 200, out))
      .catch((e: any) => sendJson(res, e.status || 500, {
        error: String(e.message || e),
        ...(e.reason ? { reason: e.reason } : {}),
      }));
    return true;
  }

  return { handle, status, resolve };
}

module.exports = {
  createTranscriber, chooseBackend, eligiblePeers, wavProblem, settings, askWhisper,
  MAX_AUDIO_BYTES, DEFAULT_PORT, RATE_MAX,
};
