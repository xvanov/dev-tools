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
    'grep -rn "needle" src',
    'grep -rn token src',
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

test('readRoots: pa-home, the data dir, worktrees, the repos root and local PA_MACHINES roots only', () => {
  const here = path.resolve(__dirname);
  const cfg = { dataDir: path.resolve('/d'), worktreesRoot: path.resolve('/d/worktrees'), reposRoot: path.resolve('/r'), termhub: { machines: { vm: { reposRoot: 'C:\\no-such-dir-on-this-machine' }, local: { reposRoot: here } } } };
  const roots = G.readRoots(path.resolve('/d/pa-home'), cfg);
  assert.deepStrictEqual(roots, [path.resolve('/d/pa-home'), path.resolve('/d'), path.resolve('/d/worktrees'), path.resolve('/r'), here]);
});
