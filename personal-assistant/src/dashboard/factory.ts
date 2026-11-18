'use strict';

// The Build page (Alt+3, /factory: the route keeps its name, the page is Build):
// the shell for the Build board (buildBoard.ts, build.board.client.js).
//
//   GET  /factory        the page (factory.html)
//   GET  /api/factory/usage  live subscription limits: 5 h, weekly, weekly Fable, extra credits
//                            (build/usage.ts; 15 s cache)
//
// Same guards as every dashboard write: loopback, X-PA on every POST. The software factory that
// used to fill this page was removed (PLAN.md D32).
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Req = import('http').IncomingMessage;
type Res = import('http').ServerResponse;
type Ctx = import('./types.ts').Ctx;

const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, 'factory.html');

function pageHtml(token: string) {
  return fs.readFileSync(PAGE, 'utf8').replace('</head>', `<meta name="pa-page" content="${token}">\n</head>`);
}

async function route(req: Req, res: Res, url: URL, { send, issuePageToken }: { send: Ctx['send']; issuePageToken: Ctx['issuePageToken'] }) {
  if (req.method === 'GET' && url.pathname === '/factory') {
    send(res, 200, pageHtml(issuePageToken()), 'text/html; charset=utf-8');
    return true;
  }
  // Live Claude subscription limits for the Build board (build/usage.ts; 15 s cache).
  if (req.method === 'GET' && url.pathname === '/api/factory/usage') {
    send(res, 200, await require('../build/usage.ts').usage());
    return true;
  }
  return false;
}

module.exports = { route };
