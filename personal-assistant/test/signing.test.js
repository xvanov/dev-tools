'use strict';

// Signed self-update (src/supervisor/signing.js): the verdicts, and the real
// thing against a throwaway repo with real SSH-signed commits when ssh-keygen
// is here. Nothing touches any git config but this temp repo's.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { judge, verifyPulled, allowedSignersPath } = require('../src/supervisor/signing');

// ---- pure ----
{
  assert.deepStrictEqual(judge('a\tG\nb\tG\n'), { ok: true, total: 2, bad: [] });
  const j = judge('a\tG\nb\tN\nc\tE\n');
  assert.strictEqual(j.ok, false);
  assert.deepStrictEqual(j.bad.map((b) => b.status), ['N', 'E']);
  assert.strictEqual(judge('').ok, true, 'nothing pulled, nothing unsigned');

  const say = [];
  const env = { PA_ALLOWED_SIGNERS: '/nope/allowed_signers' };
  const unsigned = () => 'aaaaaaaaaaaa\tN\n';
  // No trusted-signers file: warn, do not block.
  let r = verifyPulled({ range: 'x..y', git: unsigned, env, say: (m) => say.push(m), exists: () => false });
  assert.strictEqual(r.state, 'warned');
  assert.strictEqual(r.mode, 'warn');
  assert.ok(say.some((m) => /WARNING/.test(m) && /not enforced/.test(m)));
  // ...unless required.
  r = verifyPulled({ range: 'x..y', git: unsigned, env, exists: () => false, require: true });
  assert.strictEqual(r.state, 'refused');
  // With the file: enforced, and passed to git as a -c, never as a config edit.
  let seen;
  r = verifyPulled({ range: 'x..y', git: (a) => { seen = a; return unsigned(); }, env, exists: () => true });
  assert.strictEqual(r.state, 'refused');
  assert.deepStrictEqual(seen.slice(0, 2), ['-c', 'gpg.ssh.allowedSignersFile=/nope/allowed_signers']);
  r = verifyPulled({ range: 'x..y', git: () => 'aaaaaaaaaaaa\tG\n', env, exists: () => true });
  assert.strictEqual(r.state, 'verified');
  // git failing: refuse when enforcing, warn otherwise.
  const boom = () => { throw new Error('ssh-keygen: not found'); };
  assert.strictEqual(verifyPulled({ range: 'x..y', git: boom, env, exists: () => true }).state, 'refused');
  assert.strictEqual(verifyPulled({ range: 'x..y', git: boom, env, exists: () => false }).state, 'warned');
  assert.ok(allowedSignersPath({ PA_DATA_DIR: path.join('d', 'x') }).endsWith('allowed_signers'));
}

// ---- real SSH signatures ----
const keygen = spawnSync('ssh-keygen', ['-V'], { encoding: 'utf8' });
if (keygen.error) {
  console.log('signing ok (pure part; ssh-keygen not available for the real-signature part)');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sign-'));
try {
  const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const keygenTo = (name) => {
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'tester', '-f', path.join(dir, name)]);
    return path.join(dir, name);
  };
  const trusted = keygenTo('trusted');
  const other = keygenTo('other');
  const pub = fs.readFileSync(`${trusted}.pub`, 'utf8').trim();
  const allowed = path.join(dir, 'allowed_signers');
  fs.writeFileSync(allowed, `tester@example.com namespaces="git" ${pub}\n`);

  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => run('git', ['-c', 'user.name=t', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', ...a], repo);
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'f'), '0');
  git('add', 'f');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  const commit = (n, key) => {
    fs.writeFileSync(path.join(repo, 'f'), String(n));
    git('add', 'f');
    git(...(key ? ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}.pub`, 'commit', '-q', '-S', '-m', `c${n}`] : ['commit', '-q', '-m', `c${n}`]));
  };
  const env = { PA_ALLOWED_SIGNERS: allowed };
  const check = () => verifyPulled({ range: `${base}..HEAD`, git: (a) => git(...a), env });

  commit(1, trusted);
  assert.strictEqual(check().state, 'verified', 'a commit signed by a trusted key passes');
  commit(2, null);
  let r = check();
  assert.strictEqual(r.state, 'refused', 'one unsigned commit in the range refuses it');
  assert.strictEqual(r.bad.length, 1);
  git('reset', '-q', '--hard', 'HEAD~1');
  commit(3, other);
  assert.strictEqual(check().state, 'refused', 'a valid signature from a key that is not trusted refuses');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('signing ok');
