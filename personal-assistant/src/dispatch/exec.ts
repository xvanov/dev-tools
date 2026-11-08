'use strict';

// Run one command on a machine and get its output and exit code.
//
//   runCommand(machineName | null, argv, {cwd, timeoutMs, maxOutputBytes?, stdin?, env?})
//     -> Promise<{code, stdout, stderr, timedOut?, signal?, truncated?, error?}>
//
// `null` (or '') is THIS machine: child_process.spawn with `shell: false`.
// A name from PA_MACHINES is that machine, through its termhub's
// `POST /api/exec` (termhub/lib/exec.ts) — the same contract, run there.
// Either way argv is an array that no shell ever sees, so a value in it is a
// value, never syntax; a caller that wants a shell names one in argv[0] and
// owns the quoting.
//
// It resolves on every outcome a command can have — non-zero exit, a program
// that does not exist, a timeout — so `code !== 0` is the one check a caller
// needs:
//
//   - exit:      code is the exit code.
//   - timeout:   code 124 (timeout(1)'s convention), timedOut: true.
//   - no such program / bad cwd: code 127 (the shell's), error says why.
//
// It REJECTS only when the command could not be put to the machine at all:
// an unknown machine name, a termhub that is down, refuses the request, or is
// too old to have the route (err.code 'EXEC_UNSUPPORTED' — update termhub on
// that machine). Those are not the command's failures and must not be read as
// "the command ran and failed".
//
// The optional fields are extensions; `cwd` and `timeoutMs` are the contract.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type ExecOptions = { cwd?: string | null | undefined; timeoutMs?: number | undefined; maxOutputBytes?: number | undefined; stdin?: string | null | undefined; env?: Record<string, string> | null | undefined };
type Truncated = { stdout: boolean; stderr: boolean };
type ExecResult = { code: number; stdout: string; stderr: string; timedOut?: boolean; signal?: string; truncated?: Truncated; error?: string };
/** A command's outcome as runLocal sees it, or as termhub's /api/exec answers it. */
type RawResult = { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean; signal?: string | null; truncated?: Truncated; error?: string | null };
type Machine = { name: string; url: string };

const { spawn } = require('child_process');
const os = require('os');
const { config } = require('../config.ts');

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_CODE = 124;
const NOT_FOUND_CODE = 127;

function checkArgv(argv: unknown): asserts argv is string[] {
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string') || !argv[0]) {
    throw new TypeError('runCommand: argv must be a non-empty array of strings');
  }
}

// Which machine a name means. Strict on purpose: a typo must not quietly run
// the command here instead of there.
function resolveMachine(name: string | null | undefined): Machine | null {
  if (name == null || name === '') return null;
  const machine = config.termhub.machines[name];
  if (machine) return machine;
  if (String(name).toLowerCase() === os.hostname().toLowerCase()) return null;
  const known = Object.keys(config.termhub.machines);
  throw new Error(
    `unknown machine "${name}" — ${known.length ? `one of: ${known.join(', ')}` : 'none configured; set PA_MACHINES in .env'}`
  );
}

// termhub's answer → this module's. Pure; exported for tests.
function normalise(r: RawResult): ExecResult {
  const out: ExecResult = { code: r.code as number, stdout: r.stdout || '', stderr: r.stderr || '' };
  if (r.timedOut) {
    out.code = TIMEOUT_CODE;
    out.timedOut = true;
  } else if (r.code == null) {
    out.code = r.signal ? 128 : NOT_FOUND_CODE;
  }
  if (r.signal) out.signal = r.signal;
  if (r.error) {
    out.error = r.error;
    if (!out.stderr) out.stderr = r.error;
  }
  if (r.truncated && (r.truncated.stdout || r.truncated.stderr)) out.truncated = r.truncated;
  return out;
}

function runLocal(argv: string[], { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_OUTPUT_BYTES, stdin, env }: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: import('child_process').ChildProcessWithoutNullStreams;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: cwd || os.homedir(),
        env: env ? { ...process.env, ...env } : process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      return resolve(normalise({ code: null, error: String(err.message || err) }));
    }
    const buf: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    const truncated: Truncated = { stdout: false, stderr: false };
    for (const name of ['stdout', 'stderr'] as const) {
      child[name].on('data', (chunk: Buffer) => {
        const room = maxOutputBytes - size[name];
        if (room <= 0) { truncated[name] = true; return; }
        const keep = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (keep.length < chunk.length) truncated[name] = true;
        buf[name].push(keep);
        size[name] += keep.length;
      });
    }
    child.stdin.on('error', () => {});
    child.stdin.end(stdin || undefined);

    let timedOut = false;
    let error: string | null = null;
    let done = false;
    const kill = () => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
        } else {
          process.kill(-(child.pid as number), 'SIGKILL');
        }
      } catch {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
    };
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      grace = setTimeout(() => finish(null, 'SIGKILL'), 5000);
    }, timeoutMs);
    function finish(code: number | null, signal: string | null) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(normalise({
        code: timedOut ? null : code,
        signal,
        timedOut,
        error: error || (timedOut ? `timed out after ${timeoutMs} ms` : null),
        stdout: Buffer.concat(buf.stdout).toString('utf8'),
        stderr: Buffer.concat(buf.stderr).toString('utf8'),
        truncated,
      }));
    }
    child.on('error', (err: NodeJS.ErrnoException) => { error = `${err.code || 'error'}: ${err.message}`; finish(null, null); });
    child.on('close', (code: number | null, signal: string | null) => finish(code, signal));
  });
}

async function runRemote(machine: Machine, argv: string[], { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes, stdin, env }: ExecOptions = {}): Promise<ExecResult> {
  const body: { argv: string[]; timeoutMs: number } & ExecOptions = { argv, timeoutMs };
  if (cwd) body.cwd = cwd;
  if (maxOutputBytes) body.maxOutputBytes = maxOutputBytes;
  if (stdin != null) body.stdin = stdin;
  if (env) body.env = env;
  const route = `${machine.url}/api/exec`;
  let res;
  try {
    res = await fetch(route, {
      method: 'POST',
      // X-Termhub + JSON are what termhub's browser guard demands (termhub/lib/requestGuard.js).
      headers: { 'Content-Type': 'application/json', 'X-Termhub': '1' },
      body: JSON.stringify(body),
      // termhub enforces the command's own deadline; this only bounds the wire.
      signal: AbortSignal.timeout(timeoutMs + 30_000),
    });
  } catch (err: any) {
    throw Object.assign(new Error(`termhub on ${machine.name} unreachable: ${err.message}`), { code: 'EXEC_UNREACHABLE' });
  }
  const text = await res.text().catch(() => '');
  if (res.status === 404) {
    throw Object.assign(
      new Error(`termhub on ${machine.name} is too old to run commands (no /api/exec) — update it there`),
      { code: 'EXEC_UNSUPPORTED', status: 404 }
    );
  }
  if (!res.ok) {
    throw Object.assign(new Error(`termhub on ${machine.name} refused the command (${res.status}): ${text.slice(0, 200)}`), {
      code: 'EXEC_REFUSED',
      status: res.status,
    });
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`termhub on ${machine.name} answered something that is not JSON`), { code: 'EXEC_REFUSED' });
  }
  return normalise(payload);
}

/**
 * Runs `argv` on `machineName` (null = this machine). See the header for the
 * contract; the signature is relied on by other dispatchers — extend it with
 * optional fields only.
 */
async function runCommand(machineName: string | null | undefined, argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  checkArgv(argv);
  const machine = resolveMachine(machineName);
  return machine ? runRemote(machine, argv, opts) : runLocal(argv, opts);
}

module.exports = { runCommand, resolveMachine, normalise, TIMEOUT_CODE, NOT_FOUND_CODE };
