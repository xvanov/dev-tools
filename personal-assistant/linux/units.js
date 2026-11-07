'use strict';

// Renders the systemd user units in this folder with this machine's paths and
// writes them to ~/.config/systemd/user. Called by linux/install.sh; safe to
// re-run (a re-run after editing .env moves capture to the new paths).
//
// Values come from src/config.js — the worker's own resolution, .env included
// — so capture writes exactly where the worker reads. Every value is quoted
// and escaped for systemd: `%` is a specifier there (an `%i` in a path would
// be expanded), and `"`/`\` would end or bend the quoting.
//
//   node linux/units.js [--worker] [--capture] [--voice]

const fs = require('fs');
const path = require('path');

// One value inside a double-quoted systemd word.
function quote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
}

/** Pure: a template with each __KEY__ replaced by its escaped value. */
function render(template, values) {
  return template.replace(/__([A-Z_]+)__/g, (m, key) => {
    if (!(key in values)) throw new Error(`units: no value for ${m}`);
    return key === 'MIC_ENV' ? values[key] : quote(values[key]);
  });
}

function values() {
  const { config, env } = require('../src/config');
  const mic = env('PA_AUDIO_MIC');
  return {
    DIR: path.resolve(__dirname, '..'),
    NODE: process.execPath,
    PY: config.audio.python,
    AUDIO_DIR: config.audioDir,
    PAUSE_FILE: config.audio.pauseFile,
    ROLL_FILE: config.audio.rollFile,
    ROLL_MINUTES: config.audio.rollMinutes,
    SAMPLE_RATE: config.audio.sampleRate,
    MIC_ENV: mic ? `Environment="PA_AUDIO_MIC=${quote(mic)}"` : '# PA_AUDIO_MIC unset: headset|hands-free',
    VOICE_PY: config.voice.python,
    VOICE_MODELS: config.voice.models,
  };
}

function unitDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config');
  return path.join(base, 'systemd', 'user');
}

function main(argv) {
  const want = { worker: argv.includes('--worker'), capture: argv.includes('--capture'), voice: argv.includes('--voice') };
  const v = values();
  const dir = unitDir();
  fs.mkdirSync(dir, { recursive: true });
  const write = (name) => {
    const out = path.join(dir, name);
    fs.writeFileSync(out, render(fs.readFileSync(path.join(__dirname, name), 'utf8'), v));
    console.log(`wrote ${out}`);
  };
  if (want.worker) write('pa-worker.service');
  if (want.capture) write('pa-capture@.service');
  if (want.voice) write('pa-voice.service');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { render, quote };
