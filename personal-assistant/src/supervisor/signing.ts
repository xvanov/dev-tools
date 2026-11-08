'use strict';

// Signed self-update (docs/native/PLAN.md 7.4): before deploy.js rolls to a
// pulled commit, every commit it pulled must carry a good SSH signature from a
// key in the trusted-signers file. How to turn it on: docs/native/SIGNED-UPDATES.md.
//
// Two modes, because enforcement cannot be switched on by a commit (a commit
// that enables it is itself unverified) and the agents' own commits are not
// signed until someone sets signing up on the machine that makes them:
//
//   enforce   the trusted-signers file exists (or --require-signed /
//             PA_REQUIRE_SIGNED=1): any commit without a good signature from
//             a listed key refuses the deploy.
//   warn      no trusted-signers file and not required: the check says plainly
//             what it found and that signatures are not enforced. The deploy
//             proceeds. This is the default today.
//   (a missing file with --require-signed is a refusal, not a warning.)
//
// The trusted-signers file is outside the working tree on purpose (default
// `<PA data dir>/allowed_signers`, PA_ALLOWED_SIGNERS overrides): a commit
// must not be able to add the key that signs it. It is passed to git with
// `-c gpg.ssh.allowedSignersFile=`, so no git config is edited anywhere.
//
// Node builtins only, like deploy.js: it runs when node_modules is broken.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).


const fs = require('fs');
const os = require('os');
const path = require('path');

// Same places as src/platform: %LOCALAPPDATA% on Windows, XDG data on Linux.
function defaultDataDir({ env = process.env, platform = process.platform, home = os.homedir() }: { env?: Record<string, string | undefined>; platform?: string; home?: string } = {}) {
  if (env.PA_DATA_DIR) return env.PA_DATA_DIR;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'personal-assistant');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'personal-assistant');
}

function allowedSignersPath(env: Record<string, string | undefined> = process.env) {
  return env.PA_ALLOWED_SIGNERS || path.join(defaultDataDir({ env }), 'allowed_signers');
}

/**
 * Pure: the verdict on `git log --format=%H%x09%G?` output.
 * Only 'G' (good signature from an allowed signer) passes.
 * @returns {{ok: boolean, total: number, bad: {commit: string, status: string}[]}}
 */
function judge(logOutput: unknown): { ok: boolean; total: number; bad: { commit: string; status: string }[] } {
  const rows = String(logOutput || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [commit, status] = l.split('\t');
    return { commit: commit ?? '', status: status || '?' };
  });
  const bad = rows.filter((r) => r.status !== 'G');
  return { ok: bad.length === 0, total: rows.length, bad };
}

const STATUS_WORDS: Record<string, string> = {
  N: 'not signed',
  B: 'bad signature',
  U: 'signed, validity unknown',
  X: 'signature expired',
  Y: 'signing key expired',
  R: 'signing key revoked',
  E: 'signature could not be checked (ssh-keygen missing, or the key is not a trusted signer)',
  '?': 'unreadable',
};

/**
 * Decides what the update may do.
 * @param {{range: string, git: (args: string[]) => string, env?: object, say?: (m: string) => void, exists?: (p: string) => boolean, require?: boolean}} o
 *   range: the revision range of pulled commits ("<from>..<head>", or a single commit).
 *   git: runs git in the repo and returns stdout (throws on failure).
 * @returns {{state: 'verified'|'warned'|'refused', mode: 'enforce'|'warn', total: number, message: string, bad?: object[]}}
 */
function verifyPulled({ range, git, env = process.env, say = () => {}, exists = fs.existsSync, require: required = env.PA_REQUIRE_SIGNED === '1' }: { range: string; git: (args: string[]) => string; env?: Record<string, string | undefined>; say?: (line: string) => void; exists?: (p: string) => boolean; require?: boolean }) {
  const file = allowedSignersPath(env);
  const have = exists(file);
  const enforce = have || required;
  if (!have && required) {
    const message = `signed updates are required but the trusted-signers file ${file} does not exist; see docs/native/SIGNED-UPDATES.md`;
    say(message);
    return { state: 'refused', mode: 'enforce', total: 0, message };
  }
  let out;
  try {
    const args = have ? ['-c', `gpg.ssh.allowedSignersFile=${file}`] : [];
    out = git([...args, 'log', '--format=%H%x09%G?', range]);
  } catch (err) {
    const message = `could not check commit signatures (${String((err as Error).message).split('\n')[0]})`;
    if (enforce) {
      say(`${message}: refusing the update`);
      return { state: 'refused', mode: 'enforce', total: 0, message };
    }
    say(`WARNING: ${message}; signatures are not enforced yet (docs/native/SIGNED-UPDATES.md)`);
    return { state: 'warned', mode: 'warn', total: 0, message };
  }
  const j = judge(out);
  if (j.ok) {
    const message = `${j.total} commit(s) pulled, all signed by a trusted key`;
    say(message);
    return { state: 'verified', mode: enforce ? 'enforce' : 'warn', total: j.total, message };
  }
  const list = j.bad.slice(0, 5).map((b) => `${b.commit.slice(0, 7)} ${STATUS_WORDS[b.status] || b.status}`).join('; ');
  const message = `${j.bad.length} of ${j.total} pulled commit(s) are not signed by a trusted key: ${list}`;
  if (enforce) {
    say(`${message}: refusing the update`);
    return { state: 'refused', mode: 'enforce', total: j.total, bad: j.bad, message };
  }
  say(`WARNING: ${message}. Signatures are not enforced yet: create ${file} to turn it on (docs/native/SIGNED-UPDATES.md)`);
  return { state: 'warned', mode: 'warn', total: j.total, bad: j.bad, message };
}

module.exports = { allowedSignersPath, defaultDataDir, judge, verifyPulled, STATUS_WORDS };
