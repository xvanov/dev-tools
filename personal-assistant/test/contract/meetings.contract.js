'use strict';

// Contract: src/repo/meetings.js (see test/repoContract.test.js).

const brief = (o = {}) => ({
  key: `brief-${Math.random().toString(36).slice(2)}`,
  eventId: 'ev-1',
  itemId: null,
  startsAt: '2095-01-01T09:00:00Z',
  seriesKey: 'weekly sync',
  kind: 'standup',
  title: 'Weekly sync',
  headline: 'Say this',
  body: '1. Do that',
  points: { points: [{ text: 'a' }], context: [] },
  refs: { 'item:1': 'x' },
  joinUrl: 'https://join.example.test/1',
  ...o,
});

/** A debrief episode on a fresh transcript item. */
async function episode({ seed }) {
  const itemId = await seed.item({ source: 'audio', body: 'spoken '.repeat(100) });
  const id = await seed.episode({ itemId });
  return { id, itemId };
}

const debrief = (e, o = {}) => ({
  episodeId: e.id,
  eventExternalId: 'ev-d',
  sourceItemId: e.itemId,
  title: 'A meeting',
  startedAt: '2095-01-01T09:00:00Z',
  endedAt: '2095-01-01T09:30:00Z',
  contentHash: 'h1',
  transcriptChars: 700,
  applied: { summary: 's', items: [{ type: 'todo', summary: 'x' }, { type: 'decision', text: 'y' }] },
  dropped: 2,
  extractedBy: 'contract',
  ...o,
});

module.exports = {
  'saveSeries: creates; keeps what a null patch leaves out; a patch overrides': async ({ repos, assert, uniq }) => {
    const key = uniq('series');
    const a = await repos.meetings.saveSeries({ seriesKey: key, label: 'Label', kind: 'standup', kindSource: 'keyword', profile: { asks: ['q'] } });
    assert.deepStrictEqual([a.series_key, a.label, a.kind, a.kind_source, a.profile], [key, 'Label', 'standup', 'keyword', { asks: ['q'] }]);
    const b = await repos.meetings.saveSeries({ seriesKey: key, label: 'New label', kind: null, kindSource: null, profile: null });
    assert.deepStrictEqual([b.label, b.kind, b.kind_source, b.profile], ['New label', 'standup', 'keyword', { asks: ['q'] }], 'nulls keep');
    const c = await repos.meetings.saveSeries({ seriesKey: key, label: 'New label', kind: 'review', kindSource: 'model', profile: { asks: [] } });
    assert.deepStrictEqual([c.kind, c.kind_source, c.profile], ['review', 'model', { asks: [] }]);
    assert.ok(c.updated_at instanceof Date);
    const fresh = await repos.meetings.saveSeries({ seriesKey: uniq('series'), label: 'L', kind: null, kindSource: null, profile: null });
    assert.deepStrictEqual([fresh.kind, fresh.profile], [null, {}], 'an empty profile is {}');
  },

  'seriesByKey: the row, or null': async ({ repos, assert, uniq }) => {
    const key = uniq('series');
    assert.strictEqual(await repos.meetings.seriesByKey(key), null);
    await repos.meetings.saveSeries({ seriesKey: key, label: 'L', kind: 'one_on_one', kindSource: 'manual', profile: null });
    assert.strictEqual((await repos.meetings.seriesByKey(key)).kind, 'one_on_one');
  },

  'setSeriesKind: sets a manual kind; null when the series is unknown': async ({ repos, assert, uniq }) => {
    const key = uniq('series');
    assert.strictEqual(await repos.meetings.setSeriesKind(key, 'review'), null);
    await repos.meetings.saveSeries({ seriesKey: key, label: 'L', kind: 'standup', kindSource: 'model', profile: null });
    const row = await repos.meetings.setSeriesKind(key, 'review');
    assert.deepStrictEqual([row.kind, row.kind_source], ['review', 'manual']);
  },

  'upsertBrief: writes the brief; a repeat updates it, clears an error and counts the attempt': async ({ repos, assert }) => {
    const v = brief();
    const first = await repos.meetings.upsertBrief(v);
    assert.deepStrictEqual(
      [first.dedupe_key, first.event_external_id, first.kind, first.title, first.headline, first.body, first.join_url, first.error, first.attempts, first.notification_id],
      [v.key, 'ev-1', 'standup', 'Weekly sync', 'Say this', '1. Do that', 'https://join.example.test/1', null, 1, null]
    );
    assert.deepStrictEqual(first.points, v.points);
    assert.deepStrictEqual(first.refs, v.refs);
    await repos.meetings.recordBriefError({ ...v, error: 'failed once' });
    assert.strictEqual((await repos.meetings.briefByKey(v.key)).error, 'failed once');
    const second = await repos.meetings.upsertBrief({ ...v, headline: 'Better', kind: 'review' });
    assert.deepStrictEqual([second.id, second.headline, second.kind, second.error, second.attempts], [first.id, 'Better', 'review', null, 3]);
  },

  'recordBriefError: a bodiless row; a repeat counts the attempt': async ({ repos, assert }) => {
    const v = brief();
    await repos.meetings.recordBriefError({ ...v, error: 'one' });
    let row = await repos.meetings.briefByKey(v.key);
    assert.deepStrictEqual([row.error, row.attempts, row.body, row.title], ['one', 1, '', 'Weekly sync']);
    await repos.meetings.recordBriefError({ ...v, error: 'two' });
    row = await repos.meetings.briefByKey(v.key);
    assert.deepStrictEqual([row.error, row.attempts], ['two', 2]);
  },

  'briefByKey: by dedupe key, or null': async ({ repos, assert, uniq }) => {
    assert.strictEqual(await repos.meetings.briefByKey(uniq('none')), null);
    const v = brief();
    const row = await repos.meetings.upsertBrief(v);
    assert.strictEqual(String((await repos.meetings.briefByKey(v.key)).id), String(row.id));
  },

  'briefById: by id, or null': async ({ repos, assert }) => {
    assert.strictEqual(await repos.meetings.briefById(999999999), null);
    const row = await repos.meetings.upsertBrief(brief({ title: 'By id' }));
    assert.strictEqual((await repos.meetings.briefById(row.id)).title, 'By id');
  },

  'markBriefNotified: links the notification': async ({ repos, assert }) => {
    const row = await repos.meetings.upsertBrief(brief());
    const n = await repos.notifications.insert({ kind: 'meeting_brief', title: 'T', body: 'B', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    const out = await repos.meetings.markBriefNotified(row.id, n.id);
    assert.strictEqual(String(out.notification_id), String(n.id));
    assert.strictEqual(String(out.id), String(row.id));
  },

  'upsertDebrief: writes it; a repeat for the same transcript updates and counts the attempt': async (t) => {
    const { repos, assert } = t;
    const e = await episode(t);
    const first = await repos.meetings.upsertDebrief(debrief(e));
    assert.deepStrictEqual(
      [Number(first.episode_id), first.title, first.content_hash, first.transcript_chars, first.dropped, first.error, first.attempts, first.extracted_by],
      [e.id, 'A meeting', 'h1', 700, 2, null, 1, 'contract']
    );
    assert.strictEqual(first.applied.items.length, 2);
    const second = await repos.meetings.upsertDebrief(debrief(e, { title: 'Renamed', dropped: 0, applied: { items: [] } }));
    assert.deepStrictEqual([second.id, second.title, second.dropped, second.attempts, second.applied], [first.id, 'Renamed', 0, 2, { items: [] }]);
    const other = await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'h2' }));
    assert.notStrictEqual(String(other.id), String(first.id), 'a new transcript is a new debrief');
  },

  'recordDebriefError: an item-less row; a repeat counts the attempt and keeps the applied items': async (t) => {
    const { repos, assert } = t;
    const e = await episode(t);
    const v = { ...debrief(e), error: 'model said no' };
    await repos.meetings.recordDebriefError(v);
    let row = await repos.meetings.lastDebrief(e.id);
    assert.strictEqual(row, null, 'a failed debrief is not "last"');
    const failed = (await repos.meetings.bestForEpisodes([e.id]))[0];
    assert.deepStrictEqual([failed.error, failed.attempts, failed.applied], ['model said no', 1, { items: [] }]);
    await repos.meetings.recordDebriefError({ ...v, error: 'again' });
    row = (await repos.meetings.bestForEpisodes([e.id]))[0];
    assert.deepStrictEqual([row.error, row.attempts], ['again', 2]);
  },

  'debriefById: by id, or null': async (t) => {
    const { repos, assert } = t;
    assert.strictEqual(await repos.meetings.debriefById(999999999), null);
    const row = await repos.meetings.upsertDebrief(debrief(await episode(t), { title: 'Find me' }));
    assert.strictEqual((await repos.meetings.debriefById(row.id)).title, 'Find me');
  },

  'debriefsForEpisode: every debrief of the episode, failed ones too, oldest first': async (t) => {
    const { repos, assert } = t;
    const e = await episode(t);
    const other = await episode(t);
    const a = await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'a' }));
    await new Promise((r) => setTimeout(r, 5));
    await repos.meetings.recordDebriefError({ ...debrief(e, { contentHash: 'b' }), error: 'x' });
    await repos.meetings.upsertDebrief(debrief(other, { contentHash: 'a' }));
    const list = await repos.meetings.debriefsForEpisode(e.id);
    assert.deepStrictEqual(list.map((d) => d.content_hash), ['a', 'b']);
    assert.strictEqual(String(list[0].id), String(a.id));
    assert.strictEqual(list[1].error, 'x', 'a failed one too');
    assert.deepStrictEqual(list[0].applied.items.map((i) => i.type), ['todo', 'decision'], 'applied is JSON');
    assert.deepStrictEqual(await repos.meetings.debriefsForEpisode(999999999), []);
  },

  'lastDebrief: the newest one that did not fail': async (t) => {
    const { repos, assert } = t;
    const e = await episode(t);
    await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'a', title: 'older' }));
    await new Promise((r) => setTimeout(r, 5));
    const newer = await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'b', title: 'newer' }));
    await new Promise((r) => setTimeout(r, 5));
    await repos.meetings.recordDebriefError({ ...debrief(e, { contentHash: 'c' }), error: 'x' });
    const last = await repos.meetings.lastDebrief(e.id);
    assert.strictEqual(String(last.id), String(newer.id));
    assert.strictEqual(await repos.meetings.lastDebrief(999999999), null);
  },

  'bestForEpisodes: one per episode, a good one before a failed one': async (t) => {
    const { repos, assert } = t;
    const a = await episode(t);
    const b = await episode(t);
    await repos.meetings.recordDebriefError({ ...debrief(a, { contentHash: 'x' }), error: 'bad' });
    const good = await repos.meetings.upsertDebrief(debrief(a, { contentHash: 'y' }));
    const onlyBad = { ...debrief(b), error: 'bad too' };
    await repos.meetings.recordDebriefError(onlyBad);
    const rows = await repos.meetings.bestForEpisodes([a.id, b.id]);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(String(rows.find((r) => Number(r.episode_id) === a.id).id), String(good.id));
    assert.strictEqual(rows.find((r) => Number(r.episode_id) === b.id).error, 'bad too');
    assert.deepStrictEqual(await repos.meetings.bestForEpisodes([]), []);
  },

  'recentDebriefs: within the days, no failures, newest first, limited': async (t) => {
    const { repos, assert } = t;
    const now = Date.now();
    const mk = async (title, startedAt, over = {}) => repos.meetings.upsertDebrief(debrief(await episode(t), { title, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(startedAt + 1800_000).toISOString(), ...over }));
    const older = await mk('older', now - 3 * 86400_000);
    const newer = await mk('newer', now - 1 * 86400_000);
    await mk('ancient', now - 30 * 86400_000);
    const failed = await episode(t);
    await repos.meetings.recordDebriefError({ ...debrief(failed, { startedAt: new Date(now - 3600_000).toISOString() }), error: 'bad' });
    const list = await repos.meetings.recentDebriefs(7, 50);
    const ids = list.map((r) => String(r.id));
    assert.ok(ids.includes(String(older.id)) && ids.includes(String(newer.id)));
    assert.ok(ids.indexOf(String(newer.id)) < ids.indexOf(String(older.id)), 'newest first');
    assert.ok(!list.some((r) => r.title === 'ancient' || r.error), 'no old, no failed');
    assert.strictEqual((await repos.meetings.recentDebriefs(7, 1)).length, 1);
  },

  'markDebriefNotified: links the notification': async (t) => {
    const { repos, assert } = t;
    const row = await repos.meetings.upsertDebrief(debrief(await episode(t)));
    const n = await repos.notifications.insert({ kind: 'meeting_debrief', title: 'T', body: 'B', url: null, dedupeKey: null, priority: 'normal', delivery: 'feed' });
    const out = await repos.meetings.markDebriefNotified(row.id, n.id);
    assert.strictEqual(String(out.notification_id), String(n.id));
  },

  'markItemUndone: stamps one applied item undone with the result': async (t) => {
    const { repos, assert } = t;
    const row = await repos.meetings.upsertDebrief(debrief(await episode(t)));
    await repos.meetings.markItemUndone(row.id, 1, 'undone');
    const after = await repos.meetings.debriefById(row.id);
    assert.strictEqual(after.applied.items[0].undone_at, undefined, 'the other item is untouched');
    assert.strictEqual(after.applied.items[1].undo, 'undone');
    assert.ok(after.applied.items[1].undone_at);
    assert.strictEqual(after.applied.items[1].type, 'decision', 'the rest of the item is kept');
    assert.ok(after.updated_at >= row.updated_at);
  },
  // --- for cli (chunk G)

  'briefStats: briefs written and failed, the last delivered, series learned': async ({ repos, assert, uniq }) => {
    const before = await repos.meetings.briefStats();
    const mk = (over = {}) => ({ key: uniq('b'), eventId: 'e', itemId: null, startsAt: '2096-01-01T09:00:00Z', seriesKey: 's', kind: 'standup', title: 't', headline: 'h', body: 'b', points: {}, refs: {}, joinUrl: null, ...over });
    await repos.meetings.upsertBrief(mk());
    await repos.meetings.recordBriefError({ ...mk(), error: 'x' });
    const key = uniq('learned');
    await repos.meetings.saveSeries({ seriesKey: key, label: 'L', kind: null, kindSource: null, profile: { learnedFrom: ['x'] } });
    const after = await repos.meetings.briefStats();
    assert.deepStrictEqual([after.ok, after.failed, after.learned], [before.ok + 1, before.failed + 1, before.learned + 1]);
    assert.ok(after.last === null || after.last instanceof Date);
  },

  'debriefStats: debriefs written, failed three times, the last written': async ({ repos, seed, db, assert }) => {
    const before = await repos.meetings.debriefStats();
    const ep = async () => seed.episode({ itemId: await seed.item({ source: 'audio', body: 'x' }) });
    const v = (episodeId, over = {}) => ({ episodeId, eventExternalId: null, sourceItemId: null, title: 'T', startedAt: '2096-01-01T09:00:00Z', endedAt: '2096-01-01T09:30:00Z', contentHash: 'h', transcriptChars: 1, applied: { items: [] }, dropped: 0, extractedBy: 'c', ...over });
    await repos.meetings.upsertDebrief(v(await ep()));
    const failing = await ep();
    for (let i = 0; i < 3; i++) await repos.meetings.recordDebriefError({ ...v(failing), error: 'x' });
    await repos.meetings.recordDebriefError({ ...v(await ep()), error: 'once' });
    const after = await repos.meetings.debriefStats();
    assert.deepStrictEqual([after.ok, after.failed], [before.ok + 1, before.failed + 1]);
    assert.ok(after.last instanceof Date);
    assert.ok(db);
  },
  'supersede: hides the older debriefs from every list, keeps the rows; a repeat write brings it back': async (t) => {
    const { repos, assert } = t;
    const e = await episode(t);
    const old = await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'a', title: 'Wrong title', startedAt: new Date().toISOString() }));
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'b', title: 'Right title', startedAt: new Date().toISOString() }));
    assert.strictEqual(await repos.meetings.supersede([], fresh.id), 0);
    assert.strictEqual(await repos.meetings.supersede([old.id, fresh.id], fresh.id), 1, 'never itself');
    const old2 = await repos.meetings.debriefById(old.id);
    assert.strictEqual(String(old2.superseded_by), String(fresh.id));
    assert.deepStrictEqual((await repos.meetings.recentDebriefs(1, 100)).filter((d) => Number(d.episode_id) === e.id).map((d) => d.title), ['Right title']);
    assert.deepStrictEqual((await repos.meetings.bestForEpisodes([e.id])).map((d) => d.title), ['Right title']);
    assert.strictEqual((await repos.meetings.lastDebrief(e.id)).title, 'Right title');
    assert.strictEqual((await repos.meetings.debriefsForEpisode(e.id)).length, 2, 'kept');
    const back = await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'a', title: 'Again' }));
    assert.strictEqual(back.superseded_by, null, 'written again, so live again');
  },

  'retireHash: frees the (episode, transcript) key so the same transcript can be debriefed as a new row': async (t) => {
    const { repos, assert } = t;
    const e = await episode(t);
    const first = await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'same', title: 'First' }));
    await repos.meetings.retireHash(first.id);
    const second = await repos.meetings.upsertDebrief(debrief(e, { contentHash: 'same', title: 'Second' }));
    assert.notStrictEqual(String(second.id), String(first.id));
    assert.strictEqual((await repos.meetings.debriefById(first.id)).title, 'First', 'untouched');
    assert.notStrictEqual((await repos.meetings.debriefById(first.id)).content_hash, 'same');
  },

  'setApplied: replaces the applied items': async (t) => {
    const { repos, assert } = t;
    const row = await repos.meetings.upsertDebrief(debrief(await episode(t)));
    await repos.meetings.setApplied(row.id, { summary: 's2', items: [{ type: 'decision', text: 'z' }] });
    assert.deepStrictEqual((await repos.meetings.debriefById(row.id)).applied, { summary: 's2', items: [{ type: 'decision', text: 'z' }] });
  },
};
