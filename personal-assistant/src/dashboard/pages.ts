'use strict';

// Jarvis pages in the dashboard (src/pages): read-only routes.
//
//   GET /pages/<slug>        the page: a shell that loads page.client.js and fetches
//                            ../api/pages/<slug> (relative, so termhub's /pa/ works)
//   GET /page.client.js      the renderer, the same file the export inlines
//   GET /pages.list.js       the Plan tab's "Pages" card (pages.list.client.js)
//   GET /api/pages           every page with its progress
//   GET /api/pages/<slug>    one page, its tasks resolved from their cards
//
// No POST: pages change through `pa page …` and the files themselves, so no
// X-PA guard is needed. Text only on the page (no HTML sink).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;

const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, 'page.client.js');
const LIST_CLIENT = path.join(__dirname, 'pages.list.client.js');
const PAGE_PATH = /^\/pages\/([a-z0-9][a-z0-9-]{0,63})$/;
const API_PATH = /^\/api\/pages\/([a-z0-9][a-z0-9-]{0,63})$/;

/** The dashboard's page for one slug. The slug is checked by PAGE_PATH before it gets here. */
function shell(slug: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${slug} · Jarvis</title>`,
    '<style>.pg-back{display:block;max-width:1100px;margin:0 auto;padding:12px 16px 0;font:13px system-ui,sans-serif;}</style>',
    '</head>',
    '<body>',
    '<a class="pg-back" href="../">← Plan</a>',
    `<div id="page-root" data-src="../api/pages/${slug}"></div>`,
    '<script src="../page.client.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function matches(url: URL): boolean {
  const p = url.pathname;
  return p === '/page.client.js' || p === '/pages.list.js' || p === '/api/pages' || PAGE_PATH.test(p) || API_PATH.test(p);
}

async function route(req: Req, res: Res, url: URL, { send }: { send: Ctx['send'] }) {
  if (req.method !== 'GET') return false;
  const p = url.pathname;
  if (p === '/page.client.js') {
    send(res, 200, fs.readFileSync(CLIENT, 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  if (p === '/pages.list.js') {
    send(res, 200, fs.readFileSync(LIST_CLIENT, 'utf8'), 'text/javascript; charset=utf-8');
    return true;
  }
  const pages = require('../pages/index.ts');
  if (p === '/api/pages') {
    send(res, 200, { pages: await pages.list() });
    return true;
  }
  let m = PAGE_PATH.exec(p);
  if (m) {
    send(res, 200, shell(String(m[1])), 'text/html; charset=utf-8');
    return true;
  }
  m = API_PATH.exec(p);
  if (m) {
    try {
      send(res, 200, await pages.resolved(String(m[1])));
    } catch (e) {
      const err = e as Error & { status?: number };
      send(res, err.status || 500, { error: err.message });
    }
    return true;
  }
  return false;
}

module.exports = { route, matches, shell };
