'use strict';

// Jarvis pages (src/pages, src/dashboard/page.client.js, pa page): validation,
// progress from cards (dropped and missing cards leave the total), the export
// is one self-contained file carrying the page, the CLI's argument parsing,
// the read-only dashboard routes, the worker pass, and no HTML sink in either
// client. Sample data only: this repo is public.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pages-'));
process.env.PA_PAGES_DIR = tmp;

const core = require('../src/pages/core.ts');
const pages = require('../src/pages/index.ts');
const cli = require('../src/cli/page.ts');
const { parseArgs } = require('../src/cli/parseArgs.ts');

const PA = path.join(__dirname, '..');

function sample(over = {}) {
  return {
    version: 1,
    slug: 'sample-plan',
    title: 'Sample rollout plan for a widget',
    summary: 'Made-up.',
    links: [{ label: 'spec', url: 'https://example.com/spec' }],
    map: {
      layers: [{ id: 'apps', label: 'Apps' }, { id: 'data', label: 'Data' }],
      nodes: [
        { id: 'app', label: 'Widget app', layer: 'apps', kind: 'service', status: 'live' },
        { id: 'db', label: 'Widget store', layer: 'data', kind: 'data', status: 'planned' },
      ],
      edges: [{ from: 'app', to: 'db', label: 'writes', flows: ['save'] }],
      flows: [{ id: 'save', label: 'Save', color: '#2f6fde', description: 'A save.' }],
    },
    sections: [{ heading: 'Why', body: 'Because.\n\n- one\n- two' }],
    tasks: [
      { card: 1, group: 'Now', nodes: ['app'] },
      { card: 2, group: 'Now', blockedOn: 'a vendor' },
      { card: 3, group: 'Later', doing: true },
      { card: 4, group: 'Later' },
      { card: 5, group: 'Later' },
      { card: 6, group: 'Later' },
    ],
    ...over,
  };
}

// ------------------------------------------------------------- validation ----
assert.deepStrictEqual(core.validate(sample()), []);
{
  const bad = sample({ slug: 'Bad Slug', tasks: [{ card: 1, nodes: ['nope'] }, { card: 1 }] });
  bad.map.edges.push({ from: 'app', to: 'ghost', flows: ['nope'] });
  bad.map.nodes.push({ id: 'x', label: 'X', layer: 'nowhere', kind: 'spaceship' });
  const errs = core.validate(bad);
  for (const want of ['slug', 'unknown to ghost', 'unknown flow nope', 'unknown layer nowhere', 'kind is one of', 'unknown node nope', 'listed twice']) {
    assert.ok(errs.some((e) => e.includes(want)), `validate reports "${want}": ${errs.join(' | ')}`);
  }
  assert.ok(core.validate(null).length && core.validate(sample({ version: 2 })).some((e) => e.includes('version')));
  assert.ok(core.validate(sample({ links: [{ label: 'x', url: 'javascript:alert(1)' }] })).some((e) => e.includes('links[0]')), 'only http(s) links');
}

// ---------------------------------------------------------- progress math ----
{
  const cards = [
    { id: 1, status: 'done', summary: 'Ship it' },
    { id: 2, status: 'open', summary: 'Ask the vendor' },
    { id: 3, status: 'dispatched', summary: 'Build it' },
    { id: 4, status: 'dropped', summary: 'Old idea' },
    { id: 5, status: 'open', summary: 'Folded', superseded_by: 7 },
    // card 6 does not exist
    { id: 7, status: 'done', summary: 'The survivor' },
  ];
  const r = core.resolve(sample(), cards, { now: new Date('2026-01-02T03:04:05Z') });
  assert.deepStrictEqual(r.tasks.map((t) => t.state), ['done', 'todo', 'doing', 'dropped', 'done', 'missing'], 'an open folded card follows the card it was folded into');
  assert.deepStrictEqual([r.progress.done, r.progress.total, r.progress.percent], [2, 4, 50], 'dropped and missing cards leave the total');
  // a folded card that was itself dropped stays dropped; one folded into an open card is open
  assert.strictEqual(core.taskState({ status: 'dropped', superseded_by: 7 }, false, new Map([[7, { status: 'open' }]])), 'dropped');
  assert.strictEqual(core.taskState({ status: 'open', superseded_by: 2 }, false, new Map([[2, { status: 'open' }]])), 'todo');
  assert.deepStrictEqual(r.progress.doing, ['Build it']);
  assert.strictEqual(r.tasks[5].title, 'card #6 not found');
  assert.strictEqual(r.tasks[4].foldedInto, 7);
  assert.deepStrictEqual(r.groups.map((g) => [g.name, g.done, g.total, g.percent]), [['Now', 1, 2, 50], ['Later', 1, 2, 50]]);
  // a live build run marks a card as being worked on
  assert.strictEqual(core.resolve(sample(), cards, { runningCards: [2] }).tasks[1].state, 'doing');
  // nothing counted: 0%, not NaN
  assert.strictEqual(core.resolve(sample({ tasks: [] }), []).progress.percent, 0);
  // the hash ignores when it was resolved, and sees a status change
  const later = core.resolve(sample(), cards, { now: new Date('2027-01-01T00:00:00Z') });
  assert.strictEqual(core.snapshotHash(r), core.snapshotHash(later));
  const changed = core.resolve(sample(), cards.map((c) => (c.id === 2 ? { ...c, status: 'done' } : c)));
  assert.notStrictEqual(core.snapshotHash(r), core.snapshotHash(changed));

  // ------------------------------------------------------------- export ----
  const client = fs.readFileSync(path.join(PA, 'src', 'dashboard', 'page.client.js'), 'utf8');
  const evil = core.resolve(sample({ title: 'A </script><script>alert(1)</script> plan' }), cards);
  const html = core.exportHtml(evil, { clientJs: client });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external script');
  assert.ok(!/<link[^>]+href=/i.test(html), 'no external stylesheet or font');
  assert.strictEqual((html.match(/<\/script>/gi) || []).length, 2, 'the page text cannot close a script tag');
  const json = /<script type="application\/json" id="page-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(json, 'the page is embedded as JSON');
  assert.strictEqual(JSON.parse(json[1]).title, evil.title, 'and reads back exactly');
  assert.match(html, /<title>A script script alert<\/title>/, 'a short, escaped title');
  assert.strictEqual(core.shortTitle('Ship'), 'Ship page');
}

// --------------------------------------------------------- publish parsing ----
assert.strictEqual(core.parsePublishUrl('done: https://claude.ai/artifact/AbC_12-x\n'), 'https://claude.ai/artifact/AbC_12-x');
assert.strictEqual(core.parsePublishUrl('https://claude.ai/code/artifact/0b1c-2d'), 'https://claude.ai/code/artifact/0b1c-2d');
assert.strictEqual(core.parsePublishUrl('no link here'), null);
{
  const first = pages.publishPrompt('/x/sample-plan.html', null, 'T');
  assert.ok(first.includes('sample-plan.html') && first.includes('icon "map"') && !first.includes('action "read"'));
  const again = pages.publishPrompt('/x/sample-plan.html', 'https://claude.ai/artifact/Q', 'T');
  assert.ok(again.includes('action "read"') && again.includes('url "https://claude.ai/artifact/Q"'), 'an update reads first, then publishes to the same url');
  const argv = pages.publishArgs('p');
  assert.deepStrictEqual(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2), ['--tools', 'Artifact,Read'], 'only the Artifact tool, and Read, which it needs');
}

// ------------------------------------------------------------- CLI parsing ----
{
  const p = (s) => {
    const a = parseArgs(s.split(' '));
    return cli.parse(a.args, a.flags);
  };
  assert.deepStrictEqual(p('page'), { verb: 'list' });
  assert.deepStrictEqual(p('page show sample-plan'), { verb: 'show', slug: 'sample-plan' });
  assert.deepStrictEqual(p('page export sample-plan --out x.html'), { verb: 'export', slug: 'sample-plan', out: 'x.html' });
  assert.deepStrictEqual(p('page doing sample-plan 12'), { verb: 'doing', slug: 'sample-plan', card: 12, on: true });
  assert.deepStrictEqual(p('page doing sample-plan 12 --off'), { verb: 'doing', slug: 'sample-plan', card: 12, on: false });
  assert.ok(p('page doing sample-plan x').error);
  assert.ok(p('page import').error && p('page frob').error);
}

// ------------------------------------------------------- the client's rules ----
for (const f of ['page.client.js', 'pages.list.client.js']) {
  const src = fs.readFileSync(path.join(PA, 'src', 'dashboard', f), 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!src.includes(sink), `${f} uses ${sink}`);
  assert.ok(!/fetch\('\//.test(src), `${f} fetches an absolute path`);
  assert.ok(!/https?:\/\/(?!claude\.ai|www\.w3\.org)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), `${f} loads nothing from elsewhere`);
}

(async () => {
  // ------------------------------------------------- files, routes, pass ----
  const empty = sample({ slug: 'no-tasks', tasks: [] });
  const inDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pages-in-'));
  fs.writeFileSync(path.join(inDir, 'in.json'), JSON.stringify(empty));
  pages.importFile(path.join(inDir, 'in.json'));
  fs.rmSync(inDir, { recursive: true, force: true });
  assert.throws(() => pages.write(sample({ slug: '../evil' })), /not valid/);
  assert.throws(() => pages.read('../evil'), /not a page name/);
  assert.deepStrictEqual(pages.slugs(), ['no-tasks']);
  const list = await pages.list();
  assert.deepStrictEqual([list[0].slug, list[0].progress.percent], ['no-tasks', 0]);

  const route = require('../src/dashboard/pages.ts');
  const sent = [];
  const send = (res, status, body, type) => sent.push({ status, body, type });
  const call = async (method, p) => {
    sent.length = 0;
    const handled = await route.route({ method }, {}, new URL('http://127.0.0.1' + p), { send });
    return handled ? sent[0] : null;
  };
  assert.ok(route.matches(new URL('http://h/pages/no-tasks')) && !route.matches(new URL('http://h/pages/../x')));
  const shell = await call('GET', '/pages/no-tasks');
  assert.ok(shell.body.includes('data-src="../api/pages/no-tasks"') && shell.body.includes('src="../page.client.js"'), 'relative: works under termhub /pa/');
  assert.strictEqual((await call('GET', '/api/pages/no-tasks')).body.slug, 'no-tasks');
  assert.strictEqual((await call('GET', '/api/pages/missing-one')).status, 404);
  assert.strictEqual((await call('GET', '/api/pages')).body.pages.length, 1);
  assert.strictEqual(await call('POST', '/api/pages'), null, 'read-only');

  // The pass exports once, then not again while nothing changes; a published page whose
  // snapshot moved is republished, but not within 10 minutes of the last publish.
  const published = [];
  const doPublish = async (s) => published.push(s);
  let r = await pages.pass({ doPublish });
  assert.deepStrictEqual(r.exported, ['no-tasks']);
  assert.ok(fs.existsSync(path.join(tmp, 'no-tasks.html')));
  r = await pages.pass({ doPublish });
  assert.deepStrictEqual([r.exported, r.published], [[], []]);
  const pg = pages.read('no-tasks');
  pg.publish = { url: 'https://claude.ai/artifact/sample', publishedAt: new Date(Date.now() - 60_000).toISOString(), hash: 'old' };
  pages.write(pg);
  r = await pages.pass({ doPublish });
  assert.deepStrictEqual(r.published, [], 'not within 10 minutes');
  r = await pages.pass({ doPublish, now: Date.now() + pages.REPUBLISH_MIN_MS });
  assert.deepStrictEqual(r.published, ['no-tasks']);
  r = await pages.pass({ doPublish, now: Date.now() + pages.REPUBLISH_MIN_MS, republish: false });
  assert.deepStrictEqual(r.published, [], 'PA_PAGES_REPUBLISH=off');

  // A failed headless publish keeps the export and says why.
  await assert.rejects(pages.publish('no-tasks', { run: async () => ({ code: 1, stdout: '', stderr: 'not logged in' }) }), (e) => /not logged in/.test(e.message) && /no-tasks\.html/.test(e.message));
  await pages.publish('no-tasks', { run: async () => ({ code: 0, stdout: 'https://claude.ai/artifact/NewOne\n', stderr: '' }) });
  assert.strictEqual(pages.read('no-tasks').publish.url, 'https://claude.ai/artifact/NewOne');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('pages ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
