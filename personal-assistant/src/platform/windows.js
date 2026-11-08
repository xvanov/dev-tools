'use strict';

// Windows: the platform this tool was built on. Everything here moved, unchanged
// in behaviour, out of the modules that used to test `process.platform` inline
// (config, cli, notify, secrets/vault, audio/gate, audio/watchdog, backup,
// routines/repoSync). See src/platform/index.js for the contract.
//
// The store lives in WSL (AGENT.md, "The store lives in WSL"); toasts and the
// credential vault are WinRT reached through Windows PowerShell; capture runs as
// two logon tasks registered by windows/install.ps1.

const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const common = require('./common');

const exec = promisify(execFile);

const id = 'windows';
const label = 'Windows';

function localAppData(env = process.env) {
  return env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

const defaults = {
  dataDir: (env = process.env) => path.join(localAppData(env), 'personal-assistant'),
  reposRoot: () => 'C:\\repos',
  venvPython: (venvDir) => path.join(venvDir, 'Scripts', 'python.exe'),
  // The new Teams (MSTeams package) is a WebView2 app; its IndexedDB lives here.
  teamsCacheDir: (env = process.env) =>
    path.join(
      localAppData(env),
      'Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView',
      'WV2Profile_tfw', 'IndexedDB', 'https_teams.microsoft.com_0.indexeddb'
    ),
  // pg_dump runs inside the WSL distro that hosts Postgres (src/backup.js).
  pgTools: ({ wslDistro = 'Ubuntu' } = {}) => `wsl:${wslDistro}`,
};

const teamsCache = { supported: true, why: 'the new Teams desktop client keeps chats in IndexedDB on this disk' };

// NTFS is case-insensitive: C:\Repos and c:\repos are one folder.
function pathKey(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

// ------------------------------------------------------- open, clipboard --

// No cmd.exe. `cmd /c start` re-parses its whole command line, so `&`, `|`,
// `^`, `<`, `>`, `%` and quotes in a URL are cmd syntax: escaping only `&`
// (as this used to) left `|calc` or `%PATH%` live. Instead the URL goes,
// as ONE argv entry, to the shell's own protocol handler —
// `rundll32 url.dll,FileProtocolHandler <url>` — which is what `start` does
// for a URL anyway, with no interpreter in between.
//
// Only schemes something here actually opens are accepted (http/https, and
// msteams: for drafts — src/draft/deliver.js): FileProtocolHandler would just
// as happily run a `file:` path or any registered handler. The URL is
// normalised by WHATWG URL, and one that still holds whitespace, a quote or a
// control character is refused rather than handed to a Windows command line,
// where Node would wrap it in quotes the handler then sees. Refused → null,
// and openUrl answers false so the caller prints the link instead.
const OPEN_SCHEMES = new Set(['http:', 'https:', 'msteams:']);

function openCommand(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!OPEN_SCHEMES.has(u.protocol)) return null;
  const href = u.href;
  if (/[\s"\u0000-\u001f\u007f]/.test(href)) return null;
  return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', href] };
}

function openUrl(url) {
  const c = openCommand(url);
  if (!c) return false;
  return common.spawnDetached(c.cmd, c.args);
}

function clipboardCommand() {
  return { cmd: 'clip', args: [] };
}

function copyToClipboard(text) {
  return common.pipeTo('clip', [], text);
}

// Desktop Teams registers msteams:, so a draft opens in the app.
function teamsDesktop() {
  return true;
}

// ------------------------------------------------------------- toasts ----

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Toast XML: title, up to ~4 lines of body, a click that opens `url`, and
// optional buttons that each open their own link (a meeting's join link).
function toastXml({ title, body, url, actions = [] }) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n');
  return [
    `<toast activationType="protocol" launch="${xmlEscape(url || '')}">`,
    '<visual><binding template="ToastGeneric">',
    `<text>${xmlEscape(title).slice(0, 120)}</text>`,
    lines ? `<text>${xmlEscape(lines).slice(0, 600)}</text>` : '',
    '</binding></visual>',
    ...(actions.length
      ? [
          '<actions>',
          ...actions
            .filter((a) => a && /^https?:\/\//.test(a.url || ''))
            .slice(0, 3)
            .map((a) => `<action content="${xmlEscape(a.label).slice(0, 40)}" activationType="protocol" arguments="${xmlEscape(a.url)}"/>`),
          '</actions>',
        ]
      : []),
    '</toast>',
  ].join('');
}

// A toast through WinRT from Windows PowerShell, under PowerShell's own app id
// (registered on every Windows install, so no Start-menu shortcut or AUMID
// registration is needed). The XML travels base64-encoded so nothing in a
// title can break out of the script.
function toastCommand(spec) {
  const xml64 = Buffer.from(toastXml(spec), 'utf8').toString('base64');
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$xml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${xml64}'))`,
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($xml)',
    "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))',
  ].join('; ');
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
}

async function toast(spec) {
  const c = toastCommand(spec);
  const r = await common.run(c.cmd, c.args, { timeoutMs: 30_000 });
  return !r.error && r.status === 0;
}

// -------------------------------------------------------------- vault ----
// Windows Credential Manager, through WinRT's PasswordVault.
//
// The vault is DPAPI-protected and per user: what lands here is readable by
// this Windows account and nobody else. Entries are "web credentials" under one
// resource name, so they show up together in Control Panel → Credential
// Manager, where you can inspect or delete them by hand.
//
// Each call is one Windows PowerShell process running a fixed script. **The
// secret travels on stdin, never in argv** — a command line is readable by
// every other process on the machine (Task Manager shows it), stdin is not.
// The script carries no data; the request (op, name, value) is a base64 JSON
// line on stdin, so no character in a value can break out of anything.

// Entries are labelled by stack: resource `dev-tools/<stack>`. Entries written
// before the label existed live under `personal-assistant`; a read falls back
// to it, a write moves the entry, a delete clears both.
const LEGACY_RESOURCE = 'personal-assistant';
const stackResource = () => `dev-tools/${common.stack()}`;

// A missing entry is {ok:true, found:false}, not an error: PasswordVault throws
// "Element not found" for both "no such credential" and "empty vault".
const VAULT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Answer($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
try {
  $line = [Console]::In.ReadLine()
  $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
  [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $vault = New-Object Windows.Security.Credentials.PasswordVault
  $res = $req.resource
  $resources = @($req.resource, $req.legacy)
  function Find($name) { foreach ($r in $resources) { try { return $vault.Retrieve($r, $name) } catch {} } return $null }
  switch ($req.op) {
    'set' {
      foreach ($r in $resources) { try { $vault.Remove($vault.Retrieve($r, $req.name)) } catch {} }
      $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($res, $req.name, $req.value)))
      Answer @{ ok = $true }
    }
    'get' {
      $c = Find $req.name
      if (-not $c) { Answer @{ ok = $true; found = $false } }
      else { $c.RetrievePassword(); Answer @{ ok = $true; found = $true; value = $c.Password } }
    }
    'delete' {
      $found = $false
      foreach ($r in $resources) { try { $vault.Remove($vault.Retrieve($r, $req.name)); $found = $true } catch {} }
      Answer @{ ok = $true; found = $found }
    }
    'list' {
      $names = @()
      foreach ($r in $resources) { try { $names += @($vault.FindAllByResource($r) | ForEach-Object { $_.UserName }) } catch {} }
      Answer @{ ok = $true; names = @($names | Sort-Object -Unique) }
    }
    default { Answer @{ ok = $false; error = 'unknown op' } }
  }
} catch {
  Answer @{ ok = $false; error = $_.Exception.Message }
}
`;

const VAULT_ENCODED = Buffer.from(VAULT_SCRIPT, 'utf16le').toString('base64');

const vault = {
  id: 'credential-manager',
  label: 'Windows Credential Manager',
  where: 'Windows Credential Manager (encrypted, your Windows account only)',
  available: () => true,
  /** The exact process a vault call starts: the value is in `input`, never in `args`. */
  invocation(request) {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', VAULT_ENCODED],
      input: Buffer.from(JSON.stringify({ ...request, resource: stackResource(), legacy: LEGACY_RESOURCE }), 'utf8').toString('base64') + '\n',
    };
  },
  // One process per request; its last stdout line is the JSON answer.
  run(request, runner) {
    const r = runner(vault.invocation(request));
    if (r.error) return { ok: false, error: String(r.error) };
    const last = String(r.stdout || '').trim().split(/\r?\n/).pop();
    try {
      return JSON.parse(last);
    } catch {
      return { ok: false, error: `unreadable reply (exit ${r.status})` };
    }
  },
};

// ------------------------------------------------------------- capture ----

// Windows records per-app microphone use here; LastUsedTimeStop is 0 while an
// app holds the device.
const MIC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
const CAM_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam';

// Pure: the apps holding the microphone (or camera), from `reg query /s /v
// LastUsedTimeStop` output. Python is left out: that is our own recorder and
// voice-dictation, and counting them would keep the gate open forever.
function parseMicHolders(regOutput) {
  const holders = [];
  let key = null;
  for (const line of String(regOutput).split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      key = line.trim();
      continue;
    }
    const m = /^\s+LastUsedTimeStop\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line);
    if (!m || !key || BigInt(m[1]) !== 0n) continue;
    const app = key.split('\\').pop().replace(/#/g, '\\');
    if (/\\pythonw?\.exe$/i.test(app)) continue;
    if (!holders.includes(app)) holders.push(app);
  }
  return holders;
}

const capture = {
  backend: 'WASAPI (soundcard + pycaw), two logon tasks',
  installed: () => true,
  restartHint: (stream) => `Start-ScheduledTask pa-capture-${stream}`,
  // Ending the task leaves the python child running (the task's process is a
  // wrapper), so the recorder itself is killed by its command line.
  restartCommand(stream) {
    const task = `pa-capture-${stream}`;
    const ps = [
      `Stop-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue`,
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'capture\\.py --stream ${stream}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }`,
      'Start-Sleep -Seconds 2',
      `Start-ScheduledTask -TaskName '${task}'`,
    ].join('; ');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', ps] };
  },
  async restart(stream) {
    const c = capture.restartCommand(stream);
    await exec(c.cmd, c.args, { windowsHide: true, timeout: 60_000 });
  },
  async micHolders() {
    const queryKey = async (k) => {
      try {
        const { stdout } = await exec('reg.exe', ['query', k, '/s', '/v', 'LastUsedTimeStop'], {
          windowsHide: true,
          timeout: 10_000,
        });
        return stdout;
      } catch (err) {
        // reg exits non-zero when some subkeys lack the value; the rest is still on stdout.
        return err.stdout || '';
      }
    };
    const [micOut, camOut] = await Promise.all([queryKey(MIC_KEY), queryKey(CAM_KEY)]);
    return parseMicHolders(`${micOut}\n${camOut}`);
  },
};

// Free bytes on the drive holding `dir` (its drive letter).
async function freeBytes(dir) {
  const drive = path.parse(path.resolve(dir)).root.slice(0, 1);
  const { stdout } = await exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-PSDrive -Name '${drive}').Free`],
    { windowsHide: true, timeout: 30_000 }
  );
  return Number(String(stdout).trim());
}

const services = {
  workerStart: 'Start-ScheduledTask pa-worker',
  workerStop: 'Stop-ScheduledTask pa-worker',
  install: 'windows\\install.ps1',
  dbProvision: 'windows/setup-wsl-postgres.sh (in WSL)',
};

// Nothing Windows-specific is uncertain enough to need its own doctor lines:
// the vault, toasts and capture tasks are reported by the checks that use them.
async function doctor() {
  return [];
}

module.exports = {
  id,
  label,
  defaults,
  teamsCache,
  pathKey,
  openCommand,
  openUrl,
  clipboardCommand,
  copyToClipboard,
  teamsDesktop,
  toastXml,
  toastCommand,
  toast,
  vault,
  capture,
  parseMicHolders,
  freeBytes,
  services,
  doctor,
};
