'use strict';

// Audio ingest must get past its settle step whenever there is a sidecar to
// read. (The bug, 2026-11-10: a local `spool = config.audioDir` shadowed the
// spool module, so every pass threw "spool.coverage is not a function" and a
// whole day of meetings, the all-company one among them, got no transcript.)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-audio-run-'));
fs.mkdirSync(path.join(dir, 'mic'));
fs.writeFileSync(path.join(dir, 'mic', '20261110T130015-mic.speech.json'), JSON.stringify({ groups: [] }));
process.env.PA_AUDIO_DIR = dir;

const audio = require('../src/ingest/audio.ts');

(async () => {
  try {
    await audio.run();
  } catch (err) {
    // Past the settle step it may need the store; what it must never do is
    // fail on the spool module itself.
    assert.ok(!/spool\.|is not a function/.test(String(err && err.message)), `audio ingest broke before the store: ${err && err.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('audioIngestRun: ok');
})();
