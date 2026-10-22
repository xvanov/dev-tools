'use strict';

// Windows Credential Manager, through WinRT's PasswordVault.
//
// The vault is DPAPI-protected and per user: what lands here is readable by
// this Windows account and nobody else, and never touches the repo or
// Postgres. Entries are "web credentials" under one resource name, so they
// show up together in Control Panel → Credential Manager, where you can
// inspect or delete them by hand.
//
// No native npm dependency: each call is one Windows PowerShell process
// running a fixed script. **The secret travels on stdin, never in argv** —
// a process's command line is readable by every other process on the machine
// (Task Manager shows it), stdin is not. The script itself is constant and
// carries no data; the request (op, name, value) is a base64 JSON line on
// stdin, so no character in a value can break out of anything.
//
// This module must not require config.js: config's `secret()` resolver
// requires it.

const { spawnSync } = require('child_process');

const RESOURCE = 'personal-assistant';
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

// Reads one base64 JSON request from stdin, answers one JSON line on stdout.
// A missing entry is {ok:true, found:false}, not an error: PasswordVault
// throws "Element not found" for both "no such credential" and "empty vault".
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Answer($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
try {
  $line = [Console]::In.ReadLine()
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $vault = New-Object Windows.Security.Credentials.PasswordVault
  $res = '${RESOURCE}'
  function Find($name) { try { return $vault.Retrieve($res, $name) } catch { return $null } }
  switch ($req.op) {
    'set' {
      $old = Find $req.name
      if ($old) { $vault.Remove($old) }
      $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($res, $req.name, $req.value)))
      Answer @{ ok = $true }
    }
    'get' {
      $c = Find $req.name
      if (-not $c) { Answer @{ ok = $true; found = $false } }
      else { $c.RetrievePassword(); Answer @{ ok = $true; found = $true; value = $c.Password } }
    }
    'delete' {
      $c = Find $req.name
      if ($c) { $vault.Remove($c) }
      Answer @{ ok = $true; found = [bool]$c }
    }
    'list' {
      $names = @()
      try { $names = @($vault.FindAllByResource($res) | ForEach-Object { $_.UserName }) } catch {}
      Answer @{ ok = $true; names = $names }
    }
    default { Answer @{ ok = $false; error = 'unknown op' } }
  }
} catch {
  Answer @{ ok = $false; error = $_.Exception.Message }
}
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

/**
 * The exact process a vault call starts. Exposed so the test can check the
 * one property that matters: the value is in `input`, nowhere in `args`.
 */
function invocation(request) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
    input: Buffer.from(JSON.stringify(request), 'utf8').toString('base64') + '\n',
  };
}

function defaultRunner({ command, args, input }) {
  const r = spawnSync(command, args, { input, windowsHide: true, timeout: 30_000, encoding: 'utf8' });
  if (r.error) return { error: r.error.message };
  return { stdout: r.stdout || '', status: r.status };
}

let runner = defaultRunner;

// Tests swap the process for a fake; nothing else should.
function setRunner(fn) {
  runner = fn || defaultRunner;
}

function available() {
  return process.platform === 'win32' || runner !== defaultRunner;
}

// Never lets the value escape in an error: whatever PowerShell said is
// scrubbed of it before it becomes a message.
function scrub(text, value) {
  let s = String(text ?? '');
  if (value) s = s.split(String(value)).join('<redacted>');
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function call(request) {
  if (!available()) throw new Error('Windows Credential Manager is only available on Windows');
  if (request.name !== undefined && !NAME_RE.test(request.name)) {
    throw new Error('secret names are UPPER_SNAKE_CASE, e.g. PA_JIRA_API_TOKEN');
  }
  const r = runner(invocation(request));
  if (r.error) throw new Error(`credential manager: ${scrub(r.error, request.value)}`);
  const last = String(r.stdout || '').trim().split(/\r?\n/).pop();
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new Error(`credential manager: unreadable reply (exit ${r.status})`);
  }
  if (!parsed.ok) throw new Error(`credential manager: ${scrub(parsed.error, request.value)}`);
  return parsed;
}

function set(name, value) {
  if (typeof value !== 'string' || !value) throw new Error('an empty value is not stored');
  call({ op: 'set', name, value });
}

// The value, or null. Only config's resolver should call this.
function get(name) {
  const r = call({ op: 'get', name });
  return r.found ? String(r.value) : null;
}

function remove(name) {
  return Boolean(call({ op: 'delete', name }).found);
}

function list() {
  const r = call({ op: 'list' });
  return [].concat(r.names || []).map(String).sort();
}

module.exports = { RESOURCE, NAME_RE, invocation, setRunner, available, scrub, set, get, remove, list };
