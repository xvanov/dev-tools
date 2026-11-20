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
// subshells, an env-var prefix, a line break, an unquoted glob or brace (the
// shell picks the names: `.e*` is .env, `{--output=x,}` a flag), `~-`/`~+`,
// an unknown command, a secret-looking path or an 8.3 short name — is not
// read-only, and the chat asks as before. `2>/dev/null` and `2>&1` are
// accepted: they write nothing. Flags are allow-listed where a tool accepts
// abbreviations (git branch); grep -r and rg's hidden/ignore/glob overrides
// ask, since they would read .env and keys inside a tree. The trees an rg
// searches are returned for the hook to keep inside the read roots.
//
// The `pa` CLI is not on it: the chat reads through the `pa` MCP tool (argv,
// no shell, PA_READ_ONLY for `runs`), and a `pa` shell command keeps asking.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const nodePath: typeof import('node:path') = require('path');

interface Verdict {
  ok: boolean;
  reason: string;
  // The trees an `rg` searches (posix-joined after the line's `cd`s; '.' is the shell's cwd): the chat's hook
  // keeps them inside the read roots, as for the Grep tool (src/chat/toolGate.ts).
  searches?: string[];
}
interface ShellState { cwd: string; searches: string[] }

const SECRET_DIRS = ['.ssh', '.aws', '.azure', '.gnupg', '.docker', '.kube'];
const SECRET_NAMES = ['.npmrc', '.git-credentials', '.netrc', '_netrc', '.pgpass', '.pypirc', '.claude.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
// .env / .env.local / .envrc / a `.env*` glob / prod.env; the PA's own env backups (env.before-*); its store (the vault's rows
// live there) and the store's backups (.dump/.pabak/.sealed); shell histories (tokens typed on a command line); key stores.
const SECRET_NAME_RE = /^\.env|\.env$|^env\.before-|credential|secret|token|_history|\.(pem|key|pfx|p12|kdbx|ppk|jks|keystore|tfstate|dump|pabak|sealed)$|\.sqlite(-wal|-shm|-journal)?$/i;

/**
 * One path segment as Windows opens it: an NTFS stream suffix (`x::$DATA`,
 * `x:stream`) and trailing dots and spaces (`.ssh.`) are dropped, so they
 * cannot hide a name.
 */
function winSegment(seg: string, i: number): string {
  const s = i === 0 && /^[a-z]:$/.test(seg) ? seg : seg.replace(/:.*$/, '');
  return s.replace(/[. ]+$/, '') || s;
}

/** Pure. Whether a path (any form: relative, `~`, backslashes, a glob) looks like a credential. */
function isSecretPath(p: unknown): boolean {
  const s = String(p ?? '').replace(/\\/g, '/').toLowerCase();
  if (!s) return false;
  const parts = s.split('/').filter((x) => x && x !== '.').map(winSegment);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] as string;
    if (SECRET_DIRS.includes(seg)) return true;
    if (seg === '.config' && parts[i + 1] === 'gh') return true;
  }
  const base = parts[parts.length - 1] ?? '';
  return SECRET_NAMES.includes(base) || SECRET_NAME_RE.test(base);
}

// Names a file-selecting glob is tried on: a glob that picks any of them out may pick a credential.
const SECRET_SAMPLES = ['.env', '.env.local', '.envrc', 'prod.env', 'env.before-x', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc', '_netrc', '.git-credentials',
  'credentials', 'credentials.json', 'secrets.json', 'token.txt', 'x.pem', 'x.key', 'x.pfx', 'x.p12', 'pa.sqlite', 'x.pabak', 'x.dump', '.bash_history', '.claude.json'];

/**
 * Pure. Whether a file-selecting glob (rg/Grep `glob`, Glob's `pattern`) may
 * pick a secret out: its last part, as a glob, matches a credential's name, or
 * the glob names a secret directory or steps up with `..`. An exclusion (`!…`)
 * never does. rg's globs override its hidden and ignore rules, so `*` alone
 * would reach `.env`.
 */
function globMaySelectSecret(g: unknown): boolean {
  const s = String(g ?? '').trim();
  if (!s) return false;
  return s.split(/\s+/).filter(Boolean).some((one) => {
    if (one.startsWith('!')) return false;
    if (isSecretPath(one) || /(^|[\\/])\.\.([\\/]|$)/.test(one)) return true;
    const last = one.replace(/\\/g, '/').split('/').pop() || '';
    let re = '';
    for (let i = 0; i < last.length; i++) {
      const c = last[i] as string;
      if (c === '*') re += '.*';
      else if (c === '?') re += '.';
      else if (c === '[') {
        const j = last.indexOf(']', i + 1);
        if (j < 0) return true;
        re += `[${last.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = j;
      } else if (c === '{') re += '(';
      else if (c === '}') re += ')';
      else if (c === ',') re += '|';
      else re += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
    let rx: RegExp;
    try {
      rx = new RegExp(`^(?:${re})$`, 'i');
    } catch {
      return true;
    }
    return SECRET_SAMPLES.some((n) => rx.test(n));
  });
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
    } else if ('*?[]{}'.includes(c)) {
      // The shell expands these into names it picks (`.e*`, `.{e,}nv`, `{--output=x,}`): unknowable here.
      return { error: `an unquoted \`${c}\` (a glob or brace expansion)` };
    } else if (c === '~' && word === null && !/^~(?=$|[/\s;&|])/.test(s.slice(i))) {
      return { error: 'a `~+`, `~-` or `~user` expansion' };
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

// An 8.3 short name (SSH~1, GIT-CR~1) can stand for any long name, so a path with one cannot be judged by name.
// Not for git, whose `HEAD~1` is a revision (git's file operands that leave the repo, --no-index, are refused).
const shortName = (p: string): boolean => /(^|[\\/])[^\\/~]+~\d/.test(p);

function secretArg(cwd: string, a: string, git = false): boolean {
  const value = isFlag(a) && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
  if (isFlag(value)) return false;
  if (!git && shortName(value)) return true;
  // git's <rev>:<path> reads a file out of history.
  const tail = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : '';
  return isSecretPath(join(cwd, value)) || isSecretPath(value) || (tail !== '' && isSecretPath(tail));
}

const ok = (reason: string): Verdict => ({ ok: true, reason });
const no = (reason: string): Verdict => ({ ok: false, reason });

const GIT_READS = ['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'rev-list', 'ls-files', 'blame', 'remote', 'worktree', 'stash', 'cherry'];
// git branch's listing flags, the only ones allowed: git accepts any unique prefix of a long option (`--mov`
// for --move) and grows new writers (--delete-merged), so a deny list cannot keep up. Short: -a -r -v -q -l -i.
const BRANCH_LIST_LONG = ['--list', '--all', '--remotes', '--verbose', '--quiet', '--show-current', '--ignore-case', '--omit-empty',
  '--color', '--no-color', '--column', '--no-column', '--abbrev', '--no-abbrev', '--format', '--sort', '--contains', '--no-contains',
  '--merged', '--no-merged', '--points-at', '--forked'];
// Those that take a value as the next word (`--contains HEAD`).
const BRANCH_VALUE_LONG = ['--format', '--sort', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--forked'];
const BRANCH_LIST_FLAGS = ['--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--forked'];
const GH_READS: Record<string, string[]> = { pr: ['view', 'list', 'checks', 'diff'], run: ['list', 'view', 'watch'], issue: ['view', 'list'], repo: ['view'] };
const FIND_ACTS = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'];

function gitSegment(args: string[]): Verdict {
  let i = 0;
  // Global options that only point somewhere or page nothing; `-c` (config) can run commands.
  while (i < args.length && isFlag(args[i] as string)) {
    const a = args[i] as string;
    if (a === '-C') {
      if (shortName(args[i + 1] ?? '')) return no(`git -C ${args[i + 1]} (a short name)`);
      i += 2;
    }
    else if (/^--(git-dir|work-tree)=/.test(a) && shortName(a.slice(a.indexOf('=') + 1))) return no(`git ${a} (a short name)`);
    else if (a === '--no-pager' || a === '-P' || a.startsWith('--git-dir=') || a.startsWith('--work-tree=') || a === '--no-optional-locks') i += 1;
    else return no(`git ${a} before the sub-command`);
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub || !GIT_READS.includes(sub)) return no(`git ${sub ?? ''} is not a reading sub-command`.trim());
  if (rest.some((a) => /^--output(=|$)|^--ext-diff$/.test(a))) return no(`git ${sub} writing a file or running a diff tool`);
  // Files outside the repository, named any way: --no-index compares two, blame --contents reads one.
  const outside = rest.find((a) => /^--(no-index|contents)(=|$)/.test(a));
  if (outside) return no(`git ${sub} ${outside} reads files outside the repository`);
  switch (sub) {
    case 'branch': {
      const names: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k] as string;
        if (a.startsWith('--')) {
          const flag = a.split('=')[0] as string;
          if (!BRANCH_LIST_LONG.includes(flag)) return no(`git branch ${a}`);
          if (BRANCH_VALUE_LONG.includes(flag) && !a.includes('=')) k++;
        } else if (isFlag(a)) {
          if (!/^-[arvqli]+$/.test(a)) return no(`git branch ${a}`);
        } else names.push(a);
      }
      const listing = rest.some((a) => BRANCH_LIST_FLAGS.includes(a.split('=')[0] as string) || /^-[^-]*l/.test(a));
      if (!listing && names.length) return no('git branch with a name creates a branch');
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

function segmentVerdict(words: string[], state: ShellState): Verdict {
  const [cmd, ...args] = words as [string, ...string[]];
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return no('an environment-variable prefix');
  const secret = args.find((a) => secretArg(state.cwd, a, cmd === 'git'));
  switch (cmd) {
    case 'cd': {
      if (args.length > 1) return no('cd with more than one argument');
      const to = args[0] ?? '~';
      if (secret) return no(`cd into ${secret}`);
      // `cd -` goes wherever the shell was before: unknown here.
      if (to === '-' || isFlag(to)) return no(`cd ${to}`);
      state.cwd = join(state.cwd, to);
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
      const searched: string[] = [];
      if (args.some((a) => /^--(pre|hostname-bin)/.test(a))) return no(`${cmd} ${args.find((a) => /^--(pre|hostname-bin)/.test(a))} runs a command`);
      if (cmd === 'grep') {
        // grep -r reads every file under a directory, dot files and ignored ones included (.env): rg skips those.
        const rec = args.find((a) => /^--(recursive|dereference-recursive|directories)/.test(a) || (/^-[^-]/.test(a) && !/^-[ef]/.test(a) && /[rRd]/.test(a.slice(1))));
        if (rec) return no(`grep ${rec} searches a whole tree (use rg)`);
      } else {
        // rg skips dot files and git-ignored ones (.env, keys) and binary files: only while these stay off.
        const loose = args.find((a) => /^--(hidden|no-ignore|unrestricted|follow|text|binary|search-zip|type-add)/.test(a) || (/^-[^-]/.test(a) && !/^-[efgtTrE]/.test(a) && /[u.Laz]/.test(a.slice(1))));
        if (loose) return no(`rg ${loose} searches hidden, ignored or binary files`);
      }
      // The pattern is not a path: the first positional, unless -e/--regexp or -f/--file gave it (anywhere on the line).
      const patternFlag = args.some((a) => /^-[ef]|^--(regexp|file)(=|$)/.test(a));
      const valueFlag = cmd === 'rg' ? /^(-[ABCmMjdEtTr]|--(max-count|max-columns|max-depth|threads|encoding|type|type-not|replace|sort|sortr|colors|context|after-context|before-context|max-filesize|path-separator|ignore-file|context-separator|field-match-separator|field-context-separator))$/ : /^(-[ABCmD]|--(max-count|context|after-context|before-context|label|color|colour|binary-files|devices|exclude|include|exclude-dir|exclude-from))$/;
      const paths: string[] = [];
      let patternGiven = patternFlag;
      for (let i = 0; i < args.length; i++) {
        const a = args[i] as string;
        if (a === '-e' || a === '--regexp') { i++; continue; }
        if (a === '-f' || a === '--file' || a === '--ignore-file') { paths.push(args[i + 1] ?? ''); i++; continue; }
        if (/^-f./.test(a)) { paths.push(a.slice(2)); continue; }
        // A glob overrides rg's hidden and ignore rules: `-g .env`, even `-g *`, reaches the secrets.
        if (cmd === 'rg' && /^(-g|--i?glob)$/.test(a)) {
          if (globMaySelectSecret(args[i + 1])) return no(`rg ${a} ${args[i + 1] ?? ''} may pick a secret file`);
          i++;
          continue;
        }
        if (cmd === 'rg' && (/^-g./.test(a) || /^--i?glob=/.test(a))) {
          const g = a.startsWith('-g') ? a.slice(2) : a.slice(a.indexOf('=') + 1);
          if (globMaySelectSecret(g)) return no(`rg ${a} may pick a secret file`);
          continue;
        }
        if (a.startsWith('--regexp=') || /^-e./.test(a)) continue;
        if (valueFlag.test(a)) { i++; continue; }
        if (isFlag(a)) { if (a.includes('=')) paths.push(a); continue; }
        if (!patternGiven) { patternGiven = true; continue; }
        paths.push(a);
        if (cmd === 'rg') searched.push(join(state.cwd, a));
      }
      if (cmd === 'rg' && !searched.length) searched.push(state.cwd || '.');
      state.searches.push(...searched);
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
  // Any line break, quoted or after a backslash (a continuation that joins `-\<newline>-output`), is more than one line.
  if (/[\r\n]/.test(command.trim())) return no('more than one line');
  const t = tokenize(command.trim());
  if ('error' in t) return no(t.error);
  const segs = segments(t.tokens);
  if (!segs) return no('an operator with nothing on one side');
  const state: ShellState = { cwd: '', searches: [] };
  for (const words of segs) {
    const v = segmentVerdict(words, state);
    if (!v.ok) return v;
  }
  return { ...ok(segs.length === 1 ? 'a read-only command' : `${segs.length} read-only commands`), searches: state.searches };
}

module.exports = { isSecretPath, insideRoots, readOnlyBash, tokenize, globMaySelectSecret };
