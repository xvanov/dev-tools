'use strict';

// The e2e harness's pure parts, tested without a stack: `pa e2e` flags → options,
// the usage text, and the argv that re-runs a command on another machine
// (`--on`). The runner is goldenPath.ts; each workflow's own rules are in
// workflowsCore.ts.
//
// This was the golden path of the software factory (plan E4: card → factory job →
// PR, hops, id chains, sweeps); it was removed with the factory (D32).
//
//   parseOptions(flags, lists)     `pa e2e` flags → options (throws on nonsense)
//   remoteArgv(flags, lists, o)    the argv `--on <machine>` runs there
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Timeouts = Record<string, number>;
/** `pa e2e` flags as cli/args parsed them: a value, or true/false for a bare flag. */
type Flags = Record<string, string | boolean | undefined>;
type Lists = { timeout?: string[] };
type Options = {
  dryRun: boolean; keep: boolean; json: boolean;
  model: string | null; repo: string; timeouts: Timeouts;
  stack: string | null; on: string | null; remotePath: string | null; report: string | null;
};

const DEFAULT_REPO = 'xvanov/dev-tools';
// `--timeout name=seconds`: the workflows' own caps (workflows.ts sets their defaults).
const TIMEOUT_NAMES = ['research', 'ci', 'teams', 'ask'];

const USAGE = `pa e2e <workflow> — one workflow of the Map, headless, against the live stack (plan 8.2)

  pa e2e <workflow> [--dry-run] [--keep] [--json] [--report file] [--stack work|personal]
                    [--repo owner/name] [--model m] [--timeout name=seconds]...
  pa e2e all --dry-run                every workflow's dry run
  pa e2e <workflow> --on <machine>    run it on a PA_MACHINES machine (the other stack) and
                                      collect its JSON report

  Exits non-zero on any hop over its target, failed check or cost over the ceiling.`;

function bad(message: string): Error & { usage: true } {
  return Object.assign(new Error(message), { usage: true as const });
}

function str(flags: Flags, name: string): string | null {
  const v = flags[name];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function bool(flags: Flags, name: string): boolean {
  const v = flags[name];
  if (v === undefined || v === false) return false;
  if (v === true) return true;
  return !/^(0|false|no)$/i.test(String(v));
}

/**
 * Pure. `pa e2e` flags → options. A boolean flag that swallowed the next word
 * (`--keep foo`) is an error, not a silent value.
 */
function parseOptions(flags: Flags = {}, lists: Lists = {}): Options {
  for (const b of ['dry-run', 'keep', 'json']) {
    if (typeof flags[b] === 'string' && !/^(0|1|true|false|yes|no)$/i.test(flags[b])) {
      throw bad(`--${b} takes no value (got "${flags[b]}")`);
    }
  }
  const model = str(flags, 'model');
  const repo = str(flags, 'repo') || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw bad(`--repo is owner/name (got "${repo}")`);
  const timeouts: Timeouts = {};
  for (const t of lists.timeout || []) {
    const m = /^([a-z_]+)=(\d+)$/.exec(String(t));
    if (!m || !TIMEOUT_NAMES.includes(m[1] as string)) throw bad(`--timeout wants name=seconds, name one of ${TIMEOUT_NAMES.join(', ')} (got "${t}")`);
    timeouts[m[1] as string] = Number(m[2]);
  }
  const stack = str(flags, 'stack');
  if (stack && !['work', 'personal'].includes(stack)) throw bad('--stack is work or personal');
  return {
    dryRun: bool(flags, 'dry-run'),
    keep: bool(flags, 'keep'),
    json: bool(flags, 'json'),
    model,
    repo,
    timeouts,
    stack,
    on: str(flags, 'on'),
    remotePath: str(flags, 'remote-path'),
    report: str(flags, 'report'),
  };
}

/**
 * Pure. The argv that runs this same `pa e2e` on another machine: the safe flags
 * only, tokens, never --on or --report.
 */
function remoteArgv(flags: Flags = {}, lists: Lists = {}, { workflow = null }: { workflow?: string | null } = {}): string[] {
  const SAFE = /^[\w./:=@-]+$/;
  if (workflow != null && !/^[a-z][a-z0-9-]*$/.test(workflow)) throw bad(`workflow "${workflow}" cannot be passed to another machine`);
  const argv = workflow ? ['e2e', workflow, '--json'] : ['e2e', '--json'];
  for (const [k, v] of Object.entries(flags)) {
    if (['on', 'remote-path', 'report', 'json', 'timeout'].includes(k)) continue;
    if (v === true) argv.push(`--${k}`);
    else if (v === false) argv.push(`--no-${k}`);
    else {
      if (!SAFE.test(String(v))) throw bad(`--${k} "${v}" cannot be passed to another machine`);
      argv.push(`--${k}`, String(v));
    }
  }
  for (const t of lists.timeout || []) {
    if (!SAFE.test(String(t))) throw bad(`--timeout "${t}" cannot be passed to another machine`);
    argv.push('--timeout', String(t));
  }
  return argv;
}

module.exports = { DEFAULT_REPO, TIMEOUT_NAMES, USAGE, parseOptions, remoteArgv };
