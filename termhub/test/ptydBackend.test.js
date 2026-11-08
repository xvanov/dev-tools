'use strict';

// TERMHUB_PTYD=1 (plan 5.1): with its PTYs in ptyd, a sessiond restart no
// longer ends the terminals. A session prints ticks while the sessiond that
// created it is killed and another started on the same data dir; the new one
// adopts the session from ptyd under the same id with the archive's metadata
// (a rename made before the restart), the reconnect sees every tick, input
// still reaches the shell, and ptyd's pid never changed. Then a DELETE through
// the new sessiond ends it in ptyd.
//
// Needs a ptyd binary (see ptydConformance.test.js): SKIPs without one unless
// PTYD_REQUIRED=1.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const spare = require('./spareTermhub');

const { waitFor, ticksIn, missingTicks } = spare;
// Name the request in a failure: a bare "timeout" says nothing about which tier stalled.
const getJson = (port, p, opts = {}) => spare.getJson(port, p, { timeoutMs: 10_000, ...opts })
  .catch((e) => { throw new Error(`${opts.method || 'GET'} :${port}${p}: ${e.message}`); });
const { findPtyd, startPtyd, startSessiond, term, nodePrint } = require('./ptydConformance.test.js');

const TICKS = 60;

(async () => {
  const bin = findPtyd();
  if (!bin) {
    if (process.env.PTYD_REQUIRED === '1') throw new Error('PTYD_REQUIRED=1 but no ptyd binary');
    console.log('SKIP ptydBackend: no ptyd binary (cargo build in ptyd/, or set PTYD_BIN)');
    process.exit(0);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-backend-'));
  const pd = await startPtyd(dir, bin);
  const env = { TERMHUB_PTYD: '1', TERMHUB_PTYD_PORT: String(pd.port), TERMHUB_PTYD_BIN: bin };
  let sd = null;
  try {
    const ptydPid = (await getJson(pd.port, '/api/ping')).body.pid;
    sd = await startSessiond(dir, env);

    const script = path.join(dir, 'counter.js');
    fs.writeFileSync(script, `let i = 0; const t = setInterval(() => { console.log('tick ' + (++i)); if (i >= ${TICKS}) { clearInterval(t); console.log('counter ' + 'done'); } }, 100);\n`);
    const created = await getJson(sd.port, '/api/sessions', {
      method: 'POST', timeoutMs: 20_000,
      body: { cwd: dir, noRc: true, title: 'before', cols: 100, rows: TICKS + 20, command: `node "${script}"`, links: { card: '7' } },
    });
    assert.strictEqual(created.status, 201, created.text);
    const id = created.body.id;
    // sessiond answers before ptyd's create lands (node-pty's spawn is sync, this is not).
    await waitFor(async () => (await getJson(pd.port, '/api/sessions')).body.sessions.some((s) => s.id === id), 10_000, 'ptyd to host it under the same id');

    const t1 = term(sd.port, id);
    await t1.opened;
    await waitFor(() => ticksIn(t1.text).length >= 10, 40_000, 'ten ticks through the first sessiond');
    const renamed = await getJson(sd.port, `/api/sessions/${id}`, { method: 'PATCH', body: { title: 'after rename' } });
    assert.strictEqual(renamed.status, 200);

    // The restart: sessiond goes away mid-command.
    await sd.stop();
    await waitFor(() => t1.closed, 5000, 'the first sessiond to drop its socket');
    const cutAt = Math.max(...ticksIn(t1.text));
    await new Promise((r) => setTimeout(r, 500));
    sd = await startSessiond(dir, env);

    await waitFor(async () => (await getJson(sd.port, '/api/sessions')).body.sessions.some((s) => s.id === id), 10_000, 'adoption');
    const listed = await getJson(sd.port, '/api/sessions');
    const s = listed.body.sessions.find((x) => x.id === id);
    assert.strictEqual(s.title, 'after rename', 'archive metadata wins on adoption');
    assert.deepStrictEqual(s.links, { card: '7' });
    assert.ok(!listed.body.restorable.some((x) => x.id === id), 'an adopted session is live, not restorable');
    assert.strictEqual(s.alive, true);

    const t2 = term(sd.port, id);
    await t2.opened;
    await waitFor(() => /counter done/.test(t2.plain()), 40_000, 'the command to finish');
    assert.deepStrictEqual(missingTicks(ticksIn(t2.text), TICKS), [], 'output lost across the sessiond restart');
    t2.send({ type: 'input', data: nodePrint(`'STILL'+'HERE'`) + '\r' });
    await waitFor(() => t2.plain().includes('STILLHERE'), 20_000, 'input after the restart');
    assert.strictEqual((await getJson(pd.port, '/api/ping')).body.pid, ptydPid, 'ptyd restarted');

    const del = await getJson(sd.port, `/api/sessions/${id}`, { method: 'DELETE', timeoutMs: 20_000 });
    assert.strictEqual(del.status, 200);
    assert.ok(!(await getJson(pd.port, '/api/sessions')).body.sessions.some((x) => x.id === id), 'DELETE reached ptyd');
    await t2.close();
    console.log(`ptydBackend ok: sessiond restarted at tick ${cutAt} of ${TICKS}; adopted ${id}; ptyd pid ${ptydPid} kept`);
  } finally {
    if (sd) await sd.stop();
    await pd.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a shell may still hold it */ }
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
