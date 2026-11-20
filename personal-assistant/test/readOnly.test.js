'use strict';

// D33: what the PA chat may run or read without a prompt — the read-only shell
// classifier, the secret-path rule and the read roots (src/policy/readOnly.ts),
// and the gate both engines' PreToolUse hooks share (src/chat/toolGate.ts).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const RO = require('../src/policy/readOnly.ts');
const G = require('../src/chat/toolGate.ts');

test('readOnlyBash: reading commands, alone or chained, run unasked', () => {
  for (const c of [
    'ls',
    'ls -la',
    'pwd',
    'cd C:/Users/me/AppData/Local/personal-assistant/worktrees/run-12 && git log --oneline -10',
    'cd "C:/Users/me/AppData/Local/personal-assistant/worktrees/run 12" && git status',
    'git status --short',
    'git log -5 --format="%h %s" | head -3',
    'git diff HEAD~1 -- src/x.ts',
    'git show HEAD:README.md',
    'git branch',
    'git branch -a -v',
    'git branch --list "feat/*"',
    'git branch --merged main',
    'git branch --show-current',
    'git rev-parse HEAD',
    'git rev-list --count HEAD',
    'git ls-files src',
    'git blame src/x.ts',
    'git remote -v',
    'git remote',
    'git worktree list --porcelain',
    'git stash list',
    'git cherry -v origin/main',
    'git -C ../other log -1',
    'git --no-pager log -1',
    'gh pr view 12',
    'gh pr list --state open',
    'gh pr checks 12',
    'gh pr diff 12',
    'gh run list --branch main --limit 1',
    'gh run view 123 --log-failed',
    'gh run watch 123 --exit-status',
    'gh issue view 4',
    'gh issue list',
    'gh repo view',
    'cat README.md; wc -l src/a.ts',
    'head -20 log.txt',
    'tail -n 50 logs/worker.log',
    'grep -n "needle" src/a.ts',
    'grep -n token src/a.ts',
    'git log -1 | grep -i fix',
    'rg -n -g "*.{ts,tsx}" needle src',
    'rg -n -g "!*.md" needle',
    'rg -l -t ts -A 2 needle src',
    'git branch --contains HEAD',
    'git branch --sort=-committerdate -v',
    'git log --oneline main~3..HEAD',
    'rg -n "token" src',
    'rg -e foo -g "*.ts" src',
    'find . -name "*.json" -maxdepth 2',
    'ls 2>/dev/null',
    'git log -1 2>&1 | head -5',
    'ls || pwd',
  ]) assert.deepStrictEqual(RO.readOnlyBash(c).ok, true, `${c}: ${RO.readOnlyBash(c).reason}`);
});

test('readOnlyBash: anything that writes, expands, redirects or is unknown asks', () => {
  for (const c of [
    '',
    'rm -rf build',
    'ls > out.txt',
    'ls >> out.txt',
    'ls 1>out.txt',
    'ls &>out.txt',
    'git log > log.txt',
    'cat `which node`',
    'cat $(echo .env)',
    'echo hi',
    'ls $HOME',
    'cat "$HOME/x"',
    'diff <(ls a) <(ls b)',
    'cat < input.txt',
    '(cd x && ls)',
    'ls &',
    'ls\nrm x',
    'FOO=1 ls',
    'GIT_PAGER=sh git log',
    'node bin/pa.js brief',
    'pa brief',
    'git push',
    'git commit -m x',
    'git checkout main',
    'git reset --hard',
    'git branch -D old',
    'git branch -d old',
    'git branch -m a b',
    'git branch --delete old',
    'git branch new-branch',
    'git branch -vd old',
    'git remote add x y',
    'git remote remove origin',
    'git worktree add ../x',
    'git worktree remove x',
    'git stash',
    'git stash pop',
    'git -c core.pager=sh log',
    'git log --output=x.txt',
    'git diff --ext-diff',
    'git fetch',
    'gh pr merge 12',
    'gh pr create',
    'gh run rerun 1',
    'gh api repos/x/y',
    'gh repo clone x/y',
    'find . -delete',
    'find . -exec rm {} ;',
    'find . -name x -fprint out',
    'rg --pre cat x src',
    'tail -f log.txt',
    'tail -F log.txt',
    'ls; ',
    '&& ls',
    'ls | | wc',
    'cat .env',
    'cat .env.local',
    'cat config/prod.env',
    'cat ~/.ssh/id_rsa',
    'ls ~/.aws',
    'cat ~/.azure/accessTokens.json',
    'cat ~/.config/gh/hosts.yml',
    'cd ~/.config && cat gh/hosts.yml',
    'cd ~/.ssh && ls',
    'cat ~/.npmrc',
    'cat ~/.git-credentials',
    'cat credentials.json',
    'cat client_secret.json',
    'cat github-token.txt',
    'grep -r password .env',
    'git show HEAD:.env',
    'cat C:/Users/me/AppData/Local/personal-assistant/env.before-jarvisd',
    'cat pa.sqlite',
    'head -c 100 server.key',
    'echo a # comment',
    "cat 'unclosed",
  ]) assert.strictEqual(RO.readOnlyBash(c).ok, false, `${JSON.stringify(c)} must ask`);
});

test('readOnlyBash: shell tricks that would write, run or reach a secret ask (review of D33)', () => {
  for (const c of [
    // The shell expands these into names it picks: `.e*` is .env, `{--output=x,}` a flag.
    'cat .e*',
    'cat .en?',
    'cat .[e]nv',
    'cat .{e,}nv',
    'cat ~/.ss*/config',
    'git log {--output=x,}',
    'find . {-delete,}',
    'ls *.md',
    // A backslash-newline joins `-` and `-output=x` in the shell.
    'git log -\\\n-output=x',
    'find . -\\\ndelete',
    "grep 'a\nb' x",
    // `~-` is $OLDPWD, `~+` $PWD; `cd -` goes back somewhere unknown.
    'cat ~-/config',
    'cat ~+/config',
    'cd - && cat config',
    // Windows drops trailing dots and stream names; short names stand for any long name.
    'cat ~/.ssh./config',
    'cat ~/.kube./config',
    'cat ~/.docker./config.json',
    'cat .env::$DATA',
    'cat ~/SSH~1/config',
    'cat ~/GIT-CR~1',
    'cd ~/DOCKER~1 && cat config.json',
    'git -C ~/SSH~1 log',
    'git diff --no-index a b',
    'git blame --contents x y',
    // More credential files.
    'cat ~/_netrc',
    'cat ~/.claude.json',
    'cat ~/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt',
    'cat ~/.bash_history',
    'cat C:/Users/me/AppData/Local/personal-assistant/backups/pa-20261115.pabak',
    'cat backups/pa-20261108.dump',
    // git branch: any unique prefix of a long option works, and new writers appear.
    'git branch --delete-merged=x',
    'git branch --mov',
    'git branch --edit-description',
    'git branch -u origin/main',
    // grep: a pattern file is read; -e anywhere makes every positional a file; -r reads dot files.
    'grep -f ~/.ssh/id_rsa x',
    'grep -f~/.ssh/id_rsa x',
    'grep ~/.aws/credentials -e key',
    'grep -r token .',
    'grep -rn token src',
    'grep -R token .',
    'grep --recursive token .',
    'grep -d recurse token .',
    // rg: a glob or type overrides the hidden and ignore rules; these run commands or read hidden/binary files.
    'rg -g .env KEY',
    'rg -g "*" KEY',
    'rg -g ".e*" KEY',
    'rg --glob=*.env KEY',
    'rg --iglob .ENV KEY',
    'rg -g "**/.ssh/**" KEY ~',
    'rg --type-add "e:*.env" -te KEY',
    'rg --hidden KEY',
    'rg -uu KEY',
    'rg -. KEY',
    'rg --no-ignore KEY',
    'rg -L KEY',
    'rg -a KEY',
    'rg -z KEY',
    'rg --search-zip KEY',
    'rg --hostname-bin=calc KEY',
    'rg --pre-glob "*" KEY',
    'rg -f ~/.ssh/id_rsa src',
    'rg --ignore-file .env KEY',
  ]) assert.strictEqual(RO.readOnlyBash(c).ok, false, `${JSON.stringify(c)} must ask`);
});

test('readOnlyBash: rg reports the trees it searches, after the line\'s cds', () => {
  assert.deepStrictEqual(RO.readOnlyBash('rg x').searches, ['.']);
  assert.deepStrictEqual(RO.readOnlyBash('rg -n x src lib').searches, ['src', 'lib']);
  assert.deepStrictEqual(RO.readOnlyBash('cd C:/w/run-1 && rg -e x src').searches, ['C:/w/run-1/src']);
  assert.deepStrictEqual(RO.readOnlyBash('cd ~ && rg x').searches, ['~']);
  assert.deepStrictEqual(RO.readOnlyBash('git log | rg x').searches, ['.']);
  assert.deepStrictEqual(RO.readOnlyBash('ls src').searches, []);
});

test('globMaySelectSecret: a glob that may pick a credential out; exclusions and code globs do not', () => {
  for (const g of ['.env', '*', '**', '**/*', '.e*', '*.env', '*.{env,txt}', '**/.ssh/**', 'id_*', '*.pem', '../x/*.ts', '*secret*']) assert.ok(RO.globMaySelectSecret(g), g);
  for (const g of ['', '*.ts', '*.{ts,tsx}', 'src/**/*.js', '!.env', '!**/*', '*.md !*.env']) assert.ok(!RO.globMaySelectSecret(g), g);
});

test('readOnlyBash: every refusal says why', () => {
  assert.match(RO.readOnlyBash('ls > x').reason, /redirection/);
  assert.match(RO.readOnlyBash('rm x').reason, /not on the read-only list/);
  assert.match(RO.readOnlyBash('cat .env').reason, /secret/);
  assert.match(RO.readOnlyBash('FOO=1 ls').reason, /environment-variable/);
});

test('isSecretPath: credentials by name and by directory, any separator or case', () => {
  for (const p of ['.env', 'a/.env', 'a\\.env.production', 'deploy/prod.env', 'C:\\Users\\me\\.ssh\\config', '~/.aws/credentials', '/home/me/.azure/x',
    '~/.config/gh/hosts.yml', 'C:\\Users\\me\\.npmrc', '.git-credentials', 'Credentials.json', 'my_SECRET.txt', 'api-token', 'id_rsa', 'id_ecdsa', 'cert.pem',
    'env.before-sqlite', 'pa.sqlite', 'pa.sqlite-wal']) assert.ok(RO.isSecretPath(p), p);
  for (const p of ['', 'README.md', 'src/env.ts', 'environment.md', 'C:\\repos\\dev-tools\\personal-assistant\\src\\policy\\policy.ts', '~/.config/git/config', 'worktrees/run-1/src/a.ts']) {
    assert.ok(!RO.isSecretPath(p), p);
  }
  assert.ok(RO.isSecretPath('src/secrets'), 'a path named *secret* asks, even a directory');
  assert.ok(RO.isSecretPath('**/.env*'), 'a glob for env files');
});

test('insideRoots: inside one root, case-insensitive; siblings and parents are outside', () => {
  const A = path.resolve('/pa/data');
  const B = path.resolve('/repos');
  assert.ok(RO.insideRoots([A, B], A, 'worktrees/run-1/x.ts'));
  assert.ok(RO.insideRoots([A, B], A, ''), 'no path: the cwd');
  assert.ok(RO.insideRoots([A, B], A, path.join(B, 'dev-tools', 'README.md')));
  assert.ok(RO.insideRoots([A], A, path.join(A.toUpperCase(), 'x')), 'case does not matter');
  assert.ok(!RO.insideRoots([A, B], A, path.resolve('/pa/data-other/x')), 'a sibling with the same prefix');
  assert.ok(!RO.insideRoots([A, B], A, '..'));
  assert.ok(!RO.insideRoots([A, B], A, path.resolve('/etc/passwd')));
});

test('gate: reads inside the read roots run unasked, off secret paths; outside, Claude Code asks', () => {
  const home = path.resolve('/data/pa-home');
  const data = path.resolve('/data');
  const repos = path.resolve('/repos');
  const ctx = { roots: [home, data, repos], cwd: home, dataDir: data };
  const allowRead = { decision: 'allow', rule: 'chat-builtin-reads-allow', tags: [] };
  const d = (name, input) => G.gate(name, input, allowRead, ctx);
  assert.strictEqual(d('Read', { file_path: 'INBOX.md' }).decision, 'allow');
  assert.strictEqual(d('Read', { file_path: path.join(data, 'worktrees', 'run-1', 'src', 'a.ts') }).decision, 'allow', 'an agent worktree');
  assert.strictEqual(d('Read', { file_path: path.join(data, 'build-reports', '12.md') }).decision, 'allow');
  assert.strictEqual(d('Read', { file_path: path.join(repos, 'dev-tools', 'CLAUDE.md') }).decision, 'allow', 'a repo');
  assert.strictEqual(d('Grep', { pattern: 'x', path: path.join(repos, 'dev-tools') }).decision, 'allow');
  assert.strictEqual(d('Glob', { pattern: '**/*.ts', path: path.join(data, 'worktrees') }).decision, 'allow');
  assert.strictEqual(d('Read', { file_path: path.resolve('/Users/me/notes.txt') }), null, 'outside the roots: no opinion, Claude Code asks');
  assert.strictEqual(d('Read', { file_path: path.join(repos, 'dev-tools', '.env') }), null, 'a secret inside a root still asks');
  assert.strictEqual(d('Read', { file_path: path.join(data, 'env.before-jarvisd') }), null);
  assert.strictEqual(d('Read', { file_path: path.join(data, 'pa.sqlite') }), null);
  assert.strictEqual(d('Glob', { pattern: '**/.env*', path: repos }), null, 'a glob that picks secrets out');
  assert.strictEqual(d('Grep', { pattern: 'KEY', glob: '.env', path: repos }), null);
  assert.strictEqual(d('Grep', { pattern: 'KEY', path: data }), null, 'never a content search across the data dir top');
  assert.strictEqual(d('Grep', { pattern: 'KEY' }).decision, 'allow', 'pa-home (the cwd) is below it');
  assert.strictEqual(G.gate('Read', { file_path: 'INBOX.md' }, { decision: 'ask', rule: 'default', tags: [] }, ctx), null, 'no policy allow: no opinion');
});

test('gate: routine actions run on the policy\'s allow; destructive and sensitive ones, and a missing policy, ask', () => {
  const ctx = { roots: [], cwd: '/', dataDir: null };
  const allow = { decision: 'allow', rule: 'chat-actions-allow', tags: [] };
  for (const t of ['session_start', 'build_start', 'build_set_idle', 'build_reply', 'build_send', 'build_stop', 'card_edit', 'card_build_settings', 'card_plan_apply', 'profile_set', 'agent_settings_set']) {
    assert.strictEqual(G.gate(`mcp__pa-chat__${t}`, {}, allow, ctx).decision, 'allow', t);
  }
  for (const t of ['profile_delete', 'profile_reset']) assert.strictEqual(G.gate(`mcp__pa-chat__${t}`, {}, allow, ctx).decision, 'ask', `${t}: even a rule that allows it`);
  assert.strictEqual(G.gate('mcp__pa-chat__build_start', {}, { ...allow, tags: ['merge'] }, ctx).decision, 'ask', 'a merge asks');
  assert.strictEqual(G.gate('mcp__pa-chat__build_start', {}, null, ctx).decision, 'ask', 'no policy: ask');
  assert.strictEqual(G.gate('mcp__pa-chat__build_start', {}, { decision: 'allow', rule: 'default', tags: [] }, ctx).decision, 'ask', 'only an explicit rule allows');
  assert.strictEqual(G.gate('mcp__pa-chat__build_start', {}, { decision: 'deny', rule: 'x', tags: [] }, ctx).decision, 'deny');
  assert.strictEqual(G.gate('Bash', { command: 'ls' }, { decision: 'allow', rule: 'chat-readonly-bash-allow', tags: ['read_only'] }, ctx).decision, 'allow');
  assert.strictEqual(G.gate('Bash', { command: 'rm x' }, { decision: 'ask', rule: 'default', tags: [] }, ctx), null);
  assert.strictEqual(G.gate('ToolSearch', { query: 'select:Artifact' }, { decision: 'allow', rule: 'chat-tool-search-allow', tags: [] }, ctx).decision, 'allow');
});

test('gate: holes found in review of D33 stay shut', () => {
  const home = path.resolve('/data/pa-home');
  const data = path.resolve('/data');
  const repos = path.resolve('/repos');
  const sshDir = path.resolve('/Users/me/.ssh');
  const links = { [path.join(repos, 'keys')]: sshDir, [path.join(repos, 'keys', 'config')]: path.join(sshDir, 'config'), [path.join(repos, 'up')]: path.resolve('/Users/me') };
  const realpath = (p) => {
    const hit = Object.keys(links).find((k) => k.toLowerCase() === path.resolve(p).toLowerCase());
    return hit ? links[hit] : null;
  };
  const ctx = { roots: [home, data, repos], cwd: home, dataDir: data, realpath, homedir: path.resolve('/Users/me') };
  const allowRead = { decision: 'allow', rule: 'chat-builtin-reads-allow', tags: [] };
  const d = (name, input, c = ctx) => G.gate(name, input, allowRead, c);
  // A link or junction inside a root leads to a secret or out of the roots.
  assert.strictEqual(d('Read', { file_path: path.join(repos, 'keys', 'config') }), null, 'a junction to ~/.ssh');
  assert.strictEqual(d('Grep', { pattern: 'x', path: path.join(repos, 'up') }), null, 'a junction out of the roots');
  // Grep's glob overrides rg's hidden and ignore rules.
  assert.strictEqual(d('Grep', { pattern: 'KEY', glob: '*', path: repos }), null);
  assert.strictEqual(d('Grep', { pattern: 'KEY', glob: '.e*', path: repos }), null);
  // An allowed Grep runs with the credential exclusions (it searches dot files).
  const g = d('Grep', { pattern: 'x', glob: '*.ts', path: path.join(repos, 'dev-tools') });
  assert.strictEqual(g.decision, 'allow');
  assert.match(g.updatedInput.glob, /^\*\.ts !\*\*\/\.\[eE\]\[nN\]\[vV\]\*/);
  assert.strictEqual(g.updatedInput.pattern, 'x');
  assert.ok(G.GREP_EXCLUDE_GLOB.split(' ').every((x) => x.startsWith('!**/')), 'exclusions only');
  // Glob stays under its path.
  assert.strictEqual(d('Glob', { pattern: '../../**/*', path: repos }), null);
  assert.strictEqual(d('Glob', { pattern: 'C:/Users/**/*', path: repos }), null);
  // Bash: rg searches stay inside the read roots, never the data dir's top; the shell is not in a secret dir.
  const bash = (command, c = ctx) => G.gate('Bash', { command }, { decision: 'allow', rule: 'chat-readonly-bash-allow', tags: ['read_only'] }, c);
  assert.strictEqual(bash(`rg -n x ${path.join(repos, 'dev-tools').replace(/\\/g, '/')}`).decision, 'allow');
  assert.strictEqual(bash('rg -n x').decision, 'allow', 'the shell in pa-home');
  assert.strictEqual(bash(`rg TOKEN ${data.replace(/\\/g, '/')}`), null, 'the data dir top: env backups, the store');
  assert.strictEqual(bash(`cd ${data.replace(/\\/g, '/')} && rg TOKEN`), null);
  assert.strictEqual(bash('rg TOKEN ~'), null, 'home is not a read root');
  assert.strictEqual(bash('rg TOKEN', { ...ctx, cwd: data }), null, 'a shell left in the data dir');
  assert.strictEqual(bash('cat config', { ...ctx, cwd: sshDir }), null, 'a shell left in ~/.ssh');
  assert.strictEqual(bash('rm x'), null, 'the gate re-checks the command');
  // A sensitive call asks even when an override rule allows its tool.
  assert.strictEqual(G.gate('mcp__pa-chat__pa', { command: 'secret', args: ['reveal', 'x'] }, { decision: 'allow', rule: 'my-override', tags: ['secret_reveal'] }, ctx).decision, 'ask');
});

test('policy: an override cannot make profile_delete/reset or a sensitive call run unasked from the chat', () => {
  const P = require('../src/policy/policy.ts');
  const base = require('../src/policy/default.policy.json');
  const pol = P.merge(base, { rules: [{ id: 'loose', tools: ['*'], decision: 'allow' }] });
  for (const t of ['profile_delete', 'profile_reset']) {
    const res = P.evaluate({ tool: t, channel: 'chat', args: {} }, pol);
    assert.strictEqual(res.decision, 'allow', 'the override does match');
    assert.strictEqual(G.gate(`mcp__pa-chat__${t}`, {}, res, { roots: [], cwd: '/' }).decision, 'ask', t);
  }
  const res = P.evaluate({ tool: 'pa', channel: 'chat', args: { command: 'secret', args: ['reveal', 'x'] } }, pol);
  assert.strictEqual(G.gate('mcp__pa-chat__pa', {}, res, { roots: [], cwd: '/' }).decision, 'ask');
});

test('readRoots: pa-home, the data dir, worktrees, the repos root and local PA_MACHINES roots only', () => {
  const here = path.resolve(__dirname);
  const cfg = { dataDir: path.resolve('/d'), worktreesRoot: path.resolve('/d/worktrees'), reposRoot: path.resolve('/r'), termhub: { machines: { vm: { reposRoot: 'C:\\no-such-dir-on-this-machine' }, local: { reposRoot: here } } } };
  const roots = G.readRoots(path.resolve('/d/pa-home'), cfg);
  assert.deepStrictEqual(roots, [path.resolve('/d/pa-home'), path.resolve('/d'), path.resolve('/d/worktrees'), path.resolve('/r'), here]);
});
