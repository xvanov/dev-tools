'use strict';

// src/dashboard/voiceCapture.js and micWorklet.js are copies of termhub's
// web/voiceCapture.js and web/micWorklet.js (the mic graph, resampler, one-mic
// BroadcastChannel and wake lock), which the voice page loads as
// talk.capture.js and talk.worklet.js. The PA serves its own copies so /talk
// works on 127.0.0.1:7300 without termhub. termhub's are canonical; this test
// fails when a copy drifts, and `node test/voiceCaptureCopy.test.js --write`
// copies them over. Skipped when the termhub directory is not there.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CANON = path.join(__dirname, '..', '..', 'termhub', 'web');
const HERE = path.join(__dirname, '..', 'src', 'dashboard');
const FILES = ['voiceCapture.js', 'micWorklet.js'];
const norm = (s) => s.replace(/\r\n/g, '\n');

if (!fs.existsSync(CANON)) {
  console.log('voiceCaptureCopy: skipped (no ../termhub)');
  process.exit(0);
}

if (process.argv.includes('--write')) {
  for (const f of FILES) {
    fs.copyFileSync(path.join(CANON, f), path.join(HERE, f));
    console.log(`voiceCaptureCopy: copied ${f}`);
  }
  process.exit(0);
}

for (const f of FILES) {
  const canon = norm(fs.readFileSync(path.join(CANON, f), 'utf8'));
  const copy = norm(fs.readFileSync(path.join(HERE, f), 'utf8'));
  assert.ok(canon === copy, `src/dashboard/${f} differs from termhub/web/${f} — run \`node test/voiceCaptureCopy.test.js --write\``);
}

// The page uses what it copied: the capture API it calls must be there.
const VC = require('../src/dashboard/voiceCapture');
for (const k of ['createResampler', 'createMicCapture', 'createMicOwner', 'createWakeLock']) assert.strictEqual(typeof VC[k], 'function', k);

console.log('voiceCaptureCopy ok');
