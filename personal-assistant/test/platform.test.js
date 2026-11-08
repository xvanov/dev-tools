'use strict';

// The platform layer (src/platform): which implementation runs where, and the
// exact process each Linux behaviour starts — built by pure functions, so
// nothing here opens a window, touches a keyring, records audio or restarts a
// service. The one invariant pinned hardest: a secret value is never in argv.

process.env.PA_TOASTS = '0';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const platform = require('../src/platform');
const common = require('../src/platform/common.ts');
const linux = platform.select('linux');
const windows = platform.select('win32');
const darwin = platform.select('darwin');

// ------------------------------------------------------------ selection --
{
  assert.strictEqual(linux.id, 'linux');
  assert.strictEqual(windows.id, 'windows');
  assert.strictEqual(darwin.id, 'darwin');
  assert.strictEqual(platform.select('freebsd').id, 'linux', 'other Unixes get the Linux implementation');
  const here = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform] || 'linux';
  assert.strictEqual(platform.id, here);
  assert.strictEqual(platform.current.id, here);
  // Every implementation has the whole contract.
  const contract = ['defaults', 'teamsCache', 'pathKey', 'openCommand', 'openUrl', 'clipboardCommand', 'copyToClipboard',
    'teamsDesktop', 'toastCommand', 'toast', 'vault', 'capture', 'freeBytes', 'services', 'doctor'];
  for (const impl of [linux, windows, darwin]) {
    for (const k of contract) assert.ok(impl[k] !== undefined, `${impl.id} lacks ${k}`);
    for (const k of ['dataDir', 'reposRoot', 'venvPython', 'teamsCacheDir', 'pgTools']) assert.strictEqual(typeof impl.defaults[k], 'function', `${impl.id}.defaults.${k}`);
    for (const k of ['id', 'label', 'where', 'available', 'invocation', 'run']) assert.ok(impl.vault[k] !== undefined, `${impl.id}.vault.${k}`);
    assert.strictEqual(impl.vault.id, 'credential-manager', 'one target id for "the OS vault" on every OS');
    for (const k of ['installed', 'restartHint', 'restartCommand', 'restart', 'micHolders']) assert.ok(impl.capture[k] !== undefined, `${impl.id}.capture.${k}`);
  }
}

// ------------------------------------------------------- linux defaults --
{
  const env = { HOME: '/home/quill' };
  assert.strictEqual(linux.defaults.dataDir(env), '/home/quill/.local/share/personal-assistant');
  assert.strictEqual(linux.defaults.dataDir({ ...env, XDG_DATA_HOME: '/data' }), '/data/personal-assistant');
  assert.strictEqual(linux.defaults.reposRoot(env), '/home/quill/repos');
  assert.strictEqual(linux.defaults.venvPython('/v'), '/v/bin/python');
  assert.strictEqual(linux.defaults.teamsCacheDir(), null, 'no Teams desktop client on Linux');
  assert.strictEqual(linux.teamsCache.supported, false);
  assert.strictEqual(windows.teamsCache.supported, true);
  assert.strictEqual(linux.defaults.pgTools({ which: (b) => (b === 'pg_dump' ? '/usr/bin/pg_dump' : null) }), 'native');
  assert.strictEqual(linux.defaults.pgTools({ which: (b) => (b === 'docker' ? '/usr/bin/docker' : null) }), 'docker:pa-postgres');
  assert.strictEqual(windows.defaults.pgTools({ wslDistro: 'Debian' }), 'wsl:Debian');
  assert.ok(windows.defaults.venvPython('v').endsWith(path.join('Scripts', 'python.exe')));
  assert.strictEqual(linux.pathKey('/repos/Quill/'), '/repos/Quill', 'case-sensitive on Linux');
  assert.notStrictEqual(linux.pathKey('/repos/Quill'), linux.pathKey('/repos/quill'));
}

// ------------------------------------------------- open, clipboard, Teams --
{
  assert.deepStrictEqual(linux.openCommand('https://x.example/a?b=1&c=2'), { cmd: 'xdg-open', args: ['https://x.example/a?b=1&c=2'] });
  // Windows: no cmd.exe in the path. The URL is one argv entry to the protocol
  // handler, verbatim — cmd metacharacters are inert because nothing parses them.
  const fph = (u) => ({ cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', u] });
  assert.deepStrictEqual(windows.openCommand('https://x.example/a?b=1&c=2'), fph('https://x.example/a?b=1&c=2'));
  for (const u of ['https://x.example/a?b=1&calc|x^y%PATH%', 'https://x.example/?q=a&&whoami', 'https://x.example/<x>']) {
    const c = windows.openCommand(u);
    assert.ok(c, `opened: ${u}`);
    assert.strictEqual(c.cmd, 'rundll32.exe', 'never cmd');
    assert.strictEqual(c.args.length, 2, 'the URL is a single argument');
    assert.ok(!c.args.some((a) => a === '/c' || a === 'start'));
  }
  assert.strictEqual(windows.openCommand('https://x.example/a?b=1&calc|x^y%PATH%').args[1], 'https://x.example/a?b=1&calc|x^y%PATH%', 'passed through, not escaped');
  assert.strictEqual(windows.openCommand('https://x.example/<x>').args[1], 'https://x.example/%3Cx%3E', 'normalised by WHATWG URL');
  assert.deepStrictEqual(windows.openCommand('msteams:/l/chat/0/0?users=a%40b.com&message=hi'), fph('msteams:/l/chat/0/0?users=a%40b.com&message=hi'), 'Teams drafts still open');
  assert.strictEqual(windows.openCommand('HTTPS://X.example/').args[1], 'https://x.example/');
  // A space or quote never reaches the command line raw (Node would quote it).
  assert.strictEqual(windows.openCommand('msteams:/l/chat/0/0?message=a b').args[1], 'msteams:/l/chat/0/0?message=a%20b');
  assert.strictEqual(windows.openCommand('https://x.example/"&calc').args[1], 'https://x.example/%22&calc');
  // Refused: not a URL, a scheme nothing here opens, or one that would need quoting.
  for (const bad of ['not a url', '', 'file:///C:/Windows/System32/calc.exe', 'C:\\Windows\\calc.exe', 'javascript:alert(1)',
    'ms-settings:', 'cmd:/c calc', '\\\\evil\\share\\x.exe', null, undefined]) {
    assert.strictEqual(windows.openCommand(bad), null, `refused: ${bad}`);
  }
  assert.strictEqual(windows.openUrl('file:///C:/Windows/System32/calc.exe'), false, 'refused → false, so the caller prints the link');
  assert.strictEqual(linux.openUrl('https://x.example', { env: {} }), false, 'headless: nothing opened, caller prints the link');

  const all = () => '/usr/bin/x';
  const none = () => null;
  assert.deepStrictEqual(linux.clipboardCommand({ env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, which: all }), { cmd: 'wl-copy', args: [] });
  assert.deepStrictEqual(linux.clipboardCommand({ env: { DISPLAY: ':0' }, which: all }), { cmd: 'xclip', args: ['-selection', 'clipboard'] });
  assert.deepStrictEqual(linux.clipboardCommand({ env: { DISPLAY: ':0' }, which: (b) => (b === 'xsel' ? '/usr/bin/xsel' : null) }), { cmd: 'xsel', args: ['--clipboard', '--input'] });
  assert.strictEqual(linux.clipboardCommand({ env: {}, which: all }), null, 'headless: no clipboard');
  assert.strictEqual(linux.clipboardCommand({ env: { DISPLAY: ':0' }, which: none }), null);

  // No msteams: handler → the draft opens in Teams on the web, still unsent.
  const deliver = require('../src/draft/deliver');
  const dm = { body: 'on it', target: { channel: 'teams', kind: 'dm', users: ['ana@example.com'] } };
  const web = deliver.links(dm, { desktopTeams: false });
  assert.ok(web.open.startsWith('https://teams.microsoft.com/l/chat/0/0?users=ana%40example.com&message=on%20it'), web.open);
  assert.strictEqual(web.open, web.web);
  assert.ok(deliver.links(dm).open.startsWith('msteams:'), 'default stays the desktop app (Windows)');
  const group = { body: 'x', target: { channel: 'teams', kind: 'group', chatId: '19:abc@thread.v2' } };
  assert.ok(deliver.links(group, { desktopTeams: false }).open.startsWith('https://teams.microsoft.com/l/chat/'));
}

// --------------------------------------------------------------- toasts --
{
  const spec = { title: '-rf Stand-up', body: '1. <b>ship</b> & tell\n2. b\n3. c\n4. d\n5. e', url: 'http://127.0.0.1:7300/#n-1', actions: [{ label: 'Join=now', url: 'https://teams.microsoft.com/l/x' }, { label: 'bad', url: 'javascript:alert(1)' }] };
  const plain = linux.toastCommand(spec);
  assert.strictEqual(plain.cmd, 'notify-send');
  const dash = plain.args.indexOf('--');
  assert.ok(dash > 0, 'title and body after --, so a title starting with "-" is not an option');
  assert.strictEqual(plain.args[dash + 1], '-rf Stand-up');
  assert.strictEqual(plain.args[dash + 2], '1. &lt;b&gt;ship&lt;/b&gt; &amp; tell\n2. b\n3. c\n4. d', 'markup escaped, four lines');
  assert.ok(!plain.args.includes('--wait'), 'no actions: nothing waits');
  const clicky = linux.toastCommand(spec, { withActions: true });
  assert.ok(clicky.args.includes('--action=default=Open'));
  assert.ok(clicky.args.includes('--action=a0=Join now'), 'an "=" in a label cannot forge an action key');
  assert.ok(clicky.args.includes('--wait'));
  assert.deepStrictEqual(clicky.links, { default: 'http://127.0.0.1:7300/#n-1', a0: 'https://teams.microsoft.com/l/x' }, 'only http(s) links');

  const win = windows.toastCommand(spec);
  assert.strictEqual(win.cmd, 'powershell.exe');
  assert.ok(!win.args.join(' ').includes('Stand-up'), 'the title rides base64-encoded');
  const mac = darwin.toastCommand(spec);
  assert.ok(mac.args.includes('-rf Stand-up') && !mac.args.slice(0, 6).join(' ').includes('Stand-up'), 'osascript reads the title from argv, never from the script');

  const ntfy = require('../src/notify/ntfy.ts');
  const r = ntfy.request({ server: 'https://ntfy.example/', topic: 'secret-topic', title: 'Brief: café', body: 'quote from mail', url: 'http://127.0.0.1:7300/' });
  assert.strictEqual(r.url, 'https://ntfy.example/', 'the topic is in the JSON body, never the URL');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.topic, 'secret-topic');
  assert.strictEqual(body.title, 'Brief: café');
  assert.ok(!r.body.includes('quote from mail'), 'titles only by default');
  assert.strictEqual(body.click, undefined, 'a loopback link means nothing on a phone');
  const withBody = JSON.parse(ntfy.request({ topic: 't', title: 'x', body: 'line', url: 'https://teams.microsoft.com/l/x', includeBody: true }).body);
  assert.strictEqual(withBody.message, 'line');
  assert.strictEqual(withBody.click, 'https://teams.microsoft.com/l/x');
}

// ---------------------------------------------------- secrets on Linux --
{
  const FAKE = 'fake-linux-tok-Q9z-not-real';
  const NAME = 'PA_TEST_LINUX_TOKEN';
  const vault = require('../src/secrets/vault.ts');

  const inv = linux.vault.invocation({ op: 'set', name: NAME, value: FAKE });
  assert.strictEqual(inv.command, 'secret-tool');
  assert.deepStrictEqual(inv.args, ['store', `--label=dev-tools [${common.stack()}]: ${NAME}`, 'service', 'dev-tools', 'stack', common.stack(), 'name', NAME]);
  assert.strictEqual(inv.input, FAKE, 'the value is stdin, verbatim, no trailing newline');
  for (const op of ['get', 'delete', 'list']) assert.ok(!('input' in linux.vault.invocation({ op, name: NAME })), `${op} sends nothing`);

  // A fake secret-tool, through the real facade.
  vault.useBackend('linux');
  // Keyed by service/name, like the real thing's attributes. OTHER_ENTRY is
  // an old, unlabelled entry: still readable, listed, and moved on rewrite.
  const store = new Map([['personal-assistant/OTHER_ENTRY', 'other-value-zz']]);
  const stored = (n) => store.get(`dev-tools/${n}`);
  const seen = [];
  vault.setRunner(({ command, args, input }) => {
    seen.push({ command, args });
    assert.strictEqual(command, 'secret-tool');
    const name = args[args.indexOf('name') + 1];
    const key = `${args[args.indexOf('service') + 1]}/${name}`;
    switch (args[0]) {
      case 'store':
        if (input === 'make-it-fail') return { stdout: '', stderr: `cannot store ${input}`, status: 1 };
        assert.strictEqual(args[args.indexOf('stack') + 1], common.stack(), 'new entries carry the stack');
        store.set(key, input);
        return { stdout: '', stderr: '', status: 0 };
      case 'lookup':
        return store.has(key) ? { stdout: store.get(key), stderr: '', status: 0 } : { stdout: '', stderr: '', status: 1 };
      case 'clear':
        store.delete(key);
        return { stdout: '', stderr: '', status: 0 };
      case 'search': {
        // secret-tool prints each secret with its attributes; only names may come out.
        const svc = args[args.indexOf('service') + 1];
        const mine = [...store].filter(([k]) => k.startsWith(`${svc}/`));
        return {
          stdout: mine.map(([k, v]) => `[/x]\nsecret = ${v}\nattribute.service = ${svc}\nattribute.name = ${k.split('/')[1]}\n`).join(''),
          stderr: '',
          status: mine.length ? 0 : 1,
        };
      }
      default:
        return { stdout: '', stderr: 'unknown', status: 2 };
    }
  });
  assert.strictEqual(vault.available(), true);
  assert.match(vault.label(), /Secret Service/);
  vault.set(NAME, FAKE);
  assert.strictEqual(stored(NAME), FAKE);
  assert.strictEqual(vault.get(NAME), FAKE);
  assert.strictEqual(vault.get('PA_NOT_THERE'), null, 'a miss is null, not an error');
  assert.deepStrictEqual(vault.list(), ['OTHER_ENTRY', NAME].sort(), 'names only, both generations');
  assert.strictEqual(vault.get('OTHER_ENTRY'), 'other-value-zz', 'an unlabelled entry is still read');
  vault.set('OTHER_ENTRY', 'moved-value');
  assert.ok(!store.has('personal-assistant/OTHER_ENTRY') && stored('OTHER_ENTRY') === 'moved-value', 'a rewrite moves it under the stack label');
  assert.throws(() => vault.set(NAME, 'make-it-fail'), (err) => !err.message.includes('make-it-fail') && /redacted/.test(err.message), 'a failure is scrubbed of the value');
  assert.strictEqual(vault.remove(NAME), true);
  assert.strictEqual(vault.remove(NAME), false);
  assert.throws(() => vault.get('lower-case'), /UPPER_SNAKE_CASE/);
  for (const s of seen) {
    const argv = s.args.join(' ');
    assert.ok(!argv.includes(FAKE) && !argv.includes('make-it-fail') && !argv.includes('other-value-zz'), `a value reached argv: ${argv}`);
  }

  // And through config.secret: real env → vault → .env, source reported, never the value.
  const cfg = require('../src/config.ts');
  store.set('dev-tools/PA_TEST_FROM_KEYRING', 'kr-value');
  cfg.forgetSecret();
  delete process.env.PA_TEST_FROM_KEYRING;
  assert.strictEqual(cfg.secret('PA_TEST_FROM_KEYRING'), 'kr-value');
  assert.strictEqual(cfg.secretSource('PA_TEST_FROM_KEYRING'), 'credential-manager');

  // A hanging keyring (locked, nobody to unlock it) is skipped for a while
  // instead of costing every lookup the timeout.
  vault.setRunner(() => ({ error: 'timed out', timedOut: true }));
  assert.throws(() => vault.get('PA_ANY'), /timed out/);
  vault.setRunner(null);
  vault.useBackend(null);
}

// -------------------------------------------------------- capture, Linux --
const SOURCES = [
  '50\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tIDLE',
  '51\talsa_input.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tRUNNING',
  '52\tbluez_input.AA_BB_CC_DD_EE_FF.0\tPipeWire\ts16le 1ch 16000Hz\tRUNNING',
].join('\n');
const OUTPUTS = `Source Output #90
\tDriver: PipeWire
\tOwner Module: n/a
\tClient: 88
\tSource: 52
\tSample Specification: float32le 1ch 48000Hz
\tCorked: yes
\tMute: no
\tProperties:
\t\tmedia.name = "WebRTC"
\t\tapplication.name = "Microsoft Edge"
\t\tapplication.process.binary = "msedge"
\t\tapplication.process.id = "4242"

Source Output #91
\tDriver: PipeWire
\tSource: 51
\tCorked: no
\tProperties:
\t\tmedia.name = "capture"
\t\tapplication.name = "python3"
\t\tapplication.process.binary = "python3.12"

Source Output #92
\tDriver: PipeWire
\tSource: 51
\tCorked: no
\tProperties:
\t\tmedia.name = "Peak detect"
\t\tapplication.name = "PulseAudio Volume Control"
\t\tapplication.process.binary = "pavucontrol"

Source Output #93
\tDriver: PipeWire
\tSource: 50
\tCorked: no
\tProperties:
\t\tapplication.name = "OBS"
\t\tapplication.process.binary = "obs"

Source Output #94
\tDriver: PipeWire
\tSource: 51
\tCorked: no
\tProperties:
\t\tapplication.name = "zoom"
\t\tapplication.process.binary = "zoom"
`;
{
  const outs = linux.parseSourceOutputs(OUTPUTS);
  assert.strictEqual(outs.length, 5);
  assert.deepStrictEqual(outs[0], { index: '90', source: '52', corked: true, props: { 'media.name': 'WebRTC', 'application.name': 'Microsoft Edge', 'application.process.binary': 'msedge', 'application.process.id': '4242' } });
  assert.deepStrictEqual(
    linux.micHoldersFromPactl(OUTPUTS, SOURCES),
    ['msedge', 'zoom'],
    'a muted (corked) call holds the mic; our Python, level meters and monitor recorders do not'
  );
  assert.deepStrictEqual(linux.micHoldersFromPactl('', SOURCES), []);
  assert.deepStrictEqual(linux.capture.restartCommand('mic'), { cmd: 'systemctl', args: ['--user', 'restart', 'pa-capture@mic.service'] });
  assert.strictEqual(linux.capture.restartHint('loopback'), 'systemctl --user restart pa-capture@loopback');
  assert.deepStrictEqual(linux.capture.micHoldersCommands().map((c) => [c.cmd, ...c.args, c.env.LC_ALL]), [
    ['pactl', 'list', 'source-outputs', 'C'],
    ['pactl', 'list', 'short', 'sources', 'C'],
  ], 'pactl in the C locale, whatever the desktop speaks');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-units-'));
  assert.strictEqual(linux.capture.installed({ env: { XDG_CONFIG_HOME: tmp } }), false, 'no unit, no restarts');
  fs.mkdirSync(path.join(tmp, 'systemd', 'user'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'systemd', 'user', 'pa-capture@.service'), '');
  assert.strictEqual(linux.capture.installed({ env: { XDG_CONFIG_HOME: tmp } }), true);
  fs.rmSync(tmp, { recursive: true, force: true });

  // The Windows registry read the gate used before, unchanged and re-exported.
  assert.strictEqual(require('../src/audio/gate').micHolders, windows.parseMicHolders);
  assert.deepStrictEqual(windows.capture.restartCommand('mic').cmd, 'powershell.exe');

  // The capture process's own reader (audio/devices_linux.py) agrees with the gate's.
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (py) {
    const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'audio'))})
import devices_linux as d
data = json.load(sys.stdin)
print(json.dumps({"active": d.active_sources(data["o"], data["s"]), "monitor": d.monitor_of("alsa_output.x"), "n": len(d.parse_source_outputs(data["o"]))}))
`;
    const out = JSON.parse(execFileSync(py, ['-I', '-c', script], { input: JSON.stringify({ o: OUTPUTS, s: SOURCES }) }).toString());
    assert.deepStrictEqual(out, { active: ['bluez_input.AA_BB_CC_DD_EE_FF.0', 'alsa_input.pci-0000_00_1f.3.analog-stereo'], monitor: 'alsa_output.x.monitor', n: 5 });
  } else {
    console.log('platform: python not found — devices_linux.py not exercised');
  }
}

// --------------------------------------------------------------- backup --
{
  const backup = require('../src/backup.ts');
  assert.deepStrictEqual(backup.parseTools('native'), { mode: 'native' });
  assert.deepStrictEqual(backup.parseTools('docker:pa-postgres'), { mode: 'docker', container: 'pa-postgres' });
  assert.deepStrictEqual(backup.parseTools('wsl:Ubuntu'), { mode: 'wsl', distro: 'Ubuntu' });
  assert.throws(() => backup.parseTools('ssh:box'), /PA_PG_TOOLS/);
  const url = 'postgres://pa:pa@127.0.0.1:5433/pa';
  assert.strictEqual(backup.containerUrl(url), 'postgres://pa:pa@127.0.0.1:5432/pa', 'inside the container the server is on 5432');
  // The password never rides the command line (ps shows it): PGPASSWORD.
  const bare = 'postgres://pa@127.0.0.1:5433/pa';
  assert.deepStrictEqual(backup.splitPassword(url), { url: bare, password: 'pa' });
  assert.deepStrictEqual(backup.splitPassword('postgres://u:p%40ss@h/db'), { url: 'postgres://u@h/db', password: 'p@ss' });
  assert.deepStrictEqual(backup.splitPassword('postgres://u@h/db'), { url: 'postgres://u@h/db', password: null });
  assert.deepStrictEqual(backup.dumpCommand({ mode: 'native' }, { url, file: '/b/pa.dump.partial' }), {
    cmd: 'pg_dump', args: ['--format=custom', '--compress=6', `--dbname=${bare}`, '--file=/b/pa.dump.partial'], env: { PGPASSWORD: 'pa' },
  });
  assert.deepStrictEqual(backup.dumpCommand({ mode: 'docker', container: 'pa-postgres' }, { url, file: '/b/pa.dump.partial' }), {
    cmd: 'docker', args: ['exec', '-e', 'PGPASSWORD', 'pa-postgres', 'pg_dump', '--format=custom', '--compress=6', '--dbname=postgres://pa@127.0.0.1:5432/pa'],
    env: { PGPASSWORD: 'pa' },
    stdoutFile: '/b/pa.dump.partial',
  });
  const wsl = backup.dumpCommand({ mode: 'wsl', distro: 'Ubuntu' }, { url, file: 'C:\\b\\pa.dump.partial' });
  assert.deepStrictEqual([wsl.cmd, wsl.args], ['wsl.exe', ['-d', 'Ubuntu', '--exec', 'pg_dump', '--format=custom', '--compress=6', `--dbname=${bare}`, '--file=/mnt/c/b/pa.dump.partial']]);
  assert.strictEqual(wsl.env.PGPASSWORD, 'pa');
  assert.match(wsl.env.WSLENV, /(^|:)PGPASSWORD\/u$/, 'carried into the distro');
  for (const c of [wsl, backup.dumpCommand({ mode: 'native' }, { url, file: '/x' })]) assert.ok(!c.args.some((a) => a.includes(':pa@')), 'no password in argv');
}

// ------------------------------------------------------ systemd units --
{
  const units = require('../linux/units');
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'linux', 'pa-capture@.service'), 'utf8');
  const out = units.render(tpl, {
    DIR: '/home/q/dev tools/pa', NODE: '/usr/bin/node', PY: '/d/50%off/venv/bin/python', AUDIO_DIR: '/d/a"b', PAUSE_FILE: '/d/p',
    ROLL_FILE: '/d/r', ROLL_MINUTES: 15, SAMPLE_RATE: 16000, MIC_ENV: '',
  });
  assert.ok(out.includes('ExecStart="/d/50%%off/venv/bin/python" "/home/q/dev tools/pa/audio/capture.py" --stream %i'), 'a % in a path is not a systemd specifier; %i is');
  assert.ok(out.includes('Environment="PA_AUDIO_DIR=/d/a\\"b"'), 'quotes cannot end the word');
  assert.ok(!/__[A-Z_]+__/.test(out), 'every placeholder filled');
  assert.throws(() => units.render('X=__NOPE__', {}), /no value/);
  const worker = units.render(fs.readFileSync(path.join(__dirname, '..', 'linux', 'pa-worker.service'), 'utf8'), { DIR: '/pa', NODE: '/n' });
  assert.ok(worker.includes('ExecStart=/bin/sh "/pa/linux/pa-launch.sh"'), 'the unit runs the launcher (Z4, 4.4)');
  assert.ok(worker.includes('Environment="PA_NODE=/n"'), 'with the node it was installed with');
  const voice = units.render(fs.readFileSync(path.join(__dirname, '..', 'linux', 'pa-voice.service'), 'utf8'), {
    DIR: '/pa', VOICE_PY: '/d/voice-venv/bin/python', VOICE_MODELS: '/d/voice models',
  });
  assert.ok(voice.includes('ExecStart="/d/voice-venv/bin/python" -I "/pa/voice/server.py" --models "/d/voice models"'));
  assert.ok(!/__[A-Z_]+__/.test(voice), 'every voice placeholder filled');
}

// ------------------------------------------------- paths from other OSes --
{
  const { toItem } = require('../src/ingest/claudeSessions.ts');
  const item = toItem({ sessionId: 's1', title: null, cwd: 'C:\\repos\\quill\\', turns: [], firstAt: null, lastAt: null }, 'x.jsonl', { machine: 'win-box' });
  assert.strictEqual(item.subject, 'Claude session in quill (on win-box)', 'a Windows cwd read on Linux names its folder');
  const posix = toItem({ sessionId: 's2', cwd: '/home/q/repos/quill', turns: [] }, 'y.jsonl');
  assert.strictEqual(posix.subject, 'Claude session in quill');
}

// ------------------------------------------------- config on this OS --
// Fresh processes, so config resolves its defaults from the env given.
{
  const probe = (env) =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', `const {config}=require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.ts'))});console.log(JSON.stringify(config.teamsCache))`], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), PA_TEAMS_CACHE: '1', ...env },
      }).toString()
    );
  if (platform.id === 'linux') {
    const off = probe({});
    assert.strictEqual(off.enabled, false, 'no 5-second Teams poll on Linux by default');
    assert.match(off.unsupported, /connector/);
    const on = probe({ PA_TEAMS_CACHE_DIR: '/tmp/x/https_teams.microsoft.com_0.indexeddb' });
    assert.strictEqual(on.enabled, true, 'an explicit cache dir opts in');
    assert.strictEqual(on.unsupported, null);
    assert.ok(on.python.endsWith(path.join('teams-venv', 'bin', 'python')));
    assert.strictEqual(probe({ PA_TEAMS_CACHE: '0', PA_TEAMS_CACHE_DIR: '/tmp/x' }).enabled, false);
  }
}

console.log('platform ok');
