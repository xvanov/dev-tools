'use strict';

// The dashboard can start agents, so its guards are tested, not assumed.

const assert = require('assert');
const { hostAllowed } = require('../src/dashboard/server.ts');

assert.ok(hostAllowed('127.0.0.1:7300'));
assert.ok(hostAllowed('localhost:7300'));
assert.ok(hostAllowed('[::1]:7300'));
// DNS rebinding arrives with the attacker's hostname in Host.
assert.ok(!hostAllowed('evil.example:7300'));
assert.ok(!hostAllowed('100.64.0.5:7300'));
assert.ok(!hostAllowed(''));
assert.ok(!hostAllowed(undefined));

// The page's inline script and the client scripts it loads share one global
// scope. A second top-level `function busy` silently replaced the first, and
// every Done, Reopen and Memory button stopped doing anything.
{
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'dashboard');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const inline = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).join('\n');
  const clients = fs.readdirSync(dir).filter((f) => f.endsWith('.client.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  const seen = new Map();
  for (const [i, src] of [inline, ...clients].entries()) {
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1] || m[2];
      assert.ok(!seen.has(name), `top-level "${name}" is declared twice in the dashboard's scripts (sources ${seen.get(name)} and ${i})`);
      seen.set(name, i);
    }
  }
}

// One design system for every layer: both PA pages load theme.css and the
// layer switcher (nav.js) by relative URL, so they work under termhub's /pa/
// too, and the server answers both.
(async () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'src', 'dashboard');
  for (const [page, layer] of [['index.html', 'dashboard'], ['talk.html', 'talk']]) {
    const html = fs.readFileSync(path.join(dir, page), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="theme\.css">/, `${page} loads theme.css`);
    assert.match(html, new RegExp(`<script src="nav\\.js" data-layer="${layer}"></script>`), `${page} loads nav.js`);
    assert.match(html, /data-jside/, `${page} has a panel for nav.js's navigation`);
    assert.ok(!/#[0-9a-fA-F]{6}\b/.test(html.slice(0, html.indexOf('</style>'))), `${page}: colours come from theme.css, not the page`);
  }
  const { handle } = require('../src/dashboard/server.ts');
  for (const [p, type] of [['/theme.css', /text\/css/], ['/nav.js', /javascript/]]) {
    const res = { writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } };
    await handle({ method: 'GET', url: p, headers: { host: '127.0.0.1:7300' } }, res);
    assert.strictEqual(res.status, 200, p);
    assert.match(res.headers['Content-Type'], type, p);
    assert.ok(res.body.length > 500, p);
  }
  console.log('dashboard ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
