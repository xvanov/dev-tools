'use strict';

// ledger.dirty on SQLite (plan 8.4.38). Checked commitments match the SQL
// (src/repo/sqlite/ledger.ts DIRTY) by reading items fetched since the oldest
// check, not each ask's 30-day window. Idle stays a single index seek.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { available, createSqliteBackend } = require('../src/db/sqlite.ts');
const { sinceMs } = require('../src/repo/sqlite/_sql.ts');
const { DIRTY } = require('../src/repo/sqlite/ledger.ts');

if (!available()) {
  if (process.env.CI) throw new Error('the SQLite driver is not installed in CI');
  console.log('SKIP ledgerDirty: no SQLite driver');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-dirty-'));
const db = createSqliteBackend(path.join(dir, 'pa_test_dirty.sqlite'), { key: 'ledger-dirty' });
const { createRepos } = require('../src/repo');

function iso(ms) {
  return new Date(ms).toISOString();
}

function norm(rows) {
  return rows
    .map((r) => ({
      id: Number(r.id),
      direction: r.direction,
      summary: r.summary,
      detail: r.detail ?? null,
      counterparty: r.counterparty ?? null,
      asked_at: r.asked_at instanceof Date ? r.asked_at.toISOString() : String(r.asked_at),
      ask_text: r.ask_text,
      source: r.source,
      item_ids: (Array.isArray(r.item_ids) ? r.item_ids : JSON.parse(String(r.item_ids))).map(Number),
      through: r.through instanceof Date ? r.through.toISOString() : new Date(r.through).toISOString(),
    }))
    .sort((a, b) => a.id - b.id || String(a.through).localeCompare(String(b.through)));
}

(async () => {
  await db.migrate();
  const repos = createRepos(db);
  const now = Date.now();
  const body = 'please review this and reply today';
  let n = 0;
  const item = async (o) => {
    n++;
    const r = await db.one(
      `insert into source_item (source, external_id, thread_external_id, occurred_at, author_identity, subject, body_text, raw, content_hash, fetched_at)
       values ($1, $2, $3, $4, $5, 's', $6, $7, $8, $9) returning id`,
      [
        o.source || 'graph_chat',
        `ext-${n}`,
        o.thread ?? null,
        iso(o.at ?? now - 86400000),
        o.author ?? null,
        o.body ?? body,
        JSON.stringify(o.raw || {}),
        `h${n}`,
        iso(o.fetched ?? now - 60000),
      ]
    );
    return Number(r.id);
  };
  const ask = async (o) => {
    const id = await item(o);
    const c = await db.one(
      `insert into commitment (source_item_id, direction, summary, detail, status, extracted_by, counterparty_person_id, project_id, ledger_checked_at)
       values ($1, $2, $3, $4, 'open', 'test', $5, $6, $7) returning id`,
      [id, o.direction || 'owed_by_me', o.summary || `ask ${n}`, o.detail ?? null, o.person ?? null, o.project ?? null, o.checked ? iso(o.checked) : null]
    );
    return { id: Number(c.id), item: id };
  };

  const person = Number((await db.one(`insert into person (display_name) values ('Ada') returning id`)).id);
  await db.query(`insert into person_identity (person_id, kind, value) values ($1, 'smtp', 'Ada@Example.com')`, [person]);
  const project = Number((await db.one(`insert into project (name, gitlab_path, repo_path) values ('app', 'owner/app', 'C:\\repos\\app') returning id`)).id);

  // Checked ask: a later reply in the thread counts, another thread does not,
  // and a reply fetched before the check does not.
  const thread = await ask({ thread: 'thr', summary: 'send the deck', at: now - 5 * 86400000, checked: now - 3600000, fetched: now - 5 * 86400000 });
  const reply = await item({ thread: 'thr', at: now - 2 * 86400000, fetched: now - 30000, body: 'sent the deck this morning' });
  await item({ thread: 'thr', at: now - 3 * 86400000, fetched: now - 7200000, body: 'old reply already judged' });
  await item({ thread: 'other', at: now - 86400000, fetched: now - 20000, body: 'unrelated thread message' });
  // Unchecked ask, so both paths run.
  const fresh = await ask({ thread: 'new', summary: 'unchecked ask', at: now - 2 * 86400000, fetched: now - 2 * 86400000 });
  await item({ thread: 'new', at: now - 86400000, fetched: now - 10000, body: 'reply to the new ask' });
  // Repaired ask text, fetched again after the check.
  const repaired = await ask({ thread: 'fix', summary: 'repaired', at: now - 4 * 86400000, checked: now - 86400000, fetched: now - 20000, raw: { repaired: true } });
  // Not repaired: the ask itself must not come back.
  await ask({ thread: 'plain', summary: 'not repaired', at: now - 4 * 86400000, checked: now - 86400000, fetched: now - 20000 });
  // Too short, graph event, outside the 30-day window.
  await item({ thread: 'thr', at: now - 86400000, fetched: now - 15000, body: 'short' });
  await item({ thread: 'thr', source: 'graph_event', at: now - 86400000, fetched: now - 15000, body: 'a calendar event body' });
  await item({ thread: 'thr', at: now - 5 * 86400000 + 40 * 86400000, fetched: now - 15000, body: 'outside the thirty day window' });
  // Owed to me: their mail, not someone else's.
  const owed = await ask({ thread: 'owed', direction: 'owed_to_me', person, summary: 'owed', at: now - 6 * 86400000, checked: now - 86400000, fetched: now - 6 * 86400000 });
  const theirs = await item({ source: 'graph_mail', thread: 'mail-1', author: 'Ada@Example.com', at: now - 2 * 86400000, fetched: now - 12000, body: 'I added your role' });
  await item({ source: 'graph_mail', thread: 'mail-2', author: 'other@example.com', at: now - 2 * 86400000, fetched: now - 12000, body: 'someone else wrote this' });
  // My GitHub in the ask's repo, and a session whose cwd is that repo.
  const code = await ask({ thread: 'code', summary: 'code', project, at: now - 8 * 86400000, checked: now - 86400000, fetched: now - 8 * 86400000, source: 'github_pr' });
  const pr = await item({ source: 'github_pr', thread: 'pr-9', author: 'me', at: now - 86400000, fetched: now - 8000, body: 'opened the pull request', raw: { project: 'owner/app' } });
  await item({ source: 'github_pr', thread: 'pr-10', author: 'me', at: now - 86400000, fetched: now - 8000, body: 'a pull request elsewhere', raw: { project: 'owner/other' } });
  const session = await item({ source: 'claude_session', author: 'me', at: now - 2 * 86400000, fetched: now - 3 * 3600000, body: 'edited the repo', raw: { cwd: 'C:\\repos\\app\\src' } });
  const remote = await item({ source: 'claude_session', author: 'me', at: now - 2 * 86400000, fetched: now - 3 * 3600000, body: 'edited it on the other machine', raw: { cwd: 'D:\\work\\app', machine: 'other' } });
  await item({ source: 'claude_session', author: 'me', at: now - 2 * 86400000, fetched: now - 3 * 3600000, body: 'a different repo', raw: { cwd: 'C:\\repos\\nope' } });
  // A live session (fetched just now) is not evidence yet.
  await item({ source: 'claude_session', author: 'me', at: now - 86400000, fetched: now - 1000, body: 'still going', raw: { cwd: 'C:\\repos\\app' } });

  const myForms = ['me'];
  const got = await repos.ledger.dirty({ myForms, limit: 50, perCommitment: 10 });
  const settled = sinceMs(10 * 60_000);
  const freshAfter = sinceMs(15 * 60_000);
  const sqlRows = await db.rows(DIRTY, [myForms, 50, 10, null, settled, freshAfter]);
  assert.deepStrictEqual(norm(got), norm(sqlRows), 'checked and unchecked dirty sets match the SQL');

  const byId = new Map(got.map((r) => [Number(r.id), r.item_ids.map(Number)]));
  assert.deepStrictEqual(byId.get(thread.id), [reply]);
  assert.ok(byId.get(fresh.id).length >= 1);
  assert.deepStrictEqual(byId.get(repaired.id), [repaired.item]);
  assert.ok(!byId.has((await db.one(`select id from commitment where summary = 'not repaired'`)).id));
  assert.ok(byId.get(owed.id).includes(theirs));
  assert.deepStrictEqual(byId.get(code.id).slice().sort((a, b) => a - b), [pr, session, remote].sort((a, b) => a - b));

  // Idle: every ask checked through the newest item. One seek, not the window.
  await db.query(`update commitment set ledger_checked_at = $1`, [iso(now + 60000)]);
  const idleSamples = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    const rows = await repos.ledger.dirty({ myForms, limit: 24, perCommitment: 10 });
    idleSamples.push(performance.now() - t);
    assert.deepStrictEqual(rows, []);
  }
  idleSamples.sort((a, b) => a - b);
  const idle = idleSamples[2];
  console.log(`dirty idle median ${idle.toFixed(1)} ms`);

  // A store the size of the work stack's item table. The window scan was ~185 ms
  // here; the fresh index is an empty seek.
  const N = 6000;
  const COMM = 300;
  const wide = 'please review this change and reply. '.repeat(40);
  const raw = JSON.stringify({ project: 'owner/app', cwd: 'C:/repos/dev-tools' });
  await db.withTx(async (tx) => {
    for (let i = 1; i <= N; i++) {
      await tx.query(
        `insert into source_item (source, external_id, thread_external_id, occurred_at, author_identity, subject, body_text, raw, content_hash, fetched_at)
         values ('graph_chat', $1, $2, $3, 'ada@example.com', 's', $4, $5, $6, $7)`,
        [`bulk-${i}`, i <= COMM ? `bulk-${i}` : `noise-${i % 800}`, iso(now - ((i % 35) + 1) * 86400000), wide, raw, `b${i}`, iso(now - 180000 - (i % 50) * 60000)]
      );
    }
    const base = Number((await tx.query(`select max(id) as id from source_item`)).rows[0].id) - N;
    for (let i = 1; i <= COMM; i++) {
      await tx.query(
        `insert into commitment (source_item_id, direction, summary, status, extracted_by, ledger_checked_at)
         values ($1, 'owed_by_me', $2, 'open', 'bench', $3)`,
        [base + i, `bulk ${i}`, iso(now - 90000)]
      );
    }
  });
  const bigIdle = [];
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    await repos.ledger.dirty({ myForms, limit: 24, perCommitment: 10 });
    bigIdle.push(performance.now() - t);
  }
  bigIdle.sort((a, b) => a - b);
  console.log(`dirty ${N} items / ${COMM} asks idle median ${bigIdle[1].toFixed(1)} ms (${bigIdle.map((x) => x.toFixed(1)).join(' ')})`);
  assert.ok(bigIdle[1] < 40, `idle dirty ${bigIdle[1].toFixed(1)} ms; the window scan was ~185 ms on this shape`);

  await db.query(
    `update source_item set fetched_at = $1, occurred_at = $2, thread_external_id = 'bulk-' || ((abs(id) % ${COMM}) + 1)
      where external_id like 'bulk-%' and thread_external_id like 'noise-%' and id % 80 = 0`,
    [iso(now - 5000), iso(now - 2 * 86400000)]
  );
  const live = [];
  let liveRows = 0;
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    liveRows = (await repos.ledger.dirty({ myForms, limit: 24, perCommitment: 10 })).length;
    live.push(performance.now() - t);
  }
  live.sort((a, b) => a - b);
  console.log(`dirty live median ${live[1].toFixed(1)} ms rows ${liveRows} (${live.map((x) => x.toFixed(1)).join(' ')})`);
  assert.ok(live[1] < 80, `live dirty ${live[1].toFixed(1)} ms`);

  await db.query(
    `update source_item set fetched_at = $1, occurred_at = $2, thread_external_id = 'bulk-' || ((abs(id) % ${COMM}) + 1)
      where external_id like 'bulk-%' and cast(replace(external_id, 'bulk-', '') as integer) > ${COMM} and cast(replace(external_id, 'bulk-', '') as integer) <= ${COMM + 2000}`,
    [iso(now - 4000), iso(now - 2 * 86400000)]
  );
  const burst = [];
  let burstRows = 0;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    burstRows = (await repos.ledger.dirty({ myForms, limit: 24, perCommitment: 10 })).length;
    burst.push(performance.now() - t);
  }
  burst.sort((a, b) => a - b);
  console.log(`dirty burst 2000 median ${burst[1].toFixed(1)} ms rows ${burstRows} (${burst.map((x) => x.toFixed(1)).join(' ')})`);
  assert.ok(burst[1] < 250, `burst dirty ${burst[1].toFixed(1)} ms; the window scan was ~1200 ms`);

  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ledgerDirty ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
