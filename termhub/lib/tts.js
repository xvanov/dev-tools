'use strict';

// Text-to-speech, two engines behind one door.
//
//   kokoro  a 325 MB ONNX model driven by a resident python worker
//           (lib/kokoro_helper.py). Sounds like a person. Default when it's
//           installed.
//   piper   a per-request subprocess. Robotic but tiny and instant to start.
//           The fallback, and still the whole story on a box without kokoro.
//
// Server-side rather than the browser's own speechSynthesis because iOS
// Safari's voices are poor and, more importantly, only a server-side engine
// sounds the same on every device that opens termhub.
//
// Everything here is best-effort by design: either engine may be missing, the
// models may be absent, the machine may be Windows. `available()` is the gate
// every caller checks, `synthesize()` rejects rather than throwing
// synchronously, and a kokoro that fails at load quietly demotes itself to
// piper — a missing TTS must never be able to break a terminal.
//
//     TERMHUB_TTS_ENGINE     'kokoro' | 'piper'  (default: kokoro if present)
//     TERMHUB_TTS_VOICE      voice id within the ACTIVE engine
//     TERMHUB_TTS_VOICE_DIR  piper: directory of <voice>.onnx + <voice>.onnx.json
//     TERMHUB_KOKORO_PYTHON  kokoro: interpreter with kokoro_onnx + soundfile
//     TERMHUB_KOKORO_DIR     kokoro: directory of kokoro-v1.0.onnx + voices-v1.0.bin
//     TERMHUB_TTS_IDLE_MS    how long the kokoro worker stays resident unused

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createLimiter } = require('./limit');

const DEFAULT_PIPER_VOICE = 'en_US-lessac-medium';
const DEFAULT_KOKORO_VOICE = 'af_heart';
const SYNTH_TIMEOUT_MS = 30000;

// Longer than this and it stops being an announcement. Callers get a truncated
// clip rather than an error: half the summary spoken beats silence.
const MAX_TEXT_CHARS = 1500;

// A handful of voice models in ~/.claude/piper-voices are 15-byte download
// stubs. Anything this small can't be an ONNX graph (real ones are 60 MB+), and
// handing one to piper is a guaranteed crash. The kokoro model is checked
// against the same floor for the same reason.
const MIN_MODEL_BYTES = 4096;

// Re-announcements ("read that again") and repeated session titles hit the same
// text constantly, and each miss costs a second or two of CPU. Small enough that
// the worst case is a few MB of PCM held for the life of the process.
const CACHE_MAX_ENTRIES = 24;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;

// Executable lookups hit the filesystem once per candidate; cache the answer
// briefly so the sidebar polling /api/voice/status doesn't re-walk $PATH.
const RESOLVE_TTL_MS = 30000;

// /api/tts is reachable by any tailnet peer through the front's generic /api/*
// proxy, inside the process that owns the user's terminals — so the amount of
// synthesis it can start has to be bounded, not merely typical. Two at a time
// keeps a multi-session announcement snappy without letting a retry loop swamp
// the box; past the queue depth callers get a 503, because a late announcement
// is worthless anyway. (Under kokoro the two simply queue inside the one
// resident worker, which serves requests serially — same bound, same effect.)
const MAX_CONCURRENT_SYNTH = 2;
const MAX_QUEUED_SYNTH = 8;

const limit = createLimiter({ max: MAX_CONCURRENT_SYNTH, queue: MAX_QUEUED_SYNTH, name: 'text-to-speech' });

// ---- piper discovery ---------------------------------------------------------

let binCache = { checkedAt: 0, bin: null };

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function fileAtLeast(file, bytes) {
  try { return fs.statSync(file).size >= bytes; } catch { return false; }
}

// PATH first, then the pipx venv piper usually lands in — a pipx install puts a
// shim in ~/.local/bin, but a `pipx install --no-shim` or a PATH that systemd
// didn't inherit leaves only the venv copy.
function piperBin() {
  if (Date.now() - binCache.checkedAt < RESOLVE_TTL_MS) return binCache.bin;
  const exe = process.platform === 'win32' ? 'piper.exe' : 'piper';
  const candidates = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  candidates.push(path.join(os.homedir(), '.local', 'pipx', 'venvs', 'piper-tts', 'bin', exe));
  candidates.push(path.join(os.homedir(), '.local', 'bin', exe));
  const bin = candidates.find(isExecutable) || null;
  binCache = { checkedAt: Date.now(), bin };
  return bin;
}

function voiceDir() {
  return process.env.TERMHUB_TTS_VOICE_DIR || path.join(os.homedir(), '.claude', 'piper-voices');
}

// A voice id names a model inside the voice directory and nothing else.
// Rejecting separators (rather than path.resolve-ing them) matters because the
// voice comes straight off a `POST /api/tts` body, which any tailnet peer can
// reach through the front's generic /api/* proxy — an unvalidated id would hand
// an arbitrary filesystem path to a subprocess. Callers only ever have ids from
// voices() anyway.
function piperModelPath(voice) {
  const id = String(voice || '').trim();
  if (!id || id.includes('/') || id.includes('\\') || id.includes('\0') || id.startsWith('.')) return null;
  return path.join(voiceDir(), `${id}.onnx`);
}

function piperModelUsable(file) {
  if (!file) return false;
  return fileAtLeast(file, MIN_MODEL_BYTES) && fileAtLeast(`${file}.json`, 64);
}

// "en_US-lessac-medium" -> "Lessac — medium (en_US)". Falls back to the raw id
// for anything that doesn't follow piper's locale-name-quality convention.
function piperLabel(id) {
  const m = /^([a-z]{2}_[A-Z]{2})-(.+)-([a-z_]+)$/.exec(id);
  if (!m) return id;
  const name = m[2].replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return `${name} — ${m[3]} (${m[1]})`;
}

function piperVoices() {
  let names;
  try { names = fs.readdirSync(voiceDir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.onnx')) continue;
    if (!piperModelUsable(path.join(voiceDir(), name))) continue;
    const id = name.slice(0, -'.onnx'.length);
    out.push({ id, label: piperLabel(id) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// The user's preferred piper voice: env, then the same ~/.claude/tts-voice.txt
// the other voice tools in this repo read, then a sane default. Deliberately
// NOT consulted for kokoro — that file holds a piper model name, and handing it
// to kokoro would name a voice that doesn't exist.
function piperDefaultVoice() {
  const env = (process.env.TERMHUB_TTS_VOICE || '').trim();
  if (env && piperModelUsable(piperModelPath(env))) return env;
  try {
    const name = fs.readFileSync(path.join(os.homedir(), '.claude', 'tts-voice.txt'), 'utf8').trim();
    if (name) return name;
  } catch {
    // no preference file — fall through
  }
  return DEFAULT_PIPER_VOICE;
}

function piperInstalled() {
  if (!piperBin()) return false;
  return piperModelUsable(piperModelPath(piperDefaultVoice())) || piperVoices().length > 0;
}

// ---- kokoro discovery --------------------------------------------------------

function kokoroPython() {
  return process.env.TERMHUB_KOKORO_PYTHON
    || path.join(os.homedir(), '.local', 'kokoro-venv', 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
}

function kokoroDir() {
  return process.env.TERMHUB_KOKORO_DIR || path.join(os.homedir(), '.claude', 'kokoro');
}

function kokoroModel() { return path.join(kokoroDir(), 'kokoro-v1.0.onnx'); }
function kokoroVoicesBin() { return path.join(kokoroDir(), 'voices-v1.0.bin'); }

const HELPER_SCRIPT = path.join(__dirname, 'kokoro_helper.py');

// The English voices shipped in kokoro v1.0, used ONLY to answer voices() before
// the worker has ever run. /api/voice/status is polled by the sidebar, and
// loading a 325 MB ONNX graph to enumerate names would be absurd — so the list
// is static until the worker reports its real one (see the `ready` frame), at
// which point that becomes the answer. Non-English voices exist in the model but
// aren't offered: everything termhub speaks is English, and `lang: en-us` through
// a Japanese voice is noise.
const KOKORO_EN_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore',
  'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
  'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

// "af_heart" -> "Heart — American female". The first letter is the accent, the
// second the gender; that's the whole convention.
const KOKORO_ACCENT = { a: 'American', b: 'British' };
function kokoroLabel(id) {
  const m = /^([ab])([fm])_(.+)$/.exec(id);
  if (!m) return id;
  const name = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  return `${name} — ${KOKORO_ACCENT[m[1]]} ${m[2] === 'f' ? 'female' : 'male'}`;
}

// A kokoro voice id is a bare identifier and nothing else — same reasoning as
// piperModelPath: it arrives from a POST body and ends up inside a subprocess.
function validKokoroVoiceId(id) {
  return /^[a-z]{2}_[a-z]+$/.test(String(id || ''));
}

// Worker state lives out here so a lazily-spawned helper survives across calls.
const kokoro = {
  child: null,
  starting: null,     // Promise resolved when the worker reports `ready`
  voices: null,       // the worker's real voice list, once it has told us
  seq: 0,
  pending: new Map(), // request id -> {resolve, reject, timer}
  buf: Buffer.alloc(0),
  frame: null,        // header of a frame whose payload hasn't fully arrived
  idleTimer: null,
  startTimer: null,
  // Set when the worker fails at import/load time (no kokoro_onnx, corrupt
  // model). Engine selection skips kokoro while this is in the future, so the
  // failure costs one spawn every few minutes rather than one per announcement.
  brokenUntil: 0,
};

// How long the worker gets to report `ready`. The model load is 0.73 s warm and
// a few seconds with a cold page cache; twenty is generous. Past it we assume
// something is wrong that waiting won't fix — a python that hangs on import
// would otherwise pin every announcement behind it.
const START_TIMEOUT_MS = 20000;

// How long the worker stays resident with nothing to say. It holds ~745 MB
// resident, which is fine mid-conversation and rude overnight. Ten minutes
// covers "user is reading the summary and thinking" without leaving the model
// pinned on a box nobody is talking to.
const IDLE_MS = Number(process.env.TERMHUB_TTS_IDLE_MS || 10 * 60 * 1000);

function kokoroInstalled() {
  if (Date.now() < kokoro.brokenUntil) return false;
  if (!isExecutable(kokoroPython())) return false;
  if (!fileAtLeast(HELPER_SCRIPT, 64)) return false;
  return fileAtLeast(kokoroModel(), MIN_MODEL_BYTES) && fileAtLeast(kokoroVoicesBin(), MIN_MODEL_BYTES);
}

function kokoroVoiceList() {
  const ids = kokoro.voices ? kokoro.voices.filter((id) => /^[ab][fm]_/.test(id)) : KOKORO_EN_VOICES;
  return ids.map((id) => ({ id, label: kokoroLabel(id) })).sort((a, b) => a.id.localeCompare(b.id));
}

function kokoroDefaultVoice() {
  const env = (process.env.TERMHUB_TTS_VOICE || '').trim();
  // Only honour the env voice if it's one this engine actually has. The same
  // variable selects the voice for whichever engine is active, so on a box where
  // it names a piper model it must not become a kokoro voice id that doesn't
  // exist — that would 500 every announcement instead of just being ignored.
  if (env && validKokoroVoiceId(env) && (!kokoro.voices || kokoro.voices.includes(env))) return env;
  return DEFAULT_KOKORO_VOICE;
}

// ---- engine selection --------------------------------------------------------

// Preference from the env, then whatever is actually installed. Never hard-fail:
// an explicit choice that isn't installed silently yields to the other engine,
// because a robotic announcement beats no announcement.
function engine() {
  const want = String(process.env.TERMHUB_TTS_ENGINE || '').trim().toLowerCase();
  const order = want === 'piper' ? ['piper', 'kokoro'] : ['kokoro', 'piper'];
  for (const name of order) {
    if (name === 'kokoro' && kokoroInstalled()) return 'kokoro';
    if (name === 'piper' && piperInstalled()) return 'piper';
  }
  return null;
}

// ---- public API -------------------------------------------------------------

function available() { return engine() !== null; }

function voices() {
  const e = engine();
  if (e === 'kokoro') return kokoroVoiceList();
  if (e === 'piper') return piperVoices();
  return [];
}

function defaultVoice() {
  const e = engine();
  if (e === 'kokoro') return kokoroDefaultVoice();
  if (e === 'piper') return piperDefaultVoice();
  return '';
}

// Everything /api/voice/status and the WS `hello` need about speech, in one
// call — so the two of them can't drift apart on which engine is live.
function status() {
  const e = engine();
  return { available: e !== null, engine: e, voice: defaultVoice(), voices: voices() };
}

// ---- synthesis cache --------------------------------------------------------

const cache = new Map(); // sha1(engine + voice + text) -> Buffer, in insertion order
let cacheBytes = 0;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key); // reinsert to make this the most-recently-used entry
  cache.set(key, hit);
  return hit;
}

function cachePut(key, buf) {
  if (buf.length > CACHE_MAX_BYTES) return; // one clip that would evict everything
  // Re-inserting an existing key replaces its buffer, so drop the old size
  // first — otherwise cacheBytes drifts upward and starts evicting early.
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.length;
  cache.set(key, buf);
  cacheBytes += buf.length;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cacheBytes -= cache.get(oldest.value).length;
    cache.delete(oldest.value);
  }
}

// Render `text` to a WAV buffer. Rejects (never throws synchronously) when no
// engine is installed, when too many syntheses are already running, when the
// engine fails, or after SYNTH_TIMEOUT_MS — in which case the child is killed
// rather than left running.
//
// Validation and the cache lookup happen OUTSIDE the limiter, so a bad voice
// fails fast and a repeated clip never queues behind a real synthesis.
function synthesize(text, { voice } = {}) {
  const body = String(text == null ? '' : text).trim().slice(0, MAX_TEXT_CHARS);
  if (!body) return Promise.reject(new Error('no text to speak'));

  const e = engine();
  if (!e) return Promise.reject(new Error('no text-to-speech engine on this machine'));

  const id = (voice && String(voice).trim()) || defaultVoice();
  const key = crypto.createHash('sha1').update(`${e}\n${id}\n${body}`).digest('hex');
  const hit = cacheGet(key);
  if (hit) return Promise.resolve(hit);

  if (e === 'kokoro') {
    if (!validKokoroVoiceId(id)) return Promise.reject(new Error(`no usable kokoro voice '${id}'`));
    return limit(() => runKokoro(body, id, key, false))
      // A kokoro that can't start at all has already demoted itself (see
      // markKokoroBroken); finish this request on piper rather than making the
      // user's first announcement the one that fails.
      .catch((err) => {
        if (!err || !err.engineDown || !piperInstalled()) throw err;
        return limit(() => runPiper(body, piperDefaultVoice(), cacheKeyFor('piper', piperDefaultVoice(), body)));
      });
  }

  const model = piperModelPath(id);
  if (!piperModelUsable(model)) return Promise.reject(new Error(`no usable piper voice '${id}'`));
  return limit(() => runPiper(body, id, key));
}

function cacheKeyFor(e, id, body) {
  return crypto.createHash('sha1').update(`${e}\n${id}\n${body}`).digest('hex');
}

// ---- piper backend -----------------------------------------------------------

// stderr is drained and discarded: piper spams onnxruntime GPU-discovery
// warnings on every run, and an unread pipe would eventually block the child.
function runPiper(body, id, key) {
  return new Promise((resolve, reject) => {
    // Someone else may have synthesised the same clip while we were queued.
    const queued = cacheGet(key);
    if (queued) return resolve(queued);

    const bin = piperBin();
    if (!bin) return reject(new Error('piper is not installed'));
    const model = piperModelPath(id);
    if (!piperModelUsable(model)) return reject(new Error(`no usable piper voice '${id}'`));

    // `-f -` is what actually writes a WAV to stdout on piper 1.6 — with no -f
    // at all it silently writes a timestamped file into the cwd instead.
    // cwd is the temp dir so that stray output can't land in a user's project.
    let child;
    try {
      child = spawn(bin, ['-m', model, '-f', '-'], {
        cwd: os.tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return reject(e);
    }

    const chunks = [];
    let done = false;
    const finish = (err, buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(buf);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(new Error('piper timed out'));
    }, SYNTH_TIMEOUT_MS);

    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', () => {});
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {}); // piper died before reading our text
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0) return finish(new Error(`piper exited ${code}`));
      if (buf.length < 44) return finish(new Error('piper produced no audio'));
      cachePut(key, buf);
      finish(null, buf);
    });

    child.stdin.end(body);
  });
}

// ---- kokoro backend: one resident worker -------------------------------------
//
// The whole point of the worker is that the 0.73 s model load is paid once, not
// once per announcement. Measured on this box for the same 11.9 s clip:
// 3153 ms with a fresh python per request, 2032 ms through the warm worker.
// Everything below exists to keep that process alive without letting it become
// a liability — it is killed on idle, on timeout, and when sessiond exits, and
// a worker that dies for any other reason is simply respawned on the next call.

function markKokoroBroken(why) {
  kokoro.brokenUntil = Date.now() + 5 * 60 * 1000;
  const err = new Error(`kokoro unavailable: ${why}`);
  err.engineDown = true;   // synthesize() reads this to fall through to piper
  return err;
}

function killKokoro(reason) {
  const child = kokoro.child;
  kokoro.child = null;
  kokoro.starting = null;
  kokoro.buf = Buffer.alloc(0);
  kokoro.frame = null;
  clearTimeout(kokoro.idleTimer);
  clearTimeout(kokoro.startTimer);
  kokoro.idleTimer = null;
  kokoro.startTimer = null;
  const err = new Error(reason);
  // A worker that dies BEFORE saying `ready` has to settle the startup promise
  // too, or every caller awaiting it waits forever — the request timeout can't
  // save them, because it isn't armed until the worker is up. Found exactly
  // this way: pointing TERMHUB_KOKORO_PYTHON at /bin/false hung the request.
  if (kokoro.onReady) { const fn = kokoro.onReady; kokoro.onReady = null; fn(err); }
  for (const [, p] of kokoro.pending) {
    clearTimeout(p.timer);
    try { p.reject(err); } catch {}
  }
  kokoro.pending.clear();
  if (child) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

// Reset the eviction clock. Only ever armed when nothing is in flight, and
// cleared synchronously by the next request, so it can't fire out from under a
// synthesis — Node is single-threaded and both happen on the same tick.
function touchKokoroIdle() {
  clearTimeout(kokoro.idleTimer);
  if (!IDLE_MS || IDLE_MS < 0) return;
  kokoro.idleTimer = setTimeout(() => {
    if (kokoro.pending.size) return touchKokoroIdle();
    killKokoro('kokoro worker idle');
  }, IDLE_MS);
  if (kokoro.idleTimer.unref) kokoro.idleTimer.unref();
}

// Pull complete frames out of the worker's stdout: a JSON header line, then
// exactly `bytes` raw bytes of WAV. Written as a loop over one growing buffer
// because a 600 KB clip arrives in dozens of chunks and any of them can split a
// header mid-line.
function consumeKokoroStdout(chunk) {
  kokoro.buf = kokoro.buf.length ? Buffer.concat([kokoro.buf, chunk]) : chunk;
  for (;;) {
    if (!kokoro.frame) {
      const nl = kokoro.buf.indexOf(0x0a);
      if (nl < 0) return;
      let header;
      try { header = JSON.parse(kokoro.buf.slice(0, nl).toString('utf8')); } catch { header = null; }
      kokoro.buf = kokoro.buf.slice(nl + 1);
      if (!header) continue;                       // garbage line; skip it
      kokoro.frame = { header, bytes: Number(header.bytes) || 0 };
    }
    if (kokoro.buf.length < kokoro.frame.bytes) return;
    const { header, bytes } = kokoro.frame;
    const payload = bytes ? kokoro.buf.slice(0, bytes) : Buffer.alloc(0);
    kokoro.buf = kokoro.buf.slice(bytes);
    kokoro.frame = null;
    handleKokoroFrame(header, payload);
  }
}

function handleKokoroFrame(header, payload) {
  if (header.type === 'ready') {
    if (Array.isArray(header.voices) && header.voices.length) kokoro.voices = header.voices;
    clearTimeout(kokoro.startTimer);
    kokoro.startTimer = null;
    if (kokoro.onReady) { const fn = kokoro.onReady; kokoro.onReady = null; fn(); }
    return;
  }
  if (header.type === 'fatal') {
    // The worker couldn't import kokoro_onnx or load the model. Demote the
    // engine so the NEXT announcement goes straight to piper.
    const err = markKokoroBroken(header.error || 'worker failed to start');
    if (kokoro.onReady) { const fn = kokoro.onReady; kokoro.onReady = null; fn(err); }
    killKokoro(err.message);
    return;
  }
  const p = kokoro.pending.get(header.id);
  if (!p) return;                                  // a reply to a timed-out request
  kokoro.pending.delete(header.id);
  clearTimeout(p.timer);
  if (header.type === 'audio' && payload.length >= 44) p.resolve(payload);
  else p.reject(new Error(header.error || 'kokoro produced no audio'));
  if (!kokoro.pending.size) touchKokoroIdle();
}

// Spawn the worker and resolve once it says `ready`. Concurrent callers share
// the one promise; a worker that never becomes ready is killed by the caller's
// own request timeout, so there's no separate startup watchdog to get wrong.
function startKokoro() {
  if (kokoro.child && kokoro.starting) return kokoro.starting;
  if (Date.now() < kokoro.brokenUntil) {
    return Promise.reject(markKokoroBroken('recently failed to start'));
  }

  let child;
  try {
    child = spawn(kokoroPython(), [HELPER_SCRIPT], {
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        TERMHUB_KOKORO_MODEL: kokoroModel(),
        TERMHUB_KOKORO_VOICES: kokoroVoicesBin(),
        PYTHONUNBUFFERED: '1',
      },
    });
  } catch (e) {
    return Promise.reject(markKokoroBroken(e.message));
  }
  kokoro.child = child;

  // Deliberately NOT unref'd. Unref'ing the pipes lets node exit with a
  // synthesis still in flight — the promise never settles and the caller hangs
  // forever, which is a far worse bug than a resident worker. sessiond's HTTP
  // server owns the event loop anyway; the idle timer releases the worker after
  // ten quiet minutes, the exit hook kills it on the way out, and a short-lived
  // script that requires this module calls shutdown().
  child.stdout.on('data', (c) => { try { consumeKokoroStdout(c); } catch { /* never let a torn frame throw */ } });
  child.stderr.on('data', () => {});   // onnxruntime GPU-discovery spam, every start
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  child.stdin.on('error', () => {});
  child.on('error', (e) => { if (kokoro.child === child) killKokoro(`kokoro worker: ${e.message}`); });
  child.on('close', () => { if (kokoro.child === child) killKokoro('kokoro worker exited'); });

  kokoro.starting = new Promise((resolve, reject) => {
    kokoro.onReady = (err) => (err ? reject(err) : resolve());
  });
  kokoro.startTimer = setTimeout(() => {
    if (kokoro.child === child) killKokoro('kokoro worker never became ready');
  }, START_TIMEOUT_MS);
  if (kokoro.startTimer.unref) kokoro.startTimer.unref();
  // An unhandled rejection here would be fatal to sessiond; every real consumer
  // awaits the same promise and handles it.
  kokoro.starting.catch(() => {});
  return kokoro.starting;
}

async function runKokoro(body, voice, key, retried) {
  const queued = cacheGet(key);
  if (queued) return queued;

  try {
    await startKokoro();
  } catch (e) {
    throw e.engineDown ? e : markKokoroBroken(e.message);
  }
  const child = kokoro.child;
  if (!child || !child.stdin.writable) {
    // Died between `ready` and here. One retry, then give up: a worker that
    // can't survive a single request is broken, not unlucky.
    if (retried) throw markKokoroBroken('worker keeps exiting');
    return runKokoro(body, voice, key, true);
  }

  clearTimeout(kokoro.idleTimer);
  kokoro.idleTimer = null;
  const id = ++kokoro.seq;

  const wav = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // An ONNX run in progress can't be cancelled, so the only way to stop
      // paying for it is to take the worker with it. The next call respawns.
      kokoro.pending.delete(id);
      killKokoro('kokoro timed out');
      reject(new Error('kokoro timed out'));
    }, SYNTH_TIMEOUT_MS);
    kokoro.pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ id, text: body, voice, speed: 1.0, lang: 'en-us' })}\n`);
    } catch (e) {
      kokoro.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  }).catch(async (err) => {
    // "the worker exited" is the one failure worth a second attempt — it's what
    // an OOM kill or an external `pkill python` looks like, and respawning is
    // cheap next to telling the user we couldn't speak.
    if (!retried && /worker exited|EPIPE|write after end/i.test(err.message || '')) {
      return runKokoro(body, voice, key, true);
    }
    throw err;
  });

  cachePut(key, wav);
  if (!kokoro.pending.size) touchKokoroIdle();
  return wav;
}

// A 745 MB python holding the model has no business outliving sessiond.
process.on('exit', () => { if (kokoro.child) { try { kokoro.child.kill('SIGKILL'); } catch {} } });

// Exposed for tests and for a clean shutdown; nothing in the server needs it.
function shutdown() { killKokoro('shutdown'); }

module.exports = {
  available, voices, defaultVoice, synthesize, status, engine, shutdown, MAX_TEXT_CHARS,
};
