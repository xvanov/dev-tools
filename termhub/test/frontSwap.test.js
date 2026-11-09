'use strict';

// Terminals survive a deploy (plan Z5). The updater replaces the front and
// leaves sessiond, which owns the PTYs, alone: a session running a long
// command keeps running while its front is killed and a new one started, and
// a client that reconnects through the new front gets the whole output —
// nothing the command printed while no front was up is lost.
//
// Real processes (sessiond and each front on their own, as in production),
// free ports, a temp data dir: it runs beside a live termhub.

const assert = require('assert');
const WebSocket = require('ws');
const { startSpareTermhub, findPtyd, ptydMissing, waitFor, watchTerminal, missingTicks } = require('./spareTermhub');

const TICKS = 60;

if (!findPtyd()) {
  const why = ptydMissing();
  console.log(`frontSwap.test.js: skipped (${why})`);
  process.exit(0);
}

(async () => {
  const th = await startSpareTermhub();
  try {
    const a = await th.startFront();
    const created = await th.getJson(a.port, '/api/sessions', {
      method: 'POST',
      body: { command: th.counterCommand(TICKS, 100), cwd: th.dir, title: 'z5 front swap', cols: 100, rows: TICKS + 20 },
    });
    assert.strictEqual(created.status, 201, created.text);
    const id = created.body.id;
    const sessiondPid = (await th.getJson(th.sessiondPort, '/api/ping')).body.pid;

    const t1 = watchTerminal(WebSocket, `ws://127.0.0.1:${a.port}/ws/term/${encodeURIComponent(id)}`);
    await t1.opened;
    await waitFor(() => t1.ticks().length >= 10, 90_000, 'ten ticks through the first front');

    // The deploy: the front goes away mid-command; its clients are cut.
    await th.stopFront(a);
    await waitFor(() => t1.closed, 30_000, 'the first front to drop its socket');
    const cutAt = Math.max(...t1.ticks());
    await new Promise((r) => setTimeout(r, 700)); // the command keeps printing with no front up
    const b = await th.startFront();

    // sessiond, the session and its process are the same ones.
    const ping = await th.getJson(th.sessiondPort, '/api/ping');
    assert.strictEqual(ping.body.pid, sessiondPid, 'sessiond restarted with the front');
    const list = await th.getJson(b.port, '/api/sessions');
    const s = list.body.sessions.find((x) => x.id === id);
    assert.ok(s, 'the session is gone after the front swap');

    // Reconnect through the new front: replay plus live output is the whole run.
    const t2 = watchTerminal(WebSocket, `ws://127.0.0.1:${b.port}/ws/term/${encodeURIComponent(id)}`);
    await t2.opened;
    await waitFor(() => /counter done/.test(t2.text), 90_000, 'the command to finish');
    assert.ok(t2.replays >= 1, 'no replay on reconnect');
    assert.deepStrictEqual(missingTicks(t2.ticks(), TICKS), [], 'output lost across the front swap');
    assert.ok(t2.ticks().length === TICKS && cutAt < TICKS, `cut at tick ${cutAt}, saw ${t2.ticks().length} after`);
    assert.strictEqual(t2.closed, false, 'the new front dropped the terminal');

    await t2.close();
    await th.getJson(b.port, `/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    console.log(`frontSwap ok: front killed at tick ${cutAt} of ${TICKS}; sessiond pid ${sessiondPid} kept; all ${TICKS} ticks after the swap`);
  } finally {
    await th.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
