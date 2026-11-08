'use strict';

// `pa passkeys` — the recovery path for passkey sign-in (plan 7.1).
//
//   pa passkeys status   whether the flag is on, how many passkeys, how many live sessions' worth of
//                        trust to drop; never prints a key
//   pa passkeys reset    forget every passkey and end every session. With none registered the
//                        dashboard's gate is open again and the next visit can register a new one.
//
// reset is for the local console only: it refuses unless stdin and stdout are a
// terminal, and it asks you to type RESET. It is not in the PA chat's allowed
// verbs (src/chat), so the assistant cannot run it through its own tool, and no
// HTTP route does it. A lost phone or a wiped authenticator is therefore a
// one-minute fix at the keyboard, not a lockout. The other exit, when the
// dashboard is unreachable for any reason, is setting PA_PASSKEYS=off.

const readline = require('readline');

const HELP = `
  Passkeys (PA_PASSKEYS=on)
    pa passkeys status               is it on, and how many passkeys are registered
    pa passkeys reset                forget every passkey and end every session — local console only;
                                     the dashboard then lets you register a new one (type RESET to confirm)
    Lost everything and cannot reach the dashboard? Set PA_PASSKEYS=off and restart the PA.
`;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

function make(out, fail) {
  return {
    async passkeys(args) {
      const { enabled } = require('../auth/settings.ts');
      const sub = (args[0] || 'status').toLowerCase();

      if (sub === 'status') {
        const repos = require('../repo');
        const n = await repos.passkeys.credentialCount();
        out(`  passkeys: ${enabled() ? 'ON' : 'off'} (PA_PASSKEYS)`);
        out(`  registered: ${n}${n === 0 && enabled() ? ' — the dashboard gate is open until you register one at /login' : ''}`);
        return;
      }

      if (sub === 'reset') {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          return fail('pa passkeys reset runs only at an interactive terminal on this machine (it is not available to scripts or agents)');
        }
        const answer = await ask('  This forgets every passkey and signs every browser out. Type RESET to continue: ');
        if (answer.trim() !== 'RESET') return fail('not reset');
        const repos = require('../repo');
        const keys = await repos.passkeys.deleteCredentials();
        const sessions = await repos.passkeys.deleteSessions();
        out(`  forgot ${keys} passkey(s), ended ${sessions} session(s).`);
        out(enabled()
          ? '  The dashboard gate is open again: visit /login to register a new passkey.'
          : '  PA_PASSKEYS is off, so nothing changed for access; register a new passkey after turning it on.');
        return;
      }

      fail(`unknown: pa passkeys ${sub}\n${HELP}`);
    },
  };
}

module.exports = { make, HELP };
