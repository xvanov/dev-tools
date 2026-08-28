'use strict';

// Clipboard-staging eligibility tests. Plain node, no framework, no deps:
//   node test/clipboard.test.js
//
// These pin down the rule that made pasting an image into a session on a REMOTE
// machine fail while it "worked" on the machine the browser was sitting at. On
// the local machine the user had just copied the image to that OS clipboard
// themselves, so the agent found an image whether or not termhub staged one —
// every staging bug was invisible there and total everywhere else.
//
// The invariant: `clipboardTarget()` may only claim a clipboard the agent can
// actually READ BACK FROM. Claude Code asks X/Wayland for `image/png` by name
// and coerces the macOS clipboard to «class PNGf»; neither has a fallback. So
// a JPEG, and a tool that cannot type a selection at all (`xsel`), are not
// "best effort" — they are a guaranteed silent miss, and the caller must be told
// to write a file instead, which every agent reads regardless of format.
//
// Platform and env are swapped in-process because the decision is nothing but a
// function of them; the actual OS calls are covered by `POST /api/clipboard-probe`
// on a real host, which is the only place they can be.

const realPlatform = process.platform;

function asPlatform(platform, env, fn) {
  const savedEnv = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, PATH: process.env.PATH };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'PATH']) {
    if (key in env) {
      if (env[key] == null) delete process.env[key];
      else process.env[key] = env[key];
    }
  }
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The module reads process.platform per call, not at load time — that is what
// makes this testable at all, and it is worth a test of its own by implication.
const { clipboardTarget, CLIPBOARD_IMAGE_MIME } = require('../lib/clipboard');

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// A PATH with nothing on it: no xclip, no wl-copy, no xsel.
const NO_TOOLS = '/nonexistent-termhub-test-bin';

eq('the staged format is PNG', CLIPBOARD_IMAGE_MIME, 'image/png');

// ---- Windows: format-agnostic, because it decodes the file itself -----------

asPlatform('win32', {}, () => {
  eq('win32 stages a PNG', clipboardTarget('image/png').available, true);
  // Image::FromFile decodes JPEG/GIF/BMP and hands the OS a bitmap, so the
  // reader's ContainsImage() is satisfied whatever came off the browser.
  eq('win32 stages a JPEG too', clipboardTarget('image/jpeg').available, true);
  eq('win32 defaults to available', clipboardTarget().available, true);
});

// ---- macOS: PNG only, because the PNGf coercion has no alternative ----------

asPlatform('darwin', {}, () => {
  eq('darwin stages a PNG', clipboardTarget('image/png').available, true);
  eq('darwin refuses a JPEG', clipboardTarget('image/jpeg').available, false);
  check('darwin says why it refused', /PNG/i.test(clipboardTarget('image/jpeg').reason || ''),
    clipboardTarget('image/jpeg').reason);
});

// ---- Linux: needs a display AND a tool that can type a selection ------------

asPlatform('linux', { DISPLAY: null, WAYLAND_DISPLAY: null, PATH: NO_TOOLS }, () => {
  eq('headless linux has no clipboard', clipboardTarget('image/png').available, false);
  check('headless linux blames the display, not the tooling',
    /display/i.test(clipboardTarget('image/png').reason || ''),
    clipboardTarget('image/png').reason);
});

asPlatform('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: null, PATH: NO_TOOLS }, () => {
  // A display with nothing installed to talk to it is a fixable state, and the
  // reason has to say so — this is the one case where the user can act.
  eq('linux with a display but no tool has no clipboard', clipboardTarget('image/png').available, false);
  check('linux names the package to install',
    /xclip|wl-clipboard/.test(clipboardTarget('image/png').reason || ''),
    clipboardTarget('image/png').reason);
});

asPlatform('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: null, PATH: NO_TOOLS }, () => {
  // xsel used to be accepted here as a third choice. It cannot attach a MIME
  // type to a selection, so the image was offered to X untyped and the agent's
  // `xclip -t image/png -o` read back nothing — a clipboard that exits 0 and
  // pastes silence. Even with xsel present the answer must be "no clipboard".
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-xsel-'));
  fs.writeFileSync(path.join(dir, 'xsel'), '#!/bin/sh\n', { mode: 0o755 });
  process.env.PATH = dir;
  try {
    eq('xsel alone is not a clipboard', clipboardTarget('image/png').available, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

asPlatform('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: null, PATH: NO_TOOLS }, () => {
  // A JPEG is refused before the tool question is even asked: the reader wants
  // image/png by name, so there is nothing a present-and-working xclip could do.
  eq('linux refuses a JPEG regardless of tooling', clipboardTarget('image/jpeg').available, false);
});

if (failures.length) {
  console.error(`clipboard: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`clipboard: ${pass} passed`);
