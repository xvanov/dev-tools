'use strict';

// `pa meeting import` / the dashboard upload (src/meetings/import.ts): the
// transcript parsers, matching a recording to a calendar event, and a whole
// import on a throwaway SQLite store: a transcript file, and an audio file
// through ffmpeg and a fake transcriber on a local port (skipped without
// ffmpeg). The model is stubbed: it says "nobody else here", as it would of a
// webinar, and the import must still not be discarded as solo.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-import-'));
process.env.PA_DB = 'sqlite';
process.env.PA_SQLITE_PATH = path.join(dir, 'pa_test_import.sqlite');
process.env.PA_SQLITE_KEY = 'import-test-key';
process.env.PA_DATA_DIR = path.join(dir, 'data');
process.env.PA_AUDIO_DIR = path.join(dir, 'audio');
process.env.PA_IMPORT_CHUNK_SECONDS = '30';

const I = require('../src/meetings/import.ts');

// ---- pure -------------------------------------------------------------------

assert.deepStrictEqual([I.kindOf('Show and Tell.MP4'), I.kindOf('a.vtt'), I.kindOf('a.txt'), I.kindOf('a.docx'), I.kindOf('noext')], ['audio', 'text', 'text', null, null]);
assert.ok(I.isMe('Quinn Marlow', 'Quinn Marlow') && I.isMe('Quinn Marlow (Guest)', 'Quinn Marlow') && !I.isMe('Quinton Marlowe', 'Quinn Marlow') && !I.isMe('', 'Quinn Marlow'));

{
  // Teams: <v Name> tags, consecutive cues of one speaker merged, you labelled Me, the length from the last cue.
  const teams = `WEBVTT

NOTE made by Teams

00:00:01.000 --> 00:00:04.000
<v Ada Lovelace>Welcome everyone, today we cover the new engine.</v>

00:00:04.500 --> 00:00:09.000
<v Ada Lovelace>First the roadmap.</v>

00:00:09.500 --> 01:02:03.250
<v Quinn Marlow>Thanks, I will review the roadmap by Friday.</v>
`;
  const r = I.parseTranscript(teams, 'Quinn Marlow');
  assert.strictEqual(r.text, 'Ada Lovelace: Welcome everyone, today we cover the new engine. First the roadmap.\n\nMe: Thanks, I will review the roadmap by Friday.');
  assert.strictEqual(r.seconds, 3723.25);
}
{
  // Zoom: "Name: text" cues; SRT numbering and commas in the timings.
  const zoom = `1
00:00:00,000 --> 00:00:05,500
Grace Hopper: Can everyone see the slides?

2
00:00:06,000 --> 00:00:09,000
Yes we can.
`;
  const r = I.parseTranscript(zoom, null);
  assert.strictEqual(r.text, 'Grace Hopper: Can everyone see the slides?\n\nThem: Yes we can.');
  assert.strictEqual(r.seconds, 9);
}
{
  // Plain text: labelled lines keep their names; unlabelled paragraphs are other people.
  assert.strictEqual(I.parseTranscript('Ada: one\nQuinn Marlow: two\nthree', 'Quinn Marlow').text, 'Ada: one\n\nMe: two three');
  assert.strictEqual(I.parseTranscript('Just a block\nof words.\n\nAnd another.', 'Quinn Marlow').text, 'Them: Just a block of words.\n\nThem: And another.');
  assert.strictEqual(I.parseTranscript('', null).text, '');
}

{
  const t = (h, m) => Date.UTC(2026, 10, 10, h, m);
  const ev = (id, from, to, extra = {}) => ({ external_id: id, subject: id, occurred_at: new Date(from).toISOString(), raw: { start: { dateTime: new Date(from).toISOString().replace('Z', '') }, end: { dateTime: new Date(to).toISOString().replace('Z', '') }, attendees: ['x@y.test'], ...extra } });
  const all = ev('all-company', t(18, 15), t(19, 15));
  const webinar = ev('webinar', t(18, 15), t(19, 15));
  const standup = ev('standup', t(15, 59), t(16, 15));
  assert.strictEqual(I.matchEvent([standup, all], t(18, 15), t(19, 10)).event.external_id, 'all-company');
  // Two slots held equally: the caller must say which (it has no call app to tell them apart).
  const tie = I.matchEvent([all, webinar], t(18, 15), t(19, 15));
  assert.deepStrictEqual([tie.event, tie.ambiguous.map((e) => e.external_id)], [null, ['all-company', 'webinar']]);
  // A brush with a slot is not that meeting; neither is a cancelled or free one.
  assert.strictEqual(I.matchEvent([standup], t(16, 10), t(17, 30)).event, null);
  assert.strictEqual(I.matchEvent([ev('c', t(18, 15), t(19, 15), { isCancelled: true }), ev('f', t(18, 15), t(19, 15), { showAs: 'free' })], t(18, 15), t(19, 15)).event, null);
}

// ---- a whole import ----------------------------------------------------------

const { available } = require('../src/db/sqlite.ts');

(async () => {
  if (!available()) return console.log('meetingImport: pure parts ok (no sqlite driver: store tests skipped)');
  const repo = require('../src/repo');
  const db = require('../src/db');
  await require('../src/db/migrate.ts').migrate();
  const llm = require('../src/llm.ts');
  let prompts = [];
  llm.complete = async ({ prompt }) => {
    prompts.push(prompt);
    return JSON.stringify({ others_present: false, title: 'Model title', summary: 'A webinar about agents.', todos: [], owed_to_me: [], updates: [], decisions: [] });
  };
  const debriefMod = require('../src/meetings/debrief.ts');

  // The calendar: two events in the same slot (the 2026-11-10 case).
  const start = Date.UTC(2026, 10, 10, 18, 15);
  const event = (id, subject) =>
    repo.sources.upsertItem({ source: 'graph_event', externalId: id, threadExternalId: null, occurredAt: new Date(start), authorIdentity: 'org@x.test', subject, bodyText: '', raw: { start: { dateTime: new Date(start).toISOString().replace('Z', '') }, end: { dateTime: new Date(start + 3600_000).toISOString().replace('Z', '') }, attendees: ['a@x.test'] }, hash: `h-${id}` });
  await event('ev-all', 'All Company Meeting');
  await event('ev-webinar', 'Mainsail AI Engineering Show and Tell');

  const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const vtt = path.join(dir, 'webinar.vtt');
  fs.writeFileSync(vtt, `WEBVTT\n\n00:00:00.000 --> 00:40:00.000\n<v Presenter>${words(80)}</v>\n`);

  // Two events overlap equally and nothing says which: refused, naming both.
  await assert.rejects(() => I.importMeeting({ file: vtt, at: new Date(start).toISOString(), debrief: false }), /ev-all[\s\S]*ev-webinar|ev-webinar[\s\S]*ev-all/);
  // Too short to be a meeting.
  const tiny = path.join(dir, 'tiny.txt');
  fs.writeFileSync(tiny, 'hello there');
  await assert.rejects(() => I.importMeeting({ file: tiny, title: 'x', debrief: false }), /nothing to debrief/);
  await assert.rejects(() => I.importMeeting({ file: path.join(dir, 'x.docx'), debrief: false }), /cannot import/);
  await assert.rejects(() => I.importMeeting({ file: vtt, eventId: 'nope', debrief: false }), /no calendar event/);
  await assert.rejects(() => I.importMeeting({ file: vtt, at: 'soon', debrief: false }), /not a date/);

  // By event: filed under it, stored as an imported loopback episode, debriefed, not discarded as solo.
  const r = await I.importMeeting({ file: vtt, eventId: 'ev-webinar' });
  assert.strictEqual(r.title, 'Mainsail AI Engineering Show and Tell');
  assert.strictEqual(r.eventId, 'ev-webinar');
  assert.strictEqual(r.startedAt, new Date(start).toISOString(), 'the event\'s start');
  assert.strictEqual(r.endedAt, new Date(start + 40 * 60_000).toISOString(), 'the length the cues say');
  const ep = await db.one('select * from audio_episode where id = $1', [r.episodeId]);
  assert.deepStrictEqual([ep.stream, ep.state, ep.kind, ep.calendar_event_id, ep.audio_path], ['loopback', 'imported', 'meeting', 'ev-webinar', null]);
  const item = await db.one('select * from source_item where id = $1', [ep.source_item_id]);
  assert.ok(item.body_text.startsWith('Presenter: word0'));
  assert.ok(r.debrief.debrief, 'debriefed');
  assert.ok(!r.debrief.solo, 'the model said nobody else was there: an imported recording is still kept');
  assert.ok(/did not attend live/.test(prompts[0]), 'the model is told it is a recording the engineer was not in');
  assert.strictEqual(r.debrief.debrief.title, 'Mainsail AI Engineering Show and Tell');
  assert.deepStrictEqual((await debriefMod.recent({ days: 3650, limit: 50 })).map((d) => d.title), ['Mainsail AI Engineering Show and Tell']);

  // The same file again: the same episode, debriefed again, the older debrief superseded, one listed.
  const again = await I.importMeeting({ file: vtt, eventId: 'ev-all' });
  assert.deepStrictEqual([again.episodeId, again.reimport, again.title], [r.episodeId, true, 'All Company Meeting']);
  assert.strictEqual((await db.one('select count(*) as n from audio_episode')).n, 1);
  assert.deepStrictEqual((await debriefMod.recent({ days: 3650, limit: 50 })).map((d) => d.title), ['All Company Meeting']);
  assert.deepStrictEqual(again.debrief.superseded, [r.debrief.debrief.id]);

  // By title: no calendar match is tried; no debrief when asked.
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, `Quinn: ${words(60)}\nRiley: ${words(60)}`);
  const t = await I.importMeeting({ file: txt, title: 'Vendor call', at: '2026-11-11T15:00:00Z', debrief: false });
  assert.deepStrictEqual([t.title, t.eventId, t.debrief, t.startedAt], ['Vendor call', null, null, '2026-11-11T15:00:00.000Z']);

  // Isolation: the live capture's own queries do not touch it.
  assert.strictEqual(await repo.audio.continuing({ startedAt: new Date(start - 600_000).toISOString(), endedAt: new Date(start + 3600_000).toISOString(), claimed: [], stream: 'mic' }), null);
  assert.strictEqual(await repo.audio.supersedeWithin(new Date(start - 600_000).toISOString(), new Date(start + 3600_000).toISOString(), []), 0);
  assert.strictEqual((await repo.audio.awaitingDebrief(new Date(start + 7200_000))).length, 0, 'the audio pass does not debrief it itself');

  // Audio: ffmpeg cuts it, the (fake) transcriber is asked once per chunk, silence is not sent.
  const ff = spawnSync(process.env.PA_FFMPEG || 'ffmpeg', ['-version'], { windowsHide: true });
  if (ff.error || ff.status !== 0) {
    console.log('meetingImport: audio part skipped (no ffmpeg)');
  } else {
    const asked = [];
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        if (!buf.includes('\n')) return;
        asked.push(path.basename(buf.trim()));
        sock.end(`This is chunk number ${asked.length} of the webinar, and the speaker explains the agent design in a good deal of detail. `.repeat(2));
      });
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const { config } = require('../src/config.ts');
    config.audio.transcribePort = server.address().port;
    // 70 s of 16 kHz tone then 30 s of silence: chunks of 30 s -> 4 chunks, the last silent.
    const rate = 16000;
    const pcm = Buffer.alloc(100 * rate * 2);
    for (let i = 0; i < 70 * rate; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    const wav = path.join(dir, 'Webinar recording.wav');
    fs.writeFileSync(wav, Buffer.concat([header, pcm]));
    const seen = [];
    const a = await I.importMeeting({ file: wav, title: 'Webinar from audio', at: '2026-11-12T14:00:00Z', debrief: false, onProgress: (p) => seen.push(p.state) });
    server.close();
    assert.strictEqual(asked.length, 3, 'three non-silent chunks sent, the silent one not: ' + asked);
    assert.ok(seen.includes('decoding') && seen.includes('transcribing') && seen.includes('storing'));
    assert.strictEqual(new Date(a.endedAt).getTime() - new Date(a.startedAt).getTime(), 100_000, 'its length from the audio');
    const it = await db.one(`select body_text from source_item where subject = 'Webinar from audio'`);
    assert.strictEqual(it.body_text.split('\n\n').length, 3);
    assert.ok(it.body_text.startsWith('Them: This is chunk number 1'));
    assert.deepStrictEqual(fs.readdirSync(process.env.PA_AUDIO_DIR).filter((n) => n.startsWith('import-')), [], 'no chunks are kept');
  }

  // The dashboard's background job: queued, then done, with its file deleted.
  const copy = path.join(dir, 'upload.txt');
  fs.copyFileSync(txt, copy);
  const job = I.start({ file: copy, name: 'upload.txt', title: 'Uploaded call', debrief: false });
  assert.strictEqual(job.state, 'queued');
  for (let i = 0; i < 100 && I.jobs()[0].state !== 'done' && I.jobs()[0].state !== 'error'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual([I.jobs()[0].state, I.jobs()[0].title, I.jobs()[0].id], ['done', 'Uploaded call', job.id]);
  assert.strictEqual(fs.existsSync(copy), false, 'the upload is deleted');
  const failing = I.start({ file: path.join(dir, 'gone.txt'), name: 'gone.txt', title: 'x' });
  for (let i = 0; i < 100 && I.jobs()[0].state === 'queued'; i++) await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 100 && I.jobs()[0].state !== 'error'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(I.jobs()[0].state, 'error');
  assert.ok(I.jobs()[0].error && failing.id === I.jobs()[0].id);

  // The upload route: guarded, streamed to disk, answered 202 with its job.
  {
    const { PassThrough } = require('stream');
    const dash = require('../src/dashboard/debriefs.ts');
    const { config } = require('../src/config.ts');
    const sent = [];
    const send = (_res, status, body) => sent.push([status, body]);
    const post = (headers, body, query) => {
      const req = new PassThrough();
      req.headers = headers;
      setImmediate(() => { for (const c of body) req.write(c); req.end(); });
      return dash.upload(req, {}, new URL(`http://x/api/debriefs/import?${query}`), { send });
    };
    const body = [Buffer.from(`Sam: ${words(70)}
`), Buffer.from(`Alex: ${words(70)}
`)];
    await post({}, body, 'name=up.txt&title=Posted');
    await post({ 'x-pa': '1' }, body, 'name=up.docx');
    config.audio.import.maxMb = 0;
    await post({ 'x-pa': '1' }, body, 'name=up.txt&title=Posted');
    config.audio.import.maxMb = 512;
    await post({ 'x-pa': '1' }, [], 'name=up.txt&title=Posted');
    await post({ 'x-pa': '1' }, body, 'name=up.txt&title=Posted%20upload&at=2026-11-13T10:00:00Z');
    assert.deepStrictEqual(sent.map((x) => x[0]), [403, 400, 413, 400, 202]);
    assert.strictEqual(sent[4][1].state, 'queued');
    for (let i = 0; i < 100 && I.jobs()[0].state !== 'done'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual([I.jobs()[0].state, I.jobs()[0].title], ['done', 'Posted upload']);
    assert.deepStrictEqual(fs.readdirSync(path.join(process.env.PA_AUDIO_DIR, 'import-uploads')), [], 'no upload is left behind, refused or done');
    assert.deepStrictEqual((await dash.route('GET', new URL('http://x/api/debriefs/imports'), {}))[0].id, I.jobs()[0].id);
  }

  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('meetingImport: ok');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
