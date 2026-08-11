'use strict';

// Covers lib/claudeModel.js — the transcript resolver and model reader behind the
// sidebar's model badge and (via the same resolveTranscript) voiceHub's turn
// tailing. Both regressions pinned here were seen live: a badge stuck on
// `<synthetic>` after a spend-limit notice, and a badge permanently blank because
// the pinned transcript was an abandoned stub.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// claudeModel resolves paths under os.homedir(), which follows $HOME on POSIX and
// %USERPROFILE% on Windows. Set BOTH before requiring the module: with only $HOME
// set, os.homedir() on Windows returns the developer's real profile and every
// assertion here compares a throwaway path against it, so the suite failed on
// every Windows machine while passing on Linux.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-claudemodel-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const {
  transcriptPath, findActiveTranscript, resolveTranscript, readLastModel, formatModelName,
} = require('../lib/claudeModel');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

const CWD = '/home/k/proj';

function projectDir() {
  const dir = path.join(HOME, '.claude', 'projects', '-home-k-proj');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Write a transcript from compact entry specs, then stamp its mtime so ordering
// is deterministic rather than dependent on how fast the test runs.
function writeTranscript(uuid, entries, mtimeSec) {
  const file = path.join(projectDir(), `${uuid}.jsonl`);
  const lines = entries.map((e) => {
    if (e.user) return JSON.stringify({ type: 'user', message: { role: 'user', content: e.user } });
    return JSON.stringify({ type: 'assistant', message: { model: e.model, content: [] } });
  });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

console.log('claudeModel');

// --- path encoding ---------------------------------------------------------

ok('encodes cwd the way Claude Code does', () => {
  assert.strictEqual(
    transcriptPath('/home/k/proj', 'abc'),
    path.join(HOME, '.claude', 'projects', '-home-k-proj', 'abc.jsonl'),
  );
});

ok('strips a trailing separator the picker adds', () => {
  assert.strictEqual(transcriptPath('/home/k/proj/', 'abc'), transcriptPath('/home/k/proj', 'abc'));
});

ok('keeps the separator when it is the whole path', () => {
  assert.strictEqual(path.basename(path.dirname(transcriptPath('/', 'abc'))), '-');
});

// --- formatModelName -------------------------------------------------------

ok('formats model ids', () => {
  assert.strictEqual(formatModelName('claude-sonnet-5'), 'Sonnet 5');
  assert.strictEqual(formatModelName('claude-opus-4-8'), 'Opus 4.8');
  assert.strictEqual(formatModelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.strictEqual(formatModelName(null), null);
});

// --- readLastModel ---------------------------------------------------------

ok('reads the newest real model', () => {
  const f = writeTranscript('m1', [{ user: 'hi' }, { model: 'claude-opus-5' }], 1000);
  assert.strictEqual(readLastModel(f), 'claude-opus-5');
});

// The live bug: Claude Code files spend-limit and interrupt notices as assistant
// entries with model "<synthetic>", so they are the newest entry after any
// interrupt and used to become the badge text verbatim.
ok('walks back past <synthetic> notices to the last real turn', () => {
  const f = writeTranscript('m2', [
    { model: 'claude-opus-5' },
    { user: 'go' },
    { model: '<synthetic>' },
  ], 1000);
  assert.strictEqual(readLastModel(f), 'claude-opus-5');
});

ok('reports no model when a transcript is only synthetic', () => {
  const f = writeTranscript('m3', [{ user: 'go' }, { model: '<synthetic>' }], 1000);
  assert.strictEqual(readLastModel(f), null);
});

ok('survives a truncated/corrupt line', () => {
  const f = path.join(projectDir(), 'm4.jsonl');
  fs.writeFileSync(f, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } })}\n{"type":"assis\n`);
  fs.utimesSync(f, 1000, 1000); // keep it out of the way of the newest-wins cases below
  assert.strictEqual(readLastModel(f), 'claude-opus-5');
});

ok('returns null for a missing file rather than throwing', () => {
  assert.strictEqual(readLastModel(path.join(projectDir(), 'nope.jsonl')), null);
});

// --- resolveTranscript -----------------------------------------------------

ok('prefers the pinned transcript while it is a real conversation', () => {
  const pinned = writeTranscript('p1', [{ model: 'claude-opus-5' }], 2000);
  writeTranscript('other1', [{ model: 'claude-sonnet-5' }], 9000); // newer, but not ours
  assert.strictEqual(resolveTranscript(CWD, 'p1', 0), pinned);
});

// The live bug: termhub pinned --session-id p2, Claude Code forked the real
// conversation to a new uuid, and the stub it left behind won forever — no model
// badge, and voiceHub tailing a file that would never change again.
ok('abandons a pinned stub once a newer transcript exists', () => {
  writeTranscript('p2', [{ user: 'hi' }], 2000); // stub: no assistant turn
  const live = writeTranscript('live2', [{ model: 'claude-opus-5' }], 9000);
  assert.strictEqual(resolveTranscript(CWD, 'p2', 0), live);
});

// The other half of that judgement: a just-launched session has no assistant turn
// either, and must not be handed some older conversation's transcript.
ok('keeps a turnless pinned transcript while it is the newest', () => {
  const pinned = writeTranscript('p3', [{ user: 'hi' }], 9500);
  writeTranscript('older3', [{ model: 'claude-sonnet-5' }], 3000);
  assert.strictEqual(resolveTranscript(CWD, 'p3', 0), pinned);
});

ok('falls back to the newest transcript when nothing is pinned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  fs.mkdirSync(path.join(HOME, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const enc = path.join(HOME, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.writeFileSync(path.join(enc, 'a.jsonl'), JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } }) + '\n');
  fs.utimesSync(path.join(enc, 'a.jsonl'), 5000, 5000);
  assert.strictEqual(resolveTranscript(dir, null, 0), path.join(enc, 'a.jsonl'));
});

ok('rejects a transcript older than the session that asked for it', () => {
  const dir = '/home/k/emptyproj';
  const enc = path.join(HOME, '.claude', 'projects', '-home-k-emptyproj');
  fs.mkdirSync(enc, { recursive: true });
  fs.writeFileSync(path.join(enc, 'old.jsonl'), JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } }) + '\n');
  fs.utimesSync(path.join(enc, 'old.jsonl'), 1000, 1000);
  assert.strictEqual(findActiveTranscript(dir, 5000 * 1000), null);
  assert.strictEqual(resolveTranscript(dir, null, 5000 * 1000), null);
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed`);
