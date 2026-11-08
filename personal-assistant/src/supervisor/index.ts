'use strict';

// The supervisor: owns the dashboard's public port so the worker can be
// replaced without a moment where nothing answers (docs/native/PLAN.md, Z1).
//
//   client ──▶ supervisor 127.0.0.1:PA_DISPATCH_PORT ──▶ generation N on 127.0.0.1:<port 0>
//
// A roll spawns generation N+1 beside N, waits for its GET /healthz to say
// ready, flips routing, sends N `drain`, closes N's long-lived streams (SSE,
// WebSocket) so their clients reconnect — to N+1 — waits for N's ordinary
// in-flight requests (30 s at most), then sends `stop` and kills it if it
// lingers. A generation that never gets ready is killed and N keeps serving.
//
// Why a proxy and not socket handoff: Node cannot pass a listening socket
// between unrelated processes on Windows. A reverse proxy is portable, and the
// extra loopback hop costs well under a millisecond.
//
// Rules for this file: node builtins only, and it never requires worker code —
// it is the one process that must not change on a deploy, so it must not load
// what a deploy changes. It reads only PA_DISPATCH_PORT / PA_DISPATCH_HOST
// (from the environment, else the same `.env` files config.js reads).
//
// Strict TypeScript (plan 4.4, docs/native/JARVISD.md): erasable syntax only
// and CommonJS exports, so Node (type stripping) and Bun both run it as is,
// and it is the supervisor of the compiled jarvisd executable too
// (`jarvisd supervise`, jarvisd/src/main.ts). The whole file is one block, so
// none of its names lands in tsc's global script scope.
//
// What runs a generation (`runtimeSpec`): PA_RUNTIME=node (default) forks
// src/worker.js under Node; bun runs jarvisd/src/main.ts under Bun; jarvisd
// runs a compiled jarvisd executable (`<exe> generation`). For jarvisd the
// executable is looked up at every roll — PA_JARVISD_EXE, else the path in
// jarvisd/dist/current, else this executable itself — so a deploy rolls to a
// newly built binary without replacing the running one (Windows locks it).
//
// Worker protocol (src/worker.js, PA_SUPERVISED=1):
//   child → supervisor  {type: 'listening', port}   its private port
//   supervisor → child  {type: 'drain'}              routing has moved away:
//                                                    hand the passes over (Z2)
//   supervisor → child  {type: 'undrain'}            routing is back (rollback)
//   supervisor → child  {type: 'stop'}               exit now (in-flight done)
//   GET /healthz        200 {ready: true} once startup has completed
//
// Rollback (Z4): the generation a roll replaced is kept, drained, for
// holdMs (150 s: the drain, 30 s at most, plus the deploy's 60 s watch, with
// room) after the flip — the standby. `rollback` undrains it and flips back;
// the deploy command (deploy.js) asks for that when the new generation's
// health fails within 60 s. A serving generation that dies while a standby
// exists is replaced by the standby rather than a fresh one.
//
// Control (a deploy script, Z4): a local socket — a named pipe on Windows, a
// unix socket elsewhere — taking one JSON line, `{"cmd":"roll"}`,
// `{"cmd":"rollback"}`, `{"cmd":"lock"|"unlock","owner"}` or
// `{"cmd":"status"}`, and answering one JSON line. `node src/supervisor
// roll|rollback|status` (or `jarvisd supervise ...`). status carries
// `source`, a hash of this file as the running supervisor loaded it (for a
// compiled jarvisd, the hash scripts/build.js embedded): deploy.js compares it
// with the file on disk to know when the supervisor itself must restart.

{
  type SupChildProcess = import('node:child_process').ChildProcess;
  type SupServer = import('node:http').Server;
  type SupIncoming = import('node:http').IncomingMessage;
  type SupHeaders = import('node:http').IncomingHttpHeaders;
  type SupSocket = import('node:net').Socket;
  type SupWritable = NodeJS.WritableStream;
  type SupReadable = NodeJS.ReadableStream & { setEncoding(enc: BufferEncoding): unknown };

  const fs: typeof import('node:fs') = require('fs');
  const os: typeof import('node:os') = require('os');
  const net: typeof import('node:net') = require('net');
  const path: typeof import('node:path') = require('path');
  const http: typeof import('node:http') = require('http');
  const crypto: typeof import('node:crypto') = require('crypto');
  const childProcess: typeof import('node:child_process') = require('child_process');

  type Level = 'info' | 'warn' | 'error';
  type Fields = Record<string, unknown>;
  type Say = (level: Level, message: string, fields?: Fields) => void;

  interface LogFile {
    file: string;
    write(text: string): void;
    flush(): Promise<void>;
    close(): Promise<void>;
  }

  interface RuntimeSpec {
    runtime: 'node' | 'bun' | 'jarvisd';
    worker: string;
    execPath: string;
  }

  interface InFlightEntry {
    method: string;
    path: string;
    at: number;
  }

  interface Generation {
    n: number;
    child: SupChildProcess;
    pid: number | undefined;
    runtime: RuntimeSpec['runtime'];
    exe: string;
    port: number | null;
    inflight: number;
    requests: Set<InFlightEntry>;
    streams: Set<() => void>;
    agent: import('node:http').Agent;
    exited: boolean;
    startedAt: number;
    onIdle: (() => void) | null;
    holdTimer?: ReturnType<typeof setTimeout>;
    exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  }

  interface DeployLock {
    owner: string;
    since: string;
    until: number;
  }

  interface Status {
    ok: boolean;
    error?: string;
    port: number;
    source: string | null;
    runtime: RuntimeSpec['runtime'];
    exe: string | null;
    generation: number | null;
    pid: number | null;
    workerPort: number | null;
    standby: { generation: number; pid: number | undefined } | null;
    rolling: boolean;
    deployLock: { owner: string; since: string; until: string } | null;
    generations: Array<{ n: number; pid: number | undefined; port: number | null; inflight: number; streams: number; requests: Array<{ method: string; path: string; ms: number }> }>;
  }

  interface ControlMessage {
    cmd?: string;
    owner?: string;
    ttlMs?: number;
  }

  interface SupervisorOptions {
    runtime?: RuntimeSpec | null;
    worker?: string;
    execPath?: string;
    port?: number;
    host?: string;
    controlPath?: string;
    env?: Record<string, string>;
    readyTimeoutMs?: number;
    drainTimeoutMs?: number;
    stopGraceMs?: number;
    holdMs?: number;
    undrainTimeoutMs?: number;
    respawn?: boolean;
    silent?: boolean;
  }

  const DEFAULT_PORT = 7300;
  const DRAIN_TIMEOUT_MS = 30_000;
  const HOLD_MS = 150_000;
  const UNDRAIN_TIMEOUT_MS = 30_000;
  const READY_TIMEOUT_MS = 180_000;
  const STOP_GRACE_MS = 10_000;
  const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

  // What this process is running, for deploy.js to compare with the disk.
  function sourceHash(file: string = __filename): string | null {
    try {
      return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    } catch {
      return null;
    }
  }
  // A compiled jarvisd cannot read its own source back: scripts/build.js
  // embeds the hash of this file at build time (bun build --define).
  const SOURCE: string | null = process.env.PA_SUPERVISOR_SOURCE_BUILT || sourceHash();

  // The log file: on Windows the pa-worker task runs under `conhost --headless`,
  // so stdout goes nowhere, and a generation that never got ready left no trace.
  // The supervisor's own lines and every generation's stdout/stderr (prefixed
  // `[gen N]`) go to <state dir>/logs/supervisor.log, rotated at `maxBytes`
  // into .1 … .<keep>.
  //
  // Never synchronous. It was appendFileSync (open, write, close per line), and
  // on Windows a close can wait seconds for the virus scanner to read the file
  // again: the supervisor's loop stopped, so it stopped proxying and stopped
  // reading its generations' output pipes, and every generation — whose stdout
  // writes to a pipe are synchronous on Windows — froze with it, at the same
  // moment, for ~10 s. That failed deploys' health watches. Now one stream, kept
  // open; a disk that stalls costs memory (capped: past `maxBacklog` lines are
  // dropped and counted), never the loop.
  function createLogFile(file: string, { maxBytes = 5 * 1024 * 1024, keep = 3, maxBacklog = 8 * 1024 * 1024 }: { maxBytes?: number; keep?: number; maxBacklog?: number } = {}): LogFile {
    let size = 0;
    let broken = false;
    let out: import('node:fs').WriteStream | null = null;
    let dropped = 0;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    } catch {
      broken = true;
    }
    function open(): import('node:fs').WriteStream {
      const s = fs.createWriteStream(file, { flags: 'a' });
      s.on('error', () => {
        broken = true; // a full or vanished disk must not take the supervisor down
      });
      out = s;
      return s;
    }
    // Rotation: lines written meanwhile wait in `pending`; the old stream ends,
    // the files shift up one (asynchronously, oldest first), a new stream opens.
    let pending: string[] | null = null;
    function rotate(): void {
      const old = out;
      out = null;
      pending = [];
      size = 0;
      const shift = (i: number): void => {
        if (i < 1) {
          const s = open();
          const lines = pending || [];
          pending = null;
          for (const l of lines) s.write(l);
          return;
        }
        const from = i === 1 ? file : `${file}.${i - 1}`;
        fs.rename(from, `${file}.${i}`, () => shift(i - 1)); // a missing or held file: skip it
      };
      if (old) old.end(() => shift(keep));
      else shift(keep);
    }
    if (!broken) open();
    return {
      file,
      write(text: string): void {
        if (broken || !text) return;
        if (pending) {
          if (pending.length < 10_000) pending.push(text);
          else dropped++;
          size += Buffer.byteLength(text);
          return;
        }
        const s = out;
        if (!s) return;
        if (s.writableLength > maxBacklog) {
          dropped++;
          return;
        }
        if (dropped) {
          const note = `${new Date().toISOString()} WARN  [supervisor] log backlog: ${dropped} line(s) dropped\n`;
          dropped = 0;
          s.write(note);
        }
        if (size + text.length > maxBytes) {
          rotate();
          (pending as string[] | null)?.push(text);
          size += Buffer.byteLength(text);
          return;
        }
        s.write(text);
        size += Buffer.byteLength(text);
      },
      /** Resolves once everything written so far is on disk (tests, shutdown). */
      async flush(): Promise<void> {
        while (pending || (out && out.writableLength)) await new Promise((r) => setTimeout(r, 10));
      },
      close(): Promise<void> {
        return new Promise((resolve) => {
          if (out) out.end(() => resolve());
          else resolve();
        });
      },
    };
  }

  // PA_DISPATCH_* without loading config.js: real env, then the tool's .env,
  // then the repo root's (config.js's precedence).
  function envSetting(name: string, fallback: string | number): string {
    const v = process.env[name];
    if (v) return v;
    const toolDir = path.join(__dirname, '..', '..');
    for (const file of [path.join(toolDir, '.env'), path.join(toolDir, '..', '.env')]) {
      try {
        const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*["']?([^"'\\r\\n#]*)`, 'm'));
        const got = m && m[1] ? m[1].trim() : '';
        if (got) return got;
      } catch {
        /* no such file */
      }
    }
    return String(fallback);
  }

  // Where the log lives: PA_DATA_DIR, else the platform's state dir — the same
  // defaults as src/platform (not required here: the supervisor loads no PA code).
  function defaultLogFile(): string {
    const custom = envSetting('PA_DATA_DIR', '');
    const base = custom
      || (process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'personal-assistant')
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'personal-assistant'));
    return path.join(base, 'logs', 'supervisor.log');
  }

  let logFile: LogFile | null = null; // set by cli(); tests run without one

  const log: Say = (level, message, fields) => {
    const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), '[supervisor]', message, fields ? JSON.stringify(fields) : ''].join(' ').trimEnd();
    (level === 'info' ? process.stdout : process.stderr).write(line + '\n');
    if (logFile) logFile.write(line + '\n');
  };

  // A generation's output: to our own stdout/stderr (journald on Linux) and the
  // log file, one prefixed line at a time.
  function relay(stream: SupReadable | null, n: number, out: SupWritable): void {
    if (!stream) return;
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = `[gen ${n}] ${buf.slice(0, i).replace(/\r$/, '')}\n`;
        buf = buf.slice(i + 1);
        out.write(line);
        if (logFile) logFile.write(line);
      }
    });
    stream.on('end', () => {
      if (buf) {
        out.write(`[gen ${n}] ${buf}\n`);
        if (logFile) logFile.write(`[gen ${n}] ${buf}\n`);
      }
    });
  }

  function defaultControlPath(port: number): string {
    return process.env.PA_SUPERVISOR_CONTROL
      || (process.platform === 'win32'
        ? `\\\\.\\pipe\\pa-supervisor-${port}`
        : path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `pa-supervisor-${port}.sock`));
  }

  function probe(port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          let j: { ready?: unknown } = {};
          try {
            j = JSON.parse(body) as { ready?: unknown };
          } catch {
            /* not JSON: not ready */
          }
          resolve(res.statusCode === 200 && j.ready === true);
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // The repo's jarvisd/ directory, from this file (src/supervisor) — or null
  // in a compiled jarvisd, whose __dirname is not on disk.
  function jarvisdDir(): string | null {
    const d = path.join(__dirname, '..', '..', '..', 'jarvisd');
    return fs.existsSync(path.join(d, 'package.json')) ? d : null;
  }

  /**
   * The compiled jarvisd a new generation runs: PA_JARVISD_EXE, else the path
   * in jarvisd/dist/current (written by a deploy that built a new binary),
   * else this executable when it is jarvisd itself.
   */
  function jarvisdExe(): string {
    const fromEnv = envSetting('PA_JARVISD_EXE', '');
    if (fromEnv) return fromEnv;
    // The pointer a deploy writes, in jarvisd/dist (from source) or beside
    // this executable (compiled: its __dirname is not on disk).
    const dir = jarvisdDir();
    const self = process.env.PA_JARVISD_SELF === 'exe';
    const dists = [...(dir ? [path.join(dir, 'dist')] : []), ...(self ? [path.dirname(process.execPath)] : [])];
    for (const dist of dists) {
      try {
        const p = fs.readFileSync(path.join(dist, 'current'), 'utf8').trim();
        if (p && fs.existsSync(path.resolve(dist, p))) return path.resolve(dist, p);
      } catch {
        /* no pointer */
      }
    }
    if (self) return process.execPath;
    throw new Error('PA_RUNTIME=jarvisd but no jarvisd executable (set PA_JARVISD_EXE, or build one: node scripts/build.js --only jarvisd)');
  }

  /**
   * What runs a generation (plan 4.1, 4.4). node: Node runs src/worker.js. bun:
   * Bun runs jarvisd/src/main.ts, which boots the same worker; Bun from PA_BUN,
   * else the one jarvisd's npm install pinned. jarvisd: a compiled jarvisd
   * runs `generation` (jarvisdExe, looked up per roll). All speak the same
   * protocol over IPC (JSON serialization), so a roll can move between them
   * and a rollback can move back.
   */
  function runtimeSpec(runtime: string = envSetting('PA_RUNTIME', process.env.PA_JARVISD_SELF ? 'jarvisd' : 'node'), { bun = envSetting('PA_BUN', '') }: { bun?: string } = {}): RuntimeSpec {
    // "jarvisd supervise" run from source under Bun: its generations run the
    // same source (the bun runtime), unless an executable is named.
    if (runtime === 'jarvisd' && process.env.PA_JARVISD_SELF === 'bun' && !envSetting('PA_JARVISD_EXE', '')) return runtimeSpec('bun', { bun: bun || process.execPath });
    if (runtime === 'jarvisd') return { runtime: 'jarvisd', worker: 'generation', execPath: jarvisdExe() };
    if (runtime !== 'bun') return { runtime: 'node', worker: path.join(__dirname, '..', 'worker.js'), execPath: process.execPath };
    const dir = jarvisdDir() || path.join(__dirname, '..', '..', '..', 'jarvisd');
    // PA_BUN, else the pinned version's own directory (deploy.js bunInstallPlan
    // installs it there: never over a bun.exe a generation is running), else the
    // dev install in jarvisd/node_modules.
    let pinned: string | null = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { devDependencies?: { bun?: string } };
      const v = String((pkg.devDependencies && pkg.devDependencies.bun) || '');
      if (/^\d+\.\d+\.\d+$/.test(v)) pinned = path.join(dir, '.bun', v, 'node_modules', 'bun', 'bin', 'bun.exe');
    } catch {
      /* no jarvisd */
    }
    const dev = path.join(dir, 'node_modules', 'bun', 'bin', 'bun.exe');
    const exe = bun || (pinned && fs.existsSync(pinned) ? pinned : dev);
    if (!fs.existsSync(exe)) throw new Error(`PA_RUNTIME=bun but no Bun at ${exe} (a deploy installs it under jarvisd/.bun/; or npm ci in jarvisd/, or set PA_BUN)`);
    return { runtime: 'bun', worker: path.join(dir, 'src', 'main.ts'), execPath: exe };
  }

  // One JSON line to a supervisor's control socket; resolves with its answer.
  function request(where: string, msg: ControlMessage, timeoutMs = READY_TIMEOUT_MS + DRAIN_TIMEOUT_MS + STOP_GRACE_MS + 10_000): Promise<Status> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(where);
      let buf = '';
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error('supervisor did not answer'));
      }, timeoutMs);
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'));
      sock.on('data', (c: string) => (buf += c));
      sock.on('end', () => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(buf) as Status);
        } catch {
          reject(new Error('bad answer from supervisor'));
        }
      });
      sock.on('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
  }

  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  function createSupervisor(opts: SupervisorOptions = {}) {
    const fixed = opts.runtime || null;
    const port = opts.port ?? Number(envSetting('PA_DISPATCH_PORT', DEFAULT_PORT));
    const host = opts.host ?? envSetting('PA_DISPATCH_HOST', '127.0.0.1');
    const controlPath = opts.controlPath;
    const env = opts.env ?? {};
    const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const drainTimeoutMs = opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    const stopGraceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
    const holdMs = opts.holdMs ?? HOLD_MS;
    const undrainTimeoutMs = opts.undrainTimeoutMs ?? UNDRAIN_TIMEOUT_MS;
    const respawn = opts.respawn ?? true;
    const say: Say = opts.silent ? () => {} : log;
    // An explicit worker/execPath (tests) is fixed; otherwise the runtime is
    // read once now and, for a compiled jarvisd, its executable at every roll.
    const baseSpec: RuntimeSpec = fixed || (opts.worker || opts.execPath ? { runtime: !opts.execPath || opts.execPath === process.execPath ? 'node' : 'bun', worker: opts.worker || path.join(__dirname, '..', 'worker.js'), execPath: opts.execPath || process.execPath } : runtimeSpec());
    const specNow = (): RuntimeSpec => (baseSpec.runtime === 'jarvisd' && !fixed ? runtimeSpec('jarvisd') : baseSpec);

    let seq = 0;
    let current: Generation | null = null; // the generation routing points at
    let standby: Generation | null = null; // the one a roll replaced, drained, kept for a rollback
    let rolling: Promise<Status> | null = null; // the roll or rollback in progress
    let closing = false;
    let crashes = 0;
    const gens = new Set<Generation>();

    // ---- generations ----

    function spawnGeneration(): Generation {
      const n = ++seq;
      const spec = specNow();
      const genEnv: Record<string, string | undefined> = { ...process.env, ...env, PA_SUPERVISED: '1', PA_SUPERVISOR_GENERATION: String(n) };
      delete genEnv.PA_JARVISD_SELF; // a generation is a worker, not a supervisor
      // With a log file, a generation's output is relayed into it (relay()).
      const stdio: import('node:child_process').StdioOptions = logFile ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'inherit', 'inherit', 'ipc'];
      // JSON, not Node's default 'advanced': Bun's IPC speaks only JSON.
      const child = spec.runtime === 'jarvisd'
        ? childProcess.spawn(spec.execPath, [spec.worker], { cwd: path.dirname(spec.execPath), env: genEnv, stdio, serialization: 'json', windowsHide: true })
        : childProcess.fork(spec.worker, [], { cwd: path.dirname(spec.worker), execPath: spec.execPath, serialization: 'json', env: genEnv, stdio, windowsHide: true });
      if (logFile) {
        relay(child.stdout, n, process.stdout);
        relay(child.stderr, n, process.stderr);
      }
      let resolveExit: (v: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
      const gen: Generation = {
        n,
        child,
        pid: child.pid,
        runtime: spec.runtime,
        exe: spec.runtime === 'jarvisd' ? spec.execPath : spec.worker,
        port: null,
        inflight: 0,
        requests: new Set(),
        streams: new Set(),
        // Keep-alive to the generation. Reusing a socket its server had just
        // closed as idle answered ECONNRESET (a 502 before the GET retry
        // below); the worker's dashboard keeps idle sockets 65 s, so that is
        // rare. (An agent `timeout` to drop idle sockets early was tried: Node
        // applies it to sockets in use as well, and requests stalled 2-10 s.)
        agent: new http.Agent({ keepAlive: true }),
        exited: false,
        startedAt: Date.now(),
        onIdle: null,
        exit: new Promise((r) => (resolveExit = r)),
      };
      child.once('exit', (code, signal) => {
        gen.exited = true;
        gen.agent.destroy();
        gens.delete(gen);
        resolveExit({ code, signal });
        if (gen === standby) {
          if (gen.holdTimer) clearTimeout(gen.holdTimer);
          standby = null;
        }
        if (gen === current && !closing) {
          current = null;
          say('warn', 'serving generation exited', { generation: n, code, signal });
          // The one it replaced is still here: go back to it, at once.
          const s: Generation | null = standby;
          if (s && !s.exited) {
            rollback({ internal: true }).catch((err: unknown) => {
              say('warn', 'fallback to the standby failed', { message: message(err) });
              if (respawn) roll({ internal: true }).catch(() => {});
            });
          } else if (respawn) setTimeout(() => roll({ internal: true }).catch(() => {}), Math.min(60_000, 1000 * 2 ** Math.min(crashes++, 6)));
        }
      });
      child.on('message', (m: unknown) => {
        const msg = m as { type?: unknown; port?: unknown } | null;
        if (msg && msg.type === 'listening' && Number.isInteger(msg.port)) gen.port = msg.port as number;
      });
      child.on('error', (err) => say('warn', 'generation error', { generation: n, message: err.message }));
      gens.add(gen);
      say('info', 'spawned generation', { generation: n, pid: child.pid, runtime: spec.runtime, ...(spec.runtime === 'jarvisd' ? { exe: spec.execPath } : {}) });
      return gen;
    }

    async function waitReady(gen: Generation, timeoutMs = readyTimeoutMs): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !gen.exited) {
        if (gen.port && (await probe(gen.port))) return true;
        await sleep(gen.port ? 200 : 100);
      }
      return false;
    }

    function send(gen: Generation, msg: { type: string }): void {
      try {
        if (gen.child.connected) gen.child.send(msg);
      } catch {
        /* already gone */
      }
    }

    async function stopGeneration(gen: Generation): Promise<void> {
      if (gen.exited) return;
      send(gen, { type: 'stop' });
      const t = setTimeout(() => gen.child.kill(), stopGraceMs);
      await gen.exit;
      clearTimeout(t);
    }

    // Routing has moved off `gen`: end its streams (their clients reconnect and
    // land on the new one), wait for the rest of its requests, then stop it —
    // or, with `hold`, keep it drained as the standby until holdMs after the
    // flip, for a rollback.
    async function retire(gen: Generation, { hold = false }: { hold?: boolean } = {}): Promise<void> {
      send(gen, { type: 'drain' });
      if (hold && holdMs > 0) {
        standby = gen;
        gen.holdTimer = setTimeout(() => {
          if (standby !== gen) return;
          standby = null;
          say('info', 'standby released', { generation: gen.n });
          void stopGeneration(gen);
        }, holdMs);
      }
      for (const end of gen.streams) end();
      if (gen.inflight > 0) {
        await Promise.race([new Promise<void>((r) => (gen.onIdle = r)), sleep(drainTimeoutMs)]);
        if (gen.inflight > 0) say('warn', 'drain timed out', { generation: gen.n, inflight: gen.inflight, requests: inFlight(gen) });
      }
      if (current === gen) return; // rolled back to while it drained
      // A request in flight at the flip may have turned into a stream since.
      for (const end of gen.streams) end();
      if (standby === gen) {
        say('info', 'generation drained, kept for a rollback', { generation: gen.n, holdMs });
        return;
      }
      await stopGeneration(gen);
      say('info', 'retired generation', { generation: gen.n });
    }

    function dropStandby(): void {
      const s = standby;
      if (!s) return;
      standby = null;
      if (s.holdTimer) clearTimeout(s.holdTimer);
      void stopGeneration(s);
    }

    // ---- the deploy lock ----
    // One deploy at a time. Two deploys once interleaved on the live stack: the
    // second roll dropped the first one's standby, and the first one's health
    // check then saw a commit it had not deployed and found nothing to roll
    // back to. A deploy (src/supervisor/deploy.js) takes this lock for its whole
    // run (roll and health watch) with an owner name; while it is held, a roll
    // or rollback from anyone else is refused with who holds it. It expires
    // after its ttl, so a deploy that died cannot wedge the supervisor. The
    // supervisor's own respawn after a crash is not a deploy and ignores it.
    const DEPLOY_LOCK_MS = 15 * 60_000;
    let deployLock: DeployLock | null = null;

    function lockHeld(): DeployLock | null {
      if (deployLock && Date.now() > deployLock.until) deployLock = null;
      return deployLock;
    }

    function guard(owner: string | null): void {
      const h = lockHeld();
      if (h && h.owner !== owner) throw new Error(`refused: another deploy holds the supervisor (${h.owner}, since ${h.since}); run again once it has finished`);
    }

    function lock(owner: string | undefined, ttlMs: number = DEPLOY_LOCK_MS): Status {
      if (!owner) throw new Error('lock needs an owner');
      guard(owner);
      if (rolling) throw new Error('refused: a roll is in progress');
      const h = lockHeld();
      deployLock = { owner, since: h ? h.since : new Date().toISOString(), until: Date.now() + Math.min(Math.max(Number(ttlMs) || DEPLOY_LOCK_MS, 1000), 60 * 60_000) };
      say('info', 'deploy lock taken', { owner });
      return status();
    }

    function unlock(owner: string | undefined): Status {
      const h = lockHeld();
      if (h && h.owner === owner) {
        deployLock = null;
        say('info', 'deploy lock released', { owner });
      }
      return status();
    }

    // Start N+1, flip to it once ready, retire N (kept as the standby). One
    // roll at a time: a second one asked for meanwhile is refused (it used to
    // share the first one's result, which hid that two deploys were running).
    function roll({ owner = null, internal = false }: { owner?: string | null; internal?: boolean } = {}): Promise<Status> {
      if (closing) return Promise.reject(new Error('supervisor is closing'));
      if (internal) {
        if (rolling) return rolling;
      } else {
        try {
          guard(owner);
        } catch (err) {
          return Promise.reject(err);
        }
        if (rolling) return Promise.reject(new Error('refused: a roll is already in progress'));
      }
      const p = (async () => {
        // A newer deploy supersedes the rollback target of the last one.
        dropStandby();
        const next = spawnGeneration();
        const ready = await waitReady(next);
        if (!ready) {
          say('warn', 'generation never became ready', { generation: next.n, exited: next.exited });
          await stopGeneration(next);
          throw new Error(`generation ${next.n} did not become ready${next.exited ? ' (it exited)' : ''}`);
        }
        const prev = current;
        current = next;
        crashes = 0;
        say('info', 'routing to generation', { generation: next.n, port: next.port, previous: prev ? prev.n : null });
        if (prev) await retire(prev, { hold: true });
      })()
        .finally(() => {
          rolling = null;
        })
        .then(() => status());
      rolling = p;
      return p;
    }

    // Back to the standby: the serving generation (if any) drains first, so it
    // lets go of the passes' lease (Z2) before the standby asks for it again;
    // the standby is undrained, waited for, flipped to; the other is stopped.
    function rollback({ owner = null, internal = false }: { owner?: string | null; internal?: boolean } = {}): Promise<Status> {
      if (closing) return Promise.reject(new Error('supervisor is closing'));
      if (!internal) {
        try {
          guard(owner);
        } catch (err) {
          return Promise.reject(err);
        }
      }
      if (rolling) return Promise.reject(new Error('a roll is in progress; roll back once it has finished'));
      const back = standby;
      if (!back || back.exited) return Promise.reject(new Error('no previous generation to roll back to (none kept, or its hold expired)'));
      const p = (async () => {
        standby = null;
        if (back.holdTimer) clearTimeout(back.holdTimer);
        const bad = current;
        if (bad) send(bad, { type: 'drain' });
        send(back, { type: 'undrain' });
        if (!(await waitReady(back, undrainTimeoutMs))) {
          if (bad && !bad.exited) send(bad, { type: 'undrain' });
          await stopGeneration(back);
          throw new Error(`generation ${back.n} did not become ready again`);
        }
        current = back;
        say('warn', 'rolled back to generation', { generation: back.n, from: bad ? bad.n : null });
        if (bad && !bad.exited) await retire(bad);
      })()
        .finally(() => {
          rolling = null;
        })
        .then(() => status());
      rolling = p;
      return p;
    }

    // Method, path (no query: it may carry a token) and age of what is in flight.
    function inFlight(gen: Generation): Array<{ method: string; path: string; ms: number }> {
      const now = Date.now();
      return [...gen.requests].slice(0, 10).map((r) => ({ method: r.method, path: r.path, ms: now - r.at }));
    }

    function status(): Status {
      const s = standby;
      const l = lockHeld();
      return {
        ok: true,
        port: publicPort(),
        source: SOURCE,
        runtime: baseSpec.runtime,
        exe: current ? current.exe : null,
        generation: current ? current.n : null,
        pid: current && current.pid !== undefined ? current.pid : null,
        workerPort: current ? current.port : null,
        standby: s && !s.exited ? { generation: s.n, pid: s.pid } : null,
        rolling: !!rolling,
        deployLock: l ? { owner: l.owner, since: l.since, until: new Date(l.until).toISOString() } : null,
        generations: [...gens].map((g) => ({ n: g.n, pid: g.pid, port: g.port, inflight: g.inflight, streams: g.streams.size, requests: inFlight(g) })),
      };
    }

    // ---- the proxy ----

    function done(gen: Generation): void {
      gen.inflight--;
      if (gen.inflight === 0 && gen.onIdle) gen.onIdle();
    }

    function forwardHeaders(headers: SupHeaders): SupHeaders {
      const out: SupHeaders = {};
      for (const [k, v] of Object.entries(headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
      return out;
    }

    const server: SupServer = http.createServer((req, res) => {
      const gen = current;
      if (!gen) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ error: 'starting' }));
        return;
      }
      // 'request' (holds the drain) → 'stream' (does not) → 'done'.
      let state: 'request' | 'stream' | 'done' = 'request';
      let endStream: (() => void) | null = null;
      gen.inflight++;
      // What is in flight, so a drain that times out can say what held it.
      const entry: InFlightEntry = { method: String(req.method), path: String(req.url).split('?')[0]!.slice(0, 120), at: Date.now() };
      gen.requests.add(entry);
      const finish = (): void => {
        gen.requests.delete(entry);
        done(gen);
      };
      const release = (): void => {
        if (state === 'request') finish();
        else if (state === 'stream' && endStream) gen.streams.delete(endStream);
        state = 'done';
      };
      let upstream: import('node:http').ClientRequest | null = null;
      const forward = (retried: boolean): void => {
        const up = http.request(
          { host: '127.0.0.1', port: gen.port ?? 0, method: req.method, path: req.url, headers: forwardHeaders(req.headers), agent: gen.agent },
          (ures: SupIncoming) => {
            res.writeHead(ures.statusCode ?? 502, ures.statusMessage, forwardHeaders(ures.headers));
            res.flushHeaders();
            // An event stream never finishes by itself, so it must not hold a
            // drain: retire() ends it cleanly and the client's reconnect (with
            // Last-Event-ID) lands on the new generation.
            if (state === 'request' && /^text\/event-stream/i.test(String(ures.headers['content-type'] || ''))) {
              finish();
              state = 'stream';
              const end = (): void => {
                release();
                ures.unpipe(res);
                res.end();
                up.destroy();
              };
              endStream = end;
              gen.streams.add(end);
            }
            ures.on('error', () => {
              if (state !== 'done') res.destroy();
            });
            ures.pipe(res);
          }
        );
        upstream = up;
        up.on('error', (err: NodeJS.ErrnoException) => {
          if (state === 'done' || up !== upstream) return;
          // A pooled socket the worker closed as idle just as we reused it: the
          // request never reached it. Safe to send again when it has no body.
          if (!retried && !res.headersSent && up.reusedSocket && err.code === 'ECONNRESET' && (req.method === 'GET' || req.method === 'HEAD')) {
            forward(true);
            return;
          }
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'worker unreachable', message: err.message }));
          } else res.destroy();
          release();
        });
        if (retried) up.end();
        else req.pipe(up);
      };
      res.on('close', () => {
        const up = upstream as import('node:http').ClientRequest | null;
        if (!res.writableFinished && up) up.destroy();
        release();
      });
      forward(false);
    });
    // WebSocket (and any other Upgrade): a byte pipe to the generation. It is a
    // stream: a roll closes it and the client reconnects.
    server.on('upgrade', (req: SupIncoming, socket: SupSocket, head: Buffer) => {
      const gen = current;
      if (!gen || !gen.port) {
        socket.destroy();
        return;
      }
      const up = net.connect(gen.port, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      const end = (): void => {
        gen.streams.delete(end);
        socket.end();
        up.end();
      };
      gen.streams.add(end);
      const gone = (): void => {
        gen.streams.delete(end);
        socket.destroy();
        up.destroy();
      };
      up.on('error', gone);
      socket.on('error', gone);
      up.on('close', gone);
      socket.on('close', gone);
    });
    server.keepAliveTimeout = 5000;

    function publicPort(): number {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : port;
    }

    // ---- control ----

    let control: import('node:net').Server | null = null;
    let controlFile: string | null = null;

    function serveControl(where: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const c = net.createServer((sock) => {
          let buf = '';
          sock.setEncoding('utf8');
          sock.on('error', () => {});
          sock.on('data', async (chunk: string) => {
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl < 0) return;
            let msg: ControlMessage;
            try {
              msg = JSON.parse(buf.slice(0, nl)) as ControlMessage;
            } catch {
              sock.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n');
              return;
            }
            const cmd = msg.cmd;
            let reply: Status | { ok: false; error: string };
            try {
              if (cmd === 'roll') reply = await roll({ owner: msg.owner || null });
              else if (cmd === 'rollback') reply = await rollback({ owner: msg.owner || null });
              else if (cmd === 'lock') reply = lock(msg.owner, msg.ttlMs);
              else if (cmd === 'unlock') reply = unlock(msg.owner);
              else if (cmd === 'status') reply = status();
              else reply = { ok: false, error: `unknown command ${cmd}` };
            } catch (err) {
              reply = { ...status(), ok: false, error: message(err) };
            }
            sock.end(JSON.stringify(reply) + '\n');
          });
        });
        control = c;
        c.once('error', reject);
        c.listen(where, () => resolve(where));
      });
    }

    async function start(): Promise<Status> {
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error(`refusing to bind ${host}: loopback only`);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      const where = controlPath || defaultControlPath(publicPort());
      if (process.platform !== 'win32') {
        // A socket file left by a killed supervisor: remove it, unless one answers.
        if (fs.existsSync(where) && !(await request(where, { cmd: 'status' }, 1000).then(() => true, () => false))) fs.unlinkSync(where);
        controlFile = where;
      }
      await serveControl(where);
      say('info', 'listening', { url: `http://${host}:${publicPort()}/`, control: where, runtime: baseSpec.runtime });
      await roll({ internal: true });
      return status();
    }

    async function close(): Promise<void> {
      closing = true;
      const s = standby;
      if (s && s.holdTimer) clearTimeout(s.holdTimer);
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      const c = control as import('node:net').Server | null;
      if (c) await new Promise<void>((r) => c.close(() => r()));
      if (controlFile) fs.rmSync(controlFile, { force: true });
      await Promise.all([...gens].map((g) => stopGeneration(g)));
    }

    return {
      start,
      roll,
      rollback,
      lock,
      unlock,
      status,
      close,
      server,
      controlPath: (): string | import('node:net').AddressInfo | null => {
        const c = control as import('node:net').Server | null;
        return c ? c.address() : null;
      },
    };
  }

  /** `node src/supervisor [run|roll|rollback|status]`, `jarvisd supervise [...]`. */
  async function cli(argv: string[]): Promise<void> {
    const cmd = argv[0] || 'run';
    const port = Number(envSetting('PA_DISPATCH_PORT', DEFAULT_PORT));
    if (cmd === 'roll' || cmd === 'rollback' || cmd === 'status') {
      const r = await request(defaultControlPath(port), { cmd });
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    }
    if (cmd !== 'run') {
      process.stderr.write('usage: node src/supervisor [run | roll | rollback | status]  (jarvisd supervise [...])\n');
      process.exit(2);
    }
    // Above normal, like each worker generation (src/util/childPriority.js,
    // not required here): a machine full of Normal test processes must not
    // starve the process every dashboard request goes through.
    try {
      os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL);
    } catch {
      /* not permitted (Linux without CAP_SYS_NICE): run at the default */
    }
    logFile = createLogFile(process.env.PA_SUPERVISOR_LOG || defaultLogFile());
    log('info', 'supervisor starting', { pid: process.pid, source: SOURCE, log: logFile.file });
    const sup = createSupervisor();
    const stop = async (signal: string): Promise<void> => {
      log('info', 'stopping', { signal });
      await sup.close().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', () => void stop('SIGINT'));
    process.on('SIGTERM', () => void stop('SIGTERM'));
    if (process.platform !== 'win32') process.on('SIGHUP', () => void sup.roll().catch((err: unknown) => log('warn', 'roll failed', { message: message(err) })));
    await sup.start();
  }

  module.exports = { createSupervisor, runtimeSpec, request, defaultControlPath, probe, envSetting, sourceHash, cli, createLogFile, defaultLogFile, DEFAULT_PORT, log };
}
