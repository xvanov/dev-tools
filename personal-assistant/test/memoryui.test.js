'use strict';

// The dashboard's Memory tab: the markdown tree pages are shown through, the
// duplicate-people heuristics, the route table, and the page's own script.
// Names are invented.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseMarkdown, parseInline, inlineText, pageSummary } = require('../src/dashboard/markdown');
const { duplicatePairs, handleOf, route, clean } = require('../src/dashboard/memory');

// ------------------------------------------------------------ markdown -----

{
  const md = [
    '# Brannoc Quill',
    'Staff engineer, ledger team [#12].',
    '',
    '## Works on',
    '- **ledger-sync** service [#12, #34]',
    '  - nightly reconciliation',
    '- reviews `payments` PRs [#note]',
    '',
    '1. first',
    '2. second',
    '',
    '> a quoted line',
    '',
    '```',
    '<b>not bold</b>',
    '```',
    '---',
    'See [the runbook](https://example.test/runbook) and *carefully* _too_.',
  ].join('\n');
  const b = parseMarkdown(md);
  assert.deepStrictEqual(b.map((x) => x.t), ['h', 'p', 'h', 'ul', 'ol', 'quote', 'pre', 'hr', 'p']);
  assert.strictEqual(b[0].level, 1);
  assert.strictEqual(inlineText(b[0].kids), 'Brannoc Quill');
  // Citations become refs; the brackets stay as text.
  assert.deepStrictEqual(b[1].kids.filter((k) => k.t === 'ref'), [{ t: 'ref', id: 12 }]);
  const ul = b[3];
  assert.strictEqual(ul.items.length, 3);
  assert.deepStrictEqual(ul.items.map((i) => i.depth), [0, 1, 0]);
  assert.strictEqual(ul.items[0].kids[0].t, 'b');
  assert.deepStrictEqual(ul.items[0].kids.filter((k) => k.t === 'ref').map((k) => k.id), [12, 34]);
  assert.ok(ul.items[2].kids.some((k) => k.t === 'code' && k.v === 'payments'));
  assert.ok(!ul.items[2].kids.some((k) => k.t === 'ref'), '[#note] is not an item');
  assert.strictEqual(b[4].items.length, 2);
  assert.strictEqual(b[6].text, '<b>not bold</b>');
  const last = b[8].kids;
  assert.ok(last.some((k) => k.t === 'link' && k.href === 'https://example.test/runbook'));
  assert.strictEqual(last.filter((k) => k.t === 'i').length, 2);
}

{
  // Markup in page text is text. Nothing in the tree is ever HTML.
  const evil = parseInline('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](data:text/html,hi)');
  assert.ok(evil.every((k) => k.t === 'text'));
  assert.strictEqual(inlineText(evil), '<img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](data:text/html,hi)');
  // snake_case and 2*3*4 are not emphasis.
  assert.ok(parseInline('call some_helper_name now').every((k) => k.t === 'text'));
  assert.ok(parseInline('2*3*4').every((k) => k.t === 'text'));
  // A bare "#1" in prose is not a citation.
  assert.ok(parseInline('our #1 priority').every((k) => k.t === 'text'));
  assert.deepStrictEqual(parseMarkdown(''), []);
  assert.deepStrictEqual(parseMarkdown(null), []);
  // Unterminated fence: the rest is code, not a crash.
  assert.strictEqual(parseMarkdown('```\nopen').at(-1).t, 'pre');
}

{
  assert.strictEqual(pageSummary('# Quill\nRuns the ledger team [#4]; reviews payments [#5, #6].\n## Works on\n- x'),
    'Runs the ledger team; reviews payments.');
  assert.strictEqual(pageSummary('# Quill\n## Works on\n- ledger-sync [#4]'), 'ledger-sync');
  assert.strictEqual(pageSummary(''), '');
  assert.ok(pageSummary(`# T\n${'word '.repeat(100)}`).length <= 160);
}

// ---------------------------------------------------- duplicate people -----

{
  assert.strictEqual(handleOf('github:Q-Brannoc'), 'qbrannoc');
  assert.strictEqual(handleOf('brannoc.quill@example.test'), 'brannocquill');

  const people = [
    { id: 1, display_name: 'Me Myself', is_me: true, identities: [{ kind: 'smtp', value: 'me@example.test' }] },
    { id: 2, display_name: 'Brannoc Quill', identities: [{ kind: 'smtp', value: 'brannoc.quill@example.test' }], claims: 3 },
    // GitHub handle with an org suffix, page titled by handle only.
    { id: 3, display_name: 'github:brannocquill-acme', page_title: 'github:brannocquill-acme',
      identities: [{ kind: 'github_username', value: 'brannocquill-acme' }], claims: 1 },
    // Same human name, two rows.
    { id: 4, display_name: 'Ysolde Varn', identities: [{ kind: 'smtp', value: 'ysolde.varn@example.test' }] },
    { id: 5, display_name: 'ysvarn', page_title: 'Ysolde Varn', identities: [{ kind: 'github_username', value: 'ysvarn' }], claims: 9 },
    // Initial + surname handle.
    { id: 6, display_name: 'Odo Fennick', identities: [{ kind: 'smtp', value: 'odo@example.test' }] },
    { id: 7, display_name: 'github:ofennick', identities: [{ kind: 'github_username', value: 'ofennick' }] },
    // Unrelated people who merely share a surname: not a pair.
    { id: 8, display_name: 'Tamsin Quill', identities: [{ kind: 'smtp', value: 'tamsin.quill@example.test' }] },
    // A bot shares nothing.
    { id: 9, display_name: 'github:helperbot', identities: [{ kind: 'github_username', value: 'helperbot' }] },
  ];
  const pairs = duplicatePairs(people);
  const key = (p) => `${p.into.id}<-${p.from.id}`;
  const got = pairs.map(key).sort();
  assert.deepStrictEqual(got, ['2<-3', '5<-4', '6<-7'].sort(), `pairs: ${got}`);
  const bq = pairs.find((p) => p.from.id === 3);
  assert.ok(bq.reasons.some((r) => /fits the other's name/.test(r)));
  assert.ok(bq.reasons.some((r) => /only by a handle/.test(r)));
  // The survivor is the one with the real name; with names equal, more history wins.
  assert.strictEqual(pairs.find((p) => p.from.id === 4 || p.into.id === 4).into.id, 5);
  // Nobody is ever suggested to be merged away from being me.
  const withMe = duplicatePairs([
    { id: 1, display_name: 'Brannoc Quill', is_me: true, identities: [] },
    { id: 2, display_name: 'github:bquill', identities: [{ kind: 'github_username', value: 'bquill' }] },
  ]);
  assert.strictEqual(withMe.length, 1);
  assert.strictEqual(withMe[0].into.id, 1);
  assert.deepStrictEqual(duplicatePairs([]), []);
  assert.deepStrictEqual(duplicatePairs(null), []);
}

// --------------------------------------------------------------- routes -----

(async () => {
  const calls = [];
  const fake = {
    stats: async () => ({ pending_review: 1 }),
    subjects: async () => [
      { kind: 'person', id: 2, title: 'Brannoc Quill', body: '# Brannoc Quill\nLedger lead [#3].', claims: 2 },
      { kind: 'topic', id: null, title: 'release train', body: null, claims: 4 },
    ],
    getPage: async () => ({ title: 'Brannoc Quill', body: '# Brannoc Quill\n<script>x</script>', generated_at: null }),
    claimsFor: async (s, o) => { calls.push(['claimsFor', s, o]); return { claims: [{ id: 1, text: 't', embedding: '[1,2]', tsv: 'x' }] }; },
    forget: async (id) => { calls.push(['forget', id]); return { retracted: 1, restored: 0 }; },
    approve: async (id) => { calls.push(['approve', id]); return { claim: { id, decision: 'add' }, consolidation: {} }; },
    mergePeople: async (a, b) => { calls.push(['merge', a, b]); return { into: a, from: b, claims: 2 }; },
    remember: async (text, o) => { calls.push(['remember', text, o]); return { claim: { id: 9, embedding: 'v' }, consolidation: {} }; },
    people: async () => [],
    reviewQueue: async () => [],
    explain: async () => null,
    item: async () => null,
  };
  const u = (p) => new URL(`http://127.0.0.1${p}`);
  const call = (method, p, body) => route(method, u(p), body, fake);
  const status = async (fn) => {
    try { await fn(); return 200; } catch (err) { return err.status || 500; }
  };

  const o = await call('GET', '/api/memory/overview');
  assert.strictEqual(o.subjects[0].summary, 'Ledger lead.');
  assert.strictEqual(o.subjects[0].hasPage, true);
  assert.strictEqual(o.subjects[1].hasPage, false);

  const pg = await call('GET', '/api/memory/page?kind=person&id=2');
  assert.ok(!('embedding' in pg.claims[0]) && !('tsv' in pg.claims[0]));
  assert.ok(JSON.stringify(pg.blocks).includes('<script>x</script>'), 'kept as text in the tree');
  await call('GET', '/api/memory/page?kind=topic&label=Release%20Train&history=1');
  assert.deepStrictEqual(calls.at(-1), ['claimsFor', { kind: 'topic', id: null, label: 'release train' }, { all: true }]);

  assert.strictEqual(await status(() => call('GET', '/api/memory/page?kind=evil')), 400);
  assert.strictEqual(await status(() => call('GET', '/api/memory/page?kind=person&id=abc')), 400);
  assert.strictEqual(await status(() => call('GET', '/api/memory/claims/5')), 404);
  assert.strictEqual(await status(() => call('GET', '/api/memory/items/5')), 404);
  assert.strictEqual(await call('GET', '/api/memory/nope'), undefined);
  assert.strictEqual(await call('POST', '/api/memory/overview'), undefined, 'reads are not POSTs');
  assert.strictEqual(await call('GET', '/api/memory/claims/5/forget'), undefined, 'writes are not GETs');

  await call('POST', '/api/memory/claims/7/reject');
  assert.deepStrictEqual(calls.at(-1), ['forget', 7], 'reject is forget');
  await call('POST', '/api/memory/claims/7/approve');
  assert.deepStrictEqual(calls.at(-1), ['approve', 7]);
  await call('POST', '/api/memory/people/merge', { into: 2, from: '3' });
  assert.deepStrictEqual(calls.at(-1), ['merge', 2, 3]);
  assert.strictEqual(await status(() => call('POST', '/api/memory/people/merge', { into: 2, from: 2 })), 400);
  assert.strictEqual(await status(() => call('POST', '/api/memory/people/merge', { into: 2 })), 400);
  assert.strictEqual(await status(() => call('POST', '/api/memory/remember', { text: '  ' })), 400);
  const r = await call('POST', '/api/memory/remember', { text: 'Quill prefers async review', subject: 'Quill' });
  assert.ok(!('embedding' in r.claim));
  assert.deepStrictEqual(calls.at(-1), ['remember', 'Quill prefers async review', { subject: 'Quill', kind: null }]);
  assert.deepStrictEqual(clean(null), null);

  // ------------------------------------------------------- the page -----
  // The page's script must parse, and must never assign HTML: everything
  // shown came from someone else's mail or chat.
  const html = fs.readFileSync(path.join(__dirname, '../src/dashboard/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 1);
  new vm.Script(scripts[0], { filename: 'index.html <script>' });
  assert.ok(!/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/.test(scripts[0]), 'no HTML sinks in the page');

  console.log('memoryui ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
