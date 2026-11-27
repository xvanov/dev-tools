'use strict';

// Command line for the secrets service. Agents call `request`; you call `set` or
// the spec commands. No command ever prints a secret value.
//
//   node lib/secrets-cli.ts list
//   node lib/secrets-cli.ts status NAME
//   node lib/secrets-cli.ts request NAME --requester claude-cloud
//       exit 0 = present, 2 = missing (popup opened on this machine), 3 = denied
//   node lib/secrets-cli.ts set NAME              (no screen: hidden prompt in this terminal;
//                                                  with a screen: opens the popup)
//   node lib/secrets-cli.ts clear NAME
//   node lib/secrets-cli.ts spec-add NAME --description "..." --destination "..." --requesters a,b
//   node lib/secrets-cli.ts spec-remove NAME
//   node lib/secrets-cli.ts set-missing           (one pass over every key with no value yet)
//   node lib/secrets-cli.ts serve                 (popup server in the foreground)
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const secrets = require('./secrets.ts');

const PORT = Number(process.env.TERMHUB_SECRETS_PORT || 7040);
const POPUP = path.join(__dirname, 'secretsPopup.ts');

function parseFlags(argv: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = v;
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** Is the popup server answering on loopback? */
function popupUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', timeout: 800 }, (res: any) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** Start the popup in the background if it is not already running. */
async function ensurePopup(): Promise<void> {
  if (await popupUp()) return;
  const child = spawn(process.execPath, [POPUP], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await popupUp()) return;
  }
  throw new Error('the secrets popup did not start');
}

/** No screen here: the value is typed in this terminal, with no echo. */
function headless(): boolean {
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/** Read one line from the terminal with echo off. The line never reaches a log. */
function readHidden(label: string): string {
  const tty = fs.openSync('/dev/tty', 'r+');
  fs.writeSync(tty, label);
  spawnSync('stty', ['-echo'], { stdio: [tty, 'ignore', 'ignore'] });
  let line = '';
  try {
    const buf = Buffer.alloc(1);
    while (fs.readSync(tty, buf, 0, 1, null) === 1) {
      const c = buf[0] as number; // readSync just filled it
      if (c === 10 || c === 13) break;
      line += String.fromCharCode(c);
    }
  } finally {
    spawnSync('stty', ['echo'], { stdio: [tty, 'ignore', 'ignore'] });
    fs.writeSync(tty, '\n');
    fs.closeSync(tty);
  }
  return line;
}

/** Open the popup page for one secret in the desktop browser, if there is one. */
function openPopup(name: string): string {
  const url = `http://127.0.0.1:${PORT}/?name=${encodeURIComponent(name)}`;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const r = spawnSync(opener, [url], { stdio: 'ignore' });
  return r.status === 0 ? `popup opened: ${url}` : `open this page yourself: ${url}`;
}

async function main(argv: string[]): Promise<number> {
  const [cmd = 'list', ...rest] = argv;
  const { pos, flags } = parseFlags(rest);
  const name = pos[0] || '';

  switch (cmd) {
    case 'list': {
      for (const s of secrets.readSpec()) {
        console.log(`${secrets.status(s.name).padEnd(8)} ${s.name}  ${s.description}`);
      }
      return 0;
    }
    case 'status': {
      console.log(secrets.status(name));
      return 0;
    }
    case 'request': {
      const requester = flags.requester || '';
      if (!requester) throw new Error('request needs --requester');
      const r = secrets.request(name, requester);
      if (r.result === 'present') { console.log('present'); return 0; }
      if (r.result === 'denied') { console.log(`denied: ${r.reason}`); return 3; }
      await ensurePopup();
      console.log(`missing. ${openPopup(name)}`);
      return 2;
    }
    case 'set': {
      if (!secrets.findSpec(name)) throw new Error(`${name} is not in the spec; run spec-add first`);
      if (headless()) {
        const value = readHidden(`Value for ${name} (typing is hidden): `);
        if (!value) throw new Error('empty value, nothing saved');
        secrets.setSecret(name, value);
        console.log(`saved ${name}`);
        return 0;
      }
      await ensurePopup();
      console.log(openPopup(name));
      return 0;
    }
    case 'clear': {
      secrets.clearSecret(name);
      console.log(`cleared ${name}`);
      return 0;
    }
    case 'spec-add': {
      secrets.upsertSpec({
        name,
        description: flags.description || '',
        destination: flags.destination || '',
        requesters: (flags.requesters || '').split(',').map((s) => s.trim()).filter(Boolean),
      });
      console.log(`spec: ${name}`);
      return 0;
    }
    case 'spec-remove': {
      secrets.removeSpec(name);
      console.log(`removed from spec: ${name} (password store value untouched; use clear to delete it)`);
      return 0;
    }
    case 'set-missing': {
      // One pass over every key that has no value yet. Enter skips one.
      const todo = secrets.readSpec().filter((s: any) => secrets.status(s.name) === 'missing');
      if (!todo.length) { console.log('Every key already has a value.'); return 0; }
      console.log(`${todo.length} keys to fill. Type each value (hidden) and press Enter; press Enter alone to skip.`);
      for (const s of todo) {
        const value = readHidden(`${s.name}: `);
        if (!value) { console.log('  skipped'); continue; }
        secrets.setSecret(s.name, value);
        console.log('  saved');
      }
      return 0;
    }
    case 'serve': {
      // Requiring the module only defines it (it starts itself only as the main
      // module), so start it here.
      require('./secretsPopup.ts').start();
      console.log(`secrets popup on http://127.0.0.1:${PORT}/`);
      return -1; // keep the process alive; the server holds it
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { if (code >= 0) process.exitCode = code; },
    (e: any) => { console.error(`error: ${e.message}`); process.exitCode = 1; },
  );
}

module.exports = { main };
