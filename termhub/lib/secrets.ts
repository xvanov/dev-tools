'use strict';

// Secrets for the whole stack (plan: Jarvis secrets service). Values live ONLY in
// `pass` (the standard Linux password store: one GPG-encrypted file per secret,
// under ~/.password-store/termhub/). This file holds the spec: names, descriptions,
// what reads each secret, and which agents may ask for it. The spec never holds a value.
//
// Why pass and not the GNOME keyring: the keyring needs a password prompt on a
// screen to unlock, which this headless machine cannot show. pass writes need no
// passphrase at all (only the public key), so the popup can always save. Reading
// needs the GPG passphrase once per boot (gpg-agent caches it).
//
// Rules this module enforces in code:
//   - a value is never returned by `status`, `list`, or `request`; only `getSecret`
//     returns it, for in-process consumers;
//   - a value is never put on a command line (it goes to pass on stdin);
//   - a name must be in the spec before it can be set or requested;
//   - a requester must be on that secret's allow-list.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

type SecretSpec = {
  name: string;
  description: string;
  /** What reads it, e.g. "rental-media: Furnished Finder adapter". */
  destination: string;
  /** Requesters allowed to ask for it, e.g. "claude-cloud", "mission-control", "cli". */
  requesters: string[];
};

type SecretStatus = 'present' | 'missing';

const NAME_RE = /^[A-Z][A-Z0-9_]{1,80}$/;

/** pass keeps every termhub secret under this folder inside the store. */
const PREFIX = 'termhub';

function storeDir(): string {
  return process.env.PASSWORD_STORE_DIR || path.join(os.homedir(), '.password-store');
}

function specPath(): string {
  return process.env.TERMHUB_SECRETS_SPEC || path.join(os.homedir(), '.config', 'termhub', 'secrets.json');
}

/** Pure: is this a legal secret name? */
function validName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Pure: does this requester appear on the spec entry's allow-list? */
function mayRequest(spec: SecretSpec, requester: string): boolean {
  return spec.requesters.includes(requester);
}

/** Read the spec file. A missing file is an empty spec, not an error. */
function readSpec(): SecretSpec[] {
  let text: string;
  try {
    text = fs.readFileSync(specPath(), 'utf8');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('secrets spec must be a JSON array');
  return parsed as SecretSpec[];
}

/** Write the spec file (names and descriptions only, never values). */
function writeSpec(specs: SecretSpec[]): void {
  const file = specPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(specs, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Add or replace one spec entry. Validates the name. */
function upsertSpec(entry: SecretSpec): void {
  if (!validName(entry.name)) throw new Error(`bad secret name: ${entry.name}`);
  const rest = readSpec().filter((s) => s.name !== entry.name);
  rest.push({
    name: entry.name,
    description: entry.description || '',
    destination: entry.destination || '',
    requesters: Array.isArray(entry.requesters) ? entry.requesters : [],
  });
  rest.sort((a, b) => a.name.localeCompare(b.name));
  writeSpec(rest);
}

/** Remove a spec entry. Does not touch the stored value. */
function removeSpec(name: string): void {
  writeSpec(readSpec().filter((s) => s.name !== name));
}

function findSpec(name: string): SecretSpec | undefined {
  return readSpec().find((s) => s.name === name);
}

/** The pass entry for a secret, e.g. termhub/JEV_API_KEY. */
function entryName(name: string): string {
  return `${PREFIX}/${name}`;
}

/** Where pass keeps the encrypted file for a secret. */
function entryFile(name: string): string {
  return path.join(storeDir(), `${entryName(name)}.gpg`);
}

/**
 * Is a value stored for this name? Checks for the encrypted file only, so it never
 * decrypts (and never needs the passphrase). Never returns the value.
 */
function status(name: string): SecretStatus {
  return fs.existsSync(entryFile(name)) ? 'present' : 'missing';
}

/** Store a value. The value travels on stdin only; pass needs no passphrase to write. */
function setSecret(name: string, value: string): void {
  if (!validName(name)) throw new Error(`bad secret name: ${name}`);
  if (!findSpec(name)) throw new Error(`${name} is not in the spec; add it first`);
  if (typeof value !== 'string' || value.length === 0) throw new Error('empty value');
  const r = spawnSync('pass', ['insert', '--multiline', '--force', entryName(name)], {
    input: value.endsWith('\n') ? value : `${value}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: 15000,
  });
  if (r.error) throw new Error(`pass insert did not finish: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`pass insert failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
}

/** Remove a stored value. */
function clearSecret(name: string): void {
  if (!validName(name)) throw new Error(`bad secret name: ${name}`);
  const r = spawnSync('pass', ['rm', '--force', entryName(name)], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 15000,
  });
  if (r.error) throw new Error(`pass rm did not finish: ${r.error.message}`);
}

/**
 * In-process read for a consumer that needs the value (an adapter, a client).
 * Throws if missing. Needs the GPG passphrase once per boot. Callers must not log
 * or return what this gives them.
 */
function getSecret(name: string): string {
  if (status(name) !== 'present') throw new Error(`secret ${name} is not set`);
  const r = spawnSync('pass', ['show', entryName(name)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  if (r.error) throw new Error(`pass show did not finish: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `pass could not decrypt ${name} (exit ${r.status}). If the GPG passphrase is not cached, ` +
      `run "pass show ${entryName(name)}" once in a terminal to unlock it for this boot.`,
    );
  }
  return (r.stdout || '').replace(/\n$/, '');
}

/**
 * What an agent gets back from a request. Never includes the value.
 *   present   -> the secret exists; the agent may use it through getSecret in-process
 *   missing   -> the secret is in the spec but has no value yet; a popup should be opened
 *   denied    -> the name is unknown or the requester is not allowed
 */
function request(name: string, requester: string): { result: 'present' | 'missing' | 'denied'; reason?: string } {
  const spec = findSpec(name);
  if (!spec) return { result: 'denied', reason: 'not in the spec' };
  if (!mayRequest(spec, requester)) return { result: 'denied', reason: `${requester} may not request ${name}` };
  return { result: status(name) };
}

module.exports = {
  validName,
  mayRequest,
  specPath,
  storeDir,
  readSpec,
  writeSpec,
  upsertSpec,
  removeSpec,
  findSpec,
  status,
  setSecret,
  clearSecret,
  getSecret,
  request,
};
