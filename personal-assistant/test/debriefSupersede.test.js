'use strict';

// A newer debrief of an episode replaces the older ones (src/meetings/debrief.ts
// supersedeOlder / supersede): the bug of 2026-11-10 was a meeting listed twice,
// once under a wrong title, because a re-debrief wrote a second row beside the
// first. What the old one applied is adopted where the new one restates it and
// undone everywhere else; transcript and audio are never touched. On a
// throwaway SQLite store, with no model call.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-debrief-sup-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_debrief_sup.sqlite');
process.env.PA_SQLITE_KEY = 'debrief-sup-test-key';
process.env.PA_DATA_DIR = path.join(dir, 'data');

const { available } = require('../src/db/sqlite.ts');

(async () => {
  if (!available()) return console.log('debriefSupersede: skipped (no sqlite driver)');
  const repo = require('../src/repo');
  const db = require('../src/db');
  await require('../src/db/migrate.ts').migrate();
  const debrief = require('../src/meetings/debrief.ts');
  const D = require('../src/meetings/debriefCore.ts');
  const hours = (h) => new Date(Date.now() - h * 3600_000).toISOString();

  const item = await db.one(`insert into source_item (source, external_id, occurred_at, author_identity, subject, body_text, content_hash) values ('audio', 'x1', $1, 'me', 'All Company Meeting', $2, 'h-x1') returning id`, [hours(3), 'spoken '.repeat(100)]);
  const ep = await db.one(`insert into audio_episode (started_at, ended_at, stream, speech_seconds, kind, calendar_event_id, state, source_item_id) values ($1, $2, 'loopback+mic', 600, 'meeting', 'ev-all', 'distilled', $3) returning id`, [hours(3), hours(2), item.id]);

  const todo = async (summary) =>
    repo.commitments.insertFromDebrief({ sourceItemId: item.id, direction: 'owed_by_me', summary, detail: 'd', counterpartyPersonId: null, dueAt: null, confidence: 0.9, extractedBy: D.VERSION });
  const write = (hash, title, applied, extra = {}) =>
    repo.meetings.upsertDebrief({ episodeId: ep.id, eventExternalId: 'ev-all', sourceItemId: item.id, title, startedAt: hours(3), endedAt: hours(2), contentHash: hash, transcriptChars: 700, applied, dropped: 0, extractedBy: D.VERSION, ...extra });
  const exists = async (id) => !!(await db.one('select id from commitment where id = $1', [id]));
  const listed = async () => (await debrief.recent({ days: 7, limit: 50 })).filter((d) => d.episodeId === ep.id).map((d) => d.id);

  const keepId = await todo('Send the budget');
  const dropId = await todo('Book the wrong room');
  const oldRow = await write('a', 'Mainsail AI Engineering Show and Tell', {
    summary: 'wrong',
    items: [
      { type: 'todo', direction: 'owed_by_me', summary: 'Send the budget', quote: 'q', commitmentId: keepId },
      { type: 'todo', direction: 'owed_by_me', summary: 'Book the wrong room', quote: 'q', commitmentId: dropId },
    ],
  });
  await new Promise((r) => setTimeout(r, 5));
  // The right debrief declined to repeat the budget to-do: it was already on the list.
  const newRow = await write('b', 'All Company Meeting', {
    summary: 'right',
    items: [],
    skipped: [{ type: 'todo', summary: 'Send the budget', quote: 'q', reason: `already on your list as #${keepId}` }],
  });
  assert.deepStrictEqual(await listed(), [newRow.id, oldRow.id].sort((a, b) => b - a), 'the bug: both show');

  // Refuses what it should not do.
  await assert.rejects(() => debrief.supersede(oldRow.id, oldRow.id), /itself/);
  await assert.rejects(() => debrief.supersede(999999, newRow.id), /no debrief #999999/);

  const r = await debrief.supersede(oldRow.id, newRow.id);
  assert.deepStrictEqual([r.adopted, r.undone, r.ids], [1, 1, [oldRow.id]]);
  assert.deepStrictEqual(await listed(), [newRow.id], 'only the newer one shows');
  assert.strictEqual(await exists(keepId), true, 'restated by the new debrief: kept');
  assert.strictEqual(await exists(dropId), false, 'not restated: undone like `pa meeting undo`');

  const now = await repo.meetings.debriefById(newRow.id);
  assert.deepStrictEqual(now.applied.items.map((i) => [i.summary, i.adoptedFrom]), [['Send the budget', oldRow.id]], 'adopted, so it can still be undone from the new one');
  const old = await repo.meetings.debriefById(oldRow.id);
  assert.strictEqual(String(old.superseded_by), String(newRow.id));
  assert.ok(old.applied.items[1].undone_at, 'the old row records what was undone');
  // Transcript and audio stay (unlike discard).
  assert.ok(await db.one('select id from source_item where id = $1', [item.id]));
  assert.strictEqual((await db.one('select state from audio_episode where id = $1', [ep.id])).state, 'distilled');

  // Undo from the new debrief reaches the adopted item.
  await debrief.undo(newRow.id, 0);
  assert.strictEqual(await exists(keepId), false);

  // Only debriefs of one meeting replace each other.
  const otherItem = await db.one(`insert into source_item (source, external_id, occurred_at, author_identity, subject, body_text, content_hash) values ('audio', 'x2', $1, 'me', 'Other', 'z', 'h-x2') returning id`, [hours(1)]);
  const other = await db.one(`insert into audio_episode (started_at, ended_at, stream, kind, state, source_item_id) values ($1, $2, 'mic', 'meeting', 'distilled', $3) returning id`, [hours(1), hours(0.5), otherItem.id]);
  const foreign = await repo.meetings.upsertDebrief({ episodeId: other.id, eventExternalId: null, sourceItemId: otherItem.id, title: 'Other', startedAt: hours(1), endedAt: hours(0.5), contentHash: 'o', transcriptChars: 1, applied: { items: [] }, dropped: 0, extractedBy: D.VERSION });
  await assert.rejects(() => debrief.supersede(foreign.id, newRow.id), /only debriefs of one meeting/);
  await assert.rejects(() => debrief.supersede(oldRow.id, newRow.id), /already superseded/);

  // supersedeOlder with nothing older is a no-op (the first debrief of a meeting).
  assert.deepStrictEqual(await debrief.supersedeOlder(foreign), { ids: [], adopted: 0, undone: 0, notified: false });

  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('debriefSupersede: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
