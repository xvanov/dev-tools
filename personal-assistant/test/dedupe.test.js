'use strict';

// The cross-thread duplicate pass (src/commitments/semantic.js) and the
// distiller's list rule (src/distill/lists.js): candidates by meaning, thread
// and anchor; the judge's typed verdicts; who survives a fold; and one
// commitment per list. Names are invented.

const assert = require('assert');
const S = require('../src/commitments/semantic');
const { collapse, listLines } = require('../src/distill/lists.ts');
const { alsoLinks } = require('../src/dashboard/links.ts');

// ------------------------------------------------------------- anchors ----
{
  const a = S.anchors(
    'Merge acme/deploystate#153 after the release; see https://github.com/acme/web/pull/77 and https://review.example.com/answers/?x=1 and OPS-42',
    null
  );
  assert.deepStrictEqual(a, ['deploystate#153', 'jira:ops-42', 'url:review.example.com/answers', 'web#77']);
  // A PR thread anchors what was said in it.
  assert.deepStrictEqual(S.anchors('Sync the apps after merging', 'https://github.com/acme/deploystate/pull/153'), ['deploystate#153']);
  // A bare "#153" or "PR #153" names no repo; a chat link is a place, not a piece of work.
  assert.deepStrictEqual(S.anchors('Review PR #153 and issue #9 in https://teams.microsoft.com/l/message/19:abc'), []);
  // UTF-8 is not a ticket.
  assert.deepStrictEqual(S.anchors('Save it as UTF-8'), []);
}

// ------------------------------------------------------------ thread key ----
{
  const draft = 'https://teams.microsoft.com/l/message/48%3Adrafts/-4.19:AbC123@thread.v2?context=%7B%7D';
  assert.strictEqual(S.threadKey('48:drafts', draft), '19:abc123@thread.v2');
  assert.strictEqual(S.threadKey('19:Other@thread.v2', null), '19:other@thread.v2');
  assert.strictEqual(S.threadKey('48:drafts', null), '48:drafts');
}

// ------------------------------------------------------ threshold logic ----
{
  const v = (x, y) => [x, y, 0];
  const base = { direction: 'owed_by_me', has_party: true, anchors: [], thread: null, source_item_id: null };
  const c = { ...base, id: '10', vector: v(1, 0), thread: 't1', anchors: ['deploystate#153'] };
  const at = (cos) => v(cos, Math.sqrt(1 - cos * cos));
  const pool = [
    { ...base, id: '1', vector: at(0.65) }, // above the threshold
    { ...base, id: '2', vector: at(0.5) }, // below, nothing else
    { ...base, id: '3', vector: at(0.45), thread: 't1' }, // same conversation: the lower floor
    { ...base, id: '4', vector: at(0.32), anchors: ['deploystate#153'] }, // shared anchor: the lowest floor
    { ...base, id: '5', vector: at(0.25), anchors: ['deploystate#153'] }, // anchor, but nothing alike
    { ...base, id: '6', vector: at(0.9), direction: 'owed_to_me' }, // other direction, both have a party
    { ...base, id: '7', vector: at(0.9), direction: 'owed_to_me', has_party: false }, // other direction, no party: comparable
  ];
  const got = S.candidates(c, pool).map((o) => o.id).sort();
  assert.deepStrictEqual(got, ['1', '3', '4', '7']);
  assert.ok(S.THRESHOLD >= 0.55 && S.THRESHOLD <= 0.7, 'threshold within the calibrated band');
  assert.ok(S.ANCHOR_FLOOR < S.THREAD_FLOOR && S.THREAD_FLOOR < S.THRESHOLD);

  // pairs(): each pair once, lower id first.
  const items = [c, ...pool];
  const ps = S.pairs(items);
  assert.ok(ps.every((p) => Number(p.a) < Number(p.b)));
  assert.strictEqual(new Set(ps.map((p) => p.key)).size, ps.length);
  assert.ok(ps.some((p) => p.key === '1-10'));
}

// ------------------------------------------------------- typed verdicts ----
{
  const asked = new Map([
    ['1-2', { a: '1', b: '2' }],
    ['3-4', { a: '3', b: '4' }],
    ['5-6', { a: '5', b: '6' }],
    ['7-8', { a: '7', b: '8' }],
    ['9-10', { a: '9', b: '10' }],
  ]);
  const answer = JSON.stringify({
    pairs: [
      { pair: '1-2', a_includes_b: true, b_includes_a: true, verdict: 'same', keep: 'B', why: 'restated' },
      { pair: '3-4', a_includes_b: true, b_includes_a: false, verdict: 'subset', keep: null, why: 'item of list' },
      { pair: '5-6', a_includes_b: false, b_includes_a: false, verdict: 'same', keep: 'A' }, // contradicts itself
      { pair: '7-8', a_includes_b: true, b_includes_a: true, verdict: 'same', keep: null }, // same without a keeper
      { pair: '99-100', a_includes_b: true, b_includes_a: true, verdict: 'same', keep: 'A' }, // not asked
      { pair: '9-10', verdict: 'maybe' },
    ],
  });
  const m = S.parseVerdicts(`Sure:\n\`\`\`json\n${answer}\n\`\`\``, asked);
  assert.deepStrictEqual(m.get('1-2'), { verdict: 'same', keep: '2', drop: '1', why: 'restated' });
  assert.deepStrictEqual(m.get('3-4'), { verdict: 'subset', keep: '3', drop: '4', why: 'item of list' });
  assert.strictEqual(m.get('5-6').verdict, 'different');
  assert.ok(!m.has('7-8'));
  assert.ok(!m.has('99-100'));
  assert.ok(!m.has('9-10'));
}

// ------------------------------------------------------- survivor choice ----
{
  const byId = new Map([
    ['1', { acted: false, summary: 'Get feedback on the review page' }],
    ['2', { acted: true, summary: 'Get feedback on the answer review page' }],
    ['3', { acted: false, summary: 'Merge deploystate#153' }],
  ]);
  // same: the judge's keeper unless only the other one was acted on.
  assert.deepStrictEqual(S.resolveVerdict({ verdict: 'same', keep: '1', drop: '2' }, byId), { drop: '1', keep: '2', relation: 'same' });
  assert.deepStrictEqual(S.resolveVerdict({ verdict: 'same', keep: '3', drop: '1' }, byId), { drop: '1', keep: '3', relation: 'same' });
  assert.strictEqual(S.resolveVerdict({ verdict: 'different', keep: null, drop: null }, byId), null);
}

// ------------------------------------------------------ subset and umbrellas ----
{
  const umbrella = { acted: false, source: 'graph_chat', summary: 'Work through hosting target, key vault, database role and network items', detail: 'Four items: choose the hosting target, stand up a key vault with an owner, create a least-privilege database role, keep the network when the box is retired.' };
  const byId = new Map([
    ['10', umbrella],
    ['11', { acted: false, source: 'graph_chat', summary: 'Create a least-privilege database role for the app' }],
    ['12', { acted: false, source: 'graph_chat', summary: 'Stand up a key vault for the app and name its owner' }],
    ['13', { acted: false, source: 'graph_chat', summary: 'Keep the network when the box is retired' }],
    ['14', { acted: true, source: 'graph_chat', summary: 'Choose the hosting target for the app' }],
    ['20', { acted: false, source: 'claude_session', summary: 'Wire up the voice page and its tests', detail: 'voice page tests wiring' }],
    ['21', { acted: false, source: 'claude_session', summary: 'Write tests for the voice page' }],
  ]);
  const same = { sameThread: true };
  // The judge named the part as the whole: the words turn it round.
  const flipped = S.resolveVerdict({ verdict: 'subset', keep: '11', drop: '10' }, byId, same);
  assert.deepStrictEqual([flipped.keep, flipped.drop, flipped.relation], ['10', '11', 'subset']);
  // Across conversations, a subset folds only on a shared anchor.
  assert.strictEqual(S.resolveVerdict({ verdict: 'subset', keep: '10', drop: '11' }, byId, { sameThread: false }), null);
  const anchored = S.resolveVerdict({ verdict: 'subset', keep: '10', drop: '11' }, byId, { sameThread: false, shared: ['app#5'] });
  assert.ok(anchored.anchored);
  // A Claude session's transcript is not a conversation.
  assert.strictEqual(S.resolveVerdict({ verdict: 'subset', keep: '20', drop: '21' }, byId, same), null);
  // An acted part is not hidden behind an untouched whole.
  assert.strictEqual(S.resolveVerdict({ verdict: 'subset', keep: '10', drop: '14' }, byId, same), null);

  const subs = ['11', '12', '13'].map((d) => S.resolveVerdict({ verdict: 'subset', keep: '10', drop: d }, byId, same));
  const folds = S.umbrellaFolds(subs);
  assert.deepStrictEqual(folds.map((f) => f.drop).sort(), ['11', '12', '13']);
  assert.ok(folds.every((f) => f.keep === '10'));
  // One "part of" verdict alone folds nothing.
  assert.deepStrictEqual(S.umbrellaFolds([{ drop: '11', keep: '10', cover: 0.9 }]), []);
  // A weak part rides along only once the umbrella is established.
  const mixed = S.umbrellaFolds([
    { drop: '11', keep: '10', cover: 0.8 },
    { drop: '12', keep: '10', cover: 0.5 },
    { drop: '13', keep: '10', cover: 0.28 },
    { drop: '15', keep: '10', cover: 0.1 },
  ]);
  assert.deepStrictEqual(mixed.map((f) => f.drop).sort(), ['11', '12', '13']);
}

// ------------------------------------------ distill: one list, one commitment ----
{
  const c = (summary, o = {}) => ({ direction: 'owed_by_me', summary, detail: null, counterparty: 'Ola Brandt', dueAt: null, project: null, confidence: 0.8, ...o });

  // The model returned per-item children plus an umbrella: collapse to the umbrella.
  const umb = c('Work through hosting target, key vault, database role and network items', {
    detail: 'Four items: choose the hosting target, stand up a key vault with an owner, create a least-privilege database role, keep the network when the box is retired.',
  });
  const out = collapse([
    c('Choose the hosting target for the app'),
    umb,
    c('Stand up a key vault for the app and name its owner', { dueAt: '2026-11-20T00:00:00.000Z' }),
    c('Create a least-privilege database role for the app'),
    c('Send the quarterly invoice to finance', { direction: 'owed_to_me' }),
  ]);
  assert.strictEqual(out.commitments.length, 2);
  const one = out.commitments.find((x) => x.direction === 'owed_by_me');
  assert.strictEqual(one.summary, umb.summary);
  assert.ok(/Items:\n- Choose the hosting target/.test(one.detail));
  assert.ok(one.detail.includes('- Create a least-privilege database role'));
  assert.strictEqual(one.dueAt, '2026-11-20T00:00:00.000Z', 'the earliest due date of the set');
  assert.ok(out.commitments.some((x) => x.summary === 'Send the quarterly invoice to finance'));

  // No umbrella, but the body is a numbered list restated item by item.
  const body = 'Where you could help:\n\n1. Target: cluster or app service?\n2. Secrets: a key vault for the app, and who owns it.\n3. Database: a least-privilege role for the app.\n\nAlso, lunch on Friday?';
  assert.deepStrictEqual(listLines(body).length, 3);
  const listed = collapse([
    c('Decide the hosting target: cluster or app service'),
    c('Provide a key vault for the app and name who owns it'),
    c('Create a least-privilege database role for the app'),
  ], body);
  assert.strictEqual(listed.commitments.length, 1);
  assert.ok(/^Handle the 3 listed items: /.test(listed.commitments[0].summary));
  assert.ok(listed.commitments[0].summary.length <= 100);
  assert.strictEqual((listed.commitments[0].detail.match(/^- /gm) || []).length, 3);

  // Independent asks stay separate.
  const apart = collapse([c('Renew the domain before it lapses'), c('Book the offsite venue for March')], 'Two things:\n- renew the domain\n- the offsite');
  assert.strictEqual(apart.commitments.length, 2);
}

// ------------------------------------------------- "also mentioned in" ----
{
  const own = [{ url: 'https://teams.microsoft.com/l/message/19%3Aa/1' }];
  const members = [
    { id: 5, item: { source: 'graph_chat', raw: { webUrl: 'https://teams.microsoft.com/l/message/19%3Aa/1' } } }, // the card's own message
    { id: 6, item: { source: 'graph_chat', raw: { webUrl: 'https://teams.microsoft.com/l/message/19%3Ab/2', chatTopic: 'Ops' } } },
    { id: 7, item: { source: 'github_pr', raw: { webUrl: 'https://github.com/acme/deploystate/pull/153' } } },
    { id: 8, item: { source: 'github_notification', raw: { webUrl: 'https://github.com/acme/deploystate/pull/153' } } }, // same PR again
  ];
  const links = alsoLinks(own, members);
  assert.deepStrictEqual(links.map((l) => l.id), [6, 7]);
  assert.ok(links.every((l) => l.kind === 'also'));
}

console.log('dedupe ok');
