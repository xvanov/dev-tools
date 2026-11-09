'use strict';

// "Save to memory" answered only after slow work, on a throwaway SQLite
// store: approving a claim must return once the row has flipped, with
// consolidation and the page rewrite (model calls) started later, outside
// the request, and batched; and the tab must move the card before it sends.
//
// Invented names only. Skips without the optional SQLite driver.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-memory-save-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_memory.sqlite');
process.env.PA_SQLITE_KEY = '';

const { available } = require('../src/db/sqlite.ts');

async function main() {
  if (!available()) {
    if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
    return console.log('SKIP memorySave: no SQLite driver');
  }
  const repo = require('../src/repo');
  await require('../src/db/migrate.ts').migrate();
  const search = require('../src/search');
  search.embed = async (texts) => texts.map(() => null);
  const consolidate = require('../src/memory/consolidate.ts');
  const pages = require('../src/memory/pages.ts');
  const memory = require('../src/memory');
  const { route } = require('../src/dashboard/memory.ts');

  // ------------------------------------------------ save does not wait ---
  {
    const calls = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    consolidate.consolidateClaims = async (ids) => { calls.push(['consolidate', ids]); await gate; return { claims: ids.length }; };
    pages.refreshSubjects = async (subjects) => { calls.push(['pages', subjects.length]); };

    const pending = [];
    for (const label of ['quill', 'quill', 'ledger']) {
      pending.push(await repo.memory.insertNote({ subjectKind: 'topic', subjectId: null, subjectLabel: label, kind: 'status', text: `${label} is frozen`, quote: 'q', vector: null, confidence: 0.4, status: 'pending_review', origin: 'agent' }));
    }
    const url = (id) => new URL(`http://127.0.0.1/api/memory/claims/${id}/approve`);
    const t0 = Date.now();
    const r = await route('POST', url(pending[0].id), {}, memory);
    const ms = Date.now() - t0;
    assert.strictEqual(r.pending, true);
    assert.strictEqual(r.claim.status, 'active');
    assert.ok(ms < 500, `approve answered in ${ms} ms`);
    assert.deepStrictEqual(calls, [], 'no consolidation or page work inside the request');
    assert.strictEqual((await repo.memory.claimById(pending[0].id)).status, 'active', 'the belief is saved before the answer');
    // Two more saves in the same burst settle with the first, in one call.
    await route('POST', url(pending[1].id), {}, memory);
    await route('POST', url(pending[2].id), {}, memory);
    assert.deepStrictEqual(calls, []);
    await assert.rejects(route('POST', url(pending[2].id), {}, memory), (err) => err.status === 409, 'a second save of the same claim is refused');
    const flushed = memory._flushSettle();
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(calls, [['consolidate', pending.map((c) => c.id)]], 'one consolidation for the burst');
    release();
    await flushed;
    assert.deepStrictEqual(calls[1], ['pages', 2], 'one page rewrite per subject');
    // The waiting form (the CLI) still does it all before answering.
    calls.length = 0;
    const p4 = await repo.memory.insertNote({ subjectKind: 'topic', subjectId: null, subjectLabel: 'quill', kind: 'status', text: 'x', quote: 'q', vector: null, confidence: 0.4, status: 'pending_review', origin: 'agent' });
    await memory.approve(p4.id, { wait: true });
    assert.deepStrictEqual(calls.map((c) => c[0]), ['consolidate', 'pages']);
  }

  // The dashboard script: Save and Discard never wait on the request.
  const html = fs.readFileSync(path.join(__dirname, '../src/dashboard/index.html'), 'utf8');
  const card = html.slice(html.indexOf('function claimCard('), html.indexOf('function outcome('));
  assert.ok(/reviewDecision\(c, 'approve'/.test(card) && !/memAct\(ok/.test(card), 'Save is optimistic');
  const decide = html.slice(html.indexOf('function reviewDecision('), html.indexOf('function reloadMemorySoon('));
  assert.ok(decide.indexOf('renderReview(mem.review)') < decide.indexOf('post('), 'the card leaves before the request is sent');
  assert.ok(/it is back in the list/.test(decide), 'a failure puts it back and says so');

  console.log('memorySave ok');
}

main()
  .then(() => require('../src/db').close?.())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
