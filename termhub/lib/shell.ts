'use strict';

//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (lib/types.ts): loose until its producer is TypeScript. */
type Json = import('./types.ts').Json;

const fs = require('fs');
const path = require('path');

// Find an executable on PATH (used to prefer pwsh over Windows PowerShell).
function findOnPath(names: any) {
  const PATH = process.env.PATH || '';
  const dirs = PATH.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          // keep looking
        }
      }
    }
  }
  return null;
}

// Resolve the default login shell for this OS. Overridable via TERMHUB_SHELL.
function defaultShell() {
  if (process.env.TERMHUB_SHELL) return process.env.TERMHUB_SHELL;

  if (process.platform === 'win32') {
    // Prefer PowerShell 7+ (pwsh) if installed, else Windows PowerShell.
    return (
      findOnPath(['pwsh']) ||
      findOnPath(['powershell']) ||
      process.env.COMSPEC ||
      'powershell.exe'
    );
  }

  return process.env.SHELL || (findOnPath(['bash']) || '/bin/bash');
}

// The arguments a session's shell is started with — today only the "no rc
// files" switch, `POST /api/sessions {noRc: true}`.
//
// Why it exists: a session started with `unsetEnv` (lib/sessionEnv.js) has the
// variables removed from the PTY's environment, but an interactive shell then
// sources ~/.bashrc / ~/.zshrc / $PROFILE, which can export them right back
// (a GH_TOKEN in .bashrc is common). The personal assistant's no-push runs ask
// for both. Per shell:
//
//   bash         --norc --noprofile (and BASH_ENV/ENV removed)
//   zsh          -f (NO_RCS). zsh still reads /etc/zshenv — a system file, not
//                the user's; nothing a zsh flag can turn off
//   fish         --no-config
//   pwsh / powershell  -NoProfile
//   sh / dash    no flag exists; an interactive sh reads only $ENV, so ENV is
//                removed from its environment
//   cmd          /D (skip the AutoRun registry commands)
//
// Any other shell is NOT pretended about: it starts normally and reports
// rcSkipped: false, so the caller can decide.
//
// Pure: shellPath → { args, unsetEnv, rcSkipped }.
function shellArgs(shellPath: any, { noRc = false }: { noRc?: boolean | undefined } = {}) {
  if (!noRc) return { args: [], unsetEnv: [], rcSkipped: false };
  const name = path.basename(String(shellPath || '').replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  switch (name) {
    case 'bash': return { args: ['--norc', '--noprofile'], unsetEnv: ['BASH_ENV', 'ENV'], rcSkipped: true };
    case 'zsh': return { args: ['-f'], unsetEnv: [], rcSkipped: true };
    case 'fish': return { args: ['--no-config'], unsetEnv: [], rcSkipped: true };
    case 'pwsh':
    case 'powershell': return { args: ['-NoProfile'], unsetEnv: [], rcSkipped: true };
    case 'sh':
    case 'dash': return { args: [], unsetEnv: ['ENV'], rcSkipped: true };
    case 'cmd': return { args: ['/D'], unsetEnv: [], rcSkipped: true };
    default: return { args: [], unsetEnv: [], rcSkipped: false };
  }
}

/** Pure. `noRc` from a request body: absent → false; anything but a boolean → {error}. */
function parseNoRc(body: any) {
  const v = body ? body.noRc : undefined;
  if (v === undefined || v === null) return { noRc: false, given: false };
  if (typeof v !== 'boolean') return { error: 'noRc must be a boolean' };
  return { noRc: v, given: true };
}

module.exports = { defaultShell, findOnPath, shellArgs, parseNoRc };
