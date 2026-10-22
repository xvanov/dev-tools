'use strict';

// Capture file naming lives in Python (audio/naming.py); this runs its check
// with whichever Python is here — the audio venv, else one on PATH — and
// skips, saying so, on a machine with neither.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { config } = require('../src/config');

const script = path.join(__dirname, 'naming_check.py');
const candidates = [config.audio.python, 'python', 'python3', 'py'].filter((p) => p && (!path.isAbsolute(p) || fs.existsSync(p)));

let ran = false;
for (const py of candidates) {
  const r = spawnSync(py, [script], { encoding: 'utf8' });
  if (r.error) continue;
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr);
    process.exit(1);
  }
  process.stdout.write(r.stdout);
  ran = true;
  break;
}
if (!ran) console.log('naming skipped (no python)');
