'use strict';

// lib/transcripts.js — the read-only transcript routes the personal assistant
// uses to ingest Claude sessions from this machine.
//
// What earns a test: listing is newest-first, top level only (subagent files
// are not sessions), and filtered by `since`; and the id cannot reach a file
// outside ~/.claude/projects — not by `..`, not by an absolute path, not by a
// separator smuggled into a segment, and not through a junction/symlink that
// points elsewhere.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listTranscripts, resolveTranscript } = require('../lib/transcripts');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-transcripts-'));
const root = path.join(base, 'projects');
const outside = path.join(base, 'secret');
fs.mkdirSync(path.join(root, 'C--repos-demo', 'aaaa-1111', 'subagents'), { recursive: true });
fs.mkdirSync(path.join(root, '-home-pat-tool'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const write = (p, text, mtimeSec) => {
  fs.writeFileSync(p, text);
  fs.utimesSync(p, mtimeSec, mtimeSec);
};
write(path.join(root, 'C--repos-demo', 'aaaa-1111.jsonl'), '{"a":1}\n', 1_700_000_100);
write(path.join(root, 'C--repos-demo', 'notes.txt'), 'not a transcript', 1_700_000_200);
write(path.join(root, 'C--repos-demo', 'aaaa-1111', 'subagents', 'agent-x.jsonl'), '{}\n', 1_700_000_300);
write(path.join(root, '-home-pat-tool', 'bbbb-2222.jsonl'), '{"b":2}\n{"b":3}\n', 1_700_000_200);
write(path.join(outside, 'leak.jsonl'), '{"secret":true}\n', 1_700_000_400);

try {
  {
    const list = listTranscripts({ root });
    assert.deepStrictEqual(list.map((t) => t.id), ['-home-pat-tool/bbbb-2222.jsonl', 'C--repos-demo/aaaa-1111.jsonl']);
    assert.strictEqual(list[0].size, 16);
    assert.strictEqual(list[0].mtimeMs, 1_700_000_200_000);
    assert.strictEqual(list[0].project, '-home-pat-tool');
  }

  {
    // `since` is exclusive, so a reader passing back the newest mtime it saw
    // does not get that file again.
    assert.deepStrictEqual(listTranscripts({ root, since: 1_700_000_100_000 }).map((t) => t.file), ['bbbb-2222.jsonl']);
    assert.strictEqual(listTranscripts({ root, limit: 1 }).length, 1);
    assert.strictEqual(listTranscripts({ root, limit: 'nonsense' }).length, 2);
    assert.deepStrictEqual(listTranscripts({ root: path.join(base, 'missing') }), []);
  }

  {
    const ok = resolveTranscript('C--repos-demo/aaaa-1111.jsonl', { root });
    assert.ok(ok.path && !ok.error);
    assert.strictEqual(fs.readFileSync(ok.path, 'utf8'), '{"a":1}\n');
    assert.strictEqual(ok.size, 8);
  }

  {
    const bad = [
      '',
      null,
      'C--repos-demo',
      '../secret/leak.jsonl',
      '../../secret/leak.jsonl',
      '../secret',
      '../leak.jsonl',
      'C--repos-demo/../../secret/leak.jsonl',
      `${outside}/leak.jsonl`,
      'C--repos-demo/aaaa-1111/subagents/agent-x.jsonl',
      'C--repos-demo/notes.txt',
      'C--repos-demo\\..\\..\\secret/leak.jsonl',
      '../secret/leak.jsonl'.replace(/\//g, '%2F'),
      'C:/leak.jsonl',
    ];
    for (const id of bad) {
      const r = resolveTranscript(id, { root });
      assert.ok(r.error && !r.path, `should refuse ${JSON.stringify(id)}`);
      assert.ok([400, 403, 404].includes(r.status), `${id} -> ${r.status}`);
    }
    assert.strictEqual(resolveTranscript('C--repos-demo/nope.jsonl', { root }).status, 404);
  }

  {
    // A project folder that is a link to somewhere else is refused, not
    // followed. On Windows a junction needs no privilege; elsewhere a symlink.
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(root, 'C--linked'), process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch {
      /* no permission to link here; the pattern checks above still hold */
    }
    if (linked) {
      const r = resolveTranscript('C--linked/leak.jsonl', { root });
      assert.strictEqual(r.status, 403);
      assert.ok(!r.path);
    }
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('transcripts.test.js ok');
