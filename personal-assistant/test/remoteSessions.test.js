'use strict';

// Claude sessions from other machines (src/ingest/remoteSessions.js).
//
// What has to hold: a remote session becomes the same item a local one would,
// through the same parser, but with ids that cannot collide with a local row;
// an unchanged transcript is not fetched again; a failed fetch is retried; and
// a machine that is off or runs an older termhub is a line in `pa doctor`, not
// a crash. The store is faked — nothing here touches Postgres or a network.
// Machine names, paths and prompts are invented.

const assert = require('assert');
const path = require('path');

// ---- fake store, installed before the module under test loads it ----------
const storePath = require.resolve('../src/ingest/store');
const cursors = new Map();
const saved = [];
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    getCursor: async (source) => cursors.get(source) || null,
    saveCursor: async (c) => cursors.set(c.source, { source: c.source, state: c.state, last_error: null }),
    saveItems: async (source, items, c) => {
      saved.push({ source, items });
      cursors.set(c.source, { source: c.source, state: c.state, last_error: null });
      return items.length;
    },
    recordError: async (source, message) => cursors.set(source, { ...(cursors.get(source) || {}), source, last_error: message }),
  },
};

const remote = require('../src/ingest/remoteSessions');
const local = require('../src/ingest/claudeSessions');

const line = (o) => JSON.stringify(o);
const transcript = [
  line({ type: 'user', sessionId: 'sess-0001', cwd: 'C:\\source\\orchard', gitBranch: 'pa/run-7-fix', timestamp: '2026-10-20T09:00:00Z', message: { content: 'Fix the flaky upload test' } }),
  line({ type: 'assistant', sessionId: 'sess-0001', timestamp: '2026-10-20T09:05:00Z', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Pushed pa/run-7-fix with the retry fix.' }] } }),
  line({ type: 'ai-title', aiTitle: 'Flaky upload test' }),
  '{"type":"user","half-writ',
].join('\n');

// ---- the item: same parser, machine-scoped ids ----------------------------
{
  const parsed = local.parseTranscript(transcript);
  const mine = local.toItem(parsed, path.join('C:\\Users\\pat\\.claude\\projects\\C--source-orchard', 'sess-0001.jsonl'));
  const theirs = local.toItem(parsed, 'C--source-orchard/sess-0001.jsonl', { machine: 'build-vm' });

  assert.strictEqual(mine.externalId, 'sess-0001');
  assert.strictEqual(mine.threadExternalId, 'C:\\source\\orchard');
  assert.strictEqual(mine.raw.machine, undefined, 'a local item is unchanged');
  assert.strictEqual(mine.subject, 'Flaky upload test');

  assert.strictEqual(theirs.externalId, 'build-vm:sess-0001');
  assert.notStrictEqual(theirs.externalId, mine.externalId);
  assert.strictEqual(theirs.threadExternalId, 'build-vm:C:\\source\\orchard');
  assert.strictEqual(theirs.raw.machine, 'build-vm');
  assert.strictEqual(theirs.raw.cwd, 'C:\\source\\orchard', 'cwd stays the real path on that machine');
  assert.strictEqual(theirs.raw.gitBranch, 'pa/run-7-fix');
  assert.strictEqual(theirs.raw.transcript, 'C--source-orchard/sess-0001.jsonl');
  assert.strictEqual(theirs.subject, 'Flaky upload test (on build-vm)');
  assert.strictEqual(theirs.bodyText, mine.bodyText);
  assert.strictEqual(theirs.authorIdentity, 'me');

  // No session id in the file: the transcript's file name, still prefixed.
  const anon = local.toItem({ ...parsed, sessionId: null }, 'C--x/sess-0002.jsonl', { machine: 'build-vm' });
  assert.strictEqual(anon.externalId, 'build-vm:sess-0002');
}

// ---- plan: fetch new and changed, keep unchanged, forget what left --------
{
  const listing = [
    { id: 'p/a.jsonl', mtimeMs: 300, size: 30 },
    { id: 'p/b.jsonl', mtimeMs: 200, size: 20 },
    { id: 'p/c.jsonl', mtimeMs: 100, size: 10 },
  ];
  const known = {
    'p/b.jsonl': { mtimeMs: 200, size: 20 }, // unchanged
    'p/c.jsonl': { mtimeMs: 100, size: 9 }, // grew
    'p/gone.jsonl': { mtimeMs: 50, size: 5 }, // no longer listed
  };
  const { fetch, keep } = remote.plan(listing, known);
  assert.deepStrictEqual(fetch.map((t) => t.id), ['p/a.jsonl', 'p/c.jsonl']);
  assert.deepStrictEqual(Object.keys(keep), ['p/b.jsonl']);

  // Over budget: the newest go first; a changed one left over keeps its old
  // mark so it still reads as changed next pass.
  const capped = remote.plan(listing, known, 1);
  assert.deepStrictEqual(capped.fetch.map((t) => t.id), ['p/a.jsonl']);
  assert.deepStrictEqual(capped.keep['p/c.jsonl'], { mtimeMs: 100, size: 9 });

  assert.deepStrictEqual(remote.plan(null, null), { fetch: [], keep: {} });
  assert.deepStrictEqual(remote.plan([{ nope: 1 }], {}).fetch, []);
}

// ---- describeError ----------------------------------------------------------
{
  const old = Object.assign(new Error('termhub 404 on /api/claude/transcripts?limit=100: {"error":"not found"}'), { status: 404 });
  assert.match(remote.describeError(old, 'build-vm'), /termhub on build-vm is too old.*update/);
  const down = new Error('fetch failed');
  assert.match(remote.describeError(down, 'build-vm'), /termhub on build-vm unreachable: fetch failed/);
  const other = Object.assign(new Error('termhub 500 on x'), { status: 500 });
  assert.match(remote.describeError(other, 'build-vm'), /^termhub on build-vm: termhub 500/);
}

// ---- machinesToRead: never this machine -------------------------------------
{
  const machines = {
    'build-vm': { name: 'build-vm', url: 'http://build-vm:7000', reposRoot: 'C:\\source' },
    'desk-01': { name: 'desk-01', url: 'http://desk-01:7000', reposRoot: 'C:\\repos' },
  };
  assert.deepStrictEqual(remote.machinesToRead(machines, 'desk-01').map((m) => m.name), ['build-vm']);
  assert.deepStrictEqual(remote.machinesToRead({}, 'desk-01'), []);
}

// ---- runMachine against a fake termhub --------------------------------------
(async () => {
  const machine = { name: 'build-vm', url: 'http://build-vm:7000', reposRoot: 'C:\\source' };
  let listing = [
    { id: 'C--source-orchard/sess-0001.jsonl', mtimeMs: 1000, size: transcript.length },
    { id: 'C--source-orchard/empty.jsonl', mtimeMs: 900, size: 2 },
    { id: 'C--source-orchard/broken.jsonl', mtimeMs: 800, size: 4 },
  ];
  const fetched = [];
  const termhub = {
    client: (url) => {
      assert.strictEqual(url, machine.url);
      return {
        claudeTranscripts: async () => listing,
        claudeTranscript: async (id) => {
          fetched.push(id);
          if (id.endsWith('broken.jsonl')) throw Object.assign(new Error('termhub 404'), { status: 404 });
          return id.endsWith('empty.jsonl') ? '{}' : transcript;
        },
      };
    },
  };

  // First pass: everything new is fetched; a session with no turns is stored
  // as read (not refetched) but makes no item; a failed fetch is not recorded.
  const changed = await remote.runMachine(machine, termhub);
  assert.strictEqual(changed, 1);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].source, 'claude_session', 'remote sessions share the local source');
  assert.strictEqual(saved[0].items[0].externalId, 'build-vm:sess-0001');
  const state = cursors.get('claude_session@build-vm').state;
  assert.deepStrictEqual(Object.keys(state.files).sort(), ['C--source-orchard/empty.jsonl', 'C--source-orchard/sess-0001.jsonl']);
  assert.strictEqual(state.failed, 1);

  // Second pass, nothing changed: only the failed one is tried again.
  fetched.length = 0;
  assert.strictEqual(await remote.runMachine(machine, termhub), 0);
  assert.deepStrictEqual(fetched, ['C--source-orchard/broken.jsonl']);
  assert.strictEqual(saved.length, 1);

  // The session grew: fetched again.
  fetched.length = 0;
  listing = [{ ...listing[0], mtimeMs: 2000, size: transcript.length + 10 }, listing[1]];
  await remote.runMachine(machine, termhub);
  assert.deepStrictEqual(fetched, ['C--source-orchard/sess-0001.jsonl']);

  // run(): an unreachable machine is recorded on its own cursor, not thrown.
  const termhubModule = require('../src/dispatch/termhub');
  const realClient = termhubModule.client;
  const { config } = require('../src/config');
  const realMachines = config.termhub.machines;
  config.termhub.machines = { 'old-box': { name: 'old-box', url: 'http://old-box:7000', reposRoot: 'C:\\r' } };
  termhubModule.client = () => ({
    claudeTranscripts: async () => {
      throw Object.assign(new Error('termhub 404 on /api/claude/transcripts?limit=100: {"error":"not found"}'), { status: 404 });
    },
  });
  try {
    assert.strictEqual(await remote.run(), 0);
    assert.match(cursors.get('claude_session@old-box').last_error, /too old/);
  } finally {
    termhubModule.client = realClient;
    config.termhub.machines = realMachines;
  }

  console.log('remoteSessions.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
