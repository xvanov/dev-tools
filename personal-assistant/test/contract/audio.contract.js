'use strict';

// Contract: src/repo/audio.js (see test/repoContract.test.js). Cases share one
// database, so each makes its own rows and finds them by id.

const long = (n = 500) => 'spoken words '.repeat(Math.ceil(n / 13));
const ago = (ms) => new Date(Date.now() - ms);

/** An owned (debriefable) episode on a fresh transcript item; returns {id, itemId, eventId}. */
async function owned({ seed }, o = {}) {
  const eventId = o.eventId === undefined ? `ev-${Math.random().toString(36).slice(2)}` : o.eventId;
  const itemId = await seed.item({ source: 'audio', body: o.body || long(), subject: o.subject || 'Recorded', occurredAt: o.startedAt || ago(3600_000) });
  const id = await seed.episode({ itemId, eventId, startedAt: o.startedAt || ago(3600_000), endedAt: o.endedAt || ago(1800_000), kind: o.kind || 'meeting', stream: o.stream || 'mic+loopback', state: o.state || 'transcribed' });
  return { id, itemId, eventId };
}

module.exports = {
  'lastOwned: the newest owned episode, with its transcript and calendar event': async (t) => {
    const { repos, seed, assert } = t;
    const eventId = `ev-last-${Date.now()}`;
    const ev = await seed.item({ source: 'graph_event', externalId: eventId, subject: 'Weekly sync', raw: { attendees: ['a@x.test'] } });
    const far = new Date('2099-01-01T10:00:00Z');
    const item = await seed.item({ source: 'audio', body: long(), subject: 'The transcript', occurredAt: far });
    const id = await seed.episode({ itemId: item, eventId, startedAt: far, endedAt: new Date('2099-01-01T11:00:00Z') });
    // Not owned: speech under 400 chars, a stream without a mic, a superseded one.
    const short = await seed.item({ source: 'audio', body: 'tiny', occurredAt: far });
    await seed.episode({ itemId: short, startedAt: new Date('2099-02-01T10:00:00Z'), endedAt: new Date('2099-02-01T11:00:00Z') });
    const loop = await seed.item({ source: 'audio', body: long(), occurredAt: far });
    await seed.episode({ itemId: loop, stream: 'loopback', startedAt: new Date('2099-03-01T10:00:00Z'), endedAt: new Date('2099-03-01T11:00:00Z') });
    const sup = await seed.item({ source: 'audio', body: long(), occurredAt: far });
    await seed.episode({ itemId: sup, state: 'superseded', startedAt: new Date('2099-04-01T10:00:00Z'), endedAt: new Date('2099-04-01T11:00:00Z') });

    const ep = await repos.audio.lastOwned();
    assert.strictEqual(Number(ep.id), id);
    assert.strictEqual(ep.item_subject, 'The transcript');
    assert.ok(ep.body_text.length >= 400 && ep.content_hash);
    assert.strictEqual(ep.event_subject, 'Weekly sync');
    assert.deepStrictEqual(ep.event_raw, { attendees: ['a@x.test'] });
    assert.strictEqual(ep.event_external_id, eventId);
  },

  'withEventById: any episode by id, owned or not; null when absent': async (t) => {
    const { repos, seed, assert } = t;
    const item = await seed.item({ source: 'audio', body: 'tiny' });
    const id = await seed.episode({ itemId: item, kind: 'ambient', stream: 'loopback' });
    const ep = await repos.audio.withEventById(id);
    assert.strictEqual(Number(ep.id), id);
    assert.strictEqual(ep.body_text, 'tiny');
    assert.strictEqual(ep.event_subject, null, 'no calendar event');
    assert.strictEqual(await repos.audio.withEventById(999999999), null);
  },

  'awaitingDebrief: owned, ended within 48h, no debrief of this transcript': async (t) => {
    const { repos, seed, assert } = t;
    const now = new Date();
    const fresh = await owned(t, { startedAt: ago(3 * 3600_000), endedAt: ago(2 * 3600_000) });
    const old = await owned(t, { startedAt: ago(60 * 3600_000), endedAt: ago(59 * 3600_000) });
    const done = await owned(t, { startedAt: ago(4 * 3600_000), endedAt: ago(3 * 3600_000) });
    const failing = await owned(t, { startedAt: ago(5 * 3600_000), endedAt: ago(4 * 3600_000) });
    const hash = async (itemId) => (await t.db.one('select content_hash from source_item where id = $1', [itemId])).content_hash;
    const base = (e, over) => ({ episodeId: e.id, eventExternalId: e.eventId, sourceItemId: e.itemId, title: 'T', startedAt: ago(3600_000).toISOString(), endedAt: ago(1800_000).toISOString(), transcriptChars: 500, applied: { items: [] }, dropped: 0, extractedBy: 'contract', ...over });
    await repos.meetings.upsertDebrief(base(done, { contentHash: await hash(done.itemId) }));
    // A failing debrief is retried until its third attempt.
    await repos.meetings.recordDebriefError({ ...base(failing, { contentHash: await hash(failing.itemId) }), error: 'boom' });
    const ids = (await repos.audio.awaitingDebrief(now)).map((e) => Number(e.id));
    assert.ok(ids.includes(fresh.id), 'fresh');
    assert.ok(!ids.includes(old.id), 'older than 48h');
    assert.ok(!ids.includes(done.id), 'already debriefed');
    assert.ok(ids.includes(failing.id), 'a failed debrief with fewer than 3 attempts is retried');
    await t.db.query('update meeting_debrief set attempts = 3 where episode_id = $1', [failing.id]);
    assert.ok(!(await repos.audio.awaitingDebrief(now)).map((e) => Number(e.id)).includes(failing.id), 'three failures stop');
    const sorted = (await repos.audio.awaitingDebrief(now)).map((e) => new Date(e.ended_at).getTime());
    assert.deepStrictEqual(sorted, [...sorted].sort((a, b) => a - b), 'oldest end first');
  },

  'waitingForQuiet: owned, ended within 45 minutes, no debrief row at all': async (t) => {
    const { repos, assert } = t;
    const now = new Date();
    const recent = await owned(t, { startedAt: ago(40 * 60_000), endedAt: ago(10 * 60_000) });
    const older = await owned(t, { startedAt: ago(2 * 3600_000), endedAt: ago(3600_000) });
    const hasRow = await owned(t, { startedAt: ago(35 * 60_000), endedAt: ago(5 * 60_000) });
    await t.db.query(
      `insert into meeting_debrief (episode_id, title, started_at, ended_at, content_hash, extracted_by, error) values ($1, 't', now(), now(), 'h', 'contract', 'x')`,
      [hasRow.id]
    );
    const ids = (await repos.audio.waitingForQuiet(now)).map((e) => Number(e.id));
    assert.ok(ids.includes(recent.id));
    assert.ok(!ids.includes(older.id));
    assert.ok(!ids.includes(hasRow.id));
  },

  'overviewSince: recorded meetings and calls since a time, newest first, with the matched event': async (t) => {
    const { repos, seed, assert } = t;
    const eventId = `ev-ov-${Date.now()}`;
    await seed.item({ source: 'graph_event', externalId: eventId, subject: 'Planning', author: 'boss@x.test', body: 'agenda', raw: { a: 1 } });
    const a = await owned(t, { eventId, startedAt: ago(5 * 3600_000), endedAt: ago(4 * 3600_000), body: 'z'.repeat(30000) });
    const b = await owned(t, { eventId: null, startedAt: ago(2 * 3600_000), endedAt: ago(3600_000), kind: 'call' });
    const dictation = await owned(t, { eventId: null, startedAt: ago(1 * 3600_000), endedAt: ago(1800_000), kind: 'dictation' });
    const gone = await owned(t, { eventId: null, startedAt: ago(100 * 3600_000), endedAt: ago(99 * 3600_000) });
    const list = await repos.audio.overviewSince(ago(10 * 3600_000));
    const ids = list.map((r) => Number(r.id));
    assert.ok(ids.includes(a.id) && ids.includes(b.id));
    assert.ok(!ids.includes(dictation.id), 'only meetings and calls');
    assert.ok(!ids.includes(gone.id), 'before the window');
    assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), 'newest first');
    const ra = list.find((r) => Number(r.id) === a.id);
    assert.strictEqual(ra.transcript.length, 24000, 'transcript capped');
    assert.deepStrictEqual([ra.event_subject, ra.event_organizer, ra.event_body, ra.event_raw, ra.event_external_id], ['Planning', 'boss@x.test', 'agenda', { a: 1 }, eventId]);
    assert.strictEqual(list.find((r) => Number(r.id) === b.id).event_subject, null);
  },

  'transcriptsFor: linked to the event, or overlapping its slot; superseded ones skipped': async (t) => {
    const { repos, seed, assert } = t;
    const eventId = `ev-tr-${Date.now()}`;
    const start = ago(2 * 3600_000);
    const end = ago(3600_000);
    const linked = await owned(t, { eventId, startedAt: ago(10 * 3600_000), endedAt: ago(9 * 3600_000) }); // by calendar_event_id
    const threaded = await seed.item({ source: 'audio', body: long(), thread: eventId, occurredAt: ago(20 * 3600_000) }); // by thread
    const overlap = await seed.item({ source: 'audio', body: long(), occurredAt: ago(2 * 3600_000 - 5 * 60_000) }); // inside the slot
    const tooShort = await seed.item({ source: 'audio', body: 'tiny', occurredAt: ago(2 * 3600_000 - 5 * 60_000) });
    const elsewhere = await seed.item({ source: 'audio', body: long(), occurredAt: ago(50 * 3600_000) });
    const sup = await seed.item({ source: 'audio', body: long(), occurredAt: ago(2 * 3600_000 - 6 * 60_000) });
    await seed.episode({ itemId: sup, state: 'superseded', startedAt: ago(30 * 3600_000), endedAt: ago(29 * 3600_000) });
    const got = await repos.audio.transcriptsFor(eventId, start.toISOString(), end.toISOString());
    const ids = got.map((r) => Number(r.id));
    assert.ok(ids.includes(linked.itemId) && ids.includes(threaded) && ids.includes(overlap));
    assert.ok(!ids.includes(tooShort) && !ids.includes(elsewhere) && !ids.includes(sup));
    const times = got.map((r) => new Date(r.occurred_at).getTime());
    assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), 'oldest first');
    assert.ok(got[0].body_text && got[0].occurred_at instanceof Date);
  },

  'continuing: the stored episode a computed one continues, none twice': async ({ repos, seed, assert }) => {
    const s = new Date('2090-05-01T10:00:00Z');
    const e = new Date('2090-05-01T11:00:00Z');
    const mic = await seed.episode({ startedAt: s, endedAt: e, stream: 'mic', speech: 100 });
    const both = await seed.episode({ startedAt: s, endedAt: e, stream: 'loopback', speech: 50 });
    const inside = await seed.episode({ startedAt: new Date('2090-05-01T10:30:00Z'), endedAt: e, stream: 'mic', speech: 900 });
    const q = (over) => ({ startedAt: s.toISOString(), endedAt: e.toISOString(), claimed: new Set(), stream: 'mic', ...over });
    const first = await repos.audio.continuing(q());
    assert.strictEqual(Number(first.id), mic, 'same start and streams first');
    assert.strictEqual(Number((await repos.audio.continuing(q({ stream: 'loopback' }))).id), both);
    assert.strictEqual(Number((await repos.audio.continuing(q({ claimed: new Set([mic, both]) }))).id), inside, 'claimed rows are skipped; one that started inside is next');
    assert.strictEqual(await repos.audio.continuing(q({ claimed: [mic, both, inside] })), null);
    assert.ok('item_external_id' in first, 'carries the transcript item external id');
  },

  'supersedeWithin: marks unclaimed rows starting inside the range, returns the count': async ({ repos, seed, assert, db }) => {
    const s = new Date('2091-05-01T10:00:00Z');
    const e = new Date('2091-05-01T11:00:00Z');
    const keep = await seed.episode({ startedAt: s, endedAt: e, stream: 'mic' });
    const frag = await seed.episode({ startedAt: new Date('2091-05-01T10:10:00Z'), endedAt: e, stream: 'mic' });
    const outside = await seed.episode({ startedAt: new Date('2091-05-01T12:00:00Z'), endedAt: new Date('2091-05-01T13:00:00Z'), stream: 'mic' });
    const n = await repos.audio.supersedeWithin(s.toISOString(), e.toISOString(), [keep]);
    assert.strictEqual(n, 1);
    const state = async (id) => (await db.one('select state from audio_episode where id = $1', [id])).state;
    assert.deepStrictEqual([await state(keep), await state(frag), await state(outside)], ['transcribed', 'superseded', 'transcribed']);
    assert.strictEqual(await repos.audio.supersedeWithin(s.toISOString(), e.toISOString(), new Set([keep])), 0, 'already superseded rows are not counted again');
  },

  'upsert: inserts; a conflict on (stream, started_at) revives and updates that row': async ({ repos, seed, assert, db }) => {
    const s = new Date('2092-05-01T10:00:00Z');
    const vals = (over = []) => {
      const v = [s.toISOString(), new Date('2092-05-01T10:30:00Z').toISOString(), 'mic', 120, 'meeting', 'ev-up', '/a.wav', '/a.json', 'distilled', null];
      over.forEach(([i, x]) => (v[i] = x));
      return v;
    };
    const row = await repos.audio.upsert(vals());
    assert.ok(row.id);
    await db.query(`update audio_episode set state = 'superseded' where id = $1`, [row.id]);
    const item = await seed.item({ source: 'audio' });
    const again = await repos.audio.upsert(vals([[3, 300], [4, 'call'], [8, 'transcribed'], [9, item]]));
    assert.strictEqual(String(again.id), String(row.id), 'same row');
    const r = await db.one('select * from audio_episode where id = $1', [row.id]);
    assert.deepStrictEqual([r.state, r.kind, r.speech_seconds, Number(r.source_item_id)], ['transcribed', 'call', 300, item]);
    const keepsItem = await repos.audio.upsert(vals());
    assert.strictEqual(Number((await db.one('select source_item_id from audio_episode where id = $1', [keepsItem.id])).source_item_id), item, 'a null item does not erase the stored one');
  },

  'update: rewrites an episode; another row holding the key throws 23505': async ({ repos, seed, assert, db }) => {
    const a = await seed.episode({ startedAt: new Date('2093-05-01T10:00:00Z'), stream: 'mic' });
    const b = await seed.episode({ startedAt: new Date('2093-05-01T11:00:00Z'), stream: 'mic' });
    const vals = (start) => [start, '2093-05-01T12:00:00Z', 'mic', 77, 'call', 'ev-u', '/p.wav', '/p.json', 'distilled', null, a];
    await repos.audio.update(vals('2093-05-01T10:00:00Z'));
    const r = await db.one('select * from audio_episode where id = $1', [a]);
    assert.deepStrictEqual([r.kind, r.speech_seconds, r.state, r.audio_path], ['call', 77, 'distilled', '/p.wav']);
    await assert.rejects(repos.audio.update(vals('2093-05-01T11:00:00Z')), (e) => e.code === '23505');
    assert.ok(b);
  },

  'updateKeepingKey: updates everything but the key and paths': async ({ repos, seed, assert, db }) => {
    const a = await seed.episode({ startedAt: new Date('2094-05-01T10:00:00Z'), stream: 'mic' });
    await db.query(`update audio_episode set audio_path = '/keep.wav' where id = $1`, [a]);
    await repos.audio.updateKeepingKey({ endedAt: '2094-05-01T13:00:00Z', speechSeconds: 42, kind: 'call', calendarEventId: 'ev-k', state: 'distilled', sourceItemId: null, id: a });
    const r = await db.one('select * from audio_episode where id = $1', [a]);
    assert.deepStrictEqual([r.kind, r.speech_seconds, r.calendar_event_id, r.state, r.audio_path, r.ended_at.toISOString()], ['call', 42, 'ev-k', 'distilled', '/keep.wav', '2094-05-01T13:00:00.000Z']);
  },
};
