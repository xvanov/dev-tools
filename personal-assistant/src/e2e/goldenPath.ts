'use strict';

// The e2e harness shared by `pa e2e <workflow>` (src/e2e/workflows.ts, buildRunners.ts): the
// outside calls every workflow makes through `deps` (so tests swap them), `gh` as the repo
// owner, the live-feed subscription, the policy dry check, and `--on <machine>`.
//
// It was the golden path of the software factory (plan E4: card → factory job → PR); that
// path was removed with the factory (D32) and Build's workflows replaced it.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Json = import('../types.ts').Json;
/**
 * Every outside call (defaultDeps()); tests hand over partial fakes, so it is
 * read call by call.
 */
type Deps = Json;
/** goldenPathCore.parseOptions()'s options, plus what workflows.ts adds. */
type Options = Json;
type Flags = Record<string, string | boolean | undefined>;
type Lists = { timeout?: string[] };
type Check = { view: string; check: string; ok: boolean; detail?: string; skipped?: boolean };
type RunResult = { code: number; stdout: string; stderr: string };
type Safe<T> = { ok: true; value: T; error?: undefined } | { ok: false; error: string; value?: undefined };

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const C = require('./goldenPathCore.ts');

function defaultDeps(): Deps {
  const { config } = require('../config.ts');
  const termhub = require('../dispatch/termhub.ts');
  const repo = require('../repo');
  const paBase = `http://${config.dispatch.host === '0.0.0.0' ? '127.0.0.1' : config.dispatch.host}:${config.dispatch.port}`;
  return {
    config,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    log: (line: string) => process.stderr.write(`e2e ${new Date().toISOString().slice(11, 19)} ${line}\n`),
    uuid: () => crypto.randomUUID(),
    paBase,
    async getJson(url: string, { timeoutMs = 30_000 }: { timeoutMs?: number } = {}) {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${res.status} on ${url.replace(/\?.*/, '')}: ${text.slice(0, 160)}`), { status: res.status });
      return text ? JSON.parse(text) : null;
    },
    async pageStatus(url: string) {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await res.body?.cancel();
      return res.status;
    },
    addCard: (text: string) => require('../commitments/request.ts').add({ text, via: 'cli' }),
    closeCard: (id: number | string) => require('../commitments.ts').setStatus(Number(id), 'dropped'),
    chat: (name: string, args: Json) => require('../mcp/chatTools.ts').handle(name, args),
    auditRows: (tool: string) => repo.audit.recent({ tool, limit: 100 }),
    hub: (machine: string | null | undefined) => termhub.forMachine(machine || null),
    dbProbe: () => repo.system.ping(),
    gh: (args: string[], owner: string) => gh(config.github.bin, args, owner),
    runCommand: (machine: string | null, argv: string[], opts: Json) => require('../dispatch/exec.ts').runCommand(machine, argv, opts),
    subscribe,
  };
}


// The dashboard's live feed (plan 0.4, GET /api/events): each event's JSON to
// `onEvent` until the returned function is called. Errors end it quietly; the
// run falls back to its poll interval.
function subscribe(url: string, onEvent: (event: Json) => void): () => void {
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          buf = buf.slice(i + 2);
          if (data) {
            try { onEvent(JSON.parse(data)); } catch { /* not ours to parse */ }
          }
        }
      }
    } catch {
      /* aborted or dropped: polling carries on */
    }
  })();
  return () => ac.abort();
}

// ---------------------------------------------------------------- GitHub ----

function run(bin: string, args: string[], { env, timeoutMs = 60_000 }: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && !stdout ? err.message : '')) });
    });
  });
}

// `gh` as the repo owner's account (PLAN.md P1): GH_TOKEN from
// `gh auth token --user <owner>` for this one child, never `gh auth switch`,
// and the token is never printed or returned.
async function gh(bin: string, args: string[], owner: string): Promise<RunResult> {
  const t = await run(bin, ['auth', 'token', '--user', owner], { timeoutMs: 20_000 });
  const token = t.code === 0 ? t.stdout.trim() : '';
  if (!token) return { code: 4, stdout: '', stderr: `gh has no login for ${owner} (gh auth login, then gh auth switch back to your default)` };
  return run(bin, args, { env: { ...process.env, GH_TOKEN: token } });
}

// --------------------------------------------------------------- helpers ----

function owner(repo: string): string {
  return String(repo).split('/')[0] as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function safely<T = any>(fn: () => T | Promise<T>): Promise<Safe<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
}

// ------------------------------------------------------------- approvals ----
const E2E_ACTOR = 'pa-e2e';

/** Dry: the policy prompts for `tool` and takes the e2e channel's answer (evaluated, not audited). */
function policyDry(tool: string): Check {
  const P = require('../policy');
  const call = P.evaluate({ tool, action: 'call', channel: 'chat', actor: E2E_ACTOR, args: {} });
  const answer = P.evaluate({ tool, action: 'approve', channel: 'e2e', actor: E2E_ACTOR, args: {} });
  const ok = call.decision === 'ask' && answer.decision === 'allow';
  return { view: 'policy', check: `${tool} prompts and takes the e2e approval`, ok, detail: `call ${call.decision} (${call.rule}); e2e answer ${answer.decision} (${answer.rule})` };
}

// ---------------------------------------------------------------- remote ----

/**
 * `--on <machine>`: the same command on another stack's machine. A dry run
 * fits termhub's exec (≤ 30 min) and its JSON comes back on stdout; a real run
 * outlives that, so it runs in a termhub session there (watchable) writing
 * `--report <file>`, read back through exec when it appears.
 */
async function remote(o: Options, flags: Flags, lists: Lists, deps: Deps, { workflow = null }: { workflow?: string | null } = {}): Promise<Json> {
  const m = deps.config.termhub.machines[o.on];
  if (!m) throw new Error(`--on ${o.on}: not in PA_MACHINES`);
  const sep = m.os === 'windows' || /^[A-Za-z]:\\/.test(m.reposRoot) ? '\\' : '/';
  const cwd = o.remotePath || [m.reposRoot.replace(/[\\/]+$/, ''), 'dev-tools', 'personal-assistant'].join(sep);
  const argv = C.remoteArgv(flags, lists, { workflow });
  if (o.dryRun) {
    const r = await deps.runCommand(o.on, ['node', 'bin/pa.js', ...argv], { cwd, timeoutMs: 10 * 60_000 });
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new Error(`pa e2e on ${o.on} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
  }
  const file = `e2e-report-${deps.uuid()}.json`;
  const command = ['node', 'bin/pa.js', ...argv, '--report', file].join(' ');
  const s = await deps.hub(o.on).createSession({ cwd, command, title: `pa e2e${workflow ? ` ${workflow}` : ''} (${o.stack || o.on})` });
  deps.log(`running on ${o.on} in termhub session ${s.id}`);
  const total = (Object.values(o.timeouts) as number[]).reduce((a, b) => a + b, 0) * 1000 + 15 * 60_000;
  const until = deps.now() + total;
  while (deps.now() < until) {
    await deps.sleep(30_000);
    const r = await deps.runCommand(o.on, ['node', '-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)},'utf8'))`], { cwd, timeoutMs: 30_000 }).catch(() => null);
    if (r && r.code === 0 && r.stdout.trim()) {
      await deps.runCommand(o.on, ['node', '-e', `require('fs').unlinkSync(${JSON.stringify(file)})`], { cwd, timeoutMs: 30_000 }).catch(() => null);
      return JSON.parse(r.stdout);
    }
  }
  throw new Error(`no report from ${o.on} after ${Math.round(total / 60000)} min (termhub session ${s.id} is still there to look at)`);
}

/** Writes the report where `--report` says (the remote runner reads it back). */
function writeReport(file: string, report: Json): void {
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + os.EOL);
}

module.exports = { remote, policyDry, E2E_ACTOR, writeReport, defaultDeps, safely, owner };
