'use strict';

// Secret and login requests: how the assistant asks for a credential without
// ever holding one in a model's context.
//
// The flow, and the one invariant it exists for:
//
//   code that needs a token  →  requestSecret()  →  a row + a toast
//   the human, in the dashboard (or `pa secret set`)  →  store()
//   store()  →  Windows Credential Manager (or the gitignored .env)
//   the code that needs it  →  config.secret(name)
//
// **Secret values flow browser → store.** No model, log line, API response
// or MCP result ever contains one. store() returns where the value went,
// never the value; there is no "show" anywhere; an agent can ask for a
// secret (request_secret) and learn whether one is configured
// (secret_status), and that is all.
//
// A login request is the same row with kind 'login': something only the
// human can do (re-authenticate a connector in /mcp, widen a `gh` scope),
// shown with its command and a Done button.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cfg = require('../config');
const db = require('../db');
const vault = require('./vault');
const { logger } = require('../log');

const log = logger('secrets');

const TARGETS = ['credential-manager', 'env-file'];
const ENV_FILE = path.join(cfg.config.toolDir, '.env');

// Secrets this tool knows how to use, listed by `pa secret list` even when
// nothing has asked for them yet.
const KNOWN = ['PA_JIRA_API_TOKEN'];

function checkName(name) {
  if (!vault.NAME_RE.test(String(name || ''))) {
    throw Object.assign(new Error('secret names are UPPER_SNAKE_CASE, e.g. PA_JIRA_API_TOKEN'), { status: 400 });
  }
  return name;
}

// ------------------------------------------------------------- .env file --

// True only when git says the file is ignored. Anything else — not a repo,
// git missing, the rule removed — is a refusal: a token written to a tracked
// file is one `git add -A` from being pushed.
function isGitIgnored(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', path.basename(file)], {
      cwd: path.dirname(file),
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function quoteEnv(value) {
  if (/[\r\n]/.test(value)) throw Object.assign(new Error('a value with a line break cannot go in .env'), { status: 400 });
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

// Replaces `NAME=` in place, or appends it. Other lines, comments and order
// are kept; the file is written whole, then renamed over the old one.
function writeEnvFile(name, value, { file = ENV_FILE, ignored = isGitIgnored } = {}) {
  checkName(name);
  if (!ignored(file)) {
    throw Object.assign(new Error(`refusing to write ${path.basename(file)}: git does not ignore it`), { status: 409 });
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {}
  const line = `${name}=${quoteEnv(value)}`;
  const lines = text ? text.split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const at = lines.findIndex((l) => l.replace(/^\s*(export\s+)?/, '').startsWith(`${name}=`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function removeFromEnvFile(name, { file = ENV_FILE } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((l) => !l.replace(/^\s*(export\s+)?/, '').startsWith(`${name}=`));
  if (kept.length === lines.length) return false;
  fs.writeFileSync(file, kept.join('\n'));
  return true;
}

// ---------------------------------------------------------------- storing --

/**
 * Puts a value where it belongs and forgets it. Returns where it went —
 * never the value.
 *
 * @returns {{ok: true, stored: string, name: string}}
 */
function storeValue(name, value, { target = 'credential-manager' } = {}) {
  checkName(name);
  if (!TARGETS.includes(target)) throw Object.assign(new Error(`unknown target "${target}"`), { status: 400 });
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error('empty value — nothing stored'), { status: 400 });
  const clean = value.trim();
  if (target === 'credential-manager') vault.set(name, clean);
  else writeEnvFile(name, clean);
  cfg.forgetSecret(name);
  log.info('stored', { name, target });
  return { ok: true, stored: target, name };
}

async function markFulfilled(name, target, requestedBy) {
  const done = await db.rows(
    `update secret_request set status = 'fulfilled', fulfilled_at = now(), stored_in = $2
      where name = $1 and status = 'pending' returning id`,
    [name, target]
  );
  // A value set with no request open still gets a row, so `pa secret list`
  // can say when it was set.
  if (!done.length) {
    await db.query(
      `insert into secret_request (kind, name, purpose, requested_by, target, status, fulfilled_at, stored_in)
       values ('secret', $1, 'set directly', $2, $3, 'fulfilled', now(), $3)`,
      [name, requestedBy, target]
    );
  }
}

// `pa secret set`: no request needed.
async function store(name, value, { target = 'credential-manager', by = 'cli' } = {}) {
  const r = storeValue(name, value, { target });
  await markFulfilled(name, target, by);
  return r;
}

// The dashboard's Save: answers request `id` with a value.
async function fulfil(id, value, { target } = {}) {
  const req = await db.one('select * from secret_request where id = $1', [id]);
  if (!req) throw Object.assign(new Error(`no request #${id}`), { status: 404 });
  if (req.kind !== 'secret') throw Object.assign(new Error(`request #${id} is a login, not a value`), { status: 400 });
  if (req.status !== 'pending') throw Object.assign(new Error(`request #${id} is already ${req.status}`), { status: 409 });
  const where = target || req.target;
  const r = storeValue(req.name, value, { target: where });
  await markFulfilled(req.name, where, req.requested_by);
  return r;
}

async function setStatus(id, status) {
  if (!['declined', 'fulfilled'].includes(status)) throw Object.assign(new Error('bad status'), { status: 400 });
  const row = await db.one(
    `update secret_request set status = $2, fulfilled_at = case when $2 = 'fulfilled' then now() end
      where id = $1 and status = 'pending' returning id, name, status`,
    [id, status]
  );
  if (!row) throw Object.assign(new Error(`request #${id} is not pending`), { status: 409 });
  return row;
}

// Declining a secret; a login is marked done with the same call.
const decline = (id) => setStatus(id, 'declined');
async function loginDone(id) {
  const req = await db.one('select kind from secret_request where id = $1', [id]);
  if (!req || req.kind !== 'login') throw Object.assign(new Error(`request #${id} is not a login`), { status: 400 });
  return setStatus(id, 'fulfilled');
}

async function remove(name) {
  checkName(name);
  const fromVault = vault.available() ? vault.remove(name) : false;
  const fromFile = removeFromEnvFile(name);
  cfg.forgetSecret(name);
  return { name, removed: fromVault || fromFile, from: [fromVault && 'credential-manager', fromFile && 'env-file'].filter(Boolean) };
}

// --------------------------------------------------------------- requests --

/**
 * Asks the human for a secret. Idempotent: a second ask for the same name
 * while one is pending returns the first. Nothing is asked when the secret
 * is already configured.
 *
 * @returns {Promise<{id: number|null, name: string, status: string}>}
 */
async function requestSecret({ name, purpose, hint = null, url = null, requestedBy = 'agent', target = 'credential-manager' }) {
  checkName(name);
  if (!purpose) throw Object.assign(new Error('a request needs a purpose the user can read'), { status: 400 });
  if (cfg.secretSource(name)) return { id: null, name, status: 'configured' };
  return openRequest({ kind: 'secret', name, purpose, hint, url, requestedBy, target });
}

/**
 * Asks the human to do something only they can: sign in, re-authenticate a
 * connector, widen a scope. `key` dedupes (e.g. 'login:github-projects').
 */
async function requestLogin({ key, purpose, hint = null, url = null, command = null, requestedBy = 'doctor' }) {
  if (!/^login:[a-z0-9-]+$/.test(String(key || ''))) throw new Error('login keys look like login:atlassian');
  return openRequest({ kind: 'login', name: key, purpose, hint, url, command, requestedBy, target: 'action' });
}

// A check that passes again closes its login request.
async function resolveLogin(key) {
  await db.query(
    `update secret_request set status = 'fulfilled', fulfilled_at = now() where name = $1 and status = 'pending'`,
    [key]
  );
}

function safeUrl(url) {
  return url && /^https:\/\//i.test(String(url)) ? String(url).slice(0, 500) : null;
}

async function openRequest({ kind, name, purpose, hint, url, command = null, requestedBy, target }) {
  const existing = await db.one(`select * from secret_request where name = $1 and status = 'pending'`, [name]);
  if (existing) return { id: Number(existing.id), name, status: 'pending', existing: true };
  const row = await db.one(
    `insert into secret_request (kind, name, purpose, hint, url, command, requested_by, target)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (name) where status = 'pending' do nothing
     returning *`,
    [kind, name, String(purpose).slice(0, 500), hint ? String(hint).slice(0, 500) : null, safeUrl(url),
      command ? String(command).slice(0, 300) : null, String(requestedBy || 'agent').slice(0, 60), target]
  );
  if (!row) {
    const again = await db.one(`select id from secret_request where name = $1 and status = 'pending'`, [name]);
    return { id: again ? Number(again.id) : null, name, status: 'pending', existing: true };
  }
  log.info('requested', { id: row.id, kind, name });
  try {
    const { notify, dashboardUrl } = require('../notify');
    await notify({
      kind: 'secret_request',
      title: kind === 'login' ? `Sign-in needed: ${purpose}` : `Secret needed: ${name}`,
      body: kind === 'login' ? hint || command || '' : `${purpose}\nPaste it in the dashboard; it goes to ${target === 'env-file' ? '.env' : 'Windows Credential Manager'}.`,
      url: dashboardUrl(`secret-${row.id}`),
      dedupeKey: `secret_request:${row.id}`,
      // Something is blocked until you answer it.
      priority: 'urgent',
    });
  } catch (err) {
    // The row is the request; the toast is a courtesy.
    log.warn('notify failed', { id: row.id, message: err.message });
  }
  return { id: Number(row.id), name, status: 'pending' };
}

// Pending requests, for the dashboard. A secret that became configured some
// other way (exported, set in another shell) stops being asked for.
async function pending() {
  const list = await db.rows(`select * from secret_request where status = 'pending' order by created_at`);
  const open = [];
  for (const r of list) {
    if (r.kind === 'secret' && cfg.secretSource(r.name)) {
      await db.query(`update secret_request set status = 'expired', fulfilled_at = now() where id = $1`, [r.id]);
      continue;
    }
    open.push(publicRow(r));
  }
  return open;
}

// The only shape a request leaves this module in. There is no value to leak
// — the table has none — but the allow-list keeps it that way if a column is
// ever added.
function publicRow(r) {
  return {
    id: Number(r.id),
    kind: r.kind,
    name: r.name,
    purpose: r.purpose,
    hint: r.hint,
    url: r.url,
    command: r.command,
    requested_by: r.requested_by,
    target: r.target,
    status: r.status,
    created_at: r.created_at,
    fulfilled_at: r.fulfilled_at,
  };
}

// Names, where each comes from, and when it was last set here. Never values.
async function list() {
  let vaultNames = [];
  let vaultError = null;
  if (vault.available()) {
    try {
      vaultNames = vault.list();
    } catch (err) {
      vaultError = err.message;
    }
  }
  const history = await db
    .rows(
      `select distinct on (name) name, fulfilled_at, stored_in from secret_request
        where kind = 'secret' and fulfilled_at is not null and stored_in is not null
        order by name, fulfilled_at desc`
    )
    .catch(() => []);
  const setAt = new Map(history.map((h) => [h.name, h.fulfilled_at]));
  const names = [...new Set([...KNOWN, ...vaultNames, ...history.map((h) => h.name)])].sort();
  const secrets = names.map((name) => ({
    name,
    source: vaultNames.includes(name) && !process.env[name] ? 'credential-manager' : cfg.secretSource(name),
    set_at: setAt.get(name) || null,
  }));
  const open = await pending().catch(() => []);
  return { secrets, pending: open, vaultError };
}

// The status an agent may learn: whether it is there, not what it is.
function status(name) {
  checkName(name);
  const source = cfg.secretSource(name);
  return { name, configured: Boolean(source), source };
}

module.exports = {
  requestSecret,
  requestLogin,
  resolveLogin,
  store,
  storeValue,
  fulfil,
  decline,
  loginDone,
  remove,
  pending,
  list,
  status,
  publicRow,
  writeEnvFile,
  isGitIgnored,
  TARGETS,
  KNOWN,
};
