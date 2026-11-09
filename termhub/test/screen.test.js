'use strict';

// One PTY, several browsers: what a newly attached browser is shown, and who
// gets to set the size.
//
// The cases that earned their place:
//  - The snapshot is the screen *at the current size*. Output written at 120
//    columns and then resized to 40 must come back reflowed to 40, because that
//    is the size the attaching browser will render at. Raw replay handed it the
//    120-column bytes, which is the "switch from laptop to phone and everything
//    is mangled" bug.
//  - A resize lands at its place in the byte stream: output from before it is
//    laid out at the old width, output after at the new one.
//  - Output produced while a snapshot is being taken reaches the new client
//    exactly once, after the snapshot — never lost in the gap, never duplicated.
//  - A resize is a claim: every client hears the new size and who owns it, a
//    same-size claim moves ownership without touching the PTY, and the owner
//    detaching releases it.
//  - Without @xterm/headless the mirror degrades to the raw byte buffer rather
//    than throwing.

const assert = require('assert');
const os = require('os');
const { ScreenMirror, mirrorAvailable } = require('../lib/screenMirror.ts');

const { Terminal } = require('@xterm/headless');

const flush = (m) => new Promise((resolve) => m.snapshot(resolve));
// What a browser shows after writing the snapshot into a terminal of the
// snapshot's size — the thing that actually has to be right.
const render = (snap) => new Promise((resolve) => {
  const t = new Terminal({ cols: snap.cols, rows: snap.rows, allowProposedApi: true });
  t.write(snap.data, () => {
    const buf = t.buffer.active; const out = [];
    for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i).translateToString(true));
    t.dispose();
    resolve(out);
  });
});

(async () => {
  assert.ok(mirrorAvailable, '@xterm/headless + @xterm/addon-serialize must be installed');

  // ---- the mirror ----------------------------------------------------------
  {
    const m = new ScreenMirror({ cols: 120, rows: 10 });
    assert.strictEqual(m.kind, 'mirror');
    const line = 'x'.repeat(100);
    m.write(line + '\r\n');
    let snap = await flush(m);
    assert.strictEqual(snap.cols, 120);
    assert.ok(snap.data.includes(line), 'one unwrapped 100-char line at 120 cols');

    m.resize(40, 10);
    snap = await flush(m);
    assert.strictEqual(snap.cols, 40);
    assert.strictEqual(snap.rows, 10);
    // Reflowed: rendered at 40 cols it is three rows of 40, 40, 20 x's.
    const shown = (await render(snap)).filter((r) => r);
    assert.deepStrictEqual(shown, ['x'.repeat(40), 'x'.repeat(40), 'x'.repeat(20)]);
    m.dispose();
  }

  {
    // Ordering: bytes written before resize() are parsed at the old size even
    // though xterm hasn't parsed them yet when resize() is called.
    // Misordered, the cursor move would be clamped to column 10 and overwrite
    // the 'j'; ordered, 'Z' lands at column 15 and reflows onto the next row.
    const m = new ScreenMirror({ cols: 20, rows: 5 });
    m.write('abcdefghij\x1b[1;15HZ\r\n');
    m.resize(10, 5);
    m.write('B');
    const snap = await flush(m);
    assert.strictEqual(snap.cols, 10);
    // Read the mirror's own buffer rather than rendering the snapshot: the
    // serializer writes a wrapped row that *starts* with never-written cells as
    // a cursor-forward from the pending-wrap position, which a real terminal
    // clamps instead of wrapping (addon-serialize 0.13). Rare — it needs a
    // cursor-positioned gap to land exactly on a wrap boundary after a shrink,
    // and a TUI repaints on the resize anyway — and not what this case tests.
    const buf = m._term.buffer.active;
    const shown = [0, 1, 2].map((i) => buf.getLine(i).translateToString(true));
    assert.deepStrictEqual(shown, ['abcdefghij', '    Z', 'B']);
    m.dispose();
  }

  {
    const m = new ScreenMirror({ cols: 30, rows: 5, forceRaw: true, maxBytes: 10 });
    assert.strictEqual(m.kind, 'raw');
    m.write('hello');
    m.write(' world, and more');
    m.resize(20, 5);
    const snap = await flush(m);
    assert.strictEqual(snap.cols, 20);
    assert.strictEqual(snap.data, ' world, and more', 'raw buffer keeps the newest chunk over budget');
  }

  // ---- the session ---------------------------------------------------------
  const { startSparePtyd, findPtyd, ptydMissing } = require('./spareTermhub');
  if (!findPtyd()) {
    const why = ptydMissing();
    console.log('screen.test.js: session cases skipped (' + why + ')');
    console.log('screen.test.js: ok');
    return;
  }
  const ptyd = await startSparePtyd(os.tmpdir());
  process.env.TERMHUB_PTYD = '1';
  process.env.TERMHUB_PTYD_PORT = String(ptyd.port);
  process.env.TERMHUB_PTYD_BIN = ptyd.bin;
  delete process.env.TERMHUB_PTYD_RESOLVED;
  const { Session } = require('../lib/session.ts');
  const s = new Session({ cwd: os.tmpdir(), cols: 80, rows: 24 });
  try {
    const a = []; const b = [];
    const A = s.attach((m) => a.push(m));
    // Output that arrives between attach and the snapshot being sent.
    // On ptyd this is a round trip (create the session, then POST /notice,
    // then the bytes come back as output), so wait for it instead of a
    // fixed gap sized for the old in-process write.
    s.notice('during-attach');
    const B = s.attach((m) => b.push(m));
    const sawNotice = (msgs) => msgs.filter((m) => (m.data || '').includes('during-attach')).length;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (sawNotice(a) < 1 || sawNotice(b) < 1)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const replayA = a.find((m) => m.type === 'replay');
    assert.ok(replayA, 'A got a replay');
    assert.strictEqual(replayA.you, A.id);
    assert.strictEqual(a[0].type, 'replay', 'the replay is the first thing a client sees');
    assert.strictEqual(sawNotice(a), 1, 'A sees output from the attach gap exactly once');
    assert.strictEqual(sawNotice(b), 1, 'B (attached after it) sees it exactly once, in its snapshot');

    a.length = 0; b.length = 0;
    s.resize(50, 20, A.id);
    let sa = a.find((m) => m.type === 'size'); let sb = b.find((m) => m.type === 'size');
    assert.deepStrictEqual([sa.cols, sa.rows, sa.owner], [50, 20, A.id]);
    assert.deepStrictEqual([sb.cols, sb.rows, sb.owner], [50, 20, A.id], 'the other client hears the claim');

    // B claims at the same size: ownership moves, PTY untouched.
    let ptyResizes = 0;
    const realResize = s.pty.resize.bind(s.pty);
    s.pty.resize = (c, r) => { ptyResizes++; realResize(c, r); };
    a.length = 0;
    s.resize(50, 20, B.id);
    assert.strictEqual(ptyResizes, 0, 'same-size claim does not reach the PTY');
    assert.strictEqual(a.find((m) => m.type === 'size').owner, B.id);
    s.resize(60, 20, B.id);
    assert.strictEqual(ptyResizes, 1);

    // Garbage dims are clamped, never passed to the PTY.
    s.resize('nope', -5, B.id);
    assert.deepStrictEqual([s.cols, s.rows], [60, 1]);

    a.length = 0;
    B.detach();
    assert.strictEqual(s.sizeOwner, null, 'the owner leaving releases the size');
    assert.strictEqual(a.find((m) => m.type === 'size').owner, null, 'and the others are told');
    A.detach();
  } finally {
    await Promise.resolve(s.kill());
    await ptyd.stop();
  }
  console.log('screen.test.js: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
