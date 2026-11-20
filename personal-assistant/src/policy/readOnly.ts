'use strict';

// What the PA chat may read without a prompt (D33, "Jarvis acts autonomously
// on routine actions"): pure checks the policy and the chat's PreToolUse hooks
// share, so both engines decide the same way.
//
//   isSecretPath(p)            a path that looks like a credential: never read unasked
//   insideRoots(roots, cwd, p) whether p (relative to cwd) is inside one of roots
//   readOnlyBash(command)      whether a shell command only reads: {ok, reason}
//
// readOnlyBash is deliberately small and conservative. It splits on `&&`,
// `||`, `;` and `|` and allows a command only when every segment is one of a
// fixed set of reading commands (cd, pwd, ls, cat, head, tail, wc, grep, rg,
// find, git's reading sub-commands, gh's view/list sub-commands). Anything it
// cannot read with certainty — output redirection, `$`, backticks, `<`,
// subshells, an env-var prefix, an unknown command, a secret-looking path —
// is not read-only, and the chat asks as before. `2>/dev/null` and `2>&1` are
// accepted: they write nothing.
//
// The `pa` CLI is not on it: the chat reads through the `pa` MCP tool (argv,
// no shell, PA_READ_ONLY for `runs`), and a `pa` shell command keeps asking.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const nodePath: typeof import('node:path') = require('path');

interface Verdict {
  ok: boolean;
  reason: string;
}

const SECRET_DIRS = ['.ssh', '.aws', '.azure', '.gnupg', '.docker', '.kube'];
const SECRET_NAMES = ['.npmrc', '.git-credentials', '.netrc', '.pgpass', '.pypirc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
// .env / .env.local / .envrc / a `.env*` glob / prod.env; the PA's own env backups (env.before-*); its store (the vault's rows live there).
const SECRET_NAME_RE = /^\.env|\.env$|^env\.before-|credential|secret|token|\.(pem|key|pfx|p12|kdbx)$|\.sqlite(-wal|-shm|-journal)?$/i;

/** Pure. Whether a path (any form: relative, `~`, backslashes, a glob) looks like a credential. */
function isSecretPath(p: unknown): boolean {
  const s = String(p ?? '').replace(/\\/g, '/').toLowerCase();
  if (!s) return false;
  const parts = s.split('/').filter((x) => x && x !== '.');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] as string;
    if (SECRET_DIRS.includes(seg)) return true;
    if (seg === '.config' && parts[i + 1] === 'gh') return true;
  }
  const base = parts[parts.length - 1] ?? '';
  return SECRET_NAMES.includes(base) || SECRET_NAME_RE.test(base);
}

const norm = (p: string): string => nodePath.resolve(p).toLowerCase();

/** Pure. Whether `target` (resolved against `cwd`; empty: cwd itself) is inside one of `roots`. Case-insensitive. */
function insideRoots(roots: readonly string[], cwd: string, target: unknown): boolean {
  const abs = norm(nodePath.resolve(cwd, String(target || '.')));
  return roots.filter(Boolean).some((r) => {
    const root = norm(r);
    return abs === root || abs.startsWith(root.endsWith(nodePath.sep) ? root : root + nodePath.sep);
  });
}

// ------------------------------------------------------------- the shell --

type Token = { op: string } | { word: string };

/**
 * Pure. A bash command line as words and the operators between them, or a
 * reason it cannot be read with certainty. Quotes are honoured; `$`,
 * backticks, `<`, `(`, `)`, a lone `&`, a newline and an unquoted `#` are
 * refused; `>` only as `2>/dev/null` or `2>&1`.
 */
function tokenize(command: string): { tokens: Token[] } | { error: string } {
  const tokens: Token[] = [];
  let word: string | null = null;
  let quotedWord = false;
  const s = command;
  const end = () => {
    if (word !== null) tokens.push({ word });
    word = null;
    quotedWord = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return { error: 'an unclosed quote' };
      word = (word ?? '') + s.slice(i + 1, j);
      quotedWord = true;
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let out = '';
      for (; j < s.length && s[j] !== '"'; j++) {
        const d = s[j] as string;
        if (d === '$' || d === '`') return { error: 'an expansion inside double quotes' };
        if (d === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1] as string)) {
          out += s[j + 1];
          j++;
        } else out += d;
      }
      if (j >= s.length) return { error: 'an unclosed quote' };
      word = (word ?? '') + out;
      quotedWord = true;
      i = j;
    } else if (c === '\\') {
      if (i + 1 >= s.length) return { error: 'a trailing backslash' };
      word = (word ?? '') + s[i + 1];
      i++;
    } else if (c === ' ' || c === '\t') {
      end();
    } else if (c === '\n' || c === '\r') {
      return { error: 'more than one line' };
    } else if (c === '$' || c === '`') {
      return { error: 'a `$` or backtick expansion' };
    } else if (c === '<' || c === '(' || c === ')') {
      return { error: `\`${c}\` (input redirection or a subshell)` };
    } else if (c === '#' && word === null) {
      return { error: 'a comment' };
    } else if (c === '>') {
      // Only stderr thrown away or joined to stdout: `2>/dev/null`, `2>&1`.
      const m = word === '2' && !quotedWord ? /^>\s*(\/dev\/null|&1)(?=$|[\s;&|])/.exec(s.slice(i)) : null;
      if (!m) return { error: 'output redirection' };
      word = null;
      quotedWord = false;
      i += m[0].length - 1;
    } else if (c === '&' || c === '|' || c === ';') {
      end();
      const two = s.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        tokens.push({ op: two });
        i++;
      } else if (c === '&') return { error: 'a background `&`' };
      else tokens.push({ op: c });
    } else {
      word = (word ?? '') + c;
    }
  }
  end();
  return { tokens };
}

/** Pure. Splits tokens into segments (the words between operators); null when an operator has nothing on one side. */
function segments(tokens: Token[]): string[][] | null {
  const out: string[][] = [[]];
  for (const t of tokens) {
    if ('op' in t) {
      if (!(out[out.length - 1] as string[]).length) return null;
      out.push([]);
    } else (out[out.length - 1] as string[]).push(t.word);
  }
  if (!(out[out.length - 1] as string[]).length) return null;
  return out;
}

const isFlag = (a: string): boolean => a.startsWith('-') && a !== '-';

// Where a relative path would land after the segment's `cd`s (posix join, `~` kept literal).
const join = (cwd: string, p: string): string => (/^([a-z]:)?[\\/]|^~/i.test(p) || !cwd ? p : `${cwd.replace(/[\\/]+$/, '')}/${p}`);

function secretArg(cwd: string, a: string): boolean {
  const value = isFlag(a) && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
  if (isFlag(value)) return false;
  // git's <rev>:<path> reads a file out of history.
  const tail = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : '';
  return isSecretPath(join(cwd, value)) || isSecretPath(value) || (tail !== '' && isSecretPath(tail));
}

const ok = (reason: string): Verdict => ({ ok: true, reason });
const no = (reason: string): Verdict => ({ ok: false, reason });

const GIT_READS = ['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'rev-list', 'ls-files', 'blame', 'remote', 'worktree', 'stash', 'cherry'];
// A branch flag that changes something: delete, move, copy, force, upstream, description.
const BRANCH_WRITE_LONG = ['--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description', '--track', '--no-track', '--create-reflog'];
const BRANCH_LIST_FLAGS = ['--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
const GH_READS: Record<string, string[]> = { pr: ['view', 'list', 'checks', 'diff'], run: ['list', 'view', 'watch'], issue: ['view', 'list'], repo: ['view'] };
const FIND_ACTS = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'];

function gitSegment(args: string[]): Verdict {
  let i = 0;
  // Global options that only point somewhere or page nothing; `-c` (config) can run commands.
  while (i < args.length && isFlag(args[i] as string)) {
    const a = args[i] as string;
    if (a === '-C') i += 2;
    else if (a === '--no-pager' || a === '-P' || a.startsWith('--git-dir=') || a.startsWith('--work-tree=') || a === '--no-optional-locks') i += 1;
    else return no(`git ${a} before the sub-command`);
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub || !GIT_READS.includes(sub)) return no(`git ${sub ?? ''} is not a reading sub-command`.trim());
  if (rest.some((a) => /^--output(=|$)|^--ext-diff$/.test(a))) return no(`git ${sub} writing a file or running a diff tool`);
  switch (sub) {
    case 'branch': {
      for (const a of rest) {
        if (BRANCH_WRITE_LONG.some((f) => a === f || a.startsWith(`${f}=`))) return no(`git branch ${a}`);
        if (/^-[^-]/.test(a) && /[dDmMcCfut]/.test(a.slice(1))) return no(`git branch ${a}`);
      }
      const listing = rest.some((a) => BRANCH_LIST_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)) || /^-[^-]*l/.test(a));
      if (!listing && rest.some((a) => !isFlag(a))) return no('git branch with a name creates a branch');
      return ok('git branch (list)');
    }
    case 'remote':
      return rest.length === 0 || (rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')) ? ok('git remote -v') : no(`git remote ${rest.join(' ')}`);
    case 'worktree':
      return rest[0] === 'list' && rest.slice(1).every((a) => ['--porcelain', '-v', '--verbose', '-z'].includes(a)) ? ok('git worktree list') : no(`git worktree ${rest[0] ?? ''}`.trim());
    case 'stash':
      return rest[0] === 'list' && rest.slice(1).every(isFlag) ? ok('git stash list') : no(`git stash ${rest[0] ?? ''}`.trim());
    default:
      return ok(`git ${sub}`);
  }
}

function segmentVerdict(words: string[], state: { cwd: string }): Verdict {
  const [cmd, ...args] = words as [string, ...string[]];
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return no('an environment-variable prefix');
  const secret = args.find((a) => secretArg(state.cwd, a));
  switch (cmd) {
    case 'cd': {
      if (args.length > 1) return no('cd with more than one argument');
      const to = args[0] ?? '~';
      if (secret) return no(`cd into ${secret}`);
      state.cwd = to === '-' ? '' : join(state.cwd, to);
      return ok('cd');
    }
    case 'pwd':
      return args.every((a) => a === '-L' || a === '-P') ? ok('pwd') : no('pwd with arguments');
    case 'ls':
    case 'cat':
    case 'wc':
    case 'head':
      return secret ? no(`${cmd} ${secret} (a secret-looking path)`) : ok(cmd);
    case 'tail':
      if (args.some((a) => a === '-f' || a === '-F' || a.startsWith('--follow') || (/^-[^-]/.test(a) && /[fF]/.test(a.slice(1))))) return no('tail --follow never ends');
      return secret ? no(`tail ${secret} (a secret-looking path)`) : ok('tail');
    case 'grep':
    case 'rg': {
      if (args.some((a) => a.startsWith('--pre'))) return no(`${cmd} --pre runs a command`);
      // The pattern is not a path: the first positional, unless -e/--regexp gave it.
      const paths: string[] = [];
      let patternGiven = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string;
        if (a === '-e' || a === '--regexp') { patternGiven = true; i++; continue; }
        if (a.startsWith('--regexp=') || /^-e./.test(a)) { patternGiven = true; continue; }
        if (isFlag(a)) { if (a.includes('=')) paths.push(a); continue; }
        if (!patternGiven) { patternGiven = true; continue; }
        paths.push(a);
      }
      const bad = paths.find((a) => secretArg(state.cwd, a));
      return bad ? no(`${cmd} in ${bad} (a secret-looking path)`) : ok(cmd);
    }
    case 'find': {
      const act = args.find((a) => FIND_ACTS.includes(a));
      if (act) return no(`find ${act}`);
      return secret ? no(`find ${secret} (a secret-looking path)`) : ok('find');
    }
    case 'git': {
      if (secret) return no(`git ${secret} (a secret-looking path)`);
      return gitSegment(args);
    }
    case 'gh': {
      const [group, sub] = args;
      const subs = group ? GH_READS[group] : undefined;
      if (!subs || !sub || !subs.includes(sub)) return no(`gh ${args.slice(0, 2).join(' ')} is not a view/list command`);
      return ok(`gh ${group} ${sub}`);
    }
    default:
      return no(`\`${cmd}\` is not on the read-only list`);
  }
}

/**
 * Pure. Whether a shell command only reads, for the PA chat's Bash tool:
 * {ok: true} only when every segment is a reading command (see the header).
 */
function readOnlyBash(command: unknown): Verdict {
  if (typeof command !== 'string' || !command.trim()) return no('no command');
  const t = tokenize(command.trim());
  if ('error' in t) return no(t.error);
  const segs = segments(t.tokens);
  if (!segs) return no('an operator with nothing on one side');
  const state = { cwd: '' };
  for (const words of segs) {
    const v = segmentVerdict(words, state);
    if (!v.ok) return v;
  }
  return ok(segs.length === 1 ? 'a read-only command' : `${segs.length} read-only commands`);
}

module.exports = { isSecretPath, insideRoots, readOnlyBash, tokenize };
