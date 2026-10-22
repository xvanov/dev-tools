'use strict';

// `pa secret` — set, list, request and delete credentials without a text
// editor and without the value ever reaching argv, a log, or a model.
//
// `set` reads the value from a hidden prompt (nothing echoed) or from piped
// stdin, never from an argument: an argument lands in shell history and is
// visible to every process on the machine for as long as `pa` runs.

const { flagBool } = require('./parseArgs');

const HELP = `
  Secrets
    pa secret list                       names, where each is stored, when it was set — never values
    pa secret set <NAME> [--env-file]    prompt (hidden) and store it; Credential Manager by default
    pa secret request <NAME> --purpose "…" [--hint "…"] [--url https://…] [--env-file]
                                         ask for it in the dashboard instead
    pa secret delete <NAME>              remove it from Credential Manager and .env
`;

function day(v) {
  return v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '';
}

// Reads a line from the terminal with echo off. Raw mode means we see each
// key: Enter ends, Backspace edits, Ctrl+C aborts. Nothing is written back
// except the prompt and a newline.
function readHidden(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Piped: `Get-Clipboard | pa secret set NAME`. Still not argv.
    return new Promise((resolve, reject) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { data += d; });
      stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      stdin.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    }
    stdin.on('data', onData);
  });
}

function make(out, fail) {
  return {
    async secret(args, flags) {
      const secrets = require('../secrets');
      const sub = (args[0] || 'list').toLowerCase();
      const name = args[1];

      if (sub === 'list') {
        const r = await secrets.list();
        out('  name                       stored in             set');
        for (const s of r.secrets) {
          out(`  ${s.name.padEnd(26)} ${(s.source || 'not configured').padEnd(21)} ${day(s.set_at)}`);
        }
        if (r.vaultError) out(`\n  credential manager unreadable: ${r.vaultError}`);
        if (r.pending.length) {
          out('\n  waiting for you (dashboard → Needs you, or `pa secret set <NAME>`)');
          for (const p of r.pending) {
            out(`    #${p.id} ${p.kind === 'login' ? p.purpose : p.name} — ${p.kind === 'login' ? p.command || p.hint || '' : p.purpose}`);
          }
        }
        return;
      }

      if (sub === 'set') {
        if (!name) return fail('usage: pa secret set <NAME> [--env-file]');
        if (args[2] !== undefined) return fail('the value is never an argument — run `pa secret set NAME` and paste at the prompt');
        const target = flagBool(flags, 'env-file') ? 'env-file' : 'credential-manager';
        const value = await readHidden(`${name} (input hidden): `);
        if (!value.trim()) return fail('nothing entered — nothing stored');
        const r = await secrets.store(name, value, { target, by: 'cli' });
        out(`stored ${r.name} in ${r.stored === 'env-file' ? 'personal-assistant/.env' : 'Windows Credential Manager'}`);
        return;
      }

      if (sub === 'request') {
        if (!name || typeof flags.purpose !== 'string') {
          return fail('usage: pa secret request <NAME> --purpose "why it is needed" [--hint "…"] [--url https://…]');
        }
        const r = await secrets.requestSecret({
          name,
          purpose: flags.purpose,
          hint: typeof flags.hint === 'string' ? flags.hint : null,
          url: typeof flags.url === 'string' ? flags.url : null,
          requestedBy: 'cli',
          target: flagBool(flags, 'env-file') ? 'env-file' : 'credential-manager',
        });
        out(r.status === 'configured'
          ? `${name} is already configured — \`pa secret set ${name}\` replaces it`
          : `request #${r.id} ${r.existing ? 'already open' : 'opened'} — answer it in the dashboard (Needs you)`);
        return;
      }

      if (sub === 'delete' || sub === 'rm') {
        if (!name) return fail('usage: pa secret delete <NAME>');
        const r = await secrets.remove(name);
        out(r.removed ? `removed ${name} from ${r.from.join(' and ')}` : `${name} was not stored here (a real env var is yours to unset)`);
        return;
      }

      fail(`unknown: pa secret ${sub}\n${HELP}`);
    },
  };
}

module.exports = { make, HELP, readHidden };
