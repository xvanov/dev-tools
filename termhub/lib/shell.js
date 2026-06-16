'use strict';

const fs = require('fs');
const path = require('path');

// Find an executable on PATH (used to prefer pwsh over Windows PowerShell).
function findOnPath(names) {
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

module.exports = { defaultShell, findOnPath };
