'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Per-user data directory for termhub (recents, etc.). Mirrors the layout used
// by the other tools in this repo (e.g. ~/.local/voice-dictation on Linux).
function dataDir() {
  if (process.env.TERMHUB_DATA_DIR) return process.env.TERMHUB_DATA_DIR;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'termhub');
  }
  return path.join(os.homedir(), '.local', 'termhub');
}

function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { dataDir, ensureDataDir };
