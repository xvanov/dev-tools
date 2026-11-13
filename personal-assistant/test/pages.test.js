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
let exportedJs = '';

/**
 * Just enough DOM to run page.client.js as the export inlines it: elements with classes,
 * attributes, style and listeners, a class/tag/attribute selector, and one animation frame
 * run by hand (`frame()`). Not a browser: layout is a fixed box per element.
 */
function fakeDom(page) {
  const nodes = [];
  function make(tag) {
    const n = {
      tag, attrs: {}, style: {}, children: [], parent: null, listeners: {}, hidden: false, _text: '',
      get className() { return this.attrs.class || ''; },
      set className(v) { this.attrs.class = String(v); },
      get classList() {
        const self = this;
        const list = () => self.className.split(/\s+/).filter(Boolean);
        return {
          contains: (c) => list().includes(c),
          add: (c) => { if (!list().includes(c)) self.className = [...list(), c].join(' '); },
          remove: (c) => { self.className = list().filter((x) => x !== c).join(' '); },
          toggle: (c, on) => { const want = on === undefined ? !list().includes(c) : !!on; if (want) self.classList.add(c); else self.classList.remove(c); return want; },
        };
      },
      get firstChild() { return this.children[0] || null; },
      set textContent(v) { this.children = []; this._text = String(v); },
      get textContent() { return this.text(); },
      text() { return this._text + this.children.map((c) => c.text()).join(''); },
      appendChild(c) { if (c.tag === '#frag') { c.children.slice().forEach((x) => this.appendChild(x)); return c; } c.parent = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parent = null; return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      fire(t) { (this.listeners[t] || []).forEach((f) => f({ key: '', preventDefault() {} })); },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 30 }; },
      descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); },
      querySelectorAll(sel) { return this.descendants().filter((d) => (sel[0] === '.' ? d.classList.contains(sel.slice(1)) : d.tag === sel)); },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    };
    nodes.push(n);
    return n;
  }
  const root = make('div');
  const data = make('script');
  data._text = JSON.stringify(page);
  const head = make('head');
  let frames = [];
  const document = {
    readyState: 'complete', title: '', head,
    createElement: make, createElementNS: (_ns, tag) => make(tag),
    createTextNode: (t) => { const n = make('#text'); n._text = String(t); return n; },
    createDocumentFragment: () => make('#frag'),
    getElementById: (id) => (id === 'page-root' ? root : id === 'page-data' ? data : head.children.find((c) => c.id === id) || null),
    addEventListener() {},
  };
  const window = { addEventListener() {}, removeEventListener() {} };
  const globals = { window, document, requestAnimationFrame: (f) => frames.push(f), setInterval() {}, fetch() {} };
  return {
    globals,
    frame() { const fs_ = frames; frames = []; fs_.forEach((f) => f()); },
    all: (pred) => root.descendants().filter(pred),
  };
}

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
  assert.strictEqual(core.shortTitle(''), 'Plan page');

  // The published file carries no note from this repo: the renderer's comments are stripped and
  // nothing in it names the tool. The stripped renderer still parses and runs (renderInFakeDom).
  const plain = core.exportHtml(core.resolve(sample(), cards), { clientJs: client });
  assert.ok(!/jarvis/i.test(plain), 'the export never says Jarvis');
  assert.ok(!plain.includes('/*'), 'no block comment from the renderer');
  assert.ok(!/^\s*\/\//m.test(plain), 'no line comment from the renderer');
  assert.ok(plain.includes("'http://www.w3.org/2000/svg'"), 'a URL in a string survives');
  exportedJs = /<script>([\s\S]*?)<\/script>/.exec(plain.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ''))[1];
}

// ------------------------------------------------ stripComments is careful ----
{
  const src = [
    '/* header',
    ' * more */',
    "var a = 'http://x/*not a comment*/'; // trailing",
    'var b = "say // no";',
    '  // a whole line',
    'var r = /\\/\\*[/]x/g, s = /a\\/\\/b/;',
    'var t = `//kept ${1} /*kept*/`;',
    'var d = a.length / 2 / 1;',
    'function f(z) { return /re\\//.test(z); }',
    'var k = [1] / 2; /* inline */ var m = 3;',
  ].join('\n');
  const out = core.stripComments(src);
  assert.ok(!out.includes('header') && !out.includes('trailing') && !out.includes('a whole line') && !out.includes('inline'), out);
  for (const keep of ["'http://x/*not a comment*/'", '"say // no"', '/\\/\\*[/]x/g', '/a\\/\\/b/', '`//kept ${1} /*kept*/`', 'a.length / 2 / 1', '/re\\//.test(z)', 'var m = 3;']) {
    assert.ok(out.includes(keep), `stripComments keeps ${keep}:\n${out}`);
  }
  const vm = require('vm');
  const ctx = { r: 0 };
  vm.runInNewContext(out + '\n;r = [a, b, r.source, s.source, t, d, f("re/"), k, m];', ctx);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.r)), ['http://x/*not a comment*/', 'say // no', '\\/\\*[/]x', 'a\\/\\/b', '//kept 1 /*kept*/', 12.5, true, 0.5, 3]);
}

// --------------------------------------------- the stripped renderer runs ----
{
  const vm = require('vm');
  const dom = fakeDom(core.resolve(sample(), []));
  vm.runInNewContext(exportedJs, dom.globals);
  assert.ok(dom.globals.window.PlanPage && typeof dom.globals.window.PlanPage.render === 'function', 'the stripped renderer ran');
  dom.frame();
  assert.ok(dom.all((n) => n.tag === 'h1')[0].text().startsWith('Sample rollout plan'), 'and drew the page');
  assert.ok(dom.all((n) => n.tag === 'path').length > 0, 'and its arrows');
}

// ------------------------------------------- owner, next, links: validation ----
{
  const ok = sample({ tasks: [{ card: 1, owner: 'Sam', next: true, links: [{ label: 'spec', url: 'https://example.com/a' }] }] });
  assert.deepStrictEqual(core.validate(ok), []);
  const bad = sample({
    tasks: [
      { card: 1, owner: '' },
      { card: 2, owner: 7 },
      { card: 3, next: 'yes' },
      { card: 4, links: 'https://example.com' },
      { card: 5, links: [{ label: 'x', url: 'javascript:alert(1)' }, { url: 'https://example.com' }] },
      { card: 6, owner: 'x'.repeat(81) },
    ],
  });
  const errs = core.validate(bad);
  for (const want of ['tasks[0]: owner', 'tasks[1]: owner', 'tasks[2]: next is true or false', 'tasks[3]: links is a list', 'tasks[4].links[0]', 'tasks[4].links[1]', 'tasks[5]: owner']) {
    assert.ok(errs.some((e) => e.includes(want)), `validate reports "${want}": ${errs.join(' | ')}`);
  }
}

// --------------------------------------------------------- status per task ----
{
  // the card decides done/dropped; then doing > blocked > next > to do
  assert.strictEqual(core.taskStatus('done', { blockedOn: 'x', next: true }), 'done');
  assert.strictEqual(core.taskStatus('dropped', { next: true }), 'dropped');
  assert.strictEqual(core.taskStatus('doing', { blockedOn: 'x' }), 'doing');
  assert.strictEqual(core.taskStatus('todo', { blockedOn: 'x', next: true }), 'blocked');
  assert.strictEqual(core.taskStatus('todo', { next: true }), 'next');
  assert.strictEqual(core.taskStatus('todo', {}), 'todo');
  assert.strictEqual(core.taskStatus('missing', { next: true }), 'missing');

  const page = sample({
    tasks: [
      { card: 1, group: 'G' }, // done
      { card: 2, group: 'G' }, // to do
      { card: 3, group: 'G', blockedOn: 'a vendor' }, // blocked
      { card: 4, group: 'G' }, // dropped
      { card: 5, group: 'G', next: true, owner: '  Sam  ' }, // next
      { card: 6, group: 'G', doing: true }, // doing
      { card: 7, group: 'G', blockedOn: 'done anyway' }, // done: a done card is not blocked
    ],
  });
  const cards = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, status: id === 1 || id === 7 ? 'done' : id === 4 ? 'dropped' : 'open', summary: `task ${id}` }));
  const r = core.resolve(page, cards);
  assert.deepStrictEqual(r.tasks.map((t) => t.status), ['done', 'todo', 'blocked', 'dropped', 'next', 'doing', 'done'], 'tasks keep the author order');
  assert.deepStrictEqual(r.groups[0].tasks.map((t) => t.card), [6, 5, 3, 2, 1, 7, 4], 'a group sorts doing, next, blocked, to do, done, dropped');
  assert.strictEqual(r.tasks[4].owner, 'Sam');
  assert.strictEqual(r.tasks[0].owner, null);
  assert.deepStrictEqual([r.progress.doing, r.progress.next, r.progress.blocked], [['task 6'], ['task 5'], 1]);
  assert.deepStrictEqual([r.progress.done, r.progress.total], [2, 6], 'statuses do not change the progress math');
}

// ------------------------------------------------- links from the card text ----
{
  assert.strictEqual(core.linkLabel('https://github.com/acme/widget/pull/211'), 'PR #211');
  assert.strictEqual(core.linkLabel('https://github.com/acme/widget/pull/211/files'), 'PR #211');
  assert.strictEqual(core.linkLabel('https://github.com/acme/widget/issues/210'), 'Issue #210');
  assert.strictEqual(core.linkLabel('https://github.com/acme/widget'), 'acme/widget');
  assert.strictEqual(core.linkLabel('https://github.com/acme/widget/tree/main/src'), 'acme/widget');
  assert.strictEqual(core.linkLabel('https://claude.ai/artifact/AbC'), 'Page');
  assert.strictEqual(core.linkLabel('https://claude.ai/code/artifact/0b1c'), 'Page');
  assert.strictEqual(core.linkLabel('https://www.example.com/x?y=1'), 'example.com');

  assert.deepStrictEqual(
    core.urlsIn('See (https://example.com/a), then https://example.com/b. And https://en.wikipedia.org/wiki/Foo_(bar) and https://example.com/a again; not ftp://x.'),
    ['https://example.com/a', 'https://example.com/b', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    'trailing punctuation and a closing parenthesis are not part of the URL; once each',
  );
  assert.deepStrictEqual(core.urlsIn(null), []);

  const page = sample({
    tasks: [{ card: 1, links: [{ label: 'the PR', url: 'https://github.com/acme/widget/pull/211' }] }, { card: 2 }],
  });
  const cards = [
    {
      id: 1,
      status: 'open',
      summary: 'Land https://github.com/acme/widget/pull/211',
      detail: 'Context.\n[2026-11-10] note: tracked in https://github.com/acme/widget/issues/210 and https://GITHUB.com/acme/widget/pull/211/ — draft https://claude.ai/artifact/Doc1',
    },
    { id: 2, status: 'open', summary: 'No links here', detail: null },
  ];
  const r = core.resolve(page, cards);
  assert.deepStrictEqual(
    r.tasks[0].links,
    [
      { label: 'the PR', url: 'https://github.com/acme/widget/pull/211' },
      { label: 'Issue #210', url: 'https://github.com/acme/widget/issues/210' },
      { label: 'Page', url: 'https://claude.ai/artifact/Doc1' },
    ],
    'the page\'s links first with their labels; the card\'s after, the same URL once',
  );
  assert.deepStrictEqual(r.tasks[1].links, []);
  assert.deepStrictEqual(core.cardLinks(undefined), []);

  // noting a URL on a card changes what the page shows, so the worker re-exports and republishes
  const noted = core.resolve(page, cards.map((c) => (c.id === 2 ? { ...c, detail: '[2026-11-12] note: https://github.com/acme/widget/pull/212' } : c)));
  assert.deepStrictEqual(noted.tasks[1].links, [{ label: 'PR #212', url: 'https://github.com/acme/widget/pull/212' }]);
  assert.notStrictEqual(core.snapshotHash(r), core.snapshotHash(noted), 'a URL noted on a card changes the snapshot hash');
  // ...and so does an owner or next flag set on the page
  assert.notStrictEqual(core.snapshotHash(r), core.snapshotHash(core.resolve({ ...page, tasks: [page.tasks[0], { card: 2, owner: 'Sam' }] }, cards)));
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
