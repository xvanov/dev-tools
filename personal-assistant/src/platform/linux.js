'use strict';

// Linux, first-class. Each behaviour uses the platform's own native mechanism
// rather than a port of the Windows one:
//
//   store         Postgres 16 + pgvector, a dedicated native cluster or the
//                 docker-compose container (Linux Docker runs Linux images)
//   secrets       the Secret Service (GNOME Keyring, KWallet, KeePassXC) via
//                 `secret-tool`, the value on stdin; .env when there is none
//   toasts        notify-send (libnotify); ntfy when there is no desktop
//   open / paste  xdg-open; wl-copy, xclip or xsel
//   services      systemd *user* units (linux/install.sh)
//   capture       PipeWire or PulseAudio through soundcard: the mic, and the
//                 default sink's monitor source as the "loopback" stream
//   who has the mic   `pactl list source-outputs`
//   Teams cache   none: there is no new Teams desktop client on Linux, so
//                 Teams arrives through the connector (see teamsCache below)
//
// Every command is built by a pure function (…Command, parse…) so the tests
// pin exactly what runs, without running it.

const fs = require('fs');
const os = require('os');
// posix: this file models that OS's paths, whichever OS evaluates it (tests run it on Windows).
const path = require('path').posix;

const common = require('./common');

const id = 'linux';
const label = 'Linux';

const PA_CAPTURE_UNIT = 'pa-capture@.service';

function home(env = process.env) {
  return env.HOME || os.homedir();
}

function xdgData(env = process.env) {
  return env.XDG_DATA_HOME || path.join(home(env), '.local', 'share');
}

function xdgConfig(env = process.env) {
  return env.XDG_CONFIG_HOME || path.join(home(env), '.config');
}

const defaults = {
  dataDir: (env = process.env) => path.join(xdgData(env), 'personal-assistant'),
  reposRoot: (env = process.env) => path.join(home(env), 'repos'),
  venvPython: (venvDir) => path.join(venvDir, 'bin', 'python'),
  // No default: see teamsCache. PA_TEAMS_CACHE_DIR opts in.
  teamsCacheDir: () => null,
  // A native pg_dump when one is installed (linux/install.sh --native), else
  // the compose container's own (--docker), which always matches the server.
  pgTools: ({ which = common.which } = {}) => (which('pg_dump') ? 'native' : which('docker') ? 'docker:pa-postgres' : 'native'),
};

// There is no new Teams desktop client for Linux (Microsoft retired the old
// one in 2022), so there is no WebView2 cache to tail. Teams arrives through
// the Microsoft 365 connector instead: minutes behind rather than seconds,
// and nothing is lost. The Teams *web* app keeps the same IndexedDB in a
// Chromium profile; pointing PA_TEAMS_CACHE_DIR at one turns the reader on,
// but that is untested against real records, so it is never the default.
const teamsCache = {
  supported: false,
  why: 'no new Teams desktop client on Linux — Teams arrives through the Microsoft 365 connector',
};

// Teams web caches in Chromium-family profiles, for `pa doctor` to point at.
function teamsWebCaches(env = process.env) {
  const roots = [
    'microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev', 'google-chrome', 'chromium',
    path.join('BraveSoftware', 'Brave-Browser'),
  ].map((b) => path.join(xdgConfig(env), b));
  roots.push(path.join(home(env), 'snap', 'chromium', 'common', 'chromium'));
  const found = [];
  for (const root of roots) {
    let profiles = [];
    try {
      profiles = fs.readdirSync(root).filter((n) => n === 'Default' || /^Profile \d+$/.test(n));
    } catch {
      continue;
    }
    for (const prof of profiles) {
      for (const origin of ['https_teams.microsoft.com_0', 'https_teams.cloud.microsoft_0']) {
        const base = path.join(root, prof, 'IndexedDB', `${origin}.indexeddb`);
        if (fs.existsSync(`${base}.leveldb`)) found.push(base);
      }
    }
  }
  return found;
}

// ext4 and friends are case-sensitive: /repos/Quill and /repos/quill differ.
function pathKey(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '');
}

// ------------------------------------------------------- the desktop ----

// A graphical session to open things in. A systemd user unit gets these once
// the desktop imports them into the user manager (GNOME and KDE do).
function hasDisplay(env = process.env) {
  return Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);
}

// notify-send and the Secret Service both live on the session bus.
function hasSessionBus(env = process.env) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return true;
  const runtime = env.XDG_RUNTIME_DIR || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null);
  return Boolean(runtime && fs.existsSync(path.join(runtime, 'bus')));
}

function openCommand(url) {
  return { cmd: 'xdg-open', args: [String(url)] };
}

// Headless (a server, an SSH session): nothing to open in, so say so and let
// the caller print the link instead.
function openUrl(url, { env = process.env } = {}) {
  if (!hasDisplay(env) || !common.which('xdg-open')) return false;
  const c = openCommand(url);
  return common.spawnDetached(c.cmd, c.args);
}

// Wayland first: under XWayland both DISPLAY and WAYLAND_DISPLAY are set, and
// only wl-copy reaches the clipboard native Wayland apps paste from.
function clipboardCommand({ env = process.env, which = common.which } = {}) {
  if (env.WAYLAND_DISPLAY && which('wl-copy')) return { cmd: 'wl-copy', args: [] };
  if (env.DISPLAY && which('xclip')) return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  if (env.DISPLAY && which('xsel')) return { cmd: 'xsel', args: ['--clipboard', '--input'] };
  return null;
}

function copyToClipboard(text) {
  const c = clipboardCommand();
  return c ? common.pipeTo(c.cmd, c.args, text) : Promise.resolve(false);
}

// An msteams: handler — teams-for-linux registers one. Without it, xdg-open
// on msteams: opens nothing, so drafts go to the Teams web app instead.
let teamsHandler;
function teamsDesktop() {
  if (teamsHandler === undefined) {
    teamsHandler = common.which('xdg-mime')
      ? Boolean(common.runSync('xdg-mime', ['query', 'default', 'x-scheme-handler/msteams'], { timeoutMs: 5000 }).stdout.trim())
      : false;
  }
  return teamsHandler;
}

// ------------------------------------------------------------- toasts ----

// Notification bodies are a markup subset on most servers (GNOME, KDE, dunst):
// escape it, so a message containing "<b>" is shown, not interpreted.
function markupEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// libnotify ≥ 0.7.10 has --action/--wait: the click opens the link, as a
// Windows toast does. Older ones (Ubuntu 22.04 ships 0.7.9) show it unclickable.
let actionSupport;
function notifySendHasActions() {
  if (actionSupport === undefined) {
    const r = common.runSync('notify-send', ['--help'], { timeoutMs: 5000 });
    actionSupport = /--action/.test(`${r.stdout}${r.stderr}`);
  }
  return actionSupport;
}

/**
 * The notify-send process for a notification. Title and body are arguments
 * (after `--`, so a title starting with "-" is not an option); nothing secret
 * is ever in a notification. `links` maps the action keys notify-send prints
 * back to the URL each opens.
 */
function toastCommand({ title, body, url, actions = [] }, { withActions = false } = {}) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n');
  const args = ['--app-name=personal-assistant', '--expire-time=15000'];
  const links = {};
  if (withActions) {
    if (/^https?:\/\//.test(url || '')) {
      args.push('--action=default=Open');
      links.default = url;
    }
    actions
      .filter((a) => a && /^https?:\/\//.test(a.url || ''))
      .slice(0, 3)
      .forEach((a, i) => {
        args.push(`--action=a${i}=${String(a.label || 'Open').replace(/[\r\n=]/g, ' ').slice(0, 40)}`);
        links[`a${i}`] = a.url;
      });
    if (Object.keys(links).length) args.push('--wait');
  }
  args.push('--', String(title ?? '').slice(0, 120), markupEscape(lines).slice(0, 600));
  return { cmd: 'notify-send', args, links };
}

function toast(spec, { env = process.env } = {}) {
  if (!hasSessionBus(env) || !common.which('notify-send')) return Promise.resolve(false);
  const c = toastCommand(spec, { withActions: hasDisplay(env) && notifySendHasActions() });
  const waits = c.args.includes('--wait');
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let child;
    try {
      child = spawn(c.cmd, c.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    let settled = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    // With --wait the process lives until the notification is clicked or
    // dismissed. It has been shown once it is still alive a moment after
    // starting (a missing notification server fails at once); never hold the
    // caller for the user's click, and never keep the child past ten minutes.
    const shown = waits ? setTimeout(() => settle(true), 1500) : null;
    const reaper = waits ? setTimeout(() => child.kill(), 10 * 60_000) : null;
    if (reaper) reaper.unref();
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => settle(false));
    child.on('close', (code) => {
      if (shown) clearTimeout(shown);
      if (reaper) clearTimeout(reaper);
      const link = c.links[out.trim()];
      if (link) openUrl(link, { env });
      settle(code === 0);
    });
  });
}

// -------------------------------------------------------------- vault ----
// The freedesktop Secret Service: GNOME Keyring, KWallet ≥ 5.97, KeePassXC.
// Encrypted at rest and unlocked with your login, per user — the Linux
// counterpart of Credential Manager. Entries carry the attributes
// `service=personal-assistant name=<NAME>`, so Seahorse ("Passwords and Keys")
// lists them together.
//
// `secret-tool store` reads the value from stdin when stdin is not a terminal,
// so — as on Windows — **the value travels on stdin, never in argv**.
// `lookup` prints it on stdout, which only this process reads.

const SERVICE = 'personal-assistant';

function attrs(name) {
  return ['service', SERVICE, 'name', name];
}

const vault = {
  id: 'credential-manager',
  label: 'the Secret Service keyring',
  where: 'the Secret Service keyring (GNOME Keyring / KWallet; encrypted, your login only)',
  available: ({ env = process.env } = {}) => Boolean(common.which('secret-tool')) && hasSessionBus(env),
  /** The one process a request turns on; for 'set', the value is its stdin. */
  invocation(request) {
    switch (request.op) {
      case 'set':
        return {
          command: 'secret-tool',
          args: ['store', `--label=${SERVICE}: ${request.name}`, ...attrs(request.name)],
          input: String(request.value),
        };
      case 'get':
        return { command: 'secret-tool', args: ['lookup', ...attrs(request.name)] };
      case 'delete':
        return { command: 'secret-tool', args: ['clear', ...attrs(request.name)] };
      case 'list':
        return { command: 'secret-tool', args: ['search', '--all', 'service', SERVICE] };
      default:
        throw new Error('unknown op');
    }
  },
  // secret-tool answers in exit codes: lookup exits 1, silently, when there is
  // no such entry. Error text comes from stderr only (the caller scrubs it);
  // stdout can hold a value and never becomes a message.
  run(request, runner) {
    const fail = (r) => ({ ok: false, error: r.error ? String(r.error) : (r.stderr || '').trim() || `secret-tool exited ${r.status}` });
    if (request.op === 'set') {
      const r = runner(vault.invocation(request));
      return r.error || r.status !== 0 ? fail(r) : { ok: true };
    }
    if (request.op === 'get') {
      const r = runner(vault.invocation(request));
      if (r.error) return fail(r);
      if (r.status === 0) return { ok: true, found: true, value: String(r.stdout).replace(/\r?\n$/, '') };
      return (r.stderr || '').trim() ? fail(r) : { ok: true, found: false };
    }
    if (request.op === 'delete') {
      // `clear` says nothing either way; ask first so the answer can say
      // whether there was anything to remove.
      const had = vault.run({ op: 'get', name: request.name }, runner);
      if (!had.ok) return had;
      if (!had.found) return { ok: true, found: false };
      const r = runner(vault.invocation(request));
      return r.error || r.status !== 0 ? fail(r) : { ok: true, found: true };
    }
    if (request.op === 'list') {
      const r = runner(vault.invocation(request));
      if (r.error) return fail(r);
      // `search` prints each item's secret too; only the name attributes are
      // read out of it, and the text goes nowhere else — not even an error.
      const names = [];
      for (const line of `${r.stdout || ''}\n${r.stderr || ''}`.split(/\r?\n/)) {
        const m = /^attribute\.name = ([A-Z][A-Z0-9_]{1,63})$/.exec(line.trim());
        if (m && !names.includes(m[1])) names.push(m[1]);
      }
      if (r.status !== 0 && !names.length) return { ok: true, names: [] };
      return { ok: true, names };
    }
    return { ok: false, error: 'unknown op' };
  },
};

// ------------------------------------------------------------- capture ----

/** Pure: `pactl list short sources` → Map(index → source name). */
function parseShortSources(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const [idx, name] = line.split('\t');
    if (/^\d+$/.test(idx || '') && name) out.set(idx, name);
  }
  return out;
}

/**
 * Pure: `pactl list source-outputs` (LC_ALL=C) → one record per recording
 * stream: {index, source, corked, props}.
 */
function parseSourceOutputs(text) {
  const outputs = [];
  let cur = null;
  let inProps = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const head = /^Source Output #(\d+)/.exec(raw);
    if (head) {
      cur = { index: head[1], source: null, corked: false, props: {} };
      outputs.push(cur);
      inProps = false;
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    if (/^Properties:$/.test(line)) {
      inProps = true;
      continue;
    }
    const prop = /^([a-z0-9_.-]+) = "(.*)"$/i.exec(line);
    if (inProps && prop) {
      cur.props[prop[1]] = prop[2];
      continue;
    }
    const field = /^([A-Za-z ]+): (.*)$/.exec(line);
    if (field) {
      inProps = false;
      if (field[1] === 'Source') cur.source = field[2].trim();
      if (field[1] === 'Corked') cur.corked = field[2].trim() === 'yes';
    }
  }
  return outputs;
}

// Not a call: our own recorder and voice-dictation (Python, as on Windows),
// level meters (pavucontrol, the GNOME/KDE volume applets) and anything
// recording a monitor — that is the speakers, not the microphone.
function isNotACall(o, sourceName) {
  const p = o.props;
  const bin = String(p['application.process.binary'] || '');
  if (/^python[0-9.]*$/i.test(path.basename(bin))) return true;
  if (/pavucontrol|pwvucontrol|plasma-pa|gnome-shell|gsd-media-keys|pipewire-pulse/i.test(`${bin} ${p['application.id'] || ''}`)) return true;
  if (/peak detect/i.test(p['media.name'] || '')) return true;
  if (sourceName && /\.monitor$/.test(sourceName)) return true;
  return false;
}

/**
 * Pure: the apps holding a microphone, from pactl's two listings — the Linux
 * counterpart of the Windows registry read in parseMicHolders. A corked
 * (paused) stream still holds the device, as a muted Teams call does.
 */
function micHoldersFromPactl(sourceOutputsText, shortSourcesText) {
  const sources = parseShortSources(shortSourcesText);
  const holders = [];
  for (const o of parseSourceOutputs(sourceOutputsText)) {
    const name = sources.get(o.source) || null;
    if (isNotACall(o, name)) continue;
    const app = o.props['application.process.binary'] || o.props['application.name'] || `stream ${o.index}`;
    if (!holders.includes(app)) holders.push(app);
  }
  return holders;
}

// Our own processes must parse pactl in English whatever the desktop's locale.
const PACTL_ENV = { LC_ALL: 'C' };

function unitDir(env = process.env) {
  return path.join(xdgConfig(env), 'systemd', 'user');
}

const capture = {
  backend: 'PipeWire/PulseAudio (soundcard): the mic, and the default sink\'s monitor as loopback',
  // Restarting a unit that was never installed fails every ten minutes and
  // notifies you each time; `pa doctor` reports the missing unit instead.
  installed: ({ env = process.env } = {}) => fs.existsSync(path.join(unitDir(env), PA_CAPTURE_UNIT)),
  restartHint: (stream) => `systemctl --user restart pa-capture@${stream}`,
  // systemd stops the whole cgroup, so unlike the Windows task there is no
  // orphaned python to hunt down by command line.
  restartCommand: (stream) => ({ cmd: 'systemctl', args: ['--user', 'restart', `pa-capture@${stream}.service`] }),
  async restart(stream) {
    if (!/^(mic|loopback)$/.test(stream)) throw new Error(`unknown stream ${stream}`);
    const c = capture.restartCommand(stream);
    const r = await common.run(c.cmd, c.args, { timeoutMs: 60_000 });
    if (r.error || r.status !== 0) throw new Error((r.stderr || r.error || `exit ${r.status}`).trim().slice(0, 200));
  },
  micHoldersCommands: () => [
    { cmd: 'pactl', args: ['list', 'source-outputs'], env: PACTL_ENV },
    { cmd: 'pactl', args: ['list', 'short', 'sources'], env: PACTL_ENV },
  ],
  // No pactl (a box with neither PipeWire's pulse layer nor PulseAudio) means
  // no unplanned-call detection: the gate then records calendar meetings only,
  // and `pa doctor` says so.
  async micHolders() {
    if (!common.which('pactl')) return [];
    const [outs, srcs] = await Promise.all(
      capture.micHoldersCommands().map((c) => common.run(c.cmd, c.args, { env: c.env, timeoutMs: 10_000 }))
    );
    if (outs.error || outs.status !== 0) return [];
    return micHoldersFromPactl(outs.stdout, srcs.stdout);
  },
};

async function freeBytes(dir) {
  return common.statfsFree(dir);
}

const services = {
  workerStart: 'systemctl --user start pa-worker',
  workerStop: 'systemctl --user stop pa-worker',
  install: 'linux/install.sh',
  dbProvision: 'linux/install.sh (or linux/setup-postgres.sh)',
};

// What only Linux can get wrong: no keyring, no notification daemon, no
// clipboard tool, no sound server, capture units not installed.
async function doctor({ ntfyConfigured = false, audioEnabled = true, env = process.env } = {}) {
  const lines = [];
  const bus = hasSessionBus(env);
  lines.push(
    vault.available({ env })
      ? { ok: true, label: 'secret store', detail: 'Secret Service via secret-tool (values on stdin)' }
      : {
          ok: false,
          label: 'secret store',
          detail: `${common.which('secret-tool') ? 'no session bus' : 'secret-tool not installed (libsecret-tools)'} — DEGRADED: secrets are read from env and the gitignored .env only`,
        }
  );
  const desktop = bus && common.which('notify-send');
  lines.push({
    ok: Boolean(desktop || ntfyConfigured),
    label: 'notifications',
    detail: desktop
      ? `notify-send${hasDisplay(env) && notifySendHasActions() ? ' (click opens the link)' : ' (not clickable: libnotify < 0.7.10 or no display)'}${ntfyConfigured ? ' · ntfy when it fails' : ''}`
      : ntfyConfigured
        ? 'ntfy only (no desktop notification daemon)'
        : 'DEGRADED: no notify-send/session bus and no PA_NTFY_TOPIC — pushes reach the dashboard feed only',
  });
  const clip = clipboardCommand({ env });
  lines.push({
    ok: Boolean(clip) || !hasDisplay(env),
    label: 'clipboard',
    detail: clip ? clip.cmd : hasDisplay(env) ? 'none — install wl-clipboard or xclip so `pa send` can copy long drafts' : 'headless — `pa send` prints drafts instead',
  });
  if (audioEnabled) {
    if (!common.which('pactl')) {
      lines.push({ ok: false, label: 'sound server', detail: 'pactl missing — DEGRADED: no unplanned-call detection, mic does not follow the call\'s device' });
    } else {
      const r = await common.run('pactl', ['info'], { env: PACTL_ENV, timeoutMs: 5000 });
      const server = /^Server Name: (.*)$/m.exec(r.stdout || '');
      lines.push({
        ok: !r.error && r.status === 0,
        label: 'sound server',
        detail: server ? server[1].trim() : `unreachable (${(r.stderr || r.error || '').trim().slice(0, 60)}) — capture cannot open a device`,
      });
    }
    lines.push({
      ok: capture.installed({ env }),
      label: 'capture units',
      detail: capture.installed({ env }) ? 'pa-capture@mic, pa-capture@loopback (systemd --user)' : 'not installed — run linux/install.sh (or PA_AUDIO_ENABLED=0)',
    });
  }
  return lines;
}

module.exports = {
  id,
  label,
  defaults,
  teamsCache,
  teamsWebCaches,
  pathKey,
  hasDisplay,
  hasSessionBus,
  openCommand,
  openUrl,
  clipboardCommand,
  copyToClipboard,
  teamsDesktop,
  toastCommand,
  toast,
  vault,
  capture,
  parseSourceOutputs,
  parseShortSources,
  micHoldersFromPactl,
  freeBytes,
  services,
  doctor,
};
